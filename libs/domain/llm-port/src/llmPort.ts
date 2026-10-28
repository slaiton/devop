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
  AgenticReviewStats,
  ClarificationResult,
  ResolveClarificationInput,
  ToolTraceEntry,
} from './types';

export interface LlmPort {
  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult>;
  reviewDiffAgentic(input: ReviewDiffInput, toolbox: AgentToolbox, options: AgenticReviewOptions): Promise<AgenticReviewOutcome>;
  resolveClarification(input: ResolveClarificationInput): Promise<ClarificationResult>;
  resolveClarificationAgentic(
    input: ResolveClarificationInput,
    toolbox: AgentToolbox,
    options: AgenticReviewOptions,
  ): Promise<{ result: ClarificationResult; trace: ToolTraceEntry[]; stats: AgenticReviewStats }>;
  reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult>;
  suggestIssueReply(input: IssueReplySuggestionInput): Promise<IssueReplySuggestionResult>;
  extractProjectProfile(input: ExtractProjectProfileInput): Promise<ProjectProfileExtraction>;
  embed(text: string): Promise<number[]>;
}
