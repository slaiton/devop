import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { GithubAdapter } from '@devsentinel/git-providers';
import { getPool, withTenant } from '@devsentinel/database';
import { getSystemSettings } from '@devsentinel/settings';
import { REVIEW_QUEUE_NAME, type ReviewJobPayload } from '@devsentinel/event-contracts';

@Injectable()
export class GithubWebhooksService {
  constructor(@InjectQueue(REVIEW_QUEUE_NAME) private readonly queue: Queue<ReviewJobPayload>) {}

  async verifySignature(rawBody: Buffer, signature: string | undefined): Promise<boolean> {
    const settings = await getSystemSettings(getPool());
    if (!settings?.githubAppWebhookSecret) return false;
    const adapter = new GithubAdapter({
      appId: settings.githubAppId ?? '',
      privateKey: (settings.githubAppPrivateKey ?? '').replace(/\\n/g, '\n'),
      webhookSecret: settings.githubAppWebhookSecret,
    });
    return adapter.verifyWebhookSignature(rawBody, signature);
  }

  async handleEvent(event: string, payload: any): Promise<void> {
    switch (event) {
      case 'installation':
        if (payload.action === 'created') await this.handleInstallationCreated(payload);
        if (payload.action === 'deleted') await this.handleInstallationDeleted(payload);
        return;
      case 'installation_repositories':
        await this.handleInstallationRepositories(payload);
        return;
      case 'push':
        await this.handlePush(payload);
        return;
      case 'pull_request':
        if (['opened', 'synchronize', 'reopened'].includes(payload.action)) {
          await this.handlePullRequest(payload);
        }
        return;
      default:
        return;
    }
  }

  private async handleInstallationCreated(payload: any): Promise<void> {
    const accountLogin: string = payload.installation.account.login;
    const installationId: number = payload.installation.id;
    const orgId = await this.ensureOrganization(accountLogin);

    await withTenant(orgId, async (client) => {
      await client.query(
        `INSERT INTO github_installations (organization_id, installation_id, account_login)
         VALUES ($1, $2, $3)
         ON CONFLICT (installation_id) DO UPDATE SET status = 'active'`,
        [orgId, installationId, accountLogin],
      );
    });

    const repos: any[] = payload.repositories ?? [];
    await this.upsertRepositories(orgId, installationId, repos);
  }

  private async handleInstallationDeleted(payload: any): Promise<void> {
    const installationId: number = payload.installation.id;
    const orgId = await this.getOrgIdByInstallation(installationId);
    if (!orgId) return;
    await withTenant(orgId, async (client) => {
      await client.query(`UPDATE github_installations SET status = 'revoked' WHERE installation_id = $1`, [
        installationId,
      ]);
    });
  }

  private async handleInstallationRepositories(payload: any): Promise<void> {
    const installationId: number = payload.installation.id;
    const orgId = await this.getOrgIdByInstallation(installationId);
    if (!orgId) return;
    const added: any[] = payload.repositories_added ?? [];
    await this.upsertRepositories(orgId, installationId, added);
  }

  private async handlePush(payload: any): Promise<void> {
    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) return;
    const orgId = await this.getOrgIdByInstallation(installationId);
    if (!orgId) return;

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

  private async handlePullRequest(payload: any): Promise<void> {
    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) return;
    const orgId = await this.getOrgIdByInstallation(installationId);
    if (!orgId) return;

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

  private async ensureOrganization(accountLogin: string): Promise<string> {
    const slug = accountLogin.toLowerCase();
    const existing = await getPool().query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await getPool().query(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [
      accountLogin,
      slug,
    ]);
    return created.rows[0].id;
  }

  /** github_installations tiene RLS; antes de conocer el tenant solo se puede
   * resolver vía la función SECURITY DEFINER creada en la migración 0006. */
  private async getOrgIdByInstallation(installationId: number): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_installation($1) AS organization_id', [
      installationId,
    ]);
    return rows[0]?.organization_id ?? null;
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
