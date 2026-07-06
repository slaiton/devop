import { Injectable } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';

@Injectable()
export class DashboardService {
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
