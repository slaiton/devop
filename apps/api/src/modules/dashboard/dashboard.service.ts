import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import { RECONSIDER_QUEUE_NAME, type ReconsiderJobPayload } from '@devsentinel/event-contracts';
import { EmailService } from '../../common/email.service';

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
                COALESCE(qgc.auto_merge_on_green, false) AS auto_merge_on_green
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
    },
  ) {
    await withTenant(orgId, async (client) => {
      const hasChanges = [
        settings.promotionSourceBranch,
        settings.promotionTargetBranch,
        settings.autoCreatePrOnPush,
        settings.notifyAuthorOnPush,
        settings.autoMergeOnGreen,
      ].some((v) => v !== undefined);
      if (hasChanges) {
        await client.query(
          `INSERT INTO quality_gate_configs
             (organization_id, repository_id, promotion_source_branch, promotion_target_branch,
              auto_create_pr_on_push, notify_author_on_push, auto_merge_on_green)
           VALUES ($1, $2, COALESCE($3, 'staging'), COALESCE($4, 'main'), COALESCE($5, false), COALESCE($6, true), COALESCE($7, false))
           ON CONFLICT (organization_id, repository_id) DO UPDATE
             SET promotion_source_branch = COALESCE($3, quality_gate_configs.promotion_source_branch),
                 promotion_target_branch = COALESCE($4, quality_gate_configs.promotion_target_branch),
                 auto_create_pr_on_push = COALESCE($5, quality_gate_configs.auto_create_pr_on_push),
                 notify_author_on_push = COALESCE($6, quality_gate_configs.notify_author_on_push),
                 auto_merge_on_green = COALESCE($7, quality_gate_configs.auto_merge_on_green)`,
          [
            orgId,
            repositoryId,
            settings.promotionSourceBranch ?? null,
            settings.promotionTargetBranch ?? null,
            settings.autoCreatePrOnPush ?? null,
            settings.notifyAuthorOnPush ?? null,
            settings.autoMergeOnGreen ?? null,
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
                (SELECT count(*) FROM findings f WHERE f.review_run_id = rr.id AND f.blocking) AS blocking_count
         FROM review_runs rr
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
                migrations_policy, compatibility_notes
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
        }
      );
    });
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
           updated_at = now()`,
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
      return { ...run, findings: findingRows };
    });
  }

  async getReviewRunDiff(orgId: string, reviewRunId: string, actor: Actor): Promise<string> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.repository_id, rr.commit_sha, r.full_name, gi.installation_id, pr.github_pr_number
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
  private async assertCanViewReviewRun(client: PoolClient, run: { repository_id: string }, actor: Actor): Promise<void> {
    if (actor.role === 'admin') return;
    const allowed = await this.isRepoMember(client, run.repository_id, actor.userId);
    if (!allowed) throw new ForbiddenException('no tienes acceso a este review run');
  }

  async getMyProfile(orgId: string, userId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id AS developer_id, d.github_login, d.email, d.display_name,
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
         LEFT JOIN review_runs rr ON rr.developer_id = d.id
         WHERE d.organization_id = $1
         GROUP BY d.id
         ORDER BY total_reviews DESC`,
        [orgId],
      );
      return rows;
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
