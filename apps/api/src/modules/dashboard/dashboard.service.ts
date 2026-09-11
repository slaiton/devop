import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { getPool, withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';
import { getSystemSettings } from '@devsentinel/settings';
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

  private async getAdapter(): Promise<GithubAdapter> {
    const settings = await getSystemSettings(getPool());
    return new GithubAdapter({
      appId: settings?.githubAppId ?? '',
      privateKey: (settings?.githubAppPrivateKey ?? '').replace(/\\n/g, '\n'),
      webhookSecret: settings?.githubAppWebhookSecret ?? '',
    });
  }

  async listRepositories(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, full_name, default_branch, webhook_status, created_at
         FROM repositories
         ORDER BY full_name`,
      );
      return rows;
    });
  }

  async getRepositorySettings(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT COALESCE(qgc.promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(qgc.promotion_target_branch, 'main') AS promotion_target_branch,
                COALESCE(qgc.auto_create_pr_on_push, false) AS auto_create_pr_on_push
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
    },
  ) {
    await withTenant(orgId, async (client) => {
      if (settings.promotionSourceBranch || settings.promotionTargetBranch || settings.autoCreatePrOnPush !== undefined) {
        await client.query(
          `INSERT INTO quality_gate_configs (organization_id, repository_id, promotion_source_branch, promotion_target_branch, auto_create_pr_on_push)
           VALUES ($1, $2, COALESCE($3, 'staging'), COALESCE($4, 'main'), COALESCE($5, false))
           ON CONFLICT (organization_id, repository_id) DO UPDATE
             SET promotion_source_branch = COALESCE($3, quality_gate_configs.promotion_source_branch),
                 promotion_target_branch = COALESCE($4, quality_gate_configs.promotion_target_branch),
                 auto_create_pr_on_push = COALESCE($5, quality_gate_configs.auto_create_pr_on_push)`,
          [
            orgId,
            repositoryId,
            settings.promotionSourceBranch ?? null,
            settings.promotionTargetBranch ?? null,
            settings.autoCreatePrOnPush ?? null,
          ],
        );
      }
    });
    return this.getRepositorySettings(orgId, repositoryId);
  }

  async listPushes(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.id, rr.commit_sha, rr.branch, rr.status, rr.quality_score, rr.risk_level,
                rr.gate_decision, rr.author_name, rr.author_email, rr.notified_at,
                rr.reviewed_at, rr.reviewed_by,
                rr.started_at, rr.completed_at,
                (SELECT count(*) FROM findings f WHERE f.review_run_id = rr.id AND f.blocking) AS blocking_count
         FROM review_runs rr
         WHERE rr.repository_id = $1 AND rr.trigger = 'push'
         ORDER BY rr.started_at DESC
         LIMIT 50`,
        [repositoryId],
      );
      return rows;
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
                pr.github_pr_number, pr.title AS pull_request_title,
                d.user_id AS developer_user_id
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         LEFT JOIN developers d ON d.id = rr.developer_id
         WHERE rr.id = $1`,
        [reviewRunId],
      );
      if (!runRows[0]) return null;
      this.assertCanViewReviewRun(runRows[0], actor);

      const { rows: findingRows } = await client.query(
        `SELECT * FROM findings WHERE review_run_id = $1
         ORDER BY (CASE severity
           WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC`,
        [reviewRunId],
      );
      const { developer_user_id, ...run } = runRows[0];
      return { ...run, findings: findingRows };
    });
  }

  async getReviewRunDiff(orgId: string, reviewRunId: string, actor: Actor): Promise<string> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.commit_sha, r.full_name, gi.installation_id, pr.github_pr_number,
                d.user_id AS developer_user_id
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         LEFT JOIN developers d ON d.id = rr.developer_id
         WHERE rr.id = $1`,
        [reviewRunId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');
      this.assertCanViewReviewRun(run, actor);

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);
      const adapter = await this.getAdapter();

      return run.github_pr_number
        ? adapter.getPullRequestDiff({ installationId, owner, repo, pullNumber: run.github_pr_number })
        : adapter.getCommitDiff({ installationId, owner, repo, commitSha: run.commit_sha });
    });
  }

  /** admin ve cualquier review run de la org; un usuario ("developer") solo el suyo,
   * resuelto vía developers.user_id enlazado al loguearse. */
  private assertCanViewReviewRun(run: { developer_user_id: string | null }, actor: Actor): void {
    if (actor.role === 'admin') return;
    if (run.developer_user_id && run.developer_user_id === actor.userId) return;
    throw new ForbiddenException('no tienes acceso a este review run');
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

  async listTeam(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT om.role, u.id AS user_id, u.name, u.email, u.avatar_url, om.created_at
         FROM org_memberships om
         JOIN users u ON u.id = om.user_id
         WHERE om.organization_id = $1
         ORDER BY om.created_at`,
        [orgId],
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
