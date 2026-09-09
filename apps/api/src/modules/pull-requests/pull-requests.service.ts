import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';
import { buildPullRequestContent } from '@devsentinel/pr-content';

interface Actor {
  userId: string;
  role: string;
}

@Injectable()
export class PullRequestsService {
  private readonly adapter: GithubAdapter;

  constructor() {
    this.adapter = new GithubAdapter({
      appId: process.env.GITHUB_APP_ID ?? '',
      privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? '',
    });
  }

  async createFromPush(orgId: string, repositoryId: string, reviewRunId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.commit_sha, rr.branch, rr.trigger, rr.status, rr.gate_decision, rr.quality_score,
                rr.risk_level, rr.summary,
                r.full_name, gi.installation_id,
                COALESCE(qgc.promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(qgc.promotion_target_branch, 'main') AS promotion_target_branch
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN quality_gate_configs qgc ON qgc.organization_id = r.organization_id AND qgc.repository_id = r.id
         WHERE rr.id = $1 AND rr.repository_id = $2`,
        [reviewRunId, repositoryId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');
      if (run.trigger !== 'push') throw new BadRequestException('solo se pueden crear PRs a partir de un push');
      if (run.status !== 'completed') throw new BadRequestException('el análisis de este push todavía no terminó');

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);
      const base = run.promotion_target_branch;

      const { rows: findingRows } = await client.query(
        `SELECT category, severity, file_path, line_start, title, explanation, blocking, violated_rule
         FROM findings WHERE review_run_id = $1`,
        [reviewRunId],
      );

      const { title, body } = buildPullRequestContent({
        repositoryFullName: run.full_name,
        branch: run.branch,
        commitSha: run.commit_sha,
        reviewRun: run,
        findings: findingRows,
      });

      const existing = await this.adapter.findOpenPullRequest({ installationId, owner, repo, head: run.branch, base });

      let prNumber: number;
      let authorLogin: string;
      const skipComments = Boolean(existing); // ya existía en GitHub — no volver a comentar los hallazgos.

      if (existing) {
        prNumber = existing.number;
        authorLogin = 'unknown';
      } else {
        const created = await this.adapter.createPullRequest({ installationId, owner, repo, head: run.branch, base, title, body });
        prNumber = created.number;
        authorLogin = created.authorLogin;
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO pull_requests
           (organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, source_review_run_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, 'devsentinel')
         ON CONFLICT (repository_id, github_pr_number) DO UPDATE
           SET source_review_run_id = $8, created_by = 'devsentinel'
         RETURNING *`,
        [orgId, repositoryId, prNumber, title, run.branch, base, authorLogin, reviewRunId],
      );

      if (!skipComments) {
        for (const finding of findingRows) {
          if (!finding.line_start) continue;
          await this.adapter.postReviewComment({
            installationId,
            owner,
            repo,
            pullNumber: prNumber,
            commitSha: run.commit_sha,
            filePath: finding.file_path,
            line: finding.line_start,
            body: `**[${finding.severity.toUpperCase()}] ${finding.title}**${finding.violated_rule ? `\n_Regla incumplida: ${finding.violated_rule}_` : ''}\n\n${finding.explanation}`,
          });
        }
      }

      return inserted[0];
    });
  }

  async listForRepository(orgId: string, repositoryId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT pr.*, ${this.ownerUserIdSelect()}
         FROM pull_requests pr
         LEFT JOIN review_runs rr ON rr.id = pr.source_review_run_id
         LEFT JOIN developers rr_dev ON rr_dev.id = rr.developer_id
         LEFT JOIN developers login_dev ON login_dev.organization_id = pr.organization_id AND login_dev.github_login = pr.author_login
         WHERE pr.repository_id = $1
         ORDER BY pr.created_at DESC`,
        [repositoryId],
      );
      const visible = actor.role === 'admin' ? rows : rows.filter((r) => r.owner_user_id === actor.userId);
      return visible.map(({ owner_user_id, ...rest }) => rest);
    });
  }

  async getById(orgId: string, pullRequestId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const pr = await this.loadWithOwnership(client, pullRequestId);
      if (!pr) throw new NotFoundException('pull request not found');
      this.assertCanView(pr, actor);
      const { owner_user_id, ...rest } = pr;
      return rest;
    });
  }

  async getStatus(orgId: string, pullRequestId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const { installationId, owner, repo, pr } = await this.loadGithubRef(client, pullRequestId);
      this.assertCanView(pr, actor);
      return this.adapter.getPullRequestStatus({ installationId, owner, repo, pullNumber: pr.github_pr_number });
    });
  }

  async getAnalysis(orgId: string, pullRequestId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const pr = await this.loadWithOwnership(client, pullRequestId);
      if (!pr) throw new NotFoundException('pull request not found');
      this.assertCanView(pr, actor);

      const { rows: runRows } = await client.query(
        `SELECT * FROM review_runs
         WHERE id = $1 OR (pull_request_id = $2)
         ORDER BY (id = $1) DESC, started_at DESC
         LIMIT 1`,
        [pr.source_review_run_id, pullRequestId],
      );
      const run = runRows[0];
      if (!run) return null;

      const { rows: findingRows } = await client.query(
        `SELECT * FROM findings WHERE review_run_id = $1
         ORDER BY (CASE severity
           WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC`,
        [run.id],
      );
      return { ...run, findings: findingRows };
    });
  }

  async validateMerge(orgId: string, pullRequestId: string): Promise<{ canMerge: boolean; reasons: string[] }> {
    return withTenant(orgId, async (client) => {
      const { installationId, owner, repo, pr } = await this.loadGithubRef(client, pullRequestId);
      const reasons: string[] = [];

      if (pr.status !== 'open') reasons.push(`el PR ya está ${pr.status}`);

      const status = await this.adapter.getPullRequestStatus({ installationId, owner, repo, pullNumber: pr.github_pr_number });
      if (status.state !== 'open') reasons.push('el PR no está abierto en GitHub');
      if (status.draft) reasons.push('el PR sigue en borrador');
      if (status.mergeableState === 'dirty') reasons.push('hay conflictos con la rama destino');
      else if (status.mergeableState === 'behind') reasons.push('la rama está desactualizada respecto al destino');
      else if (status.mergeableState === 'blocked') reasons.push('bloqueado por revisiones o checks requeridos pendientes en GitHub');
      else if (status.mergeableState === 'unstable') reasons.push('hay checks no obligatorios fallando');

      let analysisRunId = pr.source_review_run_id;
      if (!analysisRunId) {
        const { rows } = await client.query(
          `SELECT id FROM review_runs WHERE pull_request_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [pullRequestId],
        );
        analysisRunId = rows[0]?.id ?? null;
      }
      if (!analysisRunId) {
        reasons.push('no hay un análisis de DevSentinel asociado a este PR');
      } else {
        const { rows } = await client.query(`SELECT status, gate_decision FROM review_runs WHERE id = $1`, [analysisRunId]);
        const run = rows[0];
        if (!run || run.status !== 'completed') reasons.push('el análisis de DevSentinel todavía no terminó');
        else if (run.gate_decision === 'no_apto') reasons.push('el análisis de DevSentinel marcó el commit como NO APTO');
      }

      return { canMerge: reasons.length === 0, reasons };
    });
  }

  async merge(orgId: string, pullRequestId: string): Promise<{ merged: boolean }> {
    const { canMerge, reasons } = await this.validateMerge(orgId, pullRequestId);
    if (!canMerge) {
      throw new BadRequestException(`no se puede mergear: ${reasons.join('; ')}`);
    }

    return withTenant(orgId, async (client) => {
      const { installationId, owner, repo, pr } = await this.loadGithubRef(client, pullRequestId);
      const result = await this.adapter.mergePullRequest({ installationId, owner, repo, pullNumber: pr.github_pr_number });
      await client.query(`UPDATE pull_requests SET status = 'merged', merged_at = now() WHERE id = $1`, [pullRequestId]);
      return result;
    });
  }

  private ownerUserIdSelect(): string {
    return 'COALESCE(rr_dev.user_id, login_dev.user_id) AS owner_user_id';
  }

  private async loadWithOwnership(client: PoolClient, pullRequestId: string): Promise<any | null> {
    const { rows } = await client.query(
      `SELECT pr.*, ${this.ownerUserIdSelect()}
       FROM pull_requests pr
       LEFT JOIN review_runs rr ON rr.id = pr.source_review_run_id
       LEFT JOIN developers rr_dev ON rr_dev.id = rr.developer_id
       LEFT JOIN developers login_dev ON login_dev.organization_id = pr.organization_id AND login_dev.github_login = pr.author_login
       WHERE pr.id = $1`,
      [pullRequestId],
    );
    return rows[0] ?? null;
  }

  private async loadGithubRef(client: PoolClient, pullRequestId: string) {
    const pr = await this.loadWithOwnership(client, pullRequestId);
    if (!pr) throw new NotFoundException('pull request not found');
    const { rows } = await client.query(
      `SELECT r.full_name, gi.installation_id FROM repositories r
       JOIN github_installations gi ON gi.id = r.github_installation_id
       WHERE r.id = $1`,
      [pr.repository_id],
    );
    const repoRow = rows[0];
    if (!repoRow) throw new NotFoundException('repository not found');
    const [owner, repo] = String(repoRow.full_name).split('/');
    return { installationId: Number(repoRow.installation_id), owner, repo, pr };
  }

  private assertCanView(pr: { owner_user_id: string | null }, actor: Actor): void {
    if (actor.role === 'admin') return;
    if (pr.owner_user_id && pr.owner_user_id === actor.userId) return;
    throw new ForbiddenException('no tienes acceso a este pull request');
  }
}
