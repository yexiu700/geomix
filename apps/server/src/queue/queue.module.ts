import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
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
      module: QueueModule,
      imports: [BillingModule, AuthModule],
      controllers: [QueueController, QueueAdminController],
      providers: [
        StepGate,
        QueueProducer,
        { provide: JOB_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        BullBoardMount,
      ],
    };
  }

  static forWorker(): DynamicModule {
    return {
      module: QueueModule,
      imports: [BillingModule],
      providers: [
        StepGate,
        QueueProducer,
        { provide: JOB_ENQUEUER, useExisting: QueueProducer },
        WorkDriver,
        MaintenanceRunner,
        WorkerRuntimeService,
        QueueRuntime,
      ],
      exports: [WorkerRuntimeService, WorkDriver, StepGate, QueueProducer, QueueRuntime],
    };
  }
}
