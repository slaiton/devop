export interface PullRequestRef {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface ReviewCommentParams extends PullRequestRef {
  commitSha: string;
  filePath: string;
  line: number;
  body: string;
}

export interface SummaryCommentParams extends PullRequestRef {
  body: string;
}

export interface CheckRunParams {
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
}

export interface CommitRef {
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
}

export interface MergeBranchParams {
  installationId: number;
  owner: string;
  repo: string;
  base: string;
  head: string;
}

export interface RecentCommitInfo {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface FindOpenPullRequestParams {
  installationId: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
}

export interface CreatePullRequestParams {
  installationId: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
  authorLogin: string;
}

export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PullRequestStatus {
  state: 'open' | 'closed';
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  checks: PullRequestCheck[];
}

/**
 * Puerto genérico para cualquier proveedor Git. El MVP solo implementa
 * GithubAdapter; GitLab/Bitbucket en V1 implementan el mismo puerto sin
 * tocar el resto del sistema (ver docs/architecture/01-arquitectura-y-componentes.md).
 */
export interface GitProviderPort {
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  getPullRequestDiff(params: PullRequestRef): Promise<string>;
  getCommitDiff(params: CommitRef): Promise<string>;
  getInstallationToken(installationId: number): Promise<string>;
  postReviewComment(params: ReviewCommentParams): Promise<{ commentId: number }>;
  postSummaryComment(params: SummaryCommentParams): Promise<void>;
  setCheckRunStatus(params: CheckRunParams): Promise<void>;
  mergePullRequest(params: PullRequestRef): Promise<{ merged: boolean }>;
  mergeBranch(params: MergeBranchParams): Promise<{ merged: boolean; conflict: boolean }>;
  getRecentCommits(params: CommitRef, count?: number): Promise<RecentCommitInfo[]>;
  findOpenPullRequest(params: FindOpenPullRequestParams): Promise<{ number: number } | null>;
  createPullRequest(params: CreatePullRequestParams): Promise<CreatedPullRequest>;
  getPullRequestStatus(params: PullRequestRef): Promise<PullRequestStatus>;
}
