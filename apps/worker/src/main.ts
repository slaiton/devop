import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule);
  // eslint-disable-next-line no-console
  console.log('[worker] listening for jobs');
}

bootstrap();
