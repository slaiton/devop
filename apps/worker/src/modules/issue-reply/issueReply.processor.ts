import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ISSUE_REPLY_SUGGESTION_QUEUE_NAME, type IssueReplySuggestionJobPayload } from '@devsentinel/event-contracts';
import { IssueReplyService } from './issueReply.service';

@Processor(ISSUE_REPLY_SUGGESTION_QUEUE_NAME, { concurrency: 2 })
export class IssueReplyProcessor extends WorkerHost {
  constructor(private readonly issueReplyService: IssueReplyService) {
    super();
  }

  async process(job: Job<IssueReplySuggestionJobPayload>): Promise<void> {
    await this.issueReplyService.process(job.data);
  }
}
