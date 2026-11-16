import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from './billing.service';
import { BillingReconcileScheduler } from './reconcile.scheduler';

describe('BillingReconcileScheduler', () => {
  it('runs a tick and keeps going when the database is down', async () => {
    const reconcileOrphans = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({
        scanned: 0,
        closed: 0,
        releasedPoints: 0,
        skippedActive: 0,
        skippedUnknown: 0,
        failed: 0,
        ledgerIssues: [],
      });
    const billing = { reconcileOrphans } as unknown as BillingService;
    const scheduler = new BillingReconcileScheduler(billing, 60_000);
    await scheduler.tick();
    await scheduler.tick();
    expect(reconcileOrphans).toHaveBeenCalledTimes(2);
    scheduler.onModuleInit();
    scheduler.onModuleDestroy();
  });
});
