import { Module } from '@nestjs/common';
import { readReconcileConfig } from '@geomix/shared';
import { BillingModule } from './billing/billing.module';
import { AdaptersModule } from './infra/adapters.module';
import { RECONCILE_INTERVAL_MS } from './billing/billing.options';
import { BillingReconcileScheduler } from './billing/reconcile.scheduler';
import { WorkerRuntimeService } from './worker/worker-runtime.service';

@Module({
  imports: [BillingModule, AdaptersModule],
  providers: [
    WorkerRuntimeService,
    {
      provide: RECONCILE_INTERVAL_MS,
      useFactory: () => readReconcileConfig(process.env).intervalMs,
    },
    BillingReconcileScheduler,
  ],
})
export class WorkerModule {}
