import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Suppress the Express `X-Powered-By` info-disclosure header (TRD §12).
  // The underlying adapter is typed as `any` because Nest abstracts over Express/Fastify.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // Global validation: strip unknown properties, auto-transform types.
  // `days` is never accepted from clients — server always recomputes it (§12).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.listen(process.env['PORT'] ?? 3000);
}

bootstrap();
