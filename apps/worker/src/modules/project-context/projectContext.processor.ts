import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PROJECT_CONTEXT_QUEUE_NAME, type ProjectContextJobPayload } from '@devsentinel/event-contracts';
import { ProjectContextService } from './projectContext.service';

@Processor(PROJECT_CONTEXT_QUEUE_NAME, { concurrency: 2 })
export class ProjectContextProcessor extends WorkerHost {
  constructor(private readonly projectContextService: ProjectContextService) {
    super();
  }

  async process(job: Job<ProjectContextJobPayload>): Promise<void> {
    await this.projectContextService.process(job.data);
  }
}
