import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadRootEnv } from './load-env';
import { WorkerModule } from './worker.module';
import { WorkerRuntimeService } from './worker/worker-runtime.service';

async function bootstrap(): Promise<void> {
  loadRootEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const status = app.get(WorkerRuntimeService).status();
  Logger.log(
    `${status.name} worker started (billing ${status.billingMode}, queue ${status.queue})`,
    'Bootstrap',
  );
}

void bootstrap();
