import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import {
  BrandFactIndexRunner,
  FACT_INDEX_ENQUEUER,
  FACT_INDEX_HANDLER,
} from '../brands/brand-fact-index.runner';
import { BrandsService } from '../brands/brands.service';
import { BriefsAutoGeneratorService } from '../briefs/briefs-auto-generator.service';
import { CrawlProbeService } from '../distribution/crawl-probe.service';
import { RetestSchedulerService } from '../distribution/retest-scheduler.service';
import { AdaptersModule } from '../infra/adapters.module';
import { GEO_BATCH_ENQUEUER, GEO_BATCH_HANDLER, GeoBatchRunner } from '../studio/geo-batch.runner';
import { RetestMetricsHookService } from '../studio/retest-metrics-hook.service';
import { StudioGenerationService } from '../studio/studio-generation.service';
import { VISIBILITY_CONFIG, readVisibilityConfig } from '../visibility/visibility.config';
import { VisibilityCollectorService } from '../visibility/visibility-collector.service';
import { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import { VisibilityJudgeService } from '../visibility/visibility-judge.service';
import { VisibilityRunLifecycleService } from '../visibility/visibility-run-lifecycle.service';
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
        { provide: GEO_BATCH_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        BullBoardMount,
      ],
      exports: [
        QueueProducer,
        JOB_ENQUEUER,
        VISIBILITY_RUN_ENQUEUER,
        FACT_INDEX_ENQUEUER,
        GEO_BATCH_ENQUEUER,
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
        { provide: GEO_BATCH_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        BrandsService,
        WorkerRuntimeService,
        {
          provide: VISIBILITY_CONFIG,
          useFactory: () => readVisibilityConfig(process.env),
        },
        VisibilityCollectorService,
        VisibilityEngineHealthService,
        VisibilityJudgeService,
        VisibilityRunLifecycleService,
        CrawlProbeService,
        RetestSchedulerService,
        MaintenanceRunner,
        BrandFactIndexRunner,
        { provide: FACT_INDEX_HANDLER, useExisting: BrandFactIndexRunner },
        StudioGenerationService,
        GeoBatchRunner,
        { provide: GEO_BATCH_HANDLER, useExisting: GeoBatchRunner },
        BriefsAutoGeneratorService,
        RetestMetricsHookService,
        {
          provide: VISIBILITY_RUN_COMPLETE_HOOKS,
          inject: [BriefsAutoGeneratorService, RetestMetricsHookService],
          useFactory: (
            autoGen: BriefsAutoGeneratorService,
            retestHook: RetestMetricsHookService,
          ) => [autoGen, retestHook],
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
        GEO_BATCH_ENQUEUER,
        VisibilityRunLifecycleService,
        CrawlProbeService,
        RetestSchedulerService,
        VisibilityRunRunner,
        BrandFactIndexRunner,
        StudioGenerationService,
        GeoBatchRunner,
        BriefsAutoGeneratorService,
        RetestMetricsHookService,
        QueueRuntime,
      ],
    };
  }
}
