/**
 * Mock HCM Server — standalone entry point (ADR-007).
 *
 * `nest build` emits `dist/mock-hcm/main.js`.
 * `compose.yml` runs: node dist/mock-hcm/main.js
 *
 * Listens on PORT env var (default 3001).
 * Does NOT import AppModule or any production service module.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { MockHcmModule } from './mock-hcm.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(MockHcmModule, {
    // Suppress NestJS banner in test output; keep it visible otherwise.
    logger:
      process.env['NODE_ENV'] === 'test' ? false : ['log', 'error', 'warn'],
  });

  // Suppress the Express `X-Powered-By` info-disclosure header (parity with main app).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const port = Number(process.env['PORT'] ?? 3001);
  await app.listen(port);

  if (process.env['NODE_ENV'] !== 'test') {
    console.log(`Mock HCM server running on port ${port}`);
    console.log(`Active scenario: ${process.env['HCM_SCENARIO'] ?? 'correct'}`);
  }
}

bootstrap();
