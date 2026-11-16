import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import { RECONCILE_INTERVAL_MS } from './billing.options';

/**
 * 约每 15 分钟对账。数据库暂时不可用时只记一条警告，worker 继续待机。
 */
@Injectable()
export class BillingReconcileScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReconcileScheduler.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(RECONCILE_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    try {
      const report = await this.billing.reconcileOrphans();
      if (report.ledgerIssues.length > 0) {
        this.logger.warn(`ledger issues ${report.ledgerIssues.length}`);
      }
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'reconcile failed');
    }
  }
}
