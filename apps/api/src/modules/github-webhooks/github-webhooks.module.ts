import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { REVIEW_QUEUE_NAME } from '@devsentinel/event-contracts';
import { GithubWebhooksController } from './github-webhooks.controller';
import { GithubWebhooksService } from './github-webhooks.service';

@Module({
  imports: [BullModule.registerQueue({ name: REVIEW_QUEUE_NAME })],
  controllers: [GithubWebhooksController],
  providers: [GithubWebhooksService],
})
export class GithubWebhooksModule {}
