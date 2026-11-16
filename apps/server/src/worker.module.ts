import { Module } from '@nestjs/common';
import { BillingModule } from './billing/billing.module';
import { AdaptersModule } from './infra/adapters.module';
import { QueueModule } from './queue/queue.module';

/**
 * 对账改由 maintenance 队列定时执行，不再另起一个 setInterval。
 * 适配层仍然注入，但队列演练不调用上游。
 */
@Module({
  imports: [BillingModule, AdaptersModule, QueueModule.forWorker()],
})
export class WorkerModule {}
