import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import {
  CLARIFICATION_QUEUE_NAME,
  PROJECT_CONTEXT_QUEUE_NAME,
  RECONSIDER_QUEUE_NAME,
  type ClarificationJobPayload,
  type ProjectContextJobPayload,
  type ReconsiderJobPayload,
} from '@devsentinel/event-contracts';
import { EmailService } from '../../common/email.service';
import { NOTIFICATION_SOUNDS, isNotificationSound } from '../notifications/sounds';

interface Actor {
  userId: string;
  role: string;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

@Injectable()
export class DashboardService {
  constructor(
    private readonly emailService: EmailService,
    @InjectQueue(RECONSIDER_QUEUE_NAME) private readonly reconsiderQueue: Queue<ReconsiderJobPayload>,
    @InjectQueue(PROJECT_CONTEXT_QUEUE_NAME) private readonly projectContextQueue: Queue<ProjectContextJobPayload>,
    @InjectQueue(CLARIFICATION_QUEUE_NAME) private readonly clarificationQueue: Queue<ClarificationJobPayload>,
  ) {}

  /** admin ve todos los repos de la org; un usuario ("user") solo los que tiene
   * asignados en repository_members. Incluye la última interacción (push/PR analizado
   * más reciente) por repo vía LATERAL, para pintar el dashboard sin N+1 requests. */
  async listRepositories(orgId: string, actor: Actor) {
    const lastActivityJoin = `
      LEFT JOIN LATERAL (
        SELECT commit_sha, branch, gate_decision, risk_level, quality_score, started_at
        FROM review_runs
        WHERE review_runs.repository_id = r.id
        ORDER BY started_at DESC
        LIMIT 1
      ) last_run ON true`;
    // Cada repo pertenece a una instalación, que pertenece a una GitHub App concreta —
    // sin este JOIN el front no puede separar la vista por App (ver GithubAppsPanel).
    const appJoin = `
      JOIN github_installations gi ON gi.id = r.github_installation_id
      LEFT JOIN github_apps ga ON ga.id = gi.github_app_id`;
    const appFields = `
      gi.account_login, ga.id AS github_app_id, ga.name AS github_app_name`;
    const lastActivityFields = `
      last_run.commit_sha AS last_commit_sha, last_run.branch AS last_branch,
      last_run.gate_decision AS last_gate_decision, last_run.risk_level AS last_risk_level,
      last_run.quality_score AS last_quality_score, last_run.started_at AS last_activity_at`;

    return withTenant(orgId, async (client) => {
      if (actor.role === 'admin') {
        const { rows } = await client.query(
          `SELECT r.id, r.full_name, r.default_branch, r.webhook_status, r.created_at, ${appFields}, ${lastActivityFields}
           FROM repositories r
           ${appJoin}
           ${lastActivityJoin}
           ORDER BY last_run.started_at DESC NULLS LAST, r.full_name`,
        );
        return rows;
      }
      const { rows } = await client.query(
        `SELECT r.id, r.full_name, r.default_branch, r.webhook_status, r.created_at, ${appFields}, ${lastActivityFields}
         FROM repositories r
         JOIN repository_members rm ON rm.repository_id = r.id
         ${appJoin}
         ${lastActivityJoin}
         WHERE rm.user_id = $1
         ORDER BY last_run.started_at DESC NULLS LAST, r.full_name`,
        [actor.userId],
      );
      return rows;
    });
  }

  private async isRepoMember(client: PoolClient, repositoryId: string, userId: string): Promise<boolean> {
    const { rows } = await client.query(
      'SELECT 1 FROM repository_members WHERE repository_id = $1 AND user_id = $2',
      [repositoryId, userId],
    );
    return rows.length > 0;
  }

  /** Usado por el controller antes de servir cualquier dato de un repo a rutas que ya
   * no son admin-only: admin pasa siempre, "user" solo si el repo está en su lista de
   * repository_members. */
  async assertRepoAccess(orgId: string, repositoryId: string, actor: Actor): Promise<void> {
    if (actor.role === 'admin') return;
    const allowed = await withTenant(orgId, (client) => this.isRepoMember(client, repositoryId, actor.userId));
    if (!allowed) throw new ForbiddenException('no tienes acceso a este repositorio');
  }

