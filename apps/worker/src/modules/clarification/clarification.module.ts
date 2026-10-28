import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CLARIFICATION_QUEUE_NAME } from '@devsentinel/event-contracts';
import { ClarificationProcessor } from './clarification.processor';
import { ClarificationService } from './clarification.service';

@Module({
  imports: [BullModule.registerQueue({ name: CLARIFICATION_QUEUE_NAME })],
  providers: [ClarificationProcessor, ClarificationService],
})
export class ClarificationModule {}
