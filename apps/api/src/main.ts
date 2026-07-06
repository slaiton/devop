import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import { runMigrations } from '@devsentinel/database';
import { AppModule } from './app.module';

async function bootstrap() {
  const migrationsPool = new Pool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  await runMigrations(migrationsPool);
  await migrationsPool.end();

  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: process.env.PUBLIC_WEB_ORIGIN ?? true, credentials: true });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${port}`);
}

bootstrap();
