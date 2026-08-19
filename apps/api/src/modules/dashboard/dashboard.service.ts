import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';
import { EmailService } from '../../common/email.service';

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

@Injectable()
export class DashboardService {
  private readonly adapter: GithubAdapter;

  constructor(private readonly emailService: EmailService) {
    this.adapter = new GithubAdapter({
      appId: process.env.GITHUB_APP_ID ?? '',
      privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? '',
    });
  }

  async listRepositories(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, full_name, default_branch, webhook_status, monitored_branches, created_at
         FROM repositories
         ORDER BY full_name`,
      );
      return rows;
    });
  }

  async getRepositorySettings(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.monitored_branches,
                COALESCE(qgc.promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(qgc.promotion_target_branch, 'main') AS promotion_target_branch
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
    settings: { monitoredBranches?: string[]; promotionSourceBranch?: string; promotionTargetBranch?: string },
  ) {
    await withTenant(orgId, async (client) => {
      if (settings.monitoredBranches) {
        await client.query('UPDATE repositories SET monitored_branches = $1 WHERE id = $2', [
          settings.monitoredBranches,
          repositoryId,
        ]);
      }
      if (settings.promotionSourceBranch || settings.promotionTargetBranch) {
        await client.query(
          `INSERT INTO quality_gate_configs (organization_id, repository_id, promotion_source_branch, promotion_target_branch)
           VALUES ($1, $2, COALESCE($3, 'staging'), COALESCE($4, 'main'))
           ON CONFLICT (organization_id, repository_id) DO UPDATE
             SET promotion_source_branch = COALESCE($3, quality_gate_configs.promotion_source_branch),
                 promotion_target_branch = COALESCE($4, quality_gate_configs.promotion_target_branch)`,
          [orgId, repositoryId, settings.promotionSourceBranch ?? null, settings.promotionTargetBranch ?? null],
        );
      }
    });
    return this.getRepositorySettings(orgId, repositoryId);
  }

  async listPullRequests(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT pr.id, pr.github_pr_number, pr.title, pr.status, pr.author_login,
                pr.source_branch, pr.target_branch,
                rr.id AS review_run_id, rr.quality_score, rr.risk_level, rr.status AS review_status
         FROM pull_requests pr
         LEFT JOIN LATERAL (
           SELECT id, quality_score, risk_level, status
           FROM review_runs
           WHERE review_runs.pull_request_id = pr.id
           ORDER BY started_at DESC
           LIMIT 1
         ) rr ON true
         WHERE pr.repository_id = $1
         ORDER BY pr.created_at DESC`,
        [repositoryId],
      );
      return rows;
    });
  }

  async listPushes(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.id, rr.commit_sha, rr.branch, rr.status, rr.quality_score, rr.risk_level,
                rr.gate_decision, rr.author_name, rr.author_email, rr.notified_at,
                rr.started_at, rr.completed_at,
                (SELECT count(*) FROM findings f WHERE f.review_run_id = rr.id AND f.blocking) AS blocking_count,
                p.id AS promotion_id, p.status AS promotion_status
         FROM review_runs rr
         LEFT JOIN promotions p ON p.review_run_id = rr.id
         WHERE rr.repository_id = $1 AND rr.trigger = 'push'
         ORDER BY rr.started_at DESC
         LIMIT 50`,
        [repositoryId],
      );
      return rows;
    });
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

  async listPromotions(orgId: string, repositoryId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, source_branch, target_branch, commit_sha, status, notes, requested_at, decided_at
         FROM promotions
         WHERE repository_id = $1
         ORDER BY requested_at DESC
         LIMIT 50`,
        [repositoryId],
      );
      return rows;
    });
  }

  async requestPromotion(orgId: string, repositoryId: string, reviewRunId: string, userId: string) {
    return withTenant(orgId, async (client) => {
      const { rows: runRows } = await client.query(
        `SELECT rr.commit_sha, rr.branch, rr.gate_decision, rr.trigger,
                COALESCE(qgc.promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(qgc.promotion_target_branch, 'main') AS promotion_target_branch
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         LEFT JOIN quality_gate_configs qgc ON qgc.organization_id = r.organization_id AND qgc.repository_id = r.id
         WHERE rr.id = $1 AND rr.repository_id = $2`,
        [reviewRunId, repositoryId],
      );
      const run = runRows[0];
      if (!run) throw new NotFoundException('review run not found');
      if (run.trigger !== 'push') throw new BadRequestException('only pushes can be promoted');
      if (run.gate_decision !== 'apto') throw new BadRequestException('quality gate did not pass for this commit');
      if (run.branch !== run.promotion_source_branch) {
        throw new BadRequestException(`only pushes to ${run.promotion_source_branch} can be promoted`);
      }

      const { rows } = await client.query(
        `INSERT INTO promotions
           (organization_id, repository_id, review_run_id, source_branch, target_branch, commit_sha, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (repository_id, commit_sha) DO NOTHING
         RETURNING id, status`,
        [orgId, repositoryId, reviewRunId, run.branch, run.promotion_target_branch, run.commit_sha, userId],
      );
      if (!rows[0]) throw new BadRequestException('a promotion for this commit already exists');
      return rows[0];
    });
  }

  async decidePromotion(
    orgId: string,
    promotionId: string,
    userId: string,
    decision: 'approved' | 'rejected',
    notes?: string,
  ) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.source_branch, p.target_branch, p.status, r.full_name, gi.installation_id
         FROM promotions p
         JOIN repositories r ON r.id = p.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         WHERE p.id = $1`,
        [promotionId],
      );
      const promotion = rows[0];
      if (!promotion) throw new NotFoundException('promotion not found');
      if (promotion.status !== 'pending') throw new BadRequestException(`promotion is already ${promotion.status}`);

      if (decision === 'approved') {
        const [owner, repo] = String(promotion.full_name).split('/');
        const result = await this.adapter.mergeBranch({
          installationId: Number(promotion.installation_id),
          owner,
          repo,
          base: promotion.target_branch,
          head: promotion.source_branch,
        });
        if (result.conflict) {
          throw new BadRequestException(
            `merge conflict promoting ${promotion.source_branch} -> ${promotion.target_branch}; resuélvelo manualmente en GitHub y reintenta`,
          );
        }
      }

      await client.query(
        `UPDATE promotions SET status = $1, decided_by = $2, notes = $3, decided_at = now() WHERE id = $4`,
        [decision, userId, notes ?? null, promotionId],
      );
      return { status: decision };
    });
  }

  async mergePullRequest(orgId: string, repositoryId: string, pullRequestId: string): Promise<{ merged: boolean }> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT pr.github_pr_number, pr.status, r.full_name, gi.installation_id
         FROM pull_requests pr
         JOIN repositories r ON r.id = pr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         WHERE pr.id = $1 AND pr.repository_id = $2`,
        [pullRequestId, repositoryId],
      );
      const pr = rows[0];
      if (!pr) throw new NotFoundException('pull request not found');
      if (pr.status !== 'open') throw new BadRequestException(`pull request is already ${pr.status}`);

      const [owner, repo] = String(pr.full_name).split('/');
      await this.adapter.mergePullRequest({
        installationId: Number(pr.installation_id),
        owner,
        repo,
        pullNumber: pr.github_pr_number,
      });

      await client.query(`UPDATE pull_requests SET status = 'merged', merged_at = now() WHERE id = $1`, [
        pullRequestId,
      ]);
      return { merged: true };
    });
  }

  async getReviewRun(orgId: string, reviewRunId: string) {
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
      if (!runRows[0]) return null;

      const { rows: findingRows } = await client.query(
        `SELECT * FROM findings WHERE review_run_id = $1
         ORDER BY (CASE severity
           WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC`,
        [reviewRunId],
      );
      return { ...runRows[0], findings: findingRows };
    });
  }

  async getReviewRunDiff(orgId: string, reviewRunId: string): Promise<string> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.commit_sha, r.full_name, gi.installation_id, pr.github_pr_number
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE rr.id = $1`,
        [reviewRunId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);

      return run.github_pr_number
        ? this.adapter.getPullRequestDiff({ installationId, owner, repo, pullNumber: run.github_pr_number })
        : this.adapter.getCommitDiff({ installationId, owner, repo, commitSha: run.commit_sha });
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
         LEFT JOIN promotions p ON p.review_run_id = rr.id
         WHERE rr.trigger = 'push' AND rr.status = 'completed'
           AND p.id IS NULL AND rr.notified_at IS NULL
         ORDER BY rr.started_at DESC
         LIMIT 30`,
      );
      return { repositories, pendingPushes };
    });
  }
}
