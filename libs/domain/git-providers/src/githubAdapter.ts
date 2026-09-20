import { createHmac, timingSafeEqual } from 'crypto';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type {
  AppInstallationSummary,
  CheckRunParams,
  CommitRef,
  CreatedIssue,
  CreatedPullRequest,
  CreateIssueParams,
  CreatePullRequestParams,
  FindOpenPullRequestParams,
  GithubIssueSummary,
  GitProviderPort,
  InstallationRepoSummary,
  IssueCommentParams,
  ListIssuesParams,
  MergeBranchParams,
  PullRequestRef,
  PullRequestStatus,
  RecentCommitInfo,
  ReviewCommentParams,
  SetIssueStateParams,
  SummaryCommentParams,
  UpdateIssueParams,
} from './gitProviderPort';

export interface GithubAdapterConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export class GithubAdapter implements GitProviderPort {
  constructor(private readonly config: GithubAdapterConfig) {}

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const expected = `sha256=${createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex')}`;
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signatureHeader);
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  async getPullRequestDiff(params: PullRequestRef): Promise<string> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      mediaType: { format: 'diff' },
    });
    return data as unknown as string;
  }

  async getCommitDiff(params: CommitRef): Promise<string> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.repos.getCommit({
      owner: params.owner,
      repo: params.repo,
      ref: params.commitSha,
      mediaType: { format: 'diff' },
    });
    return data as unknown as string;
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const auth = createAppAuth({ appId: this.config.appId, privateKey: this.config.privateKey });
    const { token } = await auth({ type: 'installation', installationId });
    return token;
  }

  async postReviewComment(params: ReviewCommentParams): Promise<{ commentId: number }> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.pulls.createReviewComment({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      commit_id: params.commitSha,
      path: params.filePath,
      line: params.line,
      body: params.body,
    });
    return { commentId: data.id };
  }

  async postSummaryComment(params: SummaryCommentParams): Promise<void> {
    // En la API de GitHub un PR es un issue (mismo espacio de numeración), así que el
    // comentario de resumen del PR es, técnicamente, un comentario de issue.
    await this.postIssueComment({ ...params, issueNumber: params.pullNumber });
  }

  async setCheckRunStatus(params: CheckRunParams): Promise<void> {
    const client = this.getInstallationClient(params.installationId);
    await client.checks.create({
      owner: params.owner,
      repo: params.repo,
      name: 'DevSentinel AI Review',
      head_sha: params.commitSha,
      status: 'completed',
      conclusion: params.conclusion,
      output: {
        title: params.title,
        summary: params.summary,
      },
    });
  }

  async mergePullRequest(params: PullRequestRef): Promise<{ merged: boolean }> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.pulls.merge({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
    });
    return { merged: data.merged };
  }

  async mergeBranch(params: MergeBranchParams): Promise<{ merged: boolean; conflict: boolean }> {
    const client = this.getInstallationClient(params.installationId);
    try {
      const { data } = await client.repos.merge({
        owner: params.owner,
        repo: params.repo,
        base: params.base,
        head: params.head,
      });
      // 204 (ya está al día) devuelve data undefined/vacío; lo tratamos como éxito.
      return { merged: !data || 'sha' in data, conflict: false };
    } catch (err: any) {
      if (err?.status === 409) {
        return { merged: false, conflict: true };
      }
      throw err;
    }
  }

  async getRecentCommits(params: CommitRef, count = 3): Promise<RecentCommitInfo[]> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.repos.listCommits({
      owner: params.owner,
      repo: params.repo,
      sha: params.commitSha,
      per_page: count + 1,
    });
    // El primer resultado es el propio commit que se está revisando; se descarta.
    return data.slice(1, count + 1).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? null,
      date: c.commit.author?.date ?? null,
    }));
  }

  async findOpenPullRequest(params: FindOpenPullRequestParams): Promise<{ number: number } | null> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.pulls.list({
      owner: params.owner,
      repo: params.repo,
      state: 'open',
      head: `${params.owner}:${params.head}`,
      base: params.base,
    });
    return data[0] ? { number: data[0].number } : null;
  }

  async createPullRequest(params: CreatePullRequestParams): Promise<CreatedPullRequest> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.pulls.create({
      owner: params.owner,
      repo: params.repo,
      head: params.head,
      base: params.base,
      title: params.title,
      body: params.body,
    });
    return { number: data.number, htmlUrl: data.html_url, authorLogin: data.user?.login ?? 'unknown' };
  }

  async getPullRequestStatus(params: PullRequestRef): Promise<PullRequestStatus> {
    const client = this.getInstallationClient(params.installationId);
    const { data: pr } = await client.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
    });

    const { data: checkRuns } = await client.checks.listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: pr.head.sha,
    });

    return {
      state: pr.state as 'open' | 'closed',
      draft: pr.draft ?? false,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state ?? 'unknown',
      headSha: pr.head.sha,
      checks: checkRuns.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    };
  }

  async createIssue(params: CreateIssueParams): Promise<CreatedIssue> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.issues.create({
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
    });
    return { number: data.number, htmlUrl: data.html_url };
  }

  async updateIssue(params: UpdateIssueParams): Promise<void> {
    const client = this.getInstallationClient(params.installationId);
    await client.issues.update({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      title: params.title,
      body: params.body,
    });
  }

  async setIssueState(params: SetIssueStateParams): Promise<void> {
    const client = this.getInstallationClient(params.installationId);
    await client.issues.update({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      state: params.state,
      state_reason: params.stateReason,
    });
  }

  async postIssueComment(params: IssueCommentParams): Promise<{ commentId: number }> {
    const client = this.getInstallationClient(params.installationId);
    const { data } = await client.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      body: params.body,
    });
    return { commentId: data.id };
  }

  /** Lista todos los issues nativos del repo (para el backfill) — el endpoint de
   * listado de GitHub también devuelve los PRs (comparten numeración con los
   * issues), así que se filtran explícitamente. */
  async listIssues(params: ListIssuesParams): Promise<GithubIssueSummary[]> {
    const client = this.getInstallationClient(params.installationId);
    const data = await client.paginate(client.issues.listForRepo, {
      owner: params.owner,
      repo: params.repo,
      state: params.state ?? 'all',
      per_page: 100,
    });
    return data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state as 'open' | 'closed',
        stateReason: issue.state_reason ?? null,
        authorLogin: issue.user?.login ?? null,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at ?? null,
      }));
  }

  /** Lista los repos a los que la instalación tiene acceso — vía la API, no vía
   * webhooks. Se usa tanto al conectar una cuenta (sincronización inicial, sin esperar
   * a que lleguen los eventos `installation`/`installation_repositories`) como para el
   * botón manual "sincronizar ahora": si el webhook de una App nunca llegó a
   * configurarse bien, esta es la única forma de que los repos aparezcan. */
  async listInstallationRepositories(installationId: number): Promise<InstallationRepoSummary[]> {
    const client = this.getInstallationClient(installationId);
    const data = await client.paginate(client.apps.listReposAccessibleToInstallation, { per_page: 100 });
    return data.map((repo) => ({
      githubRepoId: repo.id,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch ?? 'main',
    }));
  }

  /** Lista TODAS las instalaciones existentes de esta App directamente desde la API —
   * cliente autenticado como App (JWT), no como una instalación concreta. Es el
   * respaldo para "conectar" una cuenta que ya tenía la App instalada de antes (p. ej.
   * la cuenta principal, instalada bajo el viejo sistema de un solo App global): el
   * flujo interactivo de `/apps/<slug>/installations/new` no pasa por nuestro
   * callback cuando GitHub detecta que ya está instalada, así que nunca dispara
   * `handleInstallCallback` — esta llamada no depende de esa interacción del
   * navegador en absoluto. */
  async listAppInstallations(): Promise<AppInstallationSummary[]> {
    const client = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.config.appId, privateKey: this.config.privateKey },
    });
    const data = await client.paginate(client.apps.listInstallations, { per_page: 100 });
    return data.map((installation) => {
      const account = installation.account as { login?: string; slug?: string } | null;
      return {
        installationId: installation.id,
        accountLogin: account?.login ?? account?.slug ?? 'unknown',
      };
    });
  }

  /** Resuelve el account_login dueño de una instalación a partir de su id — cliente
   * autenticado como App (JWT), no como instalación, ya que no conocemos de antemano
   * ningún dato de esa instalación más que su id. */
  async getInstallationAccountLogin(installationId: number): Promise<string> {
    const client = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.config.appId, privateKey: this.config.privateKey },
    });
    const { data } = await client.apps.getInstallation({ installation_id: installationId });
    const account = data.account as { login?: string; slug?: string } | null;
    return account?.login ?? account?.slug ?? 'unknown';
  }

  private getInstallationClient(installationId: number): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        installationId,
      },
    });
  }
}
