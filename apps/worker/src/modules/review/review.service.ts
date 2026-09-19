import { Injectable, Logger } from '@nestjs/common';
import { getPool, withTenant } from '@devsentinel/database';
import type { GitProviderPort } from '@devsentinel/git-providers';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import { OpenAiCompatibleLlmAdapter, embedLocally, type ProjectProfile, type ReviewResult } from '@devsentinel/llm-port';
import { getSystemSettings, sendEmail } from '@devsentinel/settings';
import type { ReviewJobPayload } from '@devsentinel/event-contracts';
import { buildPullRequestContent } from '@devsentinel/pr-content';
import { upsertFindingsIssue } from '@devsentinel/issue-content';
import { RepoCheckoutService } from './repoCheckout.service';
import { StaticAnalysisService } from './staticAnalysis.service';
import { RagContextService } from './ragContext.service';

interface QualityGateConfig {
  min_coverage_pct: number;
  block_on_risk_level: 'medium' | 'high';
  block_on_secret: boolean;
}

const DEFAULT_GATE_CONFIG: QualityGateConfig = {
  min_coverage_pct: 0,
  block_on_risk_level: 'high',
  block_on_secret: true,
};

type GateDecision = 'apto' | 'requiere_revision' | 'no_apto';

const GATE_LABEL: Record<GateDecision, string> = {
  apto: '✓ APTO',
  requiere_revision: '⚠ REQUIERE REVISIÓN',
  no_apto: '❌ NO APTO',
};

