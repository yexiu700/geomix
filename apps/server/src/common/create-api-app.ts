import 'reflect-metadata';
import { INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parseEnv } from '@geomix/shared';
import { ApiModule } from '../api.module';
import {
  createExtensionBridgeCorsMiddleware,
  readSingleOriginHeader,
  type CorsRequestLike,
} from '../extension/extension-cors';
import { loadRootEnv } from '../load-env';
import { ApiExceptionFilter } from './api-exception.filter';

export async function createApiApp(): Promise<INestApplication> {
  loadRootEnv();
  const env = parseEnv();
  const app = await NestFactory.create(ApiModule, { logger: false, rawBody: true });
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  const webOrigins = env.WEB_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const webOriginSet = new Set(webOrigins);

  app.use(createExtensionBridgeCorsMiddleware(webOriginSet));
  app.enableCors((req: CorsRequestLike, callback) => {
    const origin = readSingleOriginHeader(req);
    if (origin && webOriginSet.has(origin)) {
      callback(null, { origin, credentials: true });
      return;
    }
    callback(null, { origin: false });
  });

  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
