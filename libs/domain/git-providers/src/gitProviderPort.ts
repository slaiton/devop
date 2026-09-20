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

export interface IssueRef {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface CreateIssueParams {
  installationId: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
}

export interface UpdateIssueParams extends IssueRef {
  title?: string;
  body?: string;
}

export interface SetIssueStateParams extends IssueRef {
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | 'reopened';
}

export interface IssueCommentParams extends IssueRef {
  body: string;
}

export interface CreatedIssue {
  number: number;
  htmlUrl: string;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ListIssuesParams {
  installationId: number;
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
}

export interface InstallationRepoSummary {
  githubRepoId: number;
  fullName: string;
  defaultBranch: string;
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
  getInstallationAccountLogin(installationId: number): Promise<string>;
  findOpenPullRequest(params: FindOpenPullRequestParams): Promise<{ number: number } | null>;
  createPullRequest(params: CreatePullRequestParams): Promise<CreatedPullRequest>;
  getPullRequestStatus(params: PullRequestRef): Promise<PullRequestStatus>;
  createIssue(params: CreateIssueParams): Promise<CreatedIssue>;
  updateIssue(params: UpdateIssueParams): Promise<void>;
  setIssueState(params: SetIssueStateParams): Promise<void>;
  postIssueComment(params: IssueCommentParams): Promise<{ commentId: number }>;
  listIssues(params: ListIssuesParams): Promise<GithubIssueSummary[]>;
  listInstallationRepositories(installationId: number): Promise<InstallationRepoSummary[]>;
}
