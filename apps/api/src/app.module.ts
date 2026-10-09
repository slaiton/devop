import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module';
import { PasskeysModule } from './modules/passkeys/passkeys.module';
import { GithubWebhooksModule } from './modules/github-webhooks/github-webhooks.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { PullRequestsModule } from './modules/pull-requests/pull-requests.module';
import { IssuesModule } from './modules/issues/issues.module';
import { UsersModule } from './modules/users/users.module';
import { SystemSettingsModule } from './modules/system-settings/system-settings.module';
import { GithubAppsModule } from './modules/github-apps/github-apps.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
    }),
    // Límite global altísimo a propósito: el servidor de Next hace SSR desde UNA sola IP en
    // nombre de todos los usuarios, así que un límite bajo por IP lo tumbaría. Los límites
    // reales se declaran con @Throttle en las rutas públicas sensibles (login, passkeys,
    // recuperación), que sí llegan desde el navegador con la IP real del cliente.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100_000 }]),
    AuthModule,
    PasskeysModule,
    GithubWebhooksModule,
    DashboardModule,
    PullRequestsModule,
    IssuesModule,
    UsersModule,
    SystemSettingsModule,
    GithubAppsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
