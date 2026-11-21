import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import {
  BrandFactIndexRunner,
  FACT_INDEX_ENQUEUER,
  FACT_INDEX_HANDLER,
} from '../brands/brand-fact-index.runner';
import { BriefsAutoGeneratorService } from '../briefs/briefs-auto-generator.service';
import { AdaptersModule } from '../infra/adapters.module';
import { VISIBILITY_CONFIG, readVisibilityConfig } from '../visibility/visibility.config';
import { VisibilityCollectorService } from '../visibility/visibility-collector.service';
import { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import { VisibilityJudgeService } from '../visibility/visibility-judge.service';
import {
  VISIBILITY_RUN_COMPLETE_HOOKS,
  VISIBILITY_RUN_ENQUEUER,
  VISIBILITY_RUN_HANDLER,
  VisibilityRunRunner,
} from '../visibility/visibility-run.runner';
import { WorkerRuntimeService } from '../worker/worker-runtime.service';
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
        { provide: VISIBILITY_RUN_ENQUEUER, useExisting: QueueProducer },
        { provide: FACT_INDEX_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        BullBoardMount,
      ],
      exports: [
        QueueProducer,
        JOB_ENQUEUER,
        VISIBILITY_RUN_ENQUEUER,
        FACT_INDEX_ENQUEUER,
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
        { provide: VISIBILITY_RUN_ENQUEUER, useExisting: QueueProducer },
        { provide: FACT_INDEX_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        MaintenanceRunner,
        WorkerRuntimeService,
        {
          provide: VISIBILITY_CONFIG,
          useFactory: () => readVisibilityConfig(process.env),
        },
        VisibilityCollectorService,
        VisibilityEngineHealthService,
        VisibilityJudgeService,
        BrandFactIndexRunner,
        { provide: FACT_INDEX_HANDLER, useExisting: BrandFactIndexRunner },
        BriefsAutoGeneratorService,
        {
          provide: VISIBILITY_RUN_COMPLETE_HOOKS,
          inject: [BriefsAutoGeneratorService],
          useFactory: (autoGen: BriefsAutoGeneratorService) => [autoGen],
        },
        VisibilityRunRunner,
        { provide: VISIBILITY_RUN_HANDLER, useExisting: VisibilityRunRunner },
        QueueRuntime,
      ],
      exports: [
        WorkerRuntimeService,
        WorkDriver,
        StepGate,
        QueueProducer,
        VISIBILITY_RUN_ENQUEUER,
        FACT_INDEX_ENQUEUER,
        VisibilityRunRunner,
        BrandFactIndexRunner,
        BriefsAutoGeneratorService,
        QueueRuntime,
      ],
    };
  }
}
