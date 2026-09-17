import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { PoolClient } from 'pg';
import { getPool, withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';
import { getSystemSettings } from '@devsentinel/settings';
import { ISSUE_REPLY_SUGGESTION_QUEUE_NAME, type IssueReplySuggestionJobPayload } from '@devsentinel/event-contracts';
import { parseReviewRunIdFromIssueBody, upsertFindingsIssue } from '@devsentinel/issue-content';

interface Actor {
  userId: string;
  role: string;
}

@Injectable()
export class IssuesService {
  constructor(
    @InjectQueue(ISSUE_REPLY_SUGGESTION_QUEUE_NAME) private readonly issueReplyQueue: Queue<IssueReplySuggestionJobPayload>,
  ) {}

  private async getAdapter(): Promise<GithubAdapter> {
    const settings = await getSystemSettings(getPool());
    return new GithubAdapter({
      appId: settings?.githubAppId ?? '',
      privateKey: (settings?.githubAppPrivateKey ?? '').replace(/\\n/g, '\n'),
      webhookSecret: settings?.githubAppWebhookSecret ?? '',
    });
  }

  async listForRepository(orgId: string, repositoryId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      if (actor.role !== 'admin' && !(await this.isRepoMember(client, repositoryId, actor.userId))) {
        return [];
      }
      const { rows } = await client.query(
        `SELECT id, github_issue_number, pull_request_id, branch, kind, origin, title, state, author_login,
                created_at, updated_at, closed_at
         FROM issues WHERE repository_id = $1 ORDER BY updated_at DESC`,
        [repositoryId],
      );
      return rows;
    });
  }

  async getById(orgId: string, issueId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT i.*, r.full_name AS repository_full_name FROM issues i
         JOIN repositories r ON r.id = i.repository_id
         WHERE i.id = $1`,
        [issueId],
      );
      const issue = rows[0];
      if (!issue) throw new NotFoundException('issue not found');
      await this.assertCanView(client, issue, actor);

      const { rows: comments } = await client.query(
        `SELECT id, github_comment_id, author_login, body, source, created_at, updated_at, deleted_at
         FROM issue_comments WHERE issue_id = $1 ORDER BY created_at`,
        [issueId],
      );
      return { ...issue, comments };
    });
  }

  async postComment(orgId: string, issueId: string, body: string, actorUserId: string) {
    if (!body?.trim()) throw new BadRequestException('el comentario no puede estar vacío');
    const adapter = await this.getAdapter();
    return withTenant(orgId, async (client) => {
      const ref = await this.loadGithubRef(client, issueId);
      const { commentId } = await adapter.postIssueComment({
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        issueNumber: ref.issue.github_issue_number,
        body,
      });
      const { rows } = await client.query(
        `INSERT INTO issue_comments (organization_id, issue_id, github_comment_id, author_login, body, source, posted_by)
         VALUES ($1, $2, $3, NULL, $4, 'devsentinel', $5)
         RETURNING *`,
        [orgId, issueId, commentId, body, actorUserId],
      );
      return rows[0];
    });
  }

  /** Marca `pending` de forma síncrona (feedback inmediato) y encola la generación —
   * el LLM solo corre en el worker, nunca acá. Sin polling: el admin recarga la
   * página como con el resto de acciones asíncronas del dashboard. */
  async requestReplySuggestion(orgId: string, issueId: string, actorUserId: string): Promise<{ queued: true }> {
    const repositoryId = await withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE issues
         SET ai_suggested_reply_status = 'pending', ai_suggested_reply_requested_by = $1,
             ai_suggested_reply_requested_at = now(), ai_suggested_reply_error = NULL
         WHERE id = $2
         RETURNING repository_id`,
        [actorUserId, issueId],
      );
      if (!rows[0]) throw new NotFoundException('issue not found');
      return rows[0].repository_id as string;
    });

    await this.issueReplyQueue.add(ISSUE_REPLY_SUGGESTION_QUEUE_NAME, {
      issueId,
      organizationId: orgId,
      repositoryId,
      requestedBy: actorUserId,
    });
    return { queued: true };
  }

  /** Botón manual: crea/actualiza el issue de hallazgos bloqueantes de un review run —
   * misma lógica idempotente que el flujo automático del worker, solo que disparada a
   * mano (p. ej. para forzar la sincronización sin esperar un push nuevo). */
  async createOrSyncFindingsIssue(orgId: string, repositoryId: string, reviewRunId: string): Promise<{ synced: true }> {
    const adapter = await this.getAdapter();
    await withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.commit_sha, rr.branch, rr.pull_request_id, rr.quality_score, rr.risk_level, rr.gate_decision, rr.summary,
                r.full_name, gi.installation_id, pr.github_pr_number
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE rr.id = $1 AND rr.repository_id = $2`,
        [reviewRunId, repositoryId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');
      const [owner, repo] = String(run.full_name).split('/');

      await upsertFindingsIssue(client, adapter, {
        organizationId: orgId,
        repositoryId,
        installationId: Number(run.installation_id),
        owner,
        repo,
        repositoryFullName: run.full_name,
        pullRequestId: run.pull_request_id,
        pullRequestNumber: run.github_pr_number ?? null,
        branch: run.branch,
        commitSha: run.commit_sha,
        reviewRunId,
        reviewRun: {
          gate_decision: run.gate_decision,
          quality_score: run.quality_score,
          risk_level: run.risk_level,
          summary: run.summary,
        },
        trigger: 'push',
      });
    });
    return { synced: true };
  }

  /** "Sincronizar ahora": trae todo issue nativo del repo (abierto o cerrado) y lo
   * refleja en la tabla local. `ON CONFLICT DO NOTHING` — si un webhook ya tocó esa
   * fila mientras tanto, esa versión es más reciente que la del listado paginado. Los
   * issues cuyo body trae el marcador de `buildIssueContent` se reclasifican como
   * `kind='findings', origin='devsentinel'` en vez de asumirlos manuales. */
  async backfillIssues(orgId: string, repositoryId: string): Promise<{ synced: number }> {
    const adapter = await this.getAdapter();
    return withTenant(orgId, async (client) => {
      const { rows: repoRows } = await client.query(
        `SELECT r.full_name, gi.installation_id FROM repositories r
         JOIN github_installations gi ON gi.id = r.github_installation_id WHERE r.id = $1`,
        [repositoryId],
      );
      const repoRow = repoRows[0];
      if (!repoRow) throw new NotFoundException('repository not found');
      const [owner, repo] = String(repoRow.full_name).split('/');
      const installationId = Number(repoRow.installation_id);

      const issues = await adapter.listIssues({ installationId, owner, repo, state: 'all' });

      let synced = 0;
      for (const issue of issues) {
        const reviewRunId = parseReviewRunIdFromIssueBody(issue.body);
        let pullRequestId: string | null = null;
        if (reviewRunId) {
          const { rows } = await client.query('SELECT pull_request_id FROM review_runs WHERE id = $1', [reviewRunId]);
          pullRequestId = rows[0]?.pull_request_id ?? null;
        }

        await client.query(
          `INSERT INTO issues
             (organization_id, repository_id, github_issue_number, kind, origin, title, body, state, state_reason,
              author_login, review_run_id, pull_request_id, created_at, updated_at, closed_at, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
           ON CONFLICT (repository_id, github_issue_number) DO NOTHING`,
          [
            orgId,
            repositoryId,
            issue.number,
            reviewRunId ? 'findings' : 'manual',
            reviewRunId ? 'devsentinel' : 'github',
            issue.title,
            issue.body ?? '',
            issue.state,
            issue.stateReason,
            issue.authorLogin,
            reviewRunId,
            pullRequestId,
            issue.createdAt,
            issue.updatedAt,
            issue.closedAt,
          ],
        );
        synced++;
      }
      return { synced };
    });
  }

  async closeIssue(orgId: string, issueId: string): Promise<void> {
    await this.setState(orgId, issueId, 'closed');
  }

  async reopenIssue(orgId: string, issueId: string): Promise<void> {
    await this.setState(orgId, issueId, 'open');
  }

  private async setState(orgId: string, issueId: string, state: 'open' | 'closed'): Promise<void> {
    const adapter = await this.getAdapter();
    await withTenant(orgId, async (client) => {
      const ref = await this.loadGithubRef(client, issueId);
      await adapter.setIssueState({
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        issueNumber: ref.issue.github_issue_number,
        state,
        stateReason: state === 'closed' ? 'completed' : 'reopened',
      });
      if (state === 'closed') {
        await client.query(`UPDATE issues SET state = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`, [
          issueId,
        ]);
      } else {
        await client.query(`UPDATE issues SET state = 'open', closed_at = NULL, updated_at = now() WHERE id = $1`, [
          issueId,
        ]);
      }
    });
  }

  private async isRepoMember(client: PoolClient, repositoryId: string, userId: string): Promise<boolean> {
    const { rows } = await client.query(
      'SELECT 1 FROM repository_members WHERE repository_id = $1 AND user_id = $2',
      [repositoryId, userId],
    );
    return rows.length > 0;
  }

  private async assertCanView(client: PoolClient, issue: { repository_id: string }, actor: Actor): Promise<void> {
    if (actor.role === 'admin') return;
    const allowed = await this.isRepoMember(client, issue.repository_id, actor.userId);
    if (!allowed) throw new ForbiddenException('no tienes acceso a este issue');
  }

  private async loadGithubRef(
    client: PoolClient,
    issueId: string,
  ): Promise<{ installationId: number; owner: string; repo: string; issue: any }> {
    const { rows } = await client.query(
      `SELECT i.*, r.full_name, gi.installation_id
       FROM issues i
       JOIN repositories r ON r.id = i.repository_id
       JOIN github_installations gi ON gi.id = r.github_installation_id
       WHERE i.id = $1`,
      [issueId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('issue not found');
    const [owner, repo] = String(row.full_name).split('/');
    return { installationId: Number(row.installation_id), owner, repo, issue: row };
  }
}
