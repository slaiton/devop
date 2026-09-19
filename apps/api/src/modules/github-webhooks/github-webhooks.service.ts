import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { GithubAdapter } from '@devsentinel/git-providers';
import { getPool, withTenant } from '@devsentinel/database';
import { decrypt } from '@devsentinel/settings';
import { REVIEW_QUEUE_NAME, type ReviewJobPayload } from '@devsentinel/event-contracts';
import { IssuesSyncService } from './issuesSync.service';

export interface WebhookAppContext {
  organizationId: string;
  githubAppRowId: string;
}

@Injectable()
export class GithubWebhooksService {
  constructor(
    @InjectQueue(REVIEW_QUEUE_NAME) private readonly queue: Queue<ReviewJobPayload>,
    private readonly issuesSync: IssuesSyncService,
  ) {}

  /** Resuelve QUÉ GitHub App envió este webhook a partir del App ID que GitHub manda
   * en el header `X-GitHub-Hook-Installation-Target-ID`, y solo entonces verifica la
   * firma HMAC con el secret de ESA App — nunca al revés, para no aceptar un payload
   * antes de saber con qué secret validarlo. `github_apps` tiene RLS, así que resolver
   * organización + secret sin conocer el tenant exige la función SECURITY DEFINER
   * `resolve_github_app` (migración 0025, mismo patrón que
   * `resolve_organization_for_installation`). */
  async verifyAndResolve(
    rawBody: Buffer,
    signature: string | undefined,
    githubAppId: string | undefined,
  ): Promise<WebhookAppContext | null> {
    if (!githubAppId) return null;
    const { rows } = await getPool().query(
      'SELECT organization_id, id, webhook_secret_encrypted FROM resolve_github_app($1)',
      [githubAppId],
    );
    const row = rows[0];
    if (!row) return null;

    const webhookSecret = decrypt(row.webhook_secret_encrypted);
    const adapter = new GithubAdapter({ appId: githubAppId, privateKey: '', webhookSecret });
    if (!adapter.verifyWebhookSignature(rawBody, signature)) return null;

    return { organizationId: row.organization_id as string, githubAppRowId: row.id as string };
  }

  async handleEvent(event: string, payload: any, ctx: WebhookAppContext): Promise<void> {
    switch (event) {
      case 'installation':
        if (payload.action === 'created') await this.handleInstallationCreated(payload, ctx);
        if (payload.action === 'deleted') await this.handleInstallationDeleted(payload, ctx);
        return;
      case 'installation_repositories':
        await this.handleInstallationRepositories(payload, ctx);
        return;
      case 'push':
        await this.handlePush(payload, ctx);
        return;
      case 'pull_request':
        if (['opened', 'synchronize', 'reopened'].includes(payload.action)) {
          await this.handlePullRequest(payload, ctx);
        }
        return;
      case 'issues':
        await this.issuesSync.handleIssueEvent(payload);
        return;
      case 'issue_comment':
        await this.issuesSync.handleIssueCommentEvent(payload);
        return;
      default:
        return;
    }
  }

  private async handleInstallationCreated(payload: any, ctx: WebhookAppContext): Promise<void> {
    const accountLogin: string = payload.installation.account.login;
    const installationId: number = payload.installation.id;

    await withTenant(ctx.organizationId, async (client) => {
      await client.query(
        `INSERT INTO github_installations (organization_id, installation_id, account_login, github_app_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (installation_id) DO UPDATE SET status = 'active', github_app_id = $4`,
        [ctx.organizationId, installationId, accountLogin, ctx.githubAppRowId],
      );
    });

    const repos: any[] = payload.repositories ?? [];
    await this.upsertRepositories(ctx.organizationId, installationId, repos);
  }

  private async handleInstallationDeleted(payload: any, ctx: WebhookAppContext): Promise<void> {
    const installationId: number = payload.installation.id;
    await withTenant(ctx.organizationId, async (client) => {
      await client.query(`UPDATE github_installations SET status = 'revoked' WHERE installation_id = $1`, [
        installationId,
      ]);
    });
  }

  private async handleInstallationRepositories(payload: any, ctx: WebhookAppContext): Promise<void> {
    const installationId: number = payload.installation.id;
    const added: any[] = payload.repositories_added ?? [];
    await this.upsertRepositories(ctx.organizationId, installationId, added);
  }

  private async handlePush(payload: any, ctx: WebhookAppContext): Promise<void> {
    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) return;
    const orgId = ctx.organizationId;

    const [owner, repo] = String(payload.repository.full_name).split('/');
    const repository = await this.getRepositoryForPush(orgId, payload.repository.id);
    if (!repository) return;

    const commitSha: string = payload.after;
    if (!commitSha || commitSha === '0000000000000000000000000000000000000000') return;

    const branch = String(payload.ref ?? '').replace(/^refs\/heads\//, '');
    if (!branch || branch === repository.default_branch) return;

    const authorName: string | null = payload.head_commit?.author?.name ?? null;
    const authorEmail: string | null = payload.head_commit?.author?.email ?? null;
    const developerId = await this.resolveDeveloper(orgId, { email: authorEmail, name: authorName });

    const reviewRunId = await this.createReviewRun(
      orgId,
      repository.id,
      null,
      commitSha,
      'push',
      branch,
      authorName,
      authorEmail,
      developerId,
    );

    await this.queue.add(REVIEW_QUEUE_NAME, {
      reviewRunId,
      organizationId: orgId,
      repositoryId: repository.id,
      installationId,
      owner,
      repo,
      commitSha,
      branch,
    });
  }

