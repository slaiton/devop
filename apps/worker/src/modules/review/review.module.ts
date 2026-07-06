import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GithubAdapter } from '@devsentinel/git-providers';
import { OpenAiCompatibleLlmAdapter, embedLocally } from '@devsentinel/llm-port';
import { REVIEW_QUEUE_NAME } from '@devsentinel/event-contracts';
import { ReviewProcessor } from './review.processor';
import { ReviewService } from './review.service';
import { RepoCheckoutService } from './repoCheckout.service';
import { StaticAnalysisService } from './staticAnalysis.service';
import { SandboxRunnerService } from './sandboxRunner.service';
import { RagContextService } from './ragContext.service';
import { GIT_PROVIDER_PORT, LLM_PORT } from './tokens';

@Module({
  imports: [BullModule.registerQueue({ name: REVIEW_QUEUE_NAME })],
  providers: [
    ReviewProcessor,
    ReviewService,
    RepoCheckoutService,
    StaticAnalysisService,
    SandboxRunnerService,
    RagContextService,
    {
      provide: GIT_PROVIDER_PORT,
      useFactory: () =>
        new GithubAdapter({
          appId: process.env.GITHUB_APP_ID ?? '',
          privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
          webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? '',
        }),
    },
    {
      provide: LLM_PORT,
      useFactory: () =>
        new OpenAiCompatibleLlmAdapter(
          process.env.LLM_MODEL ?? '',
          process.env.LLM_PROVIDER_BASE_URL ?? '',
          process.env.LLM_PROVIDER_API_KEY ?? '',
          embedLocally,
        ),
    },
  ],
})
export class ReviewModule {}
