import type { ReviewDiffInput, ReviewResult } from './types';

export interface LlmPort {
  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult>;
  embed(text: string): Promise<number[]>;
}
