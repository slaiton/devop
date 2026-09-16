import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReviewModule } from './modules/review/review.module';
import { ReconsiderModule } from './modules/reconsider/reconsider.module';
import { IssueReplyModule } from './modules/issue-reply/issueReply.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
    }),
    ReviewModule,
    ReconsiderModule,
    IssueReplyModule,
  ],
})
export class AppModule {}
