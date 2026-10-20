import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PROJECT_CONTEXT_QUEUE_NAME } from '@devsentinel/event-contracts';
import { ProjectContextProcessor } from './projectContext.processor';
import { ProjectContextService } from './projectContext.service';

@Module({
  imports: [BullModule.registerQueue({ name: PROJECT_CONTEXT_QUEUE_NAME })],
  providers: [ProjectContextProcessor, ProjectContextService],
})
export class ProjectContextModule {}
