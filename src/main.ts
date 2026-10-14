import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/logging/all-exceptions.filter';
import { HttpRequestLoggingInterceptor } from './common/logging/http-request-logging.interceptor';
import { initOptionalSentry } from './common/logging/sentry.optional';
import { createAppLogger } from './common/logging/structured-logger';
import { setupSwagger } from './swagger';

async function bootstrap() {
  initOptionalSentry();

  const logger = createAppLogger();
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
    logger,
  });
  app.useLogger(logger);
  app.useWebSocketAdapter(new IoAdapter(app));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Single request-completion logger (do not also enable nestjs-pino HTTP middleware).
  app.useGlobalInterceptors(new HttpRequestLoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  setupSwagger(app);

  const config = app.get(ConfigService);
  const port = config.get<string>('PORT') ?? process.env.PORT ?? '3000';
  await app.listen(port);
  logger.log(
    {
      event: 'app.started',
      service: 'bhaiway-api',
      environment: process.env.NODE_ENV ?? 'development',
    },
    'Application listening',
  );
}
void bootstrap();
