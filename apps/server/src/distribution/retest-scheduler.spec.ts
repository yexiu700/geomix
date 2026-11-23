import { describe, expect, it, vi } from 'vitest';
import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import type { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';
import { currentTenantId, runInTenant } from '../tenant/tenant-context';
import { readVisibilityConfig } from '../visibility/visibility.config';
import { deriveVisibilityRunId } from '../visibility/visibility.mapper';
import type { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import {
  RetestSchedulerService,
  ensureRetestSchedulesForPublishRecord,
  type RetestRunCreator,
} from './retest-scheduler.service';

const DAY_MS = 24 * 60 * 60 * 1000;

type ScheduleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: number;
  dueAt: Date;
  status: string;
  visibilityRunId: string | null;
  metricsSnapshotJson: unknown;
  skipReason: string | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type TenantState = {
  id: string;
  isActive: boolean;
  expiresAt: Date;
  billingMode: 'SHADOW' | 'STRICT';
  available: number;
};

function createHarness(opts?: {
  tenants?: TenantState[];
  engines?: Array<{ key: string; available: boolean }>;
  unitPrice?: number;
  featureEnabled?: boolean;
  createRunImpl?: RetestRunCreator['createRun'];
}) {
  const schedules = new Map<string, ScheduleRow>();
  const publishRecords = new Map<
    string,
    {
      id: string;
      tenantId: string;
      brandId: string;
      brandMarketId: string;
      articleId: string;
      publishedAt: Date;
      latestRetestRunId: string | null;
      afterMetrics: unknown;
      article: { id: string; title: string; targetPrompt: string };
      brandMarket: { id: string; market: 'CN' | 'GLOBAL'; localBrandName: string };
    }
  >();
  const tenants = new Map<string, TenantState>();
  for (const t of opts?.tenants ?? [
    {
      id: 'tenant_a',
      isActive: true,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      billingMode: 'STRICT',
      available: 100,
    },
  ]) {
    tenants.set(t.id, { ...t });
  }

  let seq = 1;

  const prisma = {
    base: {
      geoRetestSchedule: {
        findMany: vi.fn(
          async (args: { where: { status?: string; dueAt?: { lte: Date } }; take?: number }) => {
            const list = [...schedules.values()]
              .filter(
                (s) =>
                  (!args.where.status || s.status === args.where.status) &&
                  (!args.where.dueAt || s.dueAt.getTime() <= args.where.dueAt.lte.getTime()),
              )
              .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id))
              .map((s) => {
                const t = tenants.get(s.tenantId);
                return {
                  ...s,
                  tenant: t ? { id: t.id, isActive: t.isActive, expiresAt: t.expiresAt } : null,
                };
              });
            return args.take !== undefined ? list.slice(0, args.take) : list;
          },
        ),
      },
    },
    scoped: {
      geoPublishRecord: {
        findFirst: vi.fn(
          async (args: { where: { id?: string; brandId?: string; brandMarketId?: string } }) => {
            const tid = currentTenantId();
            const rec = args.where.id ? publishRecords.get(args.where.id) : undefined;
            if (!rec || rec.tenantId !== tid) return null;
            if (args.where.brandId && rec.brandId !== args.where.brandId) return null;
            if (args.where.brandMarketId && rec.brandMarketId !== args.where.brandMarketId) {
              return null;
            }
            return rec;
          },
        ),
        updateMany: vi.fn(
          async (args: {
            where: { id?: string; OR?: Array<{ latestRetestRunId: null | { not: string } }> };
            data: { latestRetestRunId?: string | null; afterMetrics?: unknown };
          }) => {
            const tid = currentTenantId();
            let count = 0;
            for (const rec of publishRecords.values()) {
              if (rec.tenantId !== tid) continue;
              if (args.where.id && rec.id !== args.where.id) continue;
              if (args.where.OR) {
                const matched = args.where.OR.some((c) =>
                  c.latestRetestRunId === null
                    ? rec.latestRetestRunId === null
                    : rec.latestRetestRunId !== c.latestRetestRunId.not,
                );
                if (!matched) continue;
              }
              if (args.data.latestRetestRunId !== undefined) {
                rec.latestRetestRunId = args.data.latestRetestRunId;
              }
              if (args.data.afterMetrics !== undefined) {
                rec.afterMetrics = null;
              }
              count += 1;
            }
            return { count };
          },
        ),
      },
      geoRetestSchedule: {
        createMany: vi.fn(
          async (args: {
            data: Array<{
              tenantId: string;
              brandId: string;
              brandMarketId: string;
              publishRecordId: string;
              milestoneDay: number;
              sampleCount: number;
              dueAt: Date;
              status: string;
            }>;
            skipDuplicates?: boolean;
          }) => {
            let count = 0;
            const now = new Date('2026-10-01T00:00:00Z');
            for (const item of args.data) {
              const dup = [...schedules.values()].some(
                (s) =>
                  s.publishRecordId === item.publishRecordId &&
                  s.milestoneDay === item.milestoneDay,
              );
              if (dup) {
                if (args.skipDuplicates) continue;
                throw new Error('Unique constraint failed');
              }
              const id = `sched_${seq++}`;
              schedules.set(id, {
                id,
                tenantId: item.tenantId,
                brandId: item.brandId,
                brandMarketId: item.brandMarketId,
                publishRecordId: item.publishRecordId,
                milestoneDay: item.milestoneDay,
                sampleCount: item.sampleCount,
                dueAt: item.dueAt,
                status: item.status,
                visibilityRunId: null,
                metricsSnapshotJson: null,
                skipReason: null,
                executedAt: null,
                createdAt: now,
                updatedAt: now,
              });
              count += 1;
            }
            return { count };
          },
        ),
        findMany: vi.fn(async (args: { where: { publishRecordId?: string } }) => {
          const tid = currentTenantId();
          return [...schedules.values()]
            .filter(
              (s) =>
                s.tenantId === tid &&
                (!args.where.publishRecordId || s.publishRecordId === args.where.publishRecordId),
            )
            .sort((a, b) => a.milestoneDay - b.milestoneDay || a.id.localeCompare(b.id));
        }),
        updateMany: vi.fn(
          async (args: {
            where: {
              id?: string;
              publishRecordId?: string;
              status?: string;
              milestoneDay?: { in: number[] };
            };
            data: Partial<ScheduleRow>;
          }) => {
            const tid = currentTenantId();
            let count = 0;
            for (const row of schedules.values()) {
              if (row.tenantId !== tid) continue;
              if (args.where.id && row.id !== args.where.id) continue;
              if (
                args.where.publishRecordId &&
                row.publishRecordId !== args.where.publishRecordId
              ) {
                continue;
              }
              if (args.where.status && row.status !== args.where.status) continue;
              if (
                args.where.milestoneDay?.in &&
                !args.where.milestoneDay.in.includes(row.milestoneDay)
              ) {
                continue;
              }
              Object.assign(row, args.data, { updatedAt: new Date() });
              count += 1;
            }
            return { count };
          },
        ),
      },
    },
  } as unknown as PrismaService;

  const unitPrice = opts?.unitPrice ?? 2;
  const billing = {
    unitPrice: vi.fn(async () => unitPrice),
    wallet: vi.fn(async (tenantId: string) => {
      const t = tenants.get(tenantId);
      if (!t) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '租户不存在');
      return {
        points: t.available,
        pointsReserved: 0,
        available: t.available,
        money: 0,
        billingMode: t.billingMode,
        billingModeSource: 'tenant' as const,
        tenantBillingMode: t.billingMode,
      };
    }),
  } as unknown as BillingService;

  const engineList = opts?.engines ?? [
    { key: 'doubao', available: true },
    { key: 'deepseek', available: true },
  ];
  const engineHealth = {
    getAvailability: vi.fn(async () => ({
      mode: 'fake' as const,
      market: 'CN' as const,
      engines: engineList,
    })),
  } as unknown as VisibilityEngineHealthService;

  const createRunMock = vi.fn(
    opts?.createRunImpl ??
      (async (brandId, input, idempotencyKey) => {
        const tid = currentTenantId()!;
        const t = tenants.get(tid)!;
        const cost = input.engines.length * (input.sampleCount ?? 1) * unitPrice;
        if (t.billingMode === 'STRICT') {
          if (t.available < cost) {
            throw new ApiError(402, API_ERROR.INSUFFICIENT_POINTS, '可用点数不足');
          }
          t.available -= cost;
        }
        return {
          id: deriveVisibilityRunId(tid, idempotencyKey),
          brandId,
        } as unknown as Awaited<ReturnType<RetestRunCreator['createRun']>>;
      }),
  );

  const runLifecycle: RetestRunCreator = {
    createRun: createRunMock,
  };

  const service = new RetestSchedulerService(
    prisma,
    billing,
    engineHealth,
    runLifecycle,
    readVisibilityConfig({
      VISIBILITY_ENABLED: opts?.featureEnabled === false ? 'false' : 'true',
      VISIBILITY_COLLECTOR: 'fake',
    }),
  );

  function seedPublishRecord(overrides?: {
    id?: string;
    tenantId?: string;
    market?: 'CN' | 'GLOBAL';
    publishedAt?: Date;
    targetPrompt?: string;
  }) {
    const id = overrides?.id ?? 'pub_1';
    const tenantId = overrides?.tenantId ?? 'tenant_a';
    const market = overrides?.market ?? 'CN';
    const publishedAt = overrides?.publishedAt ?? new Date('2026-10-01T00:00:00Z');
    publishRecords.set(id, {
      id,
      tenantId,
      brandId: 'brand_1',
      brandMarketId: market === 'GLOBAL' ? 'bm_global' : 'bm_cn',
      articleId: 'art_1',
      publishedAt,
      latestRetestRunId: null,
      afterMetrics: null,
      article: {
        id: 'art_1',
        title: '四盘位静音家用 NAS 实测指南',
        targetPrompt: overrides?.targetPrompt ?? '2026 四盘位静音家用 NAS 推荐',
      },
      brandMarket: {
        id: market === 'GLOBAL' ? 'bm_global' : 'bm_cn',
        market,
        localBrandName: '星辰存储',
      },
    });
    return publishRecords.get(id)!;
  }

  return {
    service,
    prisma,
    billing,
    engineHealth,
    createRunMock,
    schedules,
    publishRecords,
    tenants,
    seedPublishRecord,
  };
}

