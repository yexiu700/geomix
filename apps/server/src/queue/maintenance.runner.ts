import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import { WorkDriver } from './work-driver';

/**
 * 维护队列负责对账、任务恢复、远端可见度引擎健康探测、以及清理占位。
 */
@Injectable()
export class MaintenanceRunner {
  private readonly logger = new Logger(MaintenanceRunner.name);

  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(WorkDriver) private readonly driver: WorkDriver,
    @Optional()
    @Inject(VisibilityEngineHealthService)
    private readonly visibilityEngineHealth?: VisibilityEngineHealthService,
  ) {}

  async run(kind: string): Promise<string> {
    if (kind === 'reconcile') {
      const report = await this.billing.reconcileOrphans();
      if (report.ledgerIssues.length > 0) {
        this.logger.warn(`ledger issues ${report.ledgerIssues.length}`);
      }
      return 'reconcile';
    }
    if (kind === 'recover') {
      const queued = await this.driver.recover();
      return `recover:${queued}`;
    }
    if (kind === 'visibility-engine-health') {
      if (!this.visibilityEngineHealth) {
        return 'visibility-engine-health-skipped';
      }
      const res = await this.visibilityEngineHealth.refreshHealth();
      const online = res.engines.filter((e) => e.available).length;
      return `visibility-engine-health:${online}/${res.engines.length}`;
    }
    if (kind === 'retention') {
      this.logger.log('article retention skipped; published articles are retained');
      return 'retention-skipped';
    }
    if (kind === 'orphan-files') {
      this.logger.log('orphan file cleanup skipped');
      return 'orphan-files-skipped';
    }
    return 'ignored';
  }
}
