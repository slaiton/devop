import 'reflect-metadata';
import * as http from 'http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule);

  // Servidor HTTP mínimo solo para el health check de Docker/orquestadores.
  // No expone lógica de negocio: el worker consume trabajos de BullMQ.
  const healthServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  });
  healthServer.listen(3001, '0.0.0.0');

  // eslint-disable-next-line no-console
  console.log('[worker] listening for jobs');
}

bootstrap();