describe('RetestSchedulerService schedule creation & configuration', () => {
  it('creates default T+7/14/30 schedules with sampleCount=1, deduplicates milestones, respects enabled:false, and is idempotent', async () => {
    const { service, seedPublishRecord, prisma } = createHarness();
    const publishedAt = new Date('2026-10-01T08:00:00Z');
    const rec = seedPublishRecord({ publishedAt });

    await runInTenant('tenant_a', async () => {
      // enabled: false -> 0 rows
      const disabled = await service.ensureSchedulesForPublishRecord(rec, { enabled: false });
      expect(disabled).toEqual([]);

      // Default [7, 14, 30]
      const defaults = await service.ensureSchedulesForPublishRecord(rec);
      expect(defaults.map((s) => s.milestoneDay)).toEqual([7, 14, 30]);
      expect(defaults.every((s) => s.sampleCount === 1 && s.status === 'PENDING')).toBe(true);
      expect(defaults[0]?.dueAt).toBe(new Date(publishedAt.getTime() + 7 * DAY_MS).toISOString());
      expect(defaults[2]?.dueAt).toBe(new Date(publishedAt.getTime() + 30 * DAY_MS).toISOString());

      // Repeated call is idempotent (skipDuplicates)
      const again = await service.ensureSchedulesForPublishRecord(rec);
      expect(again).toHaveLength(3);
    });

    // Duplicate & unsorted custom milestones with sampleCount=3 on another record
    const rec2 = seedPublishRecord({ id: 'pub_2', publishedAt });
    await runInTenant('tenant_a', async () => {
      const custom = await service.ensureSchedulesForPublishRecord(rec2, {
        enabled: true,
        milestones: [30, 7, 7, 14],
        sampleCount: 3,
      });
      expect(custom.map((s) => s.milestoneDay)).toEqual([7, 14, 30]);
      expect(custom.every((s) => s.sampleCount === 3)).toBe(true);
    });

    // Defensive guard on legacy mock missing geoRetestSchedule
    const legacy = await ensureRetestSchedulesForPublishRecord({} as PrismaService['scoped'], rec);
    expect(legacy).toEqual([]);
    expect(prisma).toBeDefined();
  });

  it('updateSchedulesForPublishRecord pauses, reactivates, switches sampleCount without mutating COMPLETED/RUNNING, and enforces cross-tenant 404', async () => {
    const { service, seedPublishRecord, schedules } = createHarness();
    const rec = seedPublishRecord();

    await runInTenant('tenant_a', async () => {
      const created = await service.ensureSchedulesForPublishRecord(rec);
      // Mark T+7 COMPLETED and T+14 RUNNING
      schedules.get(created[0]!.id)!.status = 'COMPLETED';
      schedules.get(created[1]!.id)!.status = 'RUNNING';

      // Pause all -> only T+30 (PENDING) becomes CANCELLED
      const paused = await service.updateSchedulesForPublishRecord(rec.id, { enabled: false });
      expect(paused.map((s) => [s.milestoneDay, s.status])).toEqual([
        [7, 'COMPLETED'],
        [14, 'RUNNING'],
        [30, 'CANCELLED'],
      ]);

      // Re-enable with sampleCount=3 -> reactivates T+30 with sampleCount=3, leaves COMPLETED/RUNNING intact
      const reactivated = await service.updateSchedulesForPublishRecord(rec.id, {
        enabled: true,
        sampleCount: 3,
      });
      expect(reactivated.map((s) => [s.milestoneDay, s.status, s.sampleCount])).toEqual([
        [7, 'COMPLETED', 1],
        [14, 'RUNNING', 1],
        [30, 'PENDING', 3],
      ]);

      // Switch sampleCount back to 1 and add T+60
      const updated = await service.updateSchedulesForPublishRecord(rec.id, {
        milestones: [7, 14, 30, 60],
        sampleCount: 1,
      });
      expect(updated.map((s) => [s.milestoneDay, s.status, s.sampleCount])).toEqual([
        [7, 'COMPLETED', 1],
        [14, 'RUNNING', 1],
        [30, 'PENDING', 1],
        [60, 'PENDING', 1],
      ]);
    });

    // Cross-tenant 404
    await runInTenant('tenant_b', async () => {
      await expect(
        service.updateSchedulesForPublishRecord(rec.id, { enabled: false }),
      ).rejects.toMatchObject({
        status: 404,
        code: AUTH_ERROR.NOT_FOUND,
      });
    });
  });
});

