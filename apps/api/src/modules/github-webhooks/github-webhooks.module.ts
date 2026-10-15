import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { REVIEW_QUEUE_NAME } from '@devsentinel/event-contracts';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { GithubWebhooksController } from './github-webhooks.controller';
import { GithubWebhooksService } from './github-webhooks.service';
import { IssuesSyncService } from './issuesSync.service';
import { WebhookLogController } from './webhookLog.controller';
import { WebhookLogService } from './webhookLog.service';

@Module({
  imports: [BullModule.registerQueue({ name: REVIEW_QUEUE_NAME }), AuthModule],
  controllers: [GithubWebhooksController, WebhookLogController],
  providers: [GithubWebhooksService, IssuesSyncService, WebhookLogService, RolesGuard],
})
export class GithubWebhooksModule {}
