import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { IMAGE_JOB_ENQUEUER, IMAGE_JOB_HANDLER, ImageJobRunner } from '../image/image-job.runner';
import { AdaptersModule } from '../infra/adapters.module';
import { KB_INDEX_HANDLER, KnowledgeIndexRunner } from '../material/knowledge-index.runner';
import {
  REWRITE_BATCH_ENQUEUER,
  REWRITE_BATCH_HANDLER,
  RewriteBatchRunner,
} from '../rewrite/rewrite-batch.runner';
import { WorkerRuntimeService } from '../worker/worker-runtime.service';
import { AI_TASK_ENQUEUER, AI_TASK_HANDLER, AiTaskRunner } from '../writing/ai-task.runner';
import { BullBoardMount } from './bull-board.mount';
import { JOB_ENQUEUER } from './job-enqueuer';
import { MaintenanceRunner } from './maintenance.runner';
import { QueueAdminController, QueueController } from './queue.controller';
import { QueueProducer } from './queue.producer';
import { QueueRuntime } from './queue.runtime';
import { StepGate } from './step-gate';
import { WorkDriver } from './work-driver';

@Module({})
export class QueueModule {
  static forApi(): DynamicModule {
    return {
      global: true,
      module: QueueModule,
      imports: [BillingModule, AuthModule],
      controllers: [QueueController, QueueAdminController],
      providers: [
        StepGate,
        QueueProducer,
        { provide: JOB_ENQUEUER, useExisting: QueueProducer },
        { provide: AI_TASK_ENQUEUER, useExisting: QueueProducer },
        { provide: REWRITE_BATCH_ENQUEUER, useExisting: QueueProducer },
        { provide: IMAGE_JOB_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        BullBoardMount,
      ],
      exports: [
        QueueProducer,
        JOB_ENQUEUER,
        AI_TASK_ENQUEUER,
        REWRITE_BATCH_ENQUEUER,
        IMAGE_JOB_ENQUEUER,
        WorkDriver,
        StepGate,
      ],
    };
  }

  static forWorker(): DynamicModule {
    return {
      module: QueueModule,
      imports: [BillingModule, AdaptersModule],
      providers: [
        StepGate,
        QueueProducer,
        { provide: JOB_ENQUEUER, useExisting: QueueProducer },
        { provide: AI_TASK_ENQUEUER, useExisting: QueueProducer },
        { provide: REWRITE_BATCH_ENQUEUER, useExisting: QueueProducer },
        { provide: IMAGE_JOB_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        MaintenanceRunner,
        WorkerRuntimeService,
        KnowledgeIndexRunner,
        { provide: KB_INDEX_HANDLER, useExisting: KnowledgeIndexRunner },
        AiTaskRunner,
        { provide: AI_TASK_HANDLER, useExisting: AiTaskRunner },
        RewriteBatchRunner,
        { provide: REWRITE_BATCH_HANDLER, useExisting: RewriteBatchRunner },
        ImageJobRunner,
        { provide: IMAGE_JOB_HANDLER, useExisting: ImageJobRunner },
        QueueRuntime,
      ],
      exports: [
        WorkerRuntimeService,
        WorkDriver,
        StepGate,
        QueueProducer,
        AI_TASK_ENQUEUER,
        REWRITE_BATCH_ENQUEUER,
        IMAGE_JOB_ENQUEUER,
        KnowledgeIndexRunner,
        AiTaskRunner,
        RewriteBatchRunner,
        ImageJobRunner,
        QueueRuntime,
      ],
    };
  }
}
