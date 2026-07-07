import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from './modules/auth/auth.module';
import { GithubWebhooksModule } from './modules/github-webhooks/github-webhooks.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
    }),
    AuthModule,
    GithubWebhooksModule,
    DashboardModule,
    HealthModule,
  ],
})
export class AppModule {}
