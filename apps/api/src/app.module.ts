import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from './modules/auth/auth.module';
import { GithubWebhooksModule } from './modules/github-webhooks/github-webhooks.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { PullRequestsModule } from './modules/pull-requests/pull-requests.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
    }),
    AuthModule,
    GithubWebhooksModule,
    DashboardModule,
    PullRequestsModule,
    HealthModule,
  ],
})
export class AppModule {}
