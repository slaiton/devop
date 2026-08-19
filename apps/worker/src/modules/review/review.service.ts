import { Inject, Injectable } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import type { GitProviderPort } from '@devsentinel/git-providers';
import type { LlmPort, ProjectProfile, ReviewResult } from '@devsentinel/llm-port';
import type { ReviewJobPayload } from '@devsentinel/event-contracts';
import { RepoCheckoutService } from './repoCheckout.service';
import { StaticAnalysisService } from './staticAnalysis.service';
import { RagContextService } from './ragContext.service';
import { GIT_PROVIDER_PORT, LLM_PORT } from './tokens';

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

// Categorías donde un finding critical fuerza NO APTO sin importar el score o lo que
// sugiera el LLM — regla dura determinista, no a discreción del modelo.
const HARD_BLOCK_CATEGORIES = new Set(['security', 'architecture', 'database', 'regression']);

@Injectable()
export class ReviewService {
  constructor(
    @Inject(GIT_PROVIDER_PORT) private readonly gitAdapter: GitProviderPort,
    @Inject(LLM_PORT) private readonly llm: LlmPort,
    private readonly checkout: RepoCheckoutService,
    private readonly staticAnalysis: StaticAnalysisService,
    private readonly ragContext: RagContextService,
  ) {}

  async runReview(payload: ReviewJobPayload): Promise<void> {
    try {
      const diff = payload.pullNumber
        ? await this.gitAdapter.getPullRequestDiff({
            installationId: payload.installationId,
            owner: payload.owner,
            repo: payload.repo,
            pullNumber: payload.pullNumber,
          })
        : await this.gitAdapter.getCommitDiff({
            installationId: payload.installationId,
            owner: payload.owner,
            repo: payload.repo,
            commitSha: payload.commitSha,
          });

      const analyzedFiles = extractAnalyzedFiles(diff);

      const installationToken = await this.gitAdapter.getInstallationToken(payload.installationId);

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
        this.gitAdapter.getRecentCommits({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          commitSha: payload.commitSha,
        }),
      ]);

      const result = await this.llm.reviewDiff({
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
      await this.publishToGithub(payload, result, gateDecision);
    } catch (err) {
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

  private async publishToGithub(payload: ReviewJobPayload, result: ReviewResult, gateDecision: GateDecision): Promise<void> {
    if (payload.pullNumber) {
      for (const finding of result.findings) {
        if (!finding.line_start) continue;
        await this.gitAdapter.postReviewComment({
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

      await this.gitAdapter.postSummaryComment({
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

    await this.gitAdapter.setCheckRunStatus({
      installationId: payload.installationId,
      owner: payload.owner,
      repo: payload.repo,
      commitSha: payload.commitSha,
      conclusion,
      title,
      summary: result.resumen_ejecutivo,
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
