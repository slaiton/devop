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

export const PROJECT_CONTEXT_QUEUE_NAME = 'project-context-jobs';

export interface ProjectContextJobPayload {
  runId: string;
  organizationId: string;
  repositoryId: string;
  mode: 'fill' | 'replace';
}

export const CLARIFICATION_QUEUE_NAME = 'clarification-jobs';

/** Una pregunta de la IA sobre un hallazgo recibió respuesta (o un admin decidió a mano): hay que re-evaluarla. */
export interface ClarificationJobPayload {
  organizationId: string;
  repositoryId: string;
  reviewRunId: string;
  findingId: string;
  /** 'reply' = la IA evalúa el hilo; 'manual' = un admin confirma o descarta el hallazgo sin pasar por la IA. */
  kind: 'reply' | 'manual';
  manual?: { decision: 'confirm' | 'dismiss'; userId: string; comment?: string };
}
