import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { RECONSIDER_QUEUE_NAME, type ReconsiderJobPayload } from '@devsentinel/event-contracts';
import { ReconsiderService } from './reconsider.service';

@Processor(RECONSIDER_QUEUE_NAME, { concurrency: 2 })
export class ReconsiderProcessor extends WorkerHost {
  constructor(private readonly reconsiderService: ReconsiderService) {
    super();
  }

  async process(job: Job<ReconsiderJobPayload>): Promise<void> {
    await this.reconsiderService.process(job.data);
  }
}