  /** Detalle mínimo de un repo — usado por el layout de pestañas del detalle de repo
   * (encabezado + barra de pestañas), sin repetir la query completa de settings. */
  async getRepository(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, full_name, default_branch, webhook_status FROM repositories WHERE id = $1`,
        [repositoryId],
      );
      if (!rows[0]) throw new NotFoundException('repository not found');
      return rows[0];
    });
  }

  async getRepositorySettings(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT COALESCE(qgc.promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(qgc.promotion_target_branch, 'main') AS promotion_target_branch,
                COALESCE(qgc.auto_create_pr_on_push, false) AS auto_create_pr_on_push,
                COALESCE(qgc.notify_author_on_push, true) AS notify_author_on_push,
                COALESCE(qgc.auto_merge_on_green, false) AS auto_merge_on_green,
                COALESCE(qgc.ignored_push_branches, ARRAY[r.default_branch]) AS ignored_push_branches,
                COALESCE(qgc.analysis_depth, 'standard') AS analysis_depth,
                COALESCE(qgc.audit_layer1, false) AS audit_layer1
         FROM repositories r
         LEFT JOIN quality_gate_configs qgc
           ON qgc.organization_id = r.organization_id AND qgc.repository_id = r.id
         WHERE r.id = $1`,
        [repositoryId],
      );
      if (!rows[0]) throw new NotFoundException('repository not found');
      return rows[0];
    });
  }

  async updateRepositorySettings(
    orgId: string,
    repositoryId: string,
    settings: {
      promotionSourceBranch?: string;
      promotionTargetBranch?: string;
      autoCreatePrOnPush?: boolean;
      notifyAuthorOnPush?: boolean;
      autoMergeOnGreen?: boolean;
      ignoredPushBranches?: string[];
      analysisDepth?: string;
      auditLayer1?: boolean;
    },
  ) {
    if (settings.auditLayer1 !== undefined && typeof settings.auditLayer1 !== 'boolean') {
      throw new BadRequestException('auditLayer1 debe ser true o false');
    }
    if (settings.analysisDepth !== undefined && settings.analysisDepth !== 'standard' && settings.analysisDepth !== 'deep') {
      throw new BadRequestException('analysisDepth debe ser "standard" o "deep"');
    }
    await withTenant(orgId, async (client) => {
      const hasChanges = [
        settings.promotionSourceBranch,
        settings.promotionTargetBranch,
        settings.autoCreatePrOnPush,
        settings.notifyAuthorOnPush,
        settings.autoMergeOnGreen,
        settings.ignoredPushBranches,
        settings.analysisDepth,
        settings.auditLayer1,
      ].some((v) => v !== undefined);
      if (hasChanges) {
        await client.query(
          `INSERT INTO quality_gate_configs
             (organization_id, repository_id, promotion_source_branch, promotion_target_branch,
              auto_create_pr_on_push, notify_author_on_push, auto_merge_on_green, ignored_push_branches, analysis_depth, audit_layer1)
           VALUES ($1, $2, COALESCE($3, 'staging'), COALESCE($4, 'main'), COALESCE($5, false), COALESCE($6, true), COALESCE($7, false), $8, COALESCE($9, 'standard'), COALESCE($10, false))
           ON CONFLICT (organization_id, repository_id) DO UPDATE
             SET promotion_source_branch = COALESCE($3, quality_gate_configs.promotion_source_branch),
                 promotion_target_branch = COALESCE($4, quality_gate_configs.promotion_target_branch),
                 auto_create_pr_on_push = COALESCE($5, quality_gate_configs.auto_create_pr_on_push),
                 notify_author_on_push = COALESCE($6, quality_gate_configs.notify_author_on_push),
                 auto_merge_on_green = COALESCE($7, quality_gate_configs.auto_merge_on_green),
                 ignored_push_branches = COALESCE($8, quality_gate_configs.ignored_push_branches),
                 analysis_depth = COALESCE($9, quality_gate_configs.analysis_depth),
                 audit_layer1 = COALESCE($10, quality_gate_configs.audit_layer1)`,
          [
            orgId,
            repositoryId,
            settings.promotionSourceBranch ?? null,
            settings.promotionTargetBranch ?? null,
            settings.autoCreatePrOnPush ?? null,
            settings.notifyAuthorOnPush ?? null,
            settings.autoMergeOnGreen ?? null,
            settings.ignoredPushBranches ?? null,
            settings.analysisDepth ?? null,
            settings.auditLayer1 ?? null,
          ],
        );
      }
    });
    return this.getRepositorySettings(orgId, repositoryId);
  }

  async listPushes(orgId: string, repositoryId: string, page: number, pageSize: number) {
    return withTenant(orgId, async (client) => {
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM review_runs WHERE repository_id = $1 AND trigger = 'push'`,
        [repositoryId],
      );
      const total = countRows[0]?.n ?? 0;

      const { rows } = await client.query(
        `SELECT rr.id, rr.commit_sha, rr.branch, rr.status, rr.quality_score, rr.risk_level,
                rr.gate_decision, rr.author_name, rr.author_email, rr.notified_at,
                rr.reviewed_at, rr.reviewed_by,
                rr.started_at, rr.completed_at,
                (SELECT count(*) FROM findings f WHERE f.review_run_id = rr.id AND f.blocking) AS blocking_count,
                (SELECT count(*)::int FROM findings f WHERE f.review_run_id = rr.id AND f.status = 'awaiting_clarification') AS questions_count,
                pr.id AS pull_request_id, pr.github_pr_number AS pr_number, pr.status AS pr_status,
                'https://github.com/' || rp.full_name || '/pull/' || pr.github_pr_number AS pr_url
         FROM review_runs rr
         JOIN repositories rp ON rp.id = rr.repository_id
         LEFT JOIN LATERAL (
           SELECT id, github_pr_number, status FROM pull_requests
           WHERE source_review_run_id = rr.id ORDER BY created_at DESC LIMIT 1
         ) pr ON true
         WHERE rr.repository_id = $1 AND rr.trigger = 'push'
         ORDER BY rr.started_at DESC
         LIMIT $2 OFFSET $3`,
        [repositoryId, pageSize, (page - 1) * pageSize],
      );
      return { items: rows, total, page, pageSize };
    });
  }

  async markReviewed(orgId: string, repositoryId: string, reviewRunId: string, userId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE review_runs SET reviewed_at = now(), reviewed_by = $1
         WHERE id = $2 AND repository_id = $3 AND trigger = 'push'
         RETURNING id, reviewed_at`,
        [userId, reviewRunId, repositoryId],
      );
      if (!rows[0]) throw new NotFoundException('review run not found');
      return rows[0];
    });
  }

  /** Encola la reconsideración con el LLM — no se llama al modelo desde `api`, esa
   * lógica vive solo en el `worker` (mismo criterio que el resto del análisis). */
  async requestFindingReconsideration(
    orgId: string,
    repositoryId: string,
    reviewRunId: string,
    findingId: string,
    comment: string,
    userId: string,
  ): Promise<{ queued: true }> {
    if (!comment?.trim()) throw new BadRequestException('el comentario no puede estar vacío');

    await withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.id FROM findings f
         JOIN review_runs rr ON rr.id = f.review_run_id
         WHERE f.id = $1 AND rr.id = $2 AND rr.repository_id = $3`,
        [findingId, reviewRunId, repositoryId],
      );
      if (!rows[0]) throw new NotFoundException('finding not found');
    });

    await this.reconsiderQueue.add(RECONSIDER_QUEUE_NAME, {
      findingId,
      reviewRunId,
      organizationId: orgId,
      repositoryId,
      comment: comment.trim(),
      requestedBy: userId,
    });

    return { queued: true };
  }

  async getProjectProfile(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT language, framework, framework_version, runtime, database, architecture_style,
                testing_strategy, notes, mandatory_rules, security_rules, conventions,
                migrations_policy, compatibility_notes, auto_generated_from
         FROM project_profiles WHERE repository_id = $1`,
        [repositoryId],
      );
      return (
        rows[0] ?? {
          language: null,
          framework: null,
          framework_version: null,
          runtime: null,
          database: null,
          architecture_style: null,
          testing_strategy: null,
          notes: null,
          mandatory_rules: [],
          security_rules: [],
          conventions: [],
          migrations_policy: null,
          compatibility_notes: null,
          auto_generated_from: null,
        }
      );
    });
  }

  /** Última corrida de "Generar contexto" del repo (null si nunca se pidió). La UI la consulta
   * cada pocos segundos mientras esté en cola o corriendo. */
  async getProjectContextRun(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, mode, status, sources, applied_fields, error_message, created_at, finished_at
         FROM project_context_runs WHERE repository_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [repositoryId],
      );
      return rows[0] ?? null;
    });
  }

  /** Encola la lectura de README / CLAUDE.md / manifiestos y la extracción del perfil con la IA.
   * Si ya hay una corrida en curso (reciente) devuelve esa en vez de apilar otra: el botón es
   * fácil de pulsar dos veces y cada corrida gasta tokens del LLM. */
  async requestProjectContext(orgId: string, userId: string, repositoryId: string, replace: boolean) {
    const STALE_AFTER_MINUTES = 10; // un worker caído no debe bloquear el botón para siempre
    const run = await withTenant(orgId, async (client) => {
      const { rows: repoRows } = await client.query('SELECT 1 FROM repositories WHERE id = $1', [repositoryId]);
      if (!repoRows[0]) throw new NotFoundException('repositorio no encontrado');

      const { rows: active } = await client.query(
        `SELECT id, mode, status, sources, applied_fields, error_message, created_at, finished_at
         FROM project_context_runs
         WHERE repository_id = $1 AND status IN ('queued', 'running')
           AND created_at > now() - make_interval(mins => $2)
         ORDER BY created_at DESC LIMIT 1`,
        [repositoryId, STALE_AFTER_MINUTES],
      );
      if (active[0]) return { row: active[0], created: false };

      const { rows } = await client.query(
        `INSERT INTO project_context_runs (organization_id, repository_id, mode, requested_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, mode, status, sources, applied_fields, error_message, created_at, finished_at`,
        [orgId, repositoryId, replace ? 'replace' : 'fill', userId],
      );
      return { row: rows[0], created: true };
    });

    if (run.created) {
      try {
        await this.projectContextQueue.add(
          PROJECT_CONTEXT_QUEUE_NAME,
          { runId: run.row.id, organizationId: orgId, repositoryId, mode: run.row.mode },
          { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
        );
      } catch (err) {
        await withTenant(orgId, (client) =>
          client.query(
            `UPDATE project_context_runs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1`,
            [run.row.id, 'no se pudo encolar la tarea (Redis no disponible)'],
          ),
        );
        throw err;
      }
    }
    return run.row;
  }

  async updateProjectProfile(
    orgId: string,
    repositoryId: string,
    profile: {
      language?: string;
      framework?: string;
      frameworkVersion?: string;
      runtime?: string;
      database?: string;
      architectureStyle?: string;
      testingStrategy?: string;
      notes?: string;
      mandatoryRules?: string[];
      securityRules?: string[];
      conventions?: string[];
      migrationsPolicy?: string;
      compatibilityNotes?: string;
    },
  ) {
    await withTenant(orgId, async (client) => {
      await client.query(
        `INSERT INTO project_profiles
           (organization_id, repository_id, language, framework, framework_version, runtime, database,
            architecture_style, testing_strategy, notes, mandatory_rules, security_rules, conventions,
            migrations_policy, compatibility_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (repository_id) DO UPDATE SET
           language = $3, framework = $4, framework_version = $5, runtime = $6, database = $7,
           architecture_style = $8, testing_strategy = $9, notes = $10, mandatory_rules = $11,
           security_rules = $12, conventions = $13, migrations_policy = $14, compatibility_notes = $15,
           auto_generated_from = NULL, updated_at = now()`,
        [
          orgId,
          repositoryId,
          profile.language ?? null,
          profile.framework ?? null,
          profile.frameworkVersion ?? null,
          profile.runtime ?? null,
          profile.database ?? null,
          profile.architectureStyle ?? null,
          profile.testingStrategy ?? null,
          profile.notes ?? null,
          profile.mandatoryRules ?? [],
          profile.securityRules ?? [],
          profile.conventions ?? [],
          profile.migrationsPolicy ?? null,
          profile.compatibilityNotes ?? null,
        ],
      );
    });
    return this.getProjectProfile(orgId, repositoryId);
  }

  async notifyReviewRun(orgId: string, repositoryId: string, reviewRunId: string): Promise<{ sent: true; to: string }> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.commit_sha, rr.branch, rr.gate_decision, rr.quality_score, rr.risk_level, rr.summary,
                rr.author_name, rr.author_email, rr.trigger
         FROM review_runs rr
         WHERE rr.id = $1 AND rr.repository_id = $2`,
        [reviewRunId, repositoryId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');
      if (run.trigger !== 'push') throw new BadRequestException('solo se pueden notificar pushes');
      if (!run.author_email) {
        throw new BadRequestException('este commit no tiene un email de autor disponible para notificar');
      }

      const { rows: findingRows } = await client.query(
        `SELECT category, severity, file_path, title, explanation, blocking
         FROM findings WHERE review_run_id = $1`,
        [reviewRunId],
      );
      const findings = findingRows.sort((a, b) => {
        if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
        return (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
      });

      const publicOrigin = process.env.PUBLIC_WEB_ORIGIN ?? '';
      const statusLabel =
        run.gate_decision === 'apto' ? '✓ APTO' : run.gate_decision === 'requiere_revision' ? '⚠ REQUIERE REVISIÓN' : '❌ NO APTO';
      const findingsHtml = findings.length
        ? `<ul>${findings
            .map(
              (f) =>
                `<li><strong>[${f.severity.toUpperCase()}${f.blocking ? ' — bloqueante' : ''}] ${f.title}</strong> (${f.file_path})<br/>${f.explanation}</li>`,
            )
            .join('')}</ul>`
        : '<p>Sin hallazgos.</p>';

      const html = [
        `<p>Hola ${run.author_name ?? ''},</p>`,
        `<p>DevSentinel AI analizó tu push a <strong>${run.branch}</strong> (commit <code>${String(run.commit_sha).slice(0, 7)}</code>): <strong>${statusLabel}</strong>.</p>`,
        `<p>Score: ${run.quality_score ?? '-'} — Riesgo: ${run.risk_level ?? '-'}</p>`,
        run.summary ? `<p>${run.summary}</p>` : '',
        findingsHtml,
        publicOrigin ? `<p><a href="${publicOrigin}/repositories/${repositoryId}">Ver detalle en DevSentinel</a></p>` : '',
      ].join('\n');

      await this.emailService.send({
        to: run.author_email,
        subject: `DevSentinel AI — ${statusLabel} en ${run.branch} (${String(run.commit_sha).slice(0, 7)})`,
        html,
      });

      await client.query('UPDATE review_runs SET notified_at = now() WHERE id = $1', [reviewRunId]);
      return { sent: true, to: run.author_email as string };
    });
  }

  async getReviewRun(orgId: string, reviewRunId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const { rows: runRows } = await client.query(
        `SELECT rr.*, r.full_name AS repository_full_name,
                pr.github_pr_number, pr.title AS pull_request_title
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE rr.id = $1`,
        [reviewRunId],
      );
      const run = runRows[0];
      if (!run) return null;
      await this.assertCanViewReviewRun(client, run, actor);

      const { rows: findingRows } = await client.query(
        `SELECT * FROM findings WHERE review_run_id = $1
         ORDER BY (CASE severity
           WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC`,
        [reviewRunId],
      );
      const { rows: clarificationRows } = await client.query(
        `SELECT fc.id, fc.finding_id, fc.role, fc.body, fc.author_login, fc.source, fc.created_at
         FROM finding_clarifications fc JOIN findings f ON f.id = fc.finding_id
         WHERE f.review_run_id = $1 ORDER BY fc.created_at, fc.id`,
        [reviewRunId],
      );
      // Capa 1 de la auditoría (si estaba activa en esta revisión): qué escáneres corrieron y qué reportaron.
      const { rows: scannerRuns } = await client.query(
        `SELECT tool, status, mandatory, reason, scanner_version, image_digest, ruleset, ruleset_pinned, duration_ms, error, findings_count
         FROM scanner_runs WHERE review_run_id = $1 ORDER BY tool`,
        [reviewRunId],
      );
      const { rows: scanFindings } = await client.query(
        `SELECT id, tool, sources, rule_id, severity, category, file_path, line_start, line_end, title, message, evidence, vuln_id, cwe,
                package_name, installed_version, fixed_version, baseline_status, validation_status
         FROM scan_findings WHERE review_run_id = $1
         ORDER BY (CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC,
                  (baseline_status = 'new') DESC, file_path, line_start LIMIT 500`,
        [reviewRunId],
      );
      return { ...run, findings: findingRows, clarifications: clarificationRows, scanner_runs: scannerRuns, scan_findings: scanFindings };
    });
  }

  async getReviewRunDiff(orgId: string, reviewRunId: string, actor: Actor): Promise<string> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.repository_id, rr.developer_id, rr.commit_sha, r.full_name, gi.installation_id, pr.github_pr_number
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE rr.id = $1`,
        [reviewRunId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');
      await this.assertCanViewReviewRun(client, run, actor);

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);
      const adapter = await buildGithubAdapterForInstallation(client, installationId);

      return run.github_pr_number
        ? adapter.getPullRequestDiff({ installationId, owner, repo, pullNumber: run.github_pr_number })
        : adapter.getCommitDiff({ installationId, owner, repo, commitSha: run.commit_sha });
    });
  }

  /** admin ve cualquier review run de la org; un usuario ("user") solo los de un repo
   * que tenga asignado en repository_members. */
  /** Responder una pregunta de la IA: un admin, el desarrollador autor del commit (su cuenta vinculada) o quien tenga el repo asignado. */
  private async assertCanAnswerClarification(
    client: PoolClient,
    run: { repository_id: string; developer_id: string | null },
    actor: Actor,
  ): Promise<void> {
    if (actor.role === 'admin') return;
    if (run.developer_id) {
      const { rows } = await client.query('SELECT 1 FROM developers WHERE id = $1 AND user_id = $2', [run.developer_id, actor.userId]);
      if (rows.length > 0) return;
    }
    if (await this.isRepoMember(client, run.repository_id, actor.userId)) return;
    throw new ForbiddenException('no tienes acceso a este hallazgo');
  }

  private async loadAwaitingFinding(client: PoolClient, findingId: string) {
    const { rows } = await client.query(
      `SELECT f.id, f.status, f.review_run_id, rr.repository_id, rr.developer_id
       FROM findings f JOIN review_runs rr ON rr.id = f.review_run_id
       WHERE f.id = $1 FOR UPDATE OF f`,
      [findingId],
    );
    if (!rows[0]) throw new NotFoundException('hallazgo no encontrado');
    if (rows[0].status !== 'awaiting_clarification') {
      throw new ConflictException('este hallazgo ya no está pendiente de aclaración (la IA o un administrador ya lo resolvió)');
    }
    return rows[0] as { id: string; review_run_id: string; repository_id: string; developer_id: string | null };
  }

  /** El desarrollador responde la pregunta de la IA: queda en la conversación y se encola la re-evaluación. */
  async answerClarification(orgId: string, findingId: string, actor: Actor, text: unknown) {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) throw new BadRequestException('escribe tu respuesta');
    if (body.length > 4000) throw new BadRequestException('la respuesta es demasiado larga (máximo 4000 caracteres)');

    const created = await withTenant(orgId, async (client) => {
      const finding = await this.loadAwaitingFinding(client, findingId);
      await this.assertCanAnswerClarification(client, finding, actor);
      const { rows: userRows } = await client.query('SELECT name, email FROM users WHERE id = $1', [actor.userId]);
      const author = userRows[0]?.name ?? userRows[0]?.email ?? null;
      const { rows } = await client.query(
        `INSERT INTO finding_clarifications (organization_id, finding_id, role, body, author_login, posted_by, source)
         VALUES ($1, $2, 'developer', $3, $4, $5, 'platform')
         RETURNING id, finding_id, role, body, author_login, source, created_at`,
        [orgId, findingId, body, author, actor.userId],
      );
      // Si ya estaba escalado a una persona, una respuesta nueva vuelve a ponerlo en manos de la IA.
      await client.query('UPDATE findings SET needs_human = false WHERE id = $1', [findingId]);
      return { clarification: rows[0], repositoryId: finding.repository_id, reviewRunId: finding.review_run_id };
    });

    await this.clarificationQueue.add(
      CLARIFICATION_QUEUE_NAME,
      { organizationId: orgId, repositoryId: created.repositoryId, reviewRunId: created.reviewRunId, findingId, kind: 'reply' },
      { attempts: 3, backoff: { type: 'exponential', delay: 20_000 }, removeOnComplete: true, removeOnFail: 50, jobId: `clar-${created.clarification.id}` },
    );
    return created.clarification;
  }

  /** Un admin decide a mano (sin pasar por la IA): confirmar el hallazgo como bloqueante o descartarlo. */
  async decideClarification(orgId: string, findingId: string, userId: string, decision: unknown, comment: unknown) {
    if (decision !== 'confirm' && decision !== 'dismiss') throw new BadRequestException('decision debe ser "confirm" o "dismiss"');
    const note = typeof comment === 'string' ? comment.trim().slice(0, 2000) : '';
    const ids = await withTenant(orgId, async (client) => {
      const finding = await this.loadAwaitingFinding(client, findingId);
      return { repositoryId: finding.repository_id, reviewRunId: finding.review_run_id };
    });
    await this.clarificationQueue.add(
      CLARIFICATION_QUEUE_NAME,
      {
        organizationId: orgId,
        repositoryId: ids.repositoryId,
        reviewRunId: ids.reviewRunId,
        findingId,
        kind: 'manual',
        manual: { decision, userId, comment: note || undefined },
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 50 },
    );
    return { queued: true };
  }

  /** Un admin ve todo; un usuario, los repos que tiene asignados y los análisis de SUS commits (el desarrollador vinculado a su
   * cuenta: es quien recibe el aviso del análisis y debe poder abrirlo y responder las preguntas de la IA). */
  private async assertCanViewReviewRun(client: PoolClient, run: { repository_id: string; developer_id?: string | null }, actor: Actor): Promise<void> {
    if (actor.role === 'admin') return;
    if (await this.isRepoMember(client, run.repository_id, actor.userId)) return;
    if (run.developer_id) {
      const { rows } = await client.query('SELECT 1 FROM developers WHERE id = $1 AND user_id = $2', [run.developer_id, actor.userId]);
      if (rows.length > 0) return;
    }
    throw new ForbiddenException('no tienes acceso a este review run');
  }

  async getMyProfile(orgId: string, userId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id AS developer_id, d.github_login, d.email, d.display_name,
                d.notification_sound, d.notification_muted,
                count(rr.id) AS total_reviews,
                count(*) FILTER (WHERE rr.gate_decision = 'apto') AS apto_count,
                count(*) FILTER (WHERE rr.gate_decision = 'no_apto') AS no_apto_count,
                round(avg(rr.quality_score)) AS avg_quality_score
         FROM developers d
         LEFT JOIN review_runs rr ON rr.developer_id = d.id
         WHERE d.user_id = $1 AND d.organization_id = $2
         GROUP BY d.id`,
        [userId, orgId],
      );
      return (
        rows[0] ?? {
          developer_id: null,
          notification_sound: null,
          notification_muted: false,
          github_login: null,
          email: null,
          display_name: null,
          total_reviews: 0,
          apto_count: 0,
          no_apto_count: 0,
          avg_quality_score: null,
        }
      );
    });
  }

  async getMyReviews(orgId: string, userId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.id, rr.repository_id, r.full_name, rr.branch, rr.commit_sha, rr.trigger,
                rr.gate_decision, rr.risk_level, rr.quality_score, rr.notified_at, rr.started_at,
                pr.github_pr_number, pr.title AS pull_request_title
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN developers d ON d.id = rr.developer_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE d.user_id = $1 AND rr.organization_id = $2
         ORDER BY rr.started_at DESC
         LIMIT 100`,
        [userId, orgId],
      );
      return rows;
    });
  }

  async listDevelopers(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.github_login, d.email, d.display_name,
                d.user_id, u.email AS user_email, u.name AS user_name,
                d.notification_sound, d.notification_volume::float AS notification_volume, d.notification_muted,
                count(rr.id) AS total_reviews,
                count(*) FILTER (WHERE rr.gate_decision = 'apto') AS apto_count,
                count(*) FILTER (WHERE rr.gate_decision = 'no_apto') AS no_apto_count,
                round(avg(rr.quality_score)) AS avg_quality_score,
                coalesce((
                  SELECT count(*) FROM findings f
                  JOIN review_runs rr2 ON rr2.id = f.review_run_id
                  WHERE rr2.developer_id = d.id AND f.blocking
                ), 0) AS blocking_findings_total
         FROM developers d
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN review_runs rr ON rr.developer_id = d.id
         WHERE d.organization_id = $1
         GROUP BY d.id, u.id
         ORDER BY total_reviews DESC`,
        [orgId],
      );
      return rows;
    });
  }

  /** Tono, volumen y silencio del aviso sonoro de un desarrollador (lo configura el admin). */
  async updateDeveloperNotification(
    orgId: string,
    developerId: string,
    input: { sound?: string | null; volume?: number; muted?: boolean },
  ) {
    if (input.sound !== undefined && input.sound !== null && !isNotificationSound(input.sound)) {
      throw new BadRequestException(`sound debe ser uno de: ${NOTIFICATION_SOUNDS.map((s) => s.id).join(', ')} (o null para el tono por defecto)`);
    }
    if (input.volume !== undefined && !(typeof input.volume === 'number' && input.volume >= 0 && input.volume <= 1)) {
      throw new BadRequestException('volume debe ser un número entre 0 y 1');
    }
    if (input.muted !== undefined && typeof input.muted !== 'boolean') throw new BadRequestException('muted debe ser true o false');

    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE developers SET
           notification_sound = CASE WHEN $2::boolean THEN $3 ELSE notification_sound END,
           notification_volume = COALESCE($4, notification_volume),
           notification_muted = COALESCE($5, notification_muted)
         WHERE id = $1
         RETURNING id, notification_sound, notification_volume::float AS notification_volume, notification_muted`,
        [developerId, input.sound !== undefined, input.sound ?? null, input.volume ?? null, input.muted ?? null],
      );
      if (!rows[0]) throw new NotFoundException('developer no encontrado');
      return rows[0];
    });
  }

  async listConnectedAccounts(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT gi.id, gi.installation_id, gi.account_login, gi.status, gi.created_at,
                count(r.id) AS repository_count
         FROM github_installations gi
         LEFT JOIN repositories r ON r.github_installation_id = gi.id
         WHERE gi.organization_id = $1
         GROUP BY gi.id
         ORDER BY gi.created_at`,
        [orgId],
      );
      return rows;
    });
  }

  async getOverview(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows: repositories } = await client.query(
        `SELECT id, full_name FROM repositories ORDER BY full_name`,
      );
      const { rows: pendingPushes } = await client.query(
        `SELECT rr.id, rr.repository_id, r.full_name, rr.branch, rr.commit_sha,
                rr.gate_decision, rr.risk_level, rr.quality_score, rr.started_at
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         WHERE rr.trigger = 'push' AND rr.status = 'completed' AND rr.reviewed_at IS NULL
         ORDER BY rr.started_at DESC
         LIMIT 30`,
      );
      return { repositories, pendingPushes };
    });
  }
}
