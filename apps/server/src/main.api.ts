import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { SITE_NAME, parseEnv } from '@geomix/shared';
import { createApiApp } from './common/create-api-app';
import { loadRootEnv } from './load-env';

async function bootstrap(): Promise<void> {
  loadRootEnv();
  const env = parseEnv();
  const app = await createApiApp();
  await app.listen(env.API_PORT);
  Logger.log(`${SITE_NAME} api listening on ${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