  private async handlePullRequest(payload: any, ctx: WebhookAppContext): Promise<void> {
    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) return;
    const orgId = ctx.organizationId;

    const [owner, repo] = String(payload.repository.full_name).split('/');
    const repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) return;

    const pr = payload.pull_request;
    const pullRequestId = await withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO pull_requests (organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
         ON CONFLICT (repository_id, github_pr_number)
         DO UPDATE SET title = $4, status = 'open'
         RETURNING id`,
        [orgId, repositoryId, pr.number, pr.title, pr.head.ref, pr.base.ref, pr.user.login],
      );
      return rows[0].id as string;
    });

    // Si este commit ya fue analizado (p. ej. vino de un push a la rama origen y el PR
    // se creó/detectó a partir de ese análisis), se reutiliza — no se vuelve a gastar
    // un análisis de IA para el mismo commit.
    const existingRunId = await this.findCompletedReviewRunForCommit(orgId, repositoryId, pr.head.sha);
    if (existingRunId) {
      await withTenant(orgId, async (client) => {
        await client.query(`UPDATE review_runs SET pull_request_id = $1 WHERE id = $2 AND pull_request_id IS NULL`, [
          pullRequestId,
          existingRunId,
        ]);
      });
      return;
    }

    const developerId = await this.resolveDeveloper(orgId, { githubLogin: pr.user.login });

    const reviewRunId = await this.createReviewRun(
      orgId,
      repositoryId,
      pullRequestId,
      pr.head.sha,
      'pull_request',
      pr.head.ref,
      null,
      null,
      developerId,
    );

    await this.queue.add(REVIEW_QUEUE_NAME, {
      reviewRunId,
      organizationId: orgId,
      repositoryId,
      installationId,
      owner,
      repo,
      commitSha: pr.head.sha,
      branch: pr.head.ref,
      pullNumber: pr.number,
    });
  }

  private async findCompletedReviewRunForCommit(
    orgId: string,
    repositoryId: string,
    commitSha: string,
  ): Promise<string | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM review_runs
         WHERE repository_id = $1 AND commit_sha = $2 AND status = 'completed'
         ORDER BY started_at DESC
         LIMIT 1`,
        [repositoryId, commitSha],
      );
      return rows[0]?.id ?? null;
    });
  }

  private async getRepositoryId(orgId: string, githubRepoId: number): Promise<string | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM repositories WHERE github_repo_id = $1', [githubRepoId]);
      return rows[0]?.id ?? null;
    });
  }

  private async getRepositoryForPush(
    orgId: string,
    githubRepoId: number,
  ): Promise<{ id: string; default_branch: string } | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id, default_branch FROM repositories WHERE github_repo_id = $1', [
        githubRepoId,
      ]);
      return rows[0] ?? null;
    });
  }

  /** login de GitHub (PRs) o email de commit (pushes) — no siempre hay ambos. */
  private async resolveDeveloper(
    orgId: string,
    identity: { githubLogin?: string | null; email?: string | null; name?: string | null },
  ): Promise<string | null> {
    const githubLogin = identity.githubLogin ?? null;
    const email = identity.email ?? null;
    if (!githubLogin && !email) return null;

    return withTenant(orgId, async (client) => {
      const existing = await client.query(
        `SELECT id FROM developers WHERE organization_id = $1 AND (($2::text IS NOT NULL AND github_login = $2) OR ($3::text IS NOT NULL AND email = $3))`,
        [orgId, githubLogin, email],
      );
      if (existing.rows[0]) return existing.rows[0].id as string;

      const { rows } = await client.query(
        `INSERT INTO developers (organization_id, github_login, email, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [orgId, githubLogin, email, identity.name ?? githubLogin ?? email],
      );
      return rows[0].id as string;
    });
  }

  private async upsertRepositories(orgId: string, installationId: number, repos: any[]): Promise<void> {
    if (!repos.length) return;
    await withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM github_installations WHERE installation_id = $1', [
        installationId,
      ]);
      const githubInstallationId = rows[0]?.id;
      if (!githubInstallationId) return;

      for (const repo of repos) {
        await client.query(
          `INSERT INTO repositories (organization_id, github_installation_id, github_repo_id, full_name, default_branch, webhook_status)
           VALUES ($1, $2, $3, $4, $5, 'active')
           ON CONFLICT (github_repo_id) DO UPDATE SET full_name = $4, webhook_status = 'active'`,
          [orgId, githubInstallationId, repo.id, repo.full_name, repo.default_branch ?? 'main'],
        );
      }
    });
  }

  private async createReviewRun(
    orgId: string,
    repositoryId: string,
    pullRequestId: string | null,
    commitSha: string,
    trigger: 'push' | 'pull_request',
    branch: string,
    authorName: string | null,
    authorEmail: string | null,
    developerId: string | null,
  ): Promise<string> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO review_runs
           (organization_id, repository_id, pull_request_id, commit_sha, trigger, branch, author_name, author_email, developer_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running')
         RETURNING id`,
        [orgId, repositoryId, pullRequestId, commitSha, trigger, branch, authorName, authorEmail, developerId],
      );
      return rows[0].id as string;
    });
  }
}
