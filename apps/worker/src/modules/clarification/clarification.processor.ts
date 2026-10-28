import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CLARIFICATION_QUEUE_NAME, type ClarificationJobPayload } from '@devsentinel/event-contracts';
import { ClarificationService } from './clarification.service';

@Processor(CLARIFICATION_QUEUE_NAME, { concurrency: 2 })
export class ClarificationProcessor extends WorkerHost {
  constructor(private readonly clarificationService: ClarificationService) {
    super();
  }

  async process(job: Job<ClarificationJobPayload>): Promise<void> {
    await this.clarificationService.process(job.data);
  }
}
