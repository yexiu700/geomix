import { Injectable } from '@nestjs/common';
import { SITE_NAME, parseEnv, type BillingMode } from '@geomix/shared';

export type WorkerStatus = {
  service: 'worker';
  name: typeof SITE_NAME;
  billingMode: BillingMode;
  queue: 'standby' | 'bullmq';
  upstream: 'disabled';
};

/**
 * 进程状态。队列连上之前保持 standby，不假装已经在消费。
 * 假任务和适配层默认不调用上游。
 */
@Injectable()
export class WorkerRuntimeService {
  private connected = false;

  markConnected(): void {
    this.connected = true;
  }

  status(source?: Record<string, string | undefined>): WorkerStatus {
    const env = parseEnv(source ?? process.env);
    return {
      service: 'worker',
      name: SITE_NAME,
      billingMode: env.BILLING_MODE,
      queue: this.connected ? 'bullmq' : 'standby',
      upstream: 'disabled',
    };
  }
}
