import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SITE_NAME, parseEnv, type BillingMode } from '@geomix/shared';

export type WorkerStatus = {
  service: 'worker';
  name: typeof SITE_NAME;
  billingMode: BillingMode;
  queue: 'standby';
};

/**
 * Keeps the worker process alive until BullMQ consumers are added.
 * The timer is intentionally not unref'd: an idle Node process would exit.
 */
@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  onModuleInit(): void {
    this.timer = setInterval(() => undefined, 30_000);
  }

  onModuleDestroy(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  status(source?: Record<string, string | undefined>): WorkerStatus {
    const env = parseEnv(source ?? process.env);
    return {
      service: 'worker',
      name: SITE_NAME,
      billingMode: env.BILLING_MODE,
      queue: 'standby',
    };
  }
}
