export const REVIEW_QUEUE_NAME = 'review-jobs';

export interface ReviewJobPayload {
  reviewRunId: string;
  organizationId: string;
  repositoryId: string;
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
  branch: string;
  pullNumber?: number;
}

export const RECONSIDER_QUEUE_NAME = 'reconsider-jobs';

export interface ReconsiderJobPayload {
  findingId: string;
  reviewRunId: string;
  organizationId: string;
  repositoryId: string;
  comment: string;
  requestedBy: string;
}

export const ISSUE_REPLY_SUGGESTION_QUEUE_NAME = 'issue-reply-suggestion-jobs';

export interface IssueReplySuggestionJobPayload {
  issueId: string;
  organizationId: string;
  repositoryId: string;
  requestedBy: string;
}
