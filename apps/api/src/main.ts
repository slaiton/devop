import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Pool } from 'pg';
import { runMigrations } from '@devsentinel/database';
import { AppModule } from './app.module';
import { originCheck } from './common/originCheck.middleware';
import { getWebAuthnConfig } from './modules/passkeys/webauthn.config';

async function bootstrap() {
  const migrationsPool = new Pool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  await runMigrations(migrationsPool);
  await migrationsPool.end();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.setGlobalPrefix('api');
  // Caddy va delante: sin esto req.ip sería siempre la IP del proxy y el límite de
  // intentos y los eventos de seguridad verían a todo el mundo como una sola persona.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: process.env.PUBLIC_WEB_ORIGIN ?? true, credentials: true });

  try {
    const webauthn = getWebAuthnConfig();
    app.use(originCheck(webauthn.origins));
    // eslint-disable-next-line no-console
    console.log(`[webauthn] passkeys activas — rpID=${webauthn.rpID} orígenes=${webauthn.origins.join(', ')}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[webauthn] passkeys deshabilitadas: ${(err as Error).message}`);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${port}`);
}

bootstrap();