// Categorías donde un finding critical fuerza NO APTO sin importar el score o lo que
// sugiera el LLM — regla dura determinista, no a discreción del modelo.
const HARD_BLOCK_CATEGORIES = new Set(['security', 'architecture', 'database', 'regression']);

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly checkout: RepoCheckoutService,
    private readonly staticAnalysis: StaticAnalysisService,
    private readonly ragContext: RagContextService,
  ) {}

  /** Construye el adapter de GitHub (credenciales de la App dueña de esta instalación,
   * ver `github_apps`) y el cliente LLM con la configuración vigente en
   * `system_settings` — se hace por job (no en el constructor) para que un cambio de
   * proveedor LLM o de credenciales de GitHub aplique al siguiente push sin reiniciar
   * el worker. */
  private async buildClients(
    organizationId: string,
    installationId: number,
  ): Promise<{ gitAdapter: GitProviderPort; llm: OpenAiCompatibleLlmAdapter }> {
    const [gitAdapter, settings] = await Promise.all([
      withTenant(organizationId, (client) => buildGithubAdapterForInstallation(client, installationId)),
      getSystemSettings(getPool()),
    ]);
    const llm = new OpenAiCompatibleLlmAdapter(
      settings?.llmModel ?? '',
      settings?.llmProviderBaseUrl ?? '',
      settings?.llmProviderApiKey ?? '',
      embedLocally,
    );
    return { gitAdapter, llm };
  }

  async runReview(payload: ReviewJobPayload): Promise<void> {
    try {
      const { gitAdapter, llm } = await this.buildClients(payload.organizationId, payload.installationId);

      const diff = payload.pullNumber
        ? await gitAdapter.getPullRequestDiff({
            installationId: payload.installationId,
            owner: payload.owner,
            repo: payload.repo,
            pullNumber: payload.pullNumber,
          })
        : await gitAdapter.getCommitDiff({
            installationId: payload.installationId,
            owner: payload.owner,
            repo: payload.repo,
            commitSha: payload.commitSha,
          });

      const analyzedFiles = extractAnalyzedFiles(diff);

      const installationToken = await gitAdapter.getInstallationToken(payload.installationId);

      const { staticFindings, retrievedContext } = await this.checkout.withCheckout(
        {
          owner: payload.owner,
          repo: payload.repo,
          commitSha: payload.commitSha,
          installationToken,
        },
        async (checkoutPath) => {
          const findings = await this.staticAnalysis.run(checkoutPath);
          const context = await this.ragContext.indexAndRetrieve(
            payload.organizationId,
            payload.repositoryId,
            checkoutPath,
            diff,
          );
          return { staticFindings: findings, retrievedContext: context };
        },
      );

      const [projectProfile, recentCommits] = await Promise.all([
        this.getProjectProfile(payload.organizationId, payload.repositoryId),
        gitAdapter.getRecentCommits({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          commitSha: payload.commitSha,
        }),
      ]);

      const result = await llm.reviewDiff({
        repositoryFullName: `${payload.owner}/${payload.repo}`,
        commitSha: payload.commitSha,
        diff,
        staticFindings,
        retrievedContext,
        projectProfile,
        recentCommits,
        analyzedFiles,
      });

      const config = await this.getQualityGateConfig(payload.organizationId, payload.repositoryId);
      const gateDecision = this.evaluateGateDecision(config, result);

      await this.persistResult(payload, result, gateDecision, analyzedFiles);
      await this.publishToGithub(gitAdapter, payload, result, gateDecision);
      await this.syncFindingsIssue(gitAdapter, payload, result, gateDecision);
      await this.maybeAutoCreatePullRequest(gitAdapter, payload, result, gateDecision);
      await this.notifyAuthorOnPush(gitAdapter, payload, result, gateDecision);
    } catch (err) {
      this.logger.error(
        `review run ${payload.reviewRunId} failed for ${payload.owner}/${payload.repo}@${payload.commitSha}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.markFailed(payload, (err as Error).message);
      throw err;
    }
  }

  private evaluateGateDecision(config: QualityGateConfig, result: ReviewResult): GateDecision {
    const hasHardBlockingFinding = result.findings.some(
      (f) => f.severity === 'critical' && HARD_BLOCK_CATEGORIES.has(f.category),
    );
    if (hasHardBlockingFinding) return 'no_apto';

    const hasSecretFinding = result.findings.some(
      (f) => f.category === 'security' && /secret|credential|token/i.test(f.title),
    );
    if (config.block_on_secret && hasSecretFinding) return 'no_apto';

    const blockingRiskLevels = config.block_on_risk_level === 'medium' ? ['medium', 'high'] : ['high'];
    if (blockingRiskLevels.includes(result.risk_level)) return 'no_apto';

    const llmVerdict = normalizeVerdict(result.resultado);
    if (llmVerdict) return llmVerdict;

    // Red de seguridad si el LLM no devolvió un veredicto válido.
    if (result.risk_level === 'high') return 'requiere_revision';
    if (result.risk_level === 'medium' && result.quality_score < 70) return 'requiere_revision';
    return 'apto';
  }

  private async persistResult(
    payload: ReviewJobPayload,
    result: ReviewResult,
    gateDecision: GateDecision,
    analyzedFiles: string[],
  ): Promise<void> {
    await withTenant(payload.organizationId, async (client) => {
      await client.query(
        `UPDATE review_runs
         SET status = 'completed', quality_score = $1, risk_level = $2, summary = $3,
             gate_decision = $4, llm_verdict = $5, final_justification = $6,
             commit_history_comparison = $7, recommendations = $8, recommended_tests = $9,
             analyzed_files = $10, completed_at = now()
         WHERE id = $11`,
        [
          result.quality_score,
          result.risk_level,
          result.resumen_ejecutivo,
          gateDecision,
          normalizeVerdict(result.resultado) ?? null,
          result.justificacion_final,
          result.comparacion_commits_previos,
          result.recomendaciones,
          result.tests_recomendados,
          analyzedFiles,
          payload.reviewRunId,
        ],
      );

      for (const finding of result.findings) {
        const blocking = gateDecision === 'no_apto' && (finding.severity === 'critical' || finding.severity === 'high');
        await client.query(
          `INSERT INTO findings
             (organization_id, review_run_id, category, severity, file_path, line_start, line_end, title, explanation, suggested_fix, confidence, rule_source, blocking, violated_rule)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'llm', $12, $13)`,
          [
            payload.organizationId,
            payload.reviewRunId,
            finding.category,
            finding.severity,
            finding.file_path,
            finding.line_start ?? null,
            finding.line_end ?? null,
            finding.title,
            finding.explanation,
            finding.suggested_fix ? JSON.stringify(finding.suggested_fix) : null,
            finding.confidence,
            blocking,
            finding.violated_rule ?? null,
          ],
        );
      }
    });
  }

  private async publishToGithub(
    gitAdapter: GitProviderPort,
    payload: ReviewJobPayload,
    result: ReviewResult,
    gateDecision: GateDecision,
  ): Promise<void> {
    if (payload.pullNumber) {
      for (const finding of result.findings) {
        if (!finding.line_start) continue;
        await gitAdapter.postReviewComment({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          pullNumber: payload.pullNumber,
          commitSha: payload.commitSha,
          filePath: finding.file_path,
          line: finding.line_start,
          body: `**[${finding.severity.toUpperCase()}] ${finding.title}**${finding.violated_rule ? `\n_Regla incumplida: ${finding.violated_rule}_` : ''}\n\n${finding.explanation}`,
        });
      }

      await gitAdapter.postSummaryComment({
        installationId: payload.installationId,
        owner: payload.owner,
        repo: payload.repo,
        pullNumber: payload.pullNumber,
        body: [
          '### DevSentinel AI Review',
          '',
          `**Resultado:** ${gateDecision.toUpperCase()}`,
          `**Quality score:** ${result.quality_score}/100`,
          `**Risk level:** ${result.risk_level}`,
          '',
          result.resumen_ejecutivo,
        ].join('\n'),
      });
    }

    const conclusion = gateDecision === 'apto' ? 'success' : gateDecision === 'requiere_revision' ? 'neutral' : 'failure';
    const title =
      gateDecision === 'apto'
        ? 'Aprobado por DevSentinel AI'
        : gateDecision === 'requiere_revision'
          ? 'Requiere revisión humana — DevSentinel AI'
          : 'Bloqueado por DevSentinel AI';

    await gitAdapter.setCheckRunStatus({
      installationId: payload.installationId,
      owner: payload.owner,
      repo: payload.repo,
      commitSha: payload.commitSha,
      conclusion,
      title,
      summary: result.resumen_ejecutivo,
    });
  }

  /** Crea/actualiza/cierra el issue de hallazgos bloqueantes del PR (o branch, sin
   * PR) — se llama siempre, no solo en no_apto, porque también debe cerrar el issue
   * cuando un push nuevo ya sale limpio. Un fallo acá no debe marcar todo el review
   * run como failed (el análisis en sí ya se publicó bien); solo se loguea. */
  private async syncFindingsIssue(
    gitAdapter: GitProviderPort,
    payload: ReviewJobPayload,
    result: ReviewResult,
    gateDecision: GateDecision,
  ): Promise<void> {
    try {
      await withTenant(payload.organizationId, async (client) => {
        const { rows } = await client.query('SELECT pull_request_id FROM review_runs WHERE id = $1', [
          payload.reviewRunId,
        ]);
        const pullRequestId: string | null = rows[0]?.pull_request_id ?? null;

        await upsertFindingsIssue(client, gitAdapter, {
          organizationId: payload.organizationId,
          repositoryId: payload.repositoryId,
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          repositoryFullName: `${payload.owner}/${payload.repo}`,
          pullRequestId,
          pullRequestNumber: payload.pullNumber ?? null,
          branch: payload.branch,
          commitSha: payload.commitSha,
          reviewRunId: payload.reviewRunId,
          reviewRun: {
            gate_decision: gateDecision,
            quality_score: result.quality_score,
            risk_level: result.risk_level,
            summary: result.resumen_ejecutivo,
          },
          trigger: 'push',
        });
      });
    } catch (err) {
      this.logger.error(
        `no se pudo sincronizar el issue de hallazgos del review run ${payload.reviewRunId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /** Crea el PR automáticamente cuando el repo tiene auto_create_pr_on_push activo y el
   * push a la rama origen es elegible: APTO, o riesgo medio con score <=70 (regla dura
   * de NO APTO sigue bloqueando siempre). Sin el flag, la creación queda solo para el
   * botón manual (PullRequestsService en apps/api). */
  private async maybeAutoCreatePullRequest(
    gitAdapter: GitProviderPort,
    payload: ReviewJobPayload,
    result: ReviewResult,
    gateDecision: GateDecision,
  ): Promise<void> {
    const eligible =
      gateDecision !== 'no_apto' &&
      (gateDecision === 'apto' || (result.risk_level === 'medium' && result.quality_score <= 70));
    if (payload.pullNumber || !eligible) return;

    const config = await this.getPushAutomationConfig(payload.organizationId, payload.repositoryId);
    if (!config.auto_create_pr_on_push || payload.branch !== config.promotion_source_branch) return;

    const existing = await gitAdapter.findOpenPullRequest({
      installationId: payload.installationId,
      owner: payload.owner,
      repo: payload.repo,
      head: payload.branch,
      base: config.promotion_target_branch,
    });
    if (existing) return;

    const { title, body } = buildPullRequestContent({
      repositoryFullName: `${payload.owner}/${payload.repo}`,
      branch: payload.branch,
      commitSha: payload.commitSha,
      reviewRun: {
        gate_decision: gateDecision,
        quality_score: result.quality_score,
        risk_level: result.risk_level,
        summary: result.resumen_ejecutivo,
      },
      findings: result.findings.map((f) => ({
        ...f,
        line_start: f.line_start ?? null,
        blocking: false,
        violated_rule: f.violated_rule ?? null,
      })),
    });

    const created = await gitAdapter.createPullRequest({
      installationId: payload.installationId,
      owner: payload.owner,
      repo: payload.repo,
      head: payload.branch,
      base: config.promotion_target_branch,
      title,
      body,
    });

    await withTenant(payload.organizationId, async (client) => {
      await client.query(
        `INSERT INTO pull_requests
           (organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, source_review_run_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, 'devsentinel')
         ON CONFLICT (repository_id, github_pr_number) DO NOTHING`,
        [
          payload.organizationId,
          payload.repositoryId,
          created.number,
          title,
          payload.branch,
          config.promotion_target_branch,
          created.authorLogin,
          payload.reviewRunId,
        ],
      );
    });

    for (const finding of result.findings) {
      if (!finding.line_start) continue;
      await gitAdapter.postReviewComment({
        installationId: payload.installationId,
        owner: payload.owner,
        repo: payload.repo,
        pullNumber: created.number,
        commitSha: payload.commitSha,
        filePath: finding.file_path,
        line: finding.line_start,
        body: `**[${finding.severity.toUpperCase()}] ${finding.title}**${finding.violated_rule ? `\n_Regla incumplida: ${finding.violated_rule}_` : ''}\n\n${finding.explanation}`,
      });
    }
  }

  /** Notifica por correo al autor de cada push analizado (activado por defecto,
   * `notify_author_on_push` por repo) y, si el commit salió APTO (score verde) y el
   * repo tiene `auto_merge_on_green` activo, intenta mergear el PR de promoción antes
   * de componer el correo — así el correo siempre refleja lo que realmente pasó, nunca
   * una promesa de merge que después falló. Un fallo acá (SMTP no configurado, merge
   * rechazado por GitHub) no debe tumbar el review run; solo se loguea. */
  private async notifyAuthorOnPush(
    gitAdapter: GitProviderPort,
    payload: ReviewJobPayload,
    result: ReviewResult,
    gateDecision: GateDecision,
  ): Promise<void> {
    if (payload.pullNumber) return; // solo pushes — un PR nativo ya tiene su propio flujo de revisión

    try {
      const config = await this.getPushAutomationConfig(payload.organizationId, payload.repositoryId);
      if (!config.notify_author_on_push) return;

      const { authorName, authorEmail, alreadyNotified } = await withTenant(payload.organizationId, async (client) => {
        const { rows } = await client.query(
          `SELECT author_name, author_email, notified_at FROM review_runs WHERE id = $1`,
          [payload.reviewRunId],
        );
        return {
          authorName: rows[0]?.author_name ?? null,
          authorEmail: rows[0]?.author_email ?? null,
          alreadyNotified: Boolean(rows[0]?.notified_at),
        };
      });
      if (!authorEmail || alreadyNotified) return;

      let mergeOutcome: 'merged' | 'failed' | null = null;
      let pullRequestUrl: string | null = null;

      const eligibleForAutoMerge =
        gateDecision === 'apto' && config.auto_merge_on_green && payload.branch === config.promotion_source_branch;
      if (eligibleForAutoMerge) {
        const pr = await gitAdapter.findOpenPullRequest({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          head: payload.branch,
          base: config.promotion_target_branch,
        });
        if (pr) {
          pullRequestUrl = `https://github.com/${payload.owner}/${payload.repo}/pull/${pr.number}`;
          try {
            const { merged } = await gitAdapter.mergePullRequest({
              installationId: payload.installationId,
              owner: payload.owner,
              repo: payload.repo,
              pullNumber: pr.number,
            });
            mergeOutcome = merged ? 'merged' : 'failed';
          } catch (err) {
            this.logger.warn(
              `auto-merge del PR #${pr.number} en ${payload.owner}/${payload.repo} falló: ${(err as Error).message}`,
            );
            mergeOutcome = 'failed';
          }
        }
      }

      const html = this.buildPushNotificationEmail({
        payload,
        result,
        gateDecision,
        authorName,
        mergeOutcome,
        pullRequestUrl,
      });

      await sendEmail(getPool(), {
        to: authorEmail,
        subject: `DevSentinel AI — ${GATE_LABEL[gateDecision]} en ${payload.branch} (${payload.commitSha.slice(0, 7)})`,
        html,
      });

      await withTenant(payload.organizationId, async (client) => {
        await client.query(`UPDATE review_runs SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`, [
          payload.reviewRunId,
        ]);
      });
    } catch (err) {
      this.logger.error(
        `no se pudo notificar/auto-mergear el review run ${payload.reviewRunId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private buildPushNotificationEmail(input: {
    payload: ReviewJobPayload;
    result: ReviewResult;
    gateDecision: GateDecision;
    authorName: string | null;
    mergeOutcome: 'merged' | 'failed' | null;
    pullRequestUrl: string | null;
  }): string {
    const { payload, result, gateDecision, authorName, mergeOutcome, pullRequestUrl } = input;
    const shortSha = payload.commitSha.slice(0, 7);
    const statusLabel = GATE_LABEL[gateDecision];

    const findingsHtml = result.findings.length
      ? `<ul>${result.findings
          .map((f) => `<li><strong>[${f.severity.toUpperCase()}] ${f.title}</strong> (${f.file_path})<br/>${f.explanation}</li>`)
          .join('')}</ul>`
      : '<p>Sin hallazgos.</p>';

    const mergeHtml =
      mergeOutcome === 'merged'
        ? `<p>✅ <strong>Se creó y mergeó automáticamente</strong> el Pull Request hacia la rama de destino.${pullRequestUrl ? ` <a href="${pullRequestUrl}">Ver PR</a>` : ''}</p>`
        : mergeOutcome === 'failed'
          ? `<p>⚠️ El commit salió APTO pero el auto-merge no se pudo completar (conflictos u otro bloqueo en GitHub) — requiere mergear a mano.${pullRequestUrl ? ` <a href="${pullRequestUrl}">Ver PR</a>` : ''}</p>`
          : '';

    const publicOrigin = process.env.PUBLIC_WEB_ORIGIN ?? '';
    const detailLink = publicOrigin
      ? `<p><a href="${publicOrigin}/review-runs/${payload.reviewRunId}">Ver detalle en DevSentinel</a></p>`
      : '';

    return [
      `<p>Hola ${authorName ?? ''},</p>`,
      `<p>DevSentinel AI analizó tu push a <strong>${payload.branch}</strong> (commit <code>${shortSha}</code>): <strong>${statusLabel}</strong>.</p>`,
      `<p>Score: ${result.quality_score}/100 — Riesgo: ${result.risk_level}</p>`,
      result.resumen_ejecutivo ? `<p>${result.resumen_ejecutivo}</p>` : '',
      findingsHtml,
      mergeHtml,
      detailLink,
    ].join('\n');
  }

  private async getPushAutomationConfig(
    organizationId: string,
    repositoryId: string,
  ): Promise<{
    auto_create_pr_on_push: boolean;
    notify_author_on_push: boolean;
    auto_merge_on_green: boolean;
    promotion_source_branch: string;
    promotion_target_branch: string;
  }> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT auto_create_pr_on_push, notify_author_on_push, auto_merge_on_green,
                COALESCE(promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(promotion_target_branch, 'main') AS promotion_target_branch
         FROM quality_gate_configs
         WHERE organization_id = $1 AND (repository_id = $2 OR repository_id IS NULL)
         ORDER BY repository_id NULLS LAST
         LIMIT 1`,
        [organizationId, repositoryId],
      );
      return (
        rows[0] ?? {
          auto_create_pr_on_push: false,
          notify_author_on_push: true,
          auto_merge_on_green: false,
          promotion_source_branch: 'staging',
          promotion_target_branch: 'main',
        }
      );
    });
  }

  private async getProjectProfile(organizationId: string, repositoryId: string): Promise<ProjectProfile | undefined> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT language, framework, framework_version, runtime, database, architecture_style,
                testing_strategy, notes, mandatory_rules, security_rules, conventions,
                migrations_policy, compatibility_notes
         FROM project_profiles
         WHERE repository_id = $1`,
        [repositoryId],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        language: row.language,
        framework: row.framework,
        frameworkVersion: row.framework_version,
        runtime: row.runtime,
        database: row.database,
        architectureStyle: row.architecture_style,
        testingStrategy: row.testing_strategy,
        notes: row.notes,
        mandatoryRules: row.mandatory_rules ?? [],
        securityRules: row.security_rules ?? [],
        conventions: row.conventions ?? [],
        migrationsPolicy: row.migrations_policy,
        compatibilityNotes: row.compatibility_notes,
      };
    });
  }

  private async getQualityGateConfig(organizationId: string, repositoryId: string): Promise<QualityGateConfig> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT min_coverage_pct, block_on_risk_level, block_on_secret
         FROM quality_gate_configs
         WHERE organization_id = $1 AND (repository_id = $2 OR repository_id IS NULL)
         ORDER BY repository_id NULLS LAST
         LIMIT 1`,
        [organizationId, repositoryId],
      );
      return rows[0] ?? DEFAULT_GATE_CONFIG;
    });
  }

  private async markFailed(payload: ReviewJobPayload, message: string): Promise<void> {
    await withTenant(payload.organizationId, async (client) => {
      await client.query(
        `UPDATE review_runs SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
        [message, payload.reviewRunId],
      );
    });
  }
}

function normalizeVerdict(resultado: string | undefined): GateDecision | null {
  switch (resultado) {
    case 'APTO':
      return 'apto';
    case 'REQUIERE_REVISION':
      return 'requiere_revision';
    case 'NO_APTO':
      return 'no_apto';
    default:
      return null;
  }
}

/** Extrae los paths de archivo tocados a partir de las cabeceras `diff --git a/x b/y`. */
function extractAnalyzedFiles(diff: string): string[] {
  const files = new Set<string>();
  const headerRegex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(diff)) !== null) {
    const path = match[2] !== '/dev/null' ? match[2] : match[1];
    if (path && path !== '/dev/null') files.add(path);
  }
  return Array.from(files);
}
