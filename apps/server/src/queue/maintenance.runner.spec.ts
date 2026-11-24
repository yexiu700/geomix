import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { CrawlProbeService } from '../distribution/crawl-probe.service';
import type { RetestSchedulerService } from '../distribution/retest-scheduler.service';
import { MaintenanceRunner } from './maintenance.runner';
import type { WorkDriver } from './work-driver';

describe('MaintenanceRunner v2.1 sweeps', () => {
  const billing = {
    reconcileOrphans: vi.fn(async () => ({ ledgerIssues: [] })),
  } as unknown as BillingService;
  const driver = {
    recover: vi.fn(async () => 0),
  } as unknown as WorkDriver;

  it('returns skipped when CrawlProbeService or RetestSchedulerService are not injected', async () => {
    const runner = new MaintenanceRunner(billing, driver);
    expect(await runner.run('crawl-probe-sweep')).toBe('crawl-probe-sweep-skipped');
    expect(await runner.run('retest-schedule-sweep')).toBe('retest-schedule-sweep-skipped');
  });

  it('delegates crawl-probe-sweep and retest-schedule-sweep to injected services', async () => {
    const crawlProbe = {
      runSweep: vi.fn(async () => ({ scanned: 5, probed: 4, failed: 1 })),
    } as unknown as CrawlProbeService;
    const retestScheduler = {
      runDueSweep: vi.fn(async () => ({
        scanned: 3,
        claimed: 3,
        triggered: 2,
        skippedInsufficientPoints: 1,
        skippedNoEngine: 0,
        skippedInactiveTenant: 0,
        failed: 0,
      })),
    } as unknown as RetestSchedulerService;

    const runner = new MaintenanceRunner(billing, driver, undefined, crawlProbe, retestScheduler);

    expect(await runner.run('crawl-probe-sweep')).toBe('crawl-probe-sweep:4/5');
    expect(crawlProbe.runSweep).toHaveBeenCalledTimes(1);

    expect(await runner.run('retest-schedule-sweep')).toBe('retest-schedule-sweep:2/3');
    expect(retestScheduler.runDueSweep).toHaveBeenCalledTimes(1);
  });
});
