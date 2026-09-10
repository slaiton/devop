import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { REVIEW_QUEUE_NAME } from '@devsentinel/event-contracts';
import { ReviewProcessor } from './review.processor';
import { ReviewService } from './review.service';
import { RepoCheckoutService } from './repoCheckout.service';
import { StaticAnalysisService } from './staticAnalysis.service';
import { SandboxRunnerService } from './sandboxRunner.service';
import { RagContextService } from './ragContext.service';

@Module({
  imports: [BullModule.registerQueue({ name: REVIEW_QUEUE_NAME })],
  providers: [ReviewProcessor, ReviewService, RepoCheckoutService, StaticAnalysisService, SandboxRunnerService, RagContextService],
})
export class ReviewModule {}
