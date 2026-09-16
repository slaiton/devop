import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ISSUE_REPLY_SUGGESTION_QUEUE_NAME } from '@devsentinel/event-contracts';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: ISSUE_REPLY_SUGGESTION_QUEUE_NAME })],
  controllers: [IssuesController],
  providers: [IssuesService, RolesGuard],
})
export class IssuesModule {}
