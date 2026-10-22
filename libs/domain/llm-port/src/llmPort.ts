import type {
  ExtractProjectProfileInput,
  ProjectProfileExtraction,
  IssueReplySuggestionInput,
  IssueReplySuggestionResult,
  ReconsiderFindingInput,
  ReconsiderFindingResult,
  ReviewDiffInput,
  ReviewResult,
  AgentToolbox,
  AgenticReviewOptions,
  AgenticReviewOutcome,
} from './types';

export interface LlmPort {
  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult>;
  reviewDiffAgentic(input: ReviewDiffInput, toolbox: AgentToolbox, options: AgenticReviewOptions): Promise<AgenticReviewOutcome>;
  reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult>;
  suggestIssueReply(input: IssueReplySuggestionInput): Promise<IssueReplySuggestionResult>;
  extractProjectProfile(input: ExtractProjectProfileInput): Promise<ProjectProfileExtraction>;
  embed(text: string): Promise<number[]>;
}
