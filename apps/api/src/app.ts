import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module';
import { contextMiddleware } from './common/context.middleware';
import type { AppConfig } from './config/env';

/** Builds the app; shared by main.ts and the integration tests (which capture logs via logStream). */
export async function createApp(config: AppConfig, logStream?: DestinationStream): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logStream), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.use(contextMiddleware);
  app.useBodyParser('json', { limit: '64kb' });
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.enableShutdownHooks();
  return app;
}
