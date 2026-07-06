export const REVIEW_QUEUE_NAME = 'review-jobs';

export interface ReviewJobPayload {
  reviewRunId: string;
  organizationId: string;
  repositoryId: string;
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
  pullNumber?: number;
}
