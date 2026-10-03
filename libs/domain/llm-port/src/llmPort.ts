import type {
  ExtractProjectProfileInput,
  ProjectProfileExtraction,
  IssueReplySuggestionInput,
  IssueReplySuggestionResult,
  ReconsiderFindingInput,
  ReconsiderFindingResult,
  ReviewDiffInput,
  ReviewResult,
} from './types';

export interface LlmPort {
  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult>;
  reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult>;
  suggestIssueReply(input: IssueReplySuggestionInput): Promise<IssueReplySuggestionResult>;
  extractProjectProfile(input: ExtractProjectProfileInput): Promise<ProjectProfileExtraction>;
  embed(text: string): Promise<number[]>;
}
