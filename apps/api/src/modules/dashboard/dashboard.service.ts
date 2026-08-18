import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';

@Injectable()
export class DashboardService {
  private readonly adapter: GithubAdapter;

  constructor() {
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
                rr.quality_score, rr.risk_level, rr.status AS review_status
         FROM pull_requests pr
         LEFT JOIN LATERAL (
           SELECT quality_score, risk_level, status
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
                rr.gate_decision, rr.started_at, rr.completed_at,
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
      const { rows: runRows } = await client.query('SELECT * FROM review_runs WHERE id = $1', [reviewRunId]);
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
}
