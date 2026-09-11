import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RECONSIDER_QUEUE_NAME } from '@devsentinel/event-contracts';
import { ReconsiderProcessor } from './reconsider.processor';
import { ReconsiderService } from './reconsider.service';

@Module({
  imports: [BullModule.registerQueue({ name: RECONSIDER_QUEUE_NAME })],
  providers: [ReconsiderProcessor, ReconsiderService],
})
export class ReconsiderModule {}
