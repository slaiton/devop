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
        `SELECT id, full_name, default_branch, webhook_status, created_at
         FROM repositories
         ORDER BY full_name`,
      );
      return rows;
    });
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
        `SELECT id, commit_sha, status, quality_score, risk_level, started_at, completed_at
         FROM review_runs
         WHERE repository_id = $1 AND trigger = 'push'
         ORDER BY started_at DESC
         LIMIT 50`,
        [repositoryId],
      );
      return rows;
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
