import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ISSUE_REPLY_SUGGESTION_QUEUE_NAME } from '@devsentinel/event-contracts';
import { IssueReplyProcessor } from './issueReply.processor';
import { IssueReplyService } from './issueReply.service';

@Module({
  imports: [BullModule.registerQueue({ name: ISSUE_REPLY_SUGGESTION_QUEUE_NAME })],
  providers: [IssueReplyProcessor, IssueReplyService],
})
export class IssueReplyModule {}
