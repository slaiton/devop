import type { ReconsiderFindingInput, ReconsiderFindingResult, ReviewDiffInput, ReviewResult } from './types';

export interface LlmPort {
  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult>;
  reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult>;
  embed(text: string): Promise<number[]>;
}
