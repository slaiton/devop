import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { REVIEW_QUEUE_NAME, type ReviewJobPayload } from '@devsentinel/event-contracts';
import { ReviewService } from './review.service';

@Processor(REVIEW_QUEUE_NAME, { concurrency: 2 })
export class ReviewProcessor extends WorkerHost {
  constructor(private readonly reviewService: ReviewService) {
    super();
  }

  async process(job: Job<ReviewJobPayload>): Promise<void> {
    await this.reviewService.runReview(job.data);
  }
}