describe('RetestSchedulerService.runDueSweep', () => {
  it('triggers due schedules with sampleCount=1 and sampleCount=3, pre-binds visibilityRunId, and enforces idempotency on concurrent sweep', async () => {
    const { service, seedPublishRecord, schedules, createRunMock, publishRecords, tenants } =
      createHarness({
        tenants: [
          {
            id: 'tenant_a',
            isActive: true,
            expiresAt: new Date('2027-01-01T00:00:00Z'),
            billingMode: 'STRICT',
            available: 50,
          },
        ],
      });

    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const rec1 = seedPublishRecord({ id: 'pub_1', publishedAt });
    const rec2 = seedPublishRecord({ id: 'pub_2', publishedAt });

    await runInTenant('tenant_a', async () => {
      await service.ensureSchedulesForPublishRecord(rec1, { milestones: [7], sampleCount: 1 });
      await service.ensureSchedulesForPublishRecord(rec2, { milestones: [7], sampleCount: 3 });
    });

    const now = new Date('2026-10-09T00:00:00Z');
    const report = await service.runDueSweep({ now });
    expect(report).toEqual({
      scanned: 2,
      claimed: 2,
      triggered: 2,
      skippedInsufficientPoints: 0,
      skippedNoEngine: 0,
      skippedInactiveTenant: 0,
      failed: 0,
    });

    expect(createRunMock).toHaveBeenCalledTimes(2);
    // 2 engines * 1 sample * 2 pts = 4, + 2 engines * 3 samples * 2 pts = 12 => total 16 deducted
    expect(tenants.get('tenant_a')!.available).toBe(34);

    const firstCall = createRunMock.mock.calls[0]!;
    expect(firstCall[1]).toMatchObject({
      market: 'CN',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      sampleCount: 1,
    });
    expect(firstCall[2]).toMatch(/^sched:/);

    const secondCall = createRunMock.mock.calls[1]!;
    expect(secondCall[1]).toMatchObject({
      sampleCount: 3,
      triggerType: 'RETEST',
    });

    // Publish records linked to new run IDs
    expect(publishRecords.get('pub_1')!.latestRetestRunId).toBeTruthy();
    expect(publishRecords.get('pub_2')!.latestRetestRunId).toBeTruthy();
    expect([...schedules.values()].every((s) => s.status === 'RUNNING' && s.visibilityRunId)).toBe(
      true,
    );

    // Second sweep immediately after -> 0 scanned, 0 double-charge
    const secondReport = await service.runDueSweep({ now });
    expect(secondReport.scanned).toBe(0);
    expect(secondReport.triggered).toBe(0);
    expect(createRunMock).toHaveBeenCalledTimes(2);
  });

  it('skips with SKIPPED_INSUFFICIENT_POINTS in STRICT mode without calling createRun or overdrafting, and catches 402 race', async () => {
    // Case 1: Pre-check catches 0 available points
    const h1 = createHarness({
      tenants: [
        {
          id: 'tenant_a',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'STRICT',
          available: 0,
        },
      ],
    });
    const rec1 = h1.seedPublishRecord({ publishedAt: new Date('2026-10-01T00:00:00Z') });
    await runInTenant('tenant_a', async () => {
      await h1.service.ensureSchedulesForPublishRecord(rec1, { milestones: [7], sampleCount: 3 });
    });

    const r1 = await h1.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(r1.skippedInsufficientPoints).toBe(1);
    expect(r1.triggered).toBe(0);
    expect(h1.createRunMock).not.toHaveBeenCalled();
    expect(h1.tenants.get('tenant_a')!.available).toBe(0);
    const sched1 = [...h1.schedules.values()][0]!;
    expect(sched1.status).toBe('SKIPPED_INSUFFICIENT_POINTS');
    expect(sched1.visibilityRunId).toBeNull();
    expect(sched1.skipReason).toContain('12 点');

    // Case 2: Race where wallet() showed enough points, then reserve() threw 402 INSUFFICIENT_POINTS
    const h2 = createHarness({
      createRunImpl: async () => {
        throw new ApiError(402, API_ERROR.INSUFFICIENT_POINTS, '并发预扣点数不足');
      },
    });
    const rec2 = h2.seedPublishRecord({ publishedAt: new Date('2026-10-01T00:00:00Z') });
    await runInTenant('tenant_a', async () => {
      await h2.service.ensureSchedulesForPublishRecord(rec2, { milestones: [7] });
    });

    const r2 = await h2.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(r2.skippedInsufficientPoints).toBe(1);
    expect(r2.failed).toBe(0);
    const sched2 = [...h2.schedules.values()][0]!;
    expect(sched2.status).toBe('SKIPPED_INSUFFICIENT_POINTS');
    expect(sched2.visibilityRunId).toBeNull();
    expect(sched2.skipReason).toContain('点数不足');
  });

  it('triggers normally in SHADOW mode even with 0 points', async () => {
    const h = createHarness({
      tenants: [
        {
          id: 'tenant_a',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'SHADOW',
          available: 0,
        },
      ],
    });
    const rec = h.seedPublishRecord({ publishedAt: new Date('2026-10-01T00:00:00Z') });
    await runInTenant('tenant_a', async () => {
      await h.service.ensureSchedulesForPublishRecord(rec, { milestones: [7] });
    });

    const report = await h.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(report.triggered).toBe(1);
    expect(report.skippedInsufficientPoints).toBe(0);
    expect(h.createRunMock).toHaveBeenCalledTimes(1);
    expect(h.tenants.get('tenant_a')!.available).toBe(0);
  });

  it('marks SKIPPED_NO_ENGINE when zero online engines exist for market', async () => {
    const h = createHarness({
      engines: [
        { key: 'doubao', available: false },
        { key: 'deepseek', available: false },
      ],
    });
    const rec = h.seedPublishRecord({ publishedAt: new Date('2026-10-01T00:00:00Z') });
    await runInTenant('tenant_a', async () => {
      await h.service.ensureSchedulesForPublishRecord(rec, { milestones: [7] });
    });

    const report = await h.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(report.skippedNoEngine).toBe(1);
    expect(report.triggered).toBe(0);
    expect(h.createRunMock).not.toHaveBeenCalled();
    const sched = [...h.schedules.values()][0]!;
    expect(sched.status).toBe('SKIPPED_NO_ENGINE');
    expect(sched.visibilityRunId).toBeNull();
  });

  it('marks CANCELLED for inactive or expired tenants without calling createRun', async () => {
    const h = createHarness({
      tenants: [
        {
          id: 'tenant_inactive',
          isActive: false,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'STRICT',
          available: 100,
        },
        {
          id: 'tenant_expired',
          isActive: true,
          expiresAt: new Date('2026-10-05T00:00:00Z'),
          billingMode: 'STRICT',
          available: 100,
        },
      ],
    });
    const r1 = h.seedPublishRecord({
      id: 'pub_inactive',
      tenantId: 'tenant_inactive',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const r2 = h.seedPublishRecord({
      id: 'pub_expired',
      tenantId: 'tenant_expired',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
    });
    await runInTenant('tenant_inactive', async () => {
      await h.service.ensureSchedulesForPublishRecord(r1, { milestones: [7] });
    });
    await runInTenant('tenant_expired', async () => {
      await h.service.ensureSchedulesForPublishRecord(r2, { milestones: [7] });
    });

    const report = await h.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(report.skippedInactiveTenant).toBe(2);
    expect(report.triggered).toBe(0);
    expect(h.createRunMock).not.toHaveBeenCalled();
    expect([...h.schedules.values()].every((s) => s.status === 'CANCELLED')).toBe(true);
  });

  it('marks FAILED on unexpected error (never stuck RUNNING) and continues processing remaining batch items', async () => {
    let callCount = 0;
    const h = createHarness({
      createRunImpl: async (brandId, _input, idempotencyKey) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('Redis enqueue timeout');
        }
        return {
          id: deriveVisibilityRunId(currentTenantId()!, idempotencyKey),
          brandId,
        } as unknown as Awaited<ReturnType<RetestRunCreator['createRun']>>;
      },
    });
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const r1 = h.seedPublishRecord({ id: 'pub_1', publishedAt });
    const r2 = h.seedPublishRecord({ id: 'pub_2', publishedAt });
    await runInTenant('tenant_a', async () => {
      await h.service.ensureSchedulesForPublishRecord(r1, { milestones: [7] });
      await h.service.ensureSchedulesForPublishRecord(r2, { milestones: [7] });
    });

    const report = await h.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(report.failed).toBe(1);
    expect(report.triggered).toBe(1);

    const list = [...h.schedules.values()].sort((a, b) => a.id.localeCompare(b.id));
    expect(list[0]?.status).toBe('FAILED');
    expect(list[0]?.visibilityRunId).toBeNull();
    expect(list[0]?.skipReason).toContain('Redis enqueue timeout');
    expect(list[1]?.status).toBe('RUNNING');
    expect(list[1]?.visibilityRunId).toBeTruthy();
  });

  it('keeps schedule RUNNING with visibilityRunId intact when secondary geoPublishRecord.updateMany fails after createRun succeeds', async () => {
    const h = createHarness();
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const rec = h.seedPublishRecord({ id: 'pub_ptr_fail', publishedAt });

    await runInTenant('tenant_a', async () => {
      await h.service.ensureSchedulesForPublishRecord(rec, { milestones: [7] });
    });

    (
      h.prisma.scoped.geoPublishRecord.updateMany as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('transient DB deadlock on publishRecord pointer sync'));

    const report = await h.service.runDueSweep({ now: new Date('2026-10-10T00:00:00Z') });
    expect(report.triggered).toBe(1);
    expect(report.failed).toBe(0);
    expect(h.createRunMock).toHaveBeenCalledTimes(1);

    const sched = [...h.schedules.values()][0]!;
    expect(sched.status).toBe('RUNNING');
    expect(sched.visibilityRunId).toBe(deriveVisibilityRunId('tenant_a', `sched:${sched.id}`));
    expect(sched.skipReason).toBeNull();
  });
});
