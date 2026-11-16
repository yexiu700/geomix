import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SITE_NAME, parseEnv } from '@geomix/shared';
import { ApiModule } from './api.module';
import { loadRootEnv } from './load-env';

async function bootstrap(): Promise<void> {
  loadRootEnv();
  const env = parseEnv();
  const app = await NestFactory.create(ApiModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: env.WEB_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  Logger.log(`${SITE_NAME} api listening on ${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
