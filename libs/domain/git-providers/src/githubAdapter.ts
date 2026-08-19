import { createHmac, timingSafeEqual } from 'crypto';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type {
  CheckRunParams,
  CommitRef,
  GitProviderPort,
  MergeBranchParams,
  PullRequestRef,
  RecentCommitInfo,
  ReviewCommentParams,
  SummaryCommentParams,
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
    const client = this.getInstallationClient(params.installationId);
    await client.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: params.body,
    });
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
