import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { REVIEW_QUEUE_NAME } from '@devsentinel/event-contracts';
import { ReviewProcessor } from './review.processor';
import { ReviewService } from './review.service';
import { RepoCheckoutService } from './repoCheckout.service';
import { StaticAnalysisService } from './staticAnalysis.service';
import { AuditModule } from '../audit/audit.module';
import { RagContextService } from './ragContext.service';

@Module({
  imports: [BullModule.registerQueue({ name: REVIEW_QUEUE_NAME }), AuditModule],
  providers: [ReviewProcessor, ReviewService, RepoCheckoutService, StaticAnalysisService, RagContextService],
})
export class ReviewModule {}
