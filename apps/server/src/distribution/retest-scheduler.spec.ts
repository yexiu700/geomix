import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  API_ERROR,
  AUTH_ERROR,
  computeDifferenceInDifferences,
  computeWilsonInterval,
  parseEnv,
} from '@geomix/shared';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import type { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { PrismaService } from '../prisma/prisma.service';
import type {
  RetestBrandMarketLike,
  RetestMetricsHookService,
  RetestObservationLike,
} from '../studio/retest-metrics-hook.service';
import { currentTenantId, runInTenant } from '../tenant/tenant-context';
import { readVisibilityConfig } from '../visibility/visibility.config';
import { deriveVisibilityRunId } from '../visibility/visibility.mapper';
import type { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import { DistributionService } from './distribution.service';
import {
  RetestSchedulerService,
  computeRetestEstimatedPoints,
  ensureRetestSchedulesForPublishRecord,
  retestBudgetEstimateQuerySchema,
  selectRetestControlPrompts,
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
  includeControlPrompts?: boolean;
  dueAt: Date;
  status: string;
  visibilityRunId: string | null;
  metricsSnapshotJson: unknown;
  controlMetricsJson?: unknown;
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
  retestMetricsHook?: RetestMetricsHookService;
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
      publishedUrl: string;
      publishedAt: Date;
      baselineRunId?: string | null;
      beforeMetrics?: unknown;
      latestRetestRunId: string | null;
      afterMetrics: unknown;
      article: { id: string; title: string; targetPrompt: string };
      brandMarket: {
        id: string;
        market: 'CN' | 'GLOBAL';
        localBrandName: string;
        controlPrompts?: string[];
      };
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

  const visibilityRuns = new Map<
    string,
    {
      id: string;
      tenantId: string;
      brandId: string;
      brandMarketId: string;
      status: string;
      triggerType?: string;
      retestArticleId?: string | null;
      prompts?: string[];
      lastError: string | null;
      finishedAt: Date | null;
      brandMarket?: RetestBrandMarketLike | null;
      observations?: RetestObservationLike[];
    }
  >();

  const visibilityObservations: Array<
    RetestObservationLike & {
      tenantId: string;
      brandId: string;
      brandMarketId: string;
      runId: string;
      createdAt: Date;
    }
  > = [];

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
      visibilityRun: {
        findFirst: vi.fn(
          async (args: { where: { id?: string; brandId?: string; brandMarketId?: string } }) => {
            const tid = currentTenantId();
            const run = args.where.id ? visibilityRuns.get(args.where.id) : undefined;
            if (!run || run.tenantId !== tid) return null;
            if (args.where.brandId && run.brandId !== args.where.brandId) return null;
            if (args.where.brandMarketId && run.brandMarketId !== args.where.brandMarketId) {
              return null;
            }
            return run;
          },
        ),
      },
      visibilityObservation: {
        findMany: vi.fn(
          async (args: {
            where: {
              brandId?: string;
              brandMarketId?: string;
              runId?: string | { not?: string };
              status?: string;
              createdAt?: { lte?: Date };
            };
          }) => {
            const tid = currentTenantId();
            return visibilityObservations.filter((obs) => {
              if (obs.tenantId !== tid) return false;
              if (args.where.brandId && obs.brandId !== args.where.brandId) return false;
              if (args.where.brandMarketId && obs.brandMarketId !== args.where.brandMarketId) {
                return false;
              }
              if (args.where.status && obs.status !== args.where.status) return false;
              if (typeof args.where.runId === 'string' && obs.runId !== args.where.runId) {
                return false;
              }
              if (
                args.where.runId &&
                typeof args.where.runId === 'object' &&
                args.where.runId.not &&
                obs.runId === args.where.runId.not
              ) {
                return false;
              }
              if (
                args.where.createdAt?.lte &&
                obs.createdAt.getTime() > args.where.createdAt.lte.getTime()
              ) {
                return false;
              }
              return true;
            });
          },
        ),
      },
      geoPublishRecord: {
        findFirst: vi.fn(
          async (args: {
            where: { id?: string; brandId?: string; brandMarketId?: string };
            include?: { retestSchedules?: { where?: { status?: string } } | boolean };
          }) => {
            const tid = currentTenantId();
            const rec = args.where.id ? publishRecords.get(args.where.id) : undefined;
            if (!rec || rec.tenantId !== tid) return null;
            if (args.where.brandId && rec.brandId !== args.where.brandId) return null;
            if (args.where.brandMarketId && rec.brandMarketId !== args.where.brandMarketId) {
              return null;
            }
            if (args.include?.retestSchedules) {
              const statusFilter =
                typeof args.include.retestSchedules === 'object'
                  ? args.include.retestSchedules.where?.status
                  : undefined;
              const retestSchedules = [...schedules.values()]
                .filter(
                  (s) =>
                    s.tenantId === tid &&
                    s.publishRecordId === rec.id &&
                    (!statusFilter || s.status === statusFilter),
                )
                .sort((a, b) => a.milestoneDay - b.milestoneDay || a.id.localeCompare(b.id));
              return { ...rec, retestSchedules };
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
                rec.afterMetrics =
                  args.data.afterMetrics === Prisma.JsonNull ? null : args.data.afterMetrics;
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
              includeControlPrompts?: boolean;
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
                includeControlPrompts: Boolean(item.includeControlPrompts),
                dueAt: item.dueAt,
                status: item.status,
                visibilityRunId: null,
                metricsSnapshotJson: null,
                controlMetricsJson: null,
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
        findFirst: vi.fn(async (args: { where: { id?: string } }) => {
          const tid = currentTenantId();
          const row = args.where.id ? schedules.get(args.where.id) : undefined;
          if (!row || row.tenantId !== tid) return null;
          return row;
        }),
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
        const promptCount = Math.max(1, input.prompts.length);
        const cost = promptCount * input.engines.length * (input.sampleCount ?? 1) * unitPrice;
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
    opts?.retestMetricsHook,
  );

  function seedPublishRecord(overrides?: {
    id?: string;
    tenantId?: string;
    market?: 'CN' | 'GLOBAL';
    publishedAt?: Date;
    publishedUrl?: string;
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
      publishedUrl: overrides?.publishedUrl ?? 'https://blog.acme.example/retest-post',
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
    visibilityRuns,
    visibilityObservations,
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
      skippedBudgetCap: 0,
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

  it('S-03: runDueSweep self-heals stuck RUNNING schedules whose linked VisibilityRun is FAILED, CANCELLED, or missing/stale while keeping active RUNNING runs intact', async () => {
    const h = createHarness();
    const now = new Date('2026-10-15T12:00:00Z');
    const oldTime = new Date('2026-10-15T11:30:00Z');

    // Seed 4 RUNNING schedules: linked FAILED, linked CANCELLED, orphaned missing run (>10m old), and still-active RUNNING
    h.schedules.set('sched_failed', {
      id: 'sched_failed',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      publishRecordId: 'pub_1',
      milestoneDay: 7,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_failed_1',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    h.schedules.set('sched_cancelled', {
      id: 'sched_cancelled',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      publishRecordId: 'pub_1',
      milestoneDay: 14,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_cancelled_1',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    h.schedules.set('sched_orphan', {
      id: 'sched_orphan',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      publishRecordId: 'pub_1',
      milestoneDay: 30,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_missing_999',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    h.schedules.set('sched_active', {
      id: 'sched_active',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      publishRecordId: 'pub_2',
      milestoneDay: 7,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_active_1',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });

    h.visibilityRuns.set('run_failed_1', {
      id: 'run_failed_1',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      status: 'FAILED',
      lastError: 'All SonarGate checks timed out',
      finishedAt: new Date('2026-10-15T11:45:00Z'),
    });
    h.visibilityRuns.set('run_cancelled_1', {
      id: 'run_cancelled_1',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      status: 'CANCELLED',
      lastError: null,
      finishedAt: new Date('2026-10-15T11:46:00Z'),
    });
    h.visibilityRuns.set('run_active_1', {
      id: 'run_active_1',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      status: 'RUNNING',
      lastError: null,
      finishedAt: null,
    });

    await h.service.runDueSweep({ now });

    expect(h.schedules.get('sched_failed')?.status).toBe('FAILED');
    expect(h.schedules.get('sched_failed')?.skipReason).toContain('SonarGate checks timed out');
    expect(h.schedules.get('sched_failed')?.executedAt).toBeInstanceOf(Date);

    expect(h.schedules.get('sched_cancelled')?.status).toBe('CANCELLED');
    expect(h.schedules.get('sched_cancelled')?.skipReason).toContain('取消');

    expect(h.schedules.get('sched_orphan')?.status).toBe('FAILED');
    expect(h.schedules.get('sched_orphan')?.skipReason).toContain('缺失');

    expect(h.schedules.get('sched_active')?.status).toBe('RUNNING');
  });

  it('R2-S-04: reconciles RUNNING schedules on COMPLETED/PARTIAL runs past 2m grace window (with metrics writeback or FAILED on 0 successes) while respecting the 2m grace window', async () => {
    const hookMock = {
      name: 'geo-retest-metrics-writeback',
      onVisibilityRunComplete: vi.fn(async () => {
        // Simulate hook transiently swallowing an error and leaving schedule in RUNNING,
        // proving the guaranteed prisma.scoped fallback completes reconciliation cleanly.
      }),
    } as unknown as RetestMetricsHookService;

    const h = createHarness({ retestMetricsHook: hookMock });
    const now = new Date('2026-10-15T12:00:00Z');
    const oldFinishedAt = new Date('2026-10-15T11:50:00Z'); // 10m ago (> 2m grace)
    const recentFinishedAt = new Date('2026-10-15T11:59:00Z'); // 1m ago (< 2m grace)
    const oldTime = new Date('2026-10-15T11:30:00Z');

    h.seedPublishRecord({
      id: 'pub_completed',
      publishedUrl: 'https://blog.acme.example/power-station-guide',
    });
    h.seedPublishRecord({
      id: 'pub_zero_success',
      publishedUrl: 'https://blog.acme.example/zero-success',
    });
    h.seedPublishRecord({
      id: 'pub_grace',
      publishedUrl: 'https://blog.acme.example/in-grace',
    });

    const bm: RetestBrandMarketLike = {
      localBrandName: 'Acme Energy',
      aliases: ['Acme'],
      ownedDomains: ['blog.acme.example'],
      competitors: [],
    };

    // (a) COMPLETED run >2m old with SUCCESS observations -> RUNNING -> COMPLETED with metrics writeback
    h.schedules.set('sched_completed_ok', {
      id: 'sched_completed_ok',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      publishRecordId: 'pub_completed',
      milestoneDay: 7,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_completed_ok',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    h.visibilityRuns.set('run_completed_ok', {
      id: 'run_completed_ok',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      status: 'COMPLETED',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      lastError: null,
      finishedAt: oldFinishedAt,
      brandMarket: bm,
      observations: [
        {
          id: 'obs_1',
          status: 'SUCCESS',
          promptText: 'best power station',
          answerText: 'Acme Energy is #1.',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          competitorHits: [],
          citations: [
            {
              url: 'https://blog.acme.example/power-station-guide',
              domain: 'blog.acme.example',
              sourceKind: 'OWNED',
            },
          ],
        },
      ],
    });

    // (b) PARTIAL run >2m old with 0 SUCCESS observations -> RUNNING -> FAILED
    h.schedules.set('sched_partial_empty', {
      id: 'sched_partial_empty',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      publishRecordId: 'pub_zero_success',
      milestoneDay: 14,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_partial_empty',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    h.visibilityRuns.set('run_partial_empty', {
      id: 'run_partial_empty',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      status: 'PARTIAL',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      lastError: 'Upstream partial failure with zero valid samples',
      finishedAt: oldFinishedAt,
      brandMarket: bm,
      observations: [],
    });

    // (c) COMPLETED run within the 2-minute grace window -> NOT prematurely reconciled
    h.schedules.set('sched_in_grace', {
      id: 'sched_in_grace',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      publishRecordId: 'pub_grace',
      milestoneDay: 30,
      sampleCount: 1,
      dueAt: oldTime,
      status: 'RUNNING',
      visibilityRunId: 'run_in_grace',
      metricsSnapshotJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: oldTime,
      updatedAt: recentFinishedAt,
    });
    h.visibilityRuns.set('run_in_grace', {
      id: 'run_in_grace',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      status: 'COMPLETED',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      lastError: null,
      finishedAt: recentFinishedAt,
      brandMarket: bm,
      observations: [],
    });

    await h.service.runDueSweep({ now });

    // (a) Transitioned RUNNING -> COMPLETED with metrics snapshot & publishRecord.afterMetrics
    const completedSched = h.schedules.get('sched_completed_ok');
    expect(completedSched?.status).toBe('COMPLETED');
    expect(completedSched?.skipReason).toBeNull();
    expect(completedSched?.executedAt).toEqual(oldFinishedAt);
    expect(completedSched?.metricsSnapshotJson).toMatchObject({
      mentionRate: 100,
      avgPosition: 1,
      sentiment: 'positive',
      citationHit: true,
      sampleCount: 1,
      hitCount: 1,
    });
    expect(h.publishRecords.get('pub_completed')?.latestRetestRunId).toBe('run_completed_ok');
    expect(h.publishRecords.get('pub_completed')?.afterMetrics).toMatchObject({
      mentionRate: 100,
      citationHit: true,
    });
    expect(hookMock.onVisibilityRunComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_completed_ok',
        status: 'COMPLETED',
        successCount: 1,
      }),
    );

    // (b) Transitioned RUNNING -> FAILED when 0 SUCCESS observations exist
    const failedSched = h.schedules.get('sched_partial_empty');
    expect(failedSched?.status).toBe('FAILED');
    expect(failedSched?.skipReason).toContain('Upstream partial failure');
    expect(failedSched?.executedAt).toEqual(oldFinishedAt);

    // (c) Within 2-minute grace window -> untouched (stays RUNNING)
    expect(h.schedules.get('sched_in_grace')?.status).toBe('RUNNING');
  });

  it('defaults includeControlPrompts=false, toggles PENDING-only schedules, selects first 2 control prompts, and enforces (target+control)*engines*sampleCount*2 budget in STRICT & SHADOW (#369)', async () => {
    expect(
      selectRetestControlPrompts(
        'Target NAS prompt',
        ['Target NAS prompt', 'Ctrl 1', 'Ctrl 2', 'Ctrl 3'],
        true,
      ),
    ).toEqual(['Ctrl 1', 'Ctrl 2']);
    expect(
      computeRetestEstimatedPoints({
        targetPromptCount: 1,
        controlPromptCount: 2,
        activeEngineCount: 2,
        sampleCount: 3,
        unitPrice: 2,
      }),
    ).toBe(36);

    const h = createHarness({
      tenants: [
        {
          id: 'tenant_strict_low',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'STRICT',
          available: 35, // 1 point short of 36!
        },
        {
          id: 'tenant_strict_ok',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'STRICT',
          available: 36,
        },
        {
          id: 'tenant_shadow',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'SHADOW',
          available: 0,
        },
      ],
    });

    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const dueNow = new Date(publishedAt.getTime() + 8 * DAY_MS);

    for (const [pubId, tid, controlPrompts] of [
      ['pub_low', 'tenant_strict_low', ['Control A', 'Control B', 'Control C']],
      ['pub_ok', 'tenant_strict_ok', ['Control A', 'Control B', 'Control C']],
      ['pub_shadow', 'tenant_shadow', ['Control A', 'Control B', 'Control C']],
      ['pub_no_ctrl', 'tenant_strict_low', []],
    ] as const) {
      h.publishRecords.set(pubId, {
        id: pubId,
        tenantId: tid,
        brandId: 'brand_1',
        brandMarketId: 'bm_cn',
        articleId: `art_${pubId}`,
        publishedUrl: `https://example.com/${pubId}`,
        publishedAt,
        latestRetestRunId: null,
        afterMetrics: null,
        article: { id: `art_${pubId}`, title: '静音 NAS 对比', targetPrompt: 'Target NAS prompt' },
        brandMarket: {
          id: 'bm_cn',
          market: 'CN',
          localBrandName: '星辰存储',
          controlPrompts: [...controlPrompts],
        },
      });
    }

    // Default includeControlPrompts is false
    const defaultCreated = await runInTenant('tenant_strict_low', () =>
      h.service.ensureSchedulesForPublishRecord({
        id: 'pub_low',
        tenantId: 'tenant_strict_low',
        brandId: 'brand_1',
        brandMarketId: 'bm_cn',
        publishedAt,
      }),
    );
    expect(defaultCreated.every((s) => s.includeControlPrompts === false)).toBe(true);

    // Mark T+14 COMPLETED so we verify toggle only mutates PENDING rows
    const sched14 = [...h.schedules.values()].find(
      (s) => s.publishRecordId === 'pub_low' && s.milestoneDay === 14,
    )!;
    sched14.status = 'COMPLETED';

    const toggled = await runInTenant('tenant_strict_low', () =>
      h.service.updateSchedulesForPublishRecord('pub_low', {
        sampleCount: 3,
        includeControlPrompts: true,
      }),
    );
    expect(toggled.find((s) => s.milestoneDay === 7)?.includeControlPrompts).toBe(true);
    expect(toggled.find((s) => s.milestoneDay === 14)?.includeControlPrompts).toBe(false);

    // Create due schedules for pub_ok (STRICT 36pts), pub_shadow (SHADOW 0pts), and pub_no_ctrl (graceful 0-control degradation -> 12pts)
    await runInTenant('tenant_strict_ok', () =>
      h.service.ensureSchedulesForPublishRecord(
        {
          id: 'pub_ok',
          tenantId: 'tenant_strict_ok',
          brandId: 'brand_1',
          brandMarketId: 'bm_cn',
          publishedAt,
        },
        { milestones: [7], sampleCount: 3, includeControlPrompts: true },
      ),
    );
    await runInTenant('tenant_shadow', () =>
      h.service.ensureSchedulesForPublishRecord(
        {
          id: 'pub_shadow',
          tenantId: 'tenant_shadow',
          brandId: 'brand_1',
          brandMarketId: 'bm_cn',
          publishedAt,
        },
        { milestones: [7], sampleCount: 3, includeControlPrompts: true },
      ),
    );
    await runInTenant('tenant_strict_low', () =>
      h.service.ensureSchedulesForPublishRecord(
        {
          id: 'pub_no_ctrl',
          tenantId: 'tenant_strict_low',
          brandId: 'brand_1',
          brandMarketId: 'bm_cn',
          publishedAt,
        },
        { milestones: [7], sampleCount: 3, includeControlPrompts: true },
      ),
    );

    const report = await h.service.runDueSweep({ now: dueNow });
    expect(report.skippedInsufficientPoints).toBe(1);
    expect(report.triggered).toBe(3);

    // STRICT low (35 < 36) -> SKIPPED_INSUFFICIENT_POINTS, zero deduction on pub_low,
    // while pub_no_ctrl gracefully degraded to 1 prompt * 2 engines * 3 samples * 2 = 12 pts -> wallet 35 - 12 = 23 (never negative!)
    const lowSched = [...h.schedules.values()].find(
      (s) => s.publishRecordId === 'pub_low' && s.milestoneDay === 7,
    )!;
    expect(lowSched.status).toBe('SKIPPED_INSUFFICIENT_POINTS');
    expect(lowSched.skipReason).toContain('36 点');
    expect(lowSched.skipReason).toContain('含 2 条对照');
    expect(h.tenants.get('tenant_strict_low')!.available).toBe(23);

    // STRICT exact 36 pts -> triggered with 3 prompts (target + first 2 controlPrompts), wallet becomes 0
    expect(h.tenants.get('tenant_strict_ok')!.available).toBe(0);
    // SHADOW 0 pts -> triggered with 3 prompts, wallet stays 0
    expect(h.tenants.get('tenant_shadow')!.available).toBe(0);

    const createCalls = h.createRunMock.mock.calls;
    const promptsPassed = createCalls.map((call) => call[1].prompts);
    expect(promptsPassed).toContainEqual(['Target NAS prompt', 'Control A', 'Control B']);
    expect(promptsPassed).toContainEqual(['Target NAS prompt']); // pub_no_ctrl graceful 0-control degradation
  });

  it('exposes live budget estimate via estimateBudgetForPublishRecord and GET /api/v2/publish-records/:id/retest-budget (#369)', async () => {
    const h = createHarness({
      tenants: [
        {
          id: 'tenant_a',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'STRICT',
          available: 30,
        },
        {
          id: 'tenant_b',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          billingMode: 'SHADOW',
          available: 0,
        },
      ],
    });
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    h.publishRecords.set('pub_budget_1', {
      id: 'pub_budget_1',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      articleId: 'art_budget_1',
      publishedUrl: 'https://example.com/budget',
      publishedAt,
      latestRetestRunId: null,
      afterMetrics: null,
      article: { id: 'art_budget_1', title: '静音 NAS', targetPrompt: 'Target NAS prompt' },
      brandMarket: {
        id: 'bm_cn',
        market: 'CN',
        localBrandName: '星辰存储',
        controlPrompts: ['Ctrl 1', 'Ctrl 2', 'Ctrl 3'],
      },
    });
    await runInTenant('tenant_a', () =>
      h.service.ensureSchedulesForPublishRecord({
        id: 'pub_budget_1',
        tenantId: 'tenant_a',
        brandId: 'brand_1',
        brandMarketId: 'bm_cn',
        publishedAt,
      }),
    );

    const withoutCtrl = await runInTenant('tenant_a', () =>
      h.service.estimateBudgetForPublishRecord('pub_budget_1', 'tenant_a', {
        includeControlPrompts: false,
        sampleCount: 1,
      }),
    );
    expect(withoutCtrl).toMatchObject({
      publishRecordId: 'pub_budget_1',
      targetPromptCount: 1,
      configuredControlPromptCount: 3,
      effectiveControlPromptCount: 0,
      totalPromptCount: 1,
      activeEngineCount: 2,
      sampleCount: 1,
      unitPrice: 2,
      perRunPoints: 4,
      pendingMilestoneCount: 3,
      totalEstimatedPoints: 12,
      billingMode: 'STRICT',
      walletAvailable: 30,
      sufficientForNextRun: true,
      sufficientForAllPending: true,
    });

    const withCtrl = await runInTenant('tenant_a', () =>
      h.service.estimateBudgetForPublishRecord('pub_budget_1', 'tenant_a', {
        includeControlPrompts: true,
        sampleCount: 3,
      }),
    );
    expect(withCtrl).toMatchObject({
      effectiveControlPromptCount: 2,
      selectedControlPrompts: ['Ctrl 1', 'Ctrl 2'],
      totalPromptCount: 3,
      perRunPoints: 36,
      totalEstimatedPoints: 108,
      sufficientForNextRun: false,
      sufficientForAllPending: false,
    });

    // Cross-tenant 404
    await expect(
      runInTenant('tenant_b', () =>
        h.service.estimateBudgetForPublishRecord('pub_budget_1', 'tenant_b'),
      ),
    ).rejects.toMatchObject({ status: 404 });

    // HTTP endpoint test via real ApiModule / DistributionController
    const env = parseEnv(process.env);
    const app = await createApiApp();
    const future = new Date(Date.now() + 30 * 86_400_000);
    const prismaSvc = app.get(PrismaService) as unknown as { base: unknown; scoped: unknown };
    const authUsers: Record<string, unknown> = {
      u_a: {
        id: 'u_a',
        tenantId: 'tenant_a',
        username: 'u_a',
        nickname: 'User A',
        role: 'MERCHANT',
        status: 'ACTIVE',
        passwordHash: 'pw_a',
        lastLoginAt: null,
        tenant: { id: 'tenant_a', name: 'Tenant A', isActive: true, expiresAt: future },
      },
      u_b: {
        id: 'u_b',
        tenantId: 'tenant_b',
        username: 'u_b',
        nickname: 'User B',
        role: 'MERCHANT',
        status: 'ACTIVE',
        passwordHash: 'pw_b',
        lastLoginAt: null,
        tenant: { id: 'tenant_b', name: 'Tenant B', isActive: true, expiresAt: future },
      },
    };
    const mockAuthPrisma = {
      $disconnect: async () => undefined,
      auditLog: {
        findMany: async () => [],
        create: async () => ({ id: 'audit_1' }),
      },
      user: {
        findUnique: async (args: { where: { id?: string } }) =>
          (args.where.id ? authUsers[args.where.id] : null) ?? null,
      },
    };
    prismaSvc.base = mockAuthPrisma;
    prismaSvc.scoped = mockAuthPrisma;

    const distService = app.get(DistributionService);
    vi.spyOn(distService, 'estimateRetestBudget').mockImplementation((pubId, auth, query) =>
      h.service.estimateBudgetForPublishRecord(pubId, auth.tenantId, query),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const tokenA = signToken(
      {
        sub: 'u_a',
        tid: 'tenant_a',
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('pw_a'),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );
    const tokenB = signToken(
      {
        sub: 'u_b',
        tid: 'tenant_b',
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('pw_b'),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const okRes = await fetch(
        `${baseUrl}/api/v2/publish-records/pub_budget_1/retest-budget?includeControlPrompts=true&sampleCount=3`,
        { headers: { Authorization: `Bearer ${tokenA}` } },
      );
      expect(okRes.status).toBe(200);
      const okBody = (await okRes.json()) as {
        data: { perRunPoints: number; selectedControlPrompts: string[] };
      };
      expect(okBody.data.perRunPoints).toBe(36);
      expect(okBody.data.selectedControlPrompts).toEqual(['Ctrl 1', 'Ctrl 2']);

      // Invalid sampleCount -> 400
      const badRes = await fetch(
        `${baseUrl}/api/v2/publish-records/pub_budget_1/retest-budget?sampleCount=2`,
        { headers: { Authorization: `Bearer ${tokenA}` } },
      );
      expect(badRes.status).toBe(400);

      // Defect 4: partially invalid milestones query tokens MUST return 400 (never silently stripped)
      expect(retestBudgetEstimateQuerySchema.safeParse({ milestones: '7,abc' }).success).toBe(
        false,
      );
      expect(
        retestBudgetEstimateQuerySchema.safeParse({ milestones: '7,Infinity,NaN' }).success,
      ).toBe(false);
      expect(retestBudgetEstimateQuerySchema.safeParse({ milestones: '7,' }).success).toBe(false);
      expect(retestBudgetEstimateQuerySchema.safeParse({ milestones: '7,14,30' }).success).toBe(
        true,
      );

      const badMilestones1 = await fetch(
        `${baseUrl}/api/v2/publish-records/pub_budget_1/retest-budget?milestones=7,abc`,
        { headers: { Authorization: `Bearer ${tokenA}` } },
      );
      expect(badMilestones1.status).toBe(400);

      const badMilestones2 = await fetch(
        `${baseUrl}/api/v2/publish-records/pub_budget_1/retest-budget?milestones=7,Infinity,NaN`,
        { headers: { Authorization: `Bearer ${tokenA}` } },
      );
      expect(badMilestones2.status).toBe(400);

      // Defect 5: selectRetestControlPrompts with maxCount <= 0 returns []
      expect(
        selectRetestControlPrompts('Target', ['Control Alpha', 'Control Beta'], true, 0),
      ).toEqual([]);
      expect(
        selectRetestControlPrompts('Target', ['Control Alpha', 'Control Beta'], true, -2),
      ).toEqual([]);

      // Cross-tenant -> 404
      const crossRes = await fetch(`${baseUrl}/api/v2/publish-records/pub_budget_1/retest-budget`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      expect(crossRes.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('reconcileStaleRunningSchedules partitions control observations and persists Wilson CI + DiD in controlMetricsJson (#369)', async () => {
    const h = createHarness();
    const now = new Date('2026-10-15T12:00:00Z');
    const oldFinishedAt = new Date(now.getTime() - 10 * 60 * 1000);
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const targetPrompt = 'Target quiet NAS';
    const ctrlPrompt = 'Control router query';

    h.publishRecords.set('pub_rec_did', {
      id: 'pub_rec_did',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      articleId: 'art_did',
      publishedUrl: 'https://xingchen.example/nas',
      publishedAt,
      baselineRunId: 'run_base_1',
      beforeMetrics: { mentionRate: 25, avgPosition: 3, sentiment: 'neutral', citationHit: false },
      latestRetestRunId: 'run_reconcile_did',
      afterMetrics: null,
      article: { id: 'art_did', title: '静音 NAS', targetPrompt },
      brandMarket: {
        id: 'bm_cn',
        market: 'CN',
        localBrandName: '星辰存储',
        controlPrompts: [ctrlPrompt],
      },
    });

    h.visibilityObservations.push(
      {
        id: 'base_c1',
        tenantId: 'tenant_a',
        brandId: 'brand_1',
        brandMarketId: 'bm_cn',
        runId: 'run_base_1',
        status: 'SUCCESS',
        promptText: ctrlPrompt,
        answerText: '星辰存储',
        brandMentioned: true,
        brandPosition: 2,
        brandSentiment: 'neutral',
        competitorHits: [],
        citations: [],
        createdAt: new Date('2026-09-28T00:00:00Z'),
      },
      {
        id: 'base_c2',
        tenantId: 'tenant_a',
        brandId: 'brand_1',
        brandMarketId: 'bm_cn',
        runId: 'run_base_1',
        status: 'SUCCESS',
        promptText: ctrlPrompt,
        answerText: '竞品',
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: 'neutral',
        competitorHits: [],
        citations: [],
        createdAt: new Date('2026-09-28T00:00:01Z'),
      },
    );

    h.schedules.set('sched_rec_did', {
      id: 'sched_rec_did',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      publishRecordId: 'pub_rec_did',
      milestoneDay: 7,
      sampleCount: 1,
      includeControlPrompts: true,
      dueAt: new Date('2026-10-08T00:00:00Z'),
      status: 'RUNNING',
      visibilityRunId: 'run_reconcile_did',
      metricsSnapshotJson: null,
      controlMetricsJson: null,
      skipReason: null,
      executedAt: null,
      createdAt: publishedAt,
      updatedAt: oldFinishedAt,
    });

    h.visibilityRuns.set('run_reconcile_did', {
      id: 'run_reconcile_did',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_cn',
      status: 'COMPLETED',
      triggerType: 'RETEST',
      retestArticleId: 'art_did',
      prompts: [targetPrompt, ctrlPrompt],
      lastError: null,
      finishedAt: oldFinishedAt,
      brandMarket: {
        localBrandName: '星辰存储',
        aliases: [],
        ownedDomains: ['xingchen.example'],
        competitors: [],
        controlPrompts: [ctrlPrompt],
      },
      observations: [
        {
          id: 'o_t1',
          status: 'SUCCESS',
          promptText: targetPrompt,
          answerText: '星辰存储推荐',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          competitorHits: [],
          citations: [
            {
              url: 'https://xingchen.example/nas',
              domain: 'xingchen.example',
              sourceKind: 'OWNED',
            },
          ],
        },
        {
          id: 'o_c1',
          status: 'SUCCESS',
          promptText: ctrlPrompt,
          answerText: '星辰存储',
          brandMentioned: true,
          brandPosition: 2,
          brandSentiment: 'neutral',
          competitorHits: [],
          citations: [],
        },
        {
          id: 'o_c2',
          status: 'SUCCESS',
          promptText: ctrlPrompt,
          answerText: '其他品牌',
          brandMentioned: false,
          brandPosition: null,
          brandSentiment: 'neutral',
          competitorHits: [],
          citations: [],
        },
      ],
    });

    await h.service.runDueSweep({ now });

    const updated = h.schedules.get('sched_rec_did')!;
    expect(updated.status).toBe('COMPLETED');
    expect(updated.metricsSnapshotJson).toEqual({
      mentionRate: 100,
      avgPosition: 1,
      sentiment: 'positive',
      citationHit: true,
      sampleCount: 1,
      hitCount: 1,
      wilson: computeWilsonInterval(1, 1),
      confidenceLevel: 'LOW',
    });
    expect(updated.controlMetricsJson).toEqual({
      controlPrompts: [ctrlPrompt],
      baselineMentionRate: 50,
      currentMentionRate: 50,
      sampleCount: 2,
      hitCount: 1,
      wilson: computeWilsonInterval(1, 2),
      did: computeDifferenceInDifferences({
        treatmentBaseline: 0.25,
        treatmentCurrent: 1,
        controlBaseline: 0.5,
        controlCurrent: 0.5,
      }),
    });
  });

  it('Tier 5 regression: preserves includeControlPrompts and sampleCount when reopening a CANCELLED milestone with zero PENDING schedules remaining', async () => {
    const h = createHarness();
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const rec = h.seedPublishRecord({
      id: 'pub_reopen_did',
      publishedAt,
    });

    await runInTenant('tenant_a', async () => {
      await h.service.ensureSchedulesForPublishRecord(rec, {
        milestones: [7, 14],
        sampleCount: 3,
        includeControlPrompts: true,
      });

      // Mark T+7 COMPLETED and T+14 CANCELLED so ZERO PENDING schedules remain
      for (const sched of h.schedules.values()) {
        if (sched.milestoneDay === 7) {
          sched.status = 'COMPLETED';
        } else if (sched.milestoneDay === 14) {
          sched.status = 'CANCELLED';
        }
      }

      // Reopen T+14 without explicitly passing includeControlPrompts or sampleCount
      const updated = await h.service.updateSchedulesForPublishRecord(rec.id, {
        enabled: true,
        milestones: [14],
      });

      const t14 = updated.find((s) => s.milestoneDay === 14)!;
      expect(t14.status).toBe('PENDING');
      expect(t14.includeControlPrompts).toBe(true);
      expect(t14.sampleCount).toBe(3);
    });
  });

  it('Tier 5 iter2 regression: reopening CANCELLED milestones with stale COMPLETED T+7 preserves CANCELLED sampleCount & includeControlPrompts across full resume, single milestone reopen, and distinct per-milestone settings', async () => {
    const h = createHarness();
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const rec = h.seedPublishRecord({
      id: 'pub_mixed_reopen',
      publishedAt,
    });

    await runInTenant('tenant_a', async () => {
      // Seed T+7, T+14, T+30 at (1, false)
      await h.service.ensureSchedulesForPublishRecord(rec, {
        milestones: [7, 14, 30],
        sampleCount: 1,
        includeControlPrompts: false,
      });

      // T+7 completes at (1, false); user upgrades remaining PENDING rows to (3, true), then pauses all
      for (const sched of h.schedules.values()) {
        if (sched.milestoneDay === 7) {
          sched.status = 'COMPLETED';
        }
      }
      await h.service.updateSchedulesForPublishRecord(rec.id, {
        sampleCount: 3,
        includeControlPrompts: true,
      });
      await h.service.updateSchedulesForPublishRecord(rec.id, { enabled: false });

      // Resume all via { enabled: true }: must preserve (3, true) on T+14 & T+30 (not clobber with T+7's 1/false)
      const resumedAll = await h.service.updateSchedulesForPublishRecord(rec.id, {
        enabled: true,
      });
      expect(resumedAll.find((s) => s.milestoneDay === 7)).toMatchObject({
        status: 'COMPLETED',
        sampleCount: 1,
        includeControlPrompts: false,
      });
      expect(resumedAll.find((s) => s.milestoneDay === 14)).toMatchObject({
        status: 'PENDING',
        sampleCount: 3,
        includeControlPrompts: true,
      });
      expect(resumedAll.find((s) => s.milestoneDay === 30)).toMatchObject({
        status: 'PENDING',
        sampleCount: 3,
        includeControlPrompts: true,
      });

      // Pause again and give T+30 distinct persisted settings (1, false) while T+14 remains (3, true)
      await h.service.updateSchedulesForPublishRecord(rec.id, { enabled: false });
      for (const sched of h.schedules.values()) {
        if (sched.milestoneDay === 30) {
          sched.sampleCount = 1;
          sched.includeControlPrompts = false;
        }
      }

      // Reopen T+14 only via { enabled: true, milestones: [14] }
      const reopenedT14 = await h.service.updateSchedulesForPublishRecord(rec.id, {
        enabled: true,
        milestones: [14],
      });
      expect(reopenedT14.find((s) => s.milestoneDay === 14)).toMatchObject({
        status: 'PENDING',
        sampleCount: 3,
        includeControlPrompts: true,
      });
      expect(reopenedT14.find((s) => s.milestoneDay === 30)).toMatchObject({
        status: 'CANCELLED',
        sampleCount: 1,
        includeControlPrompts: false,
      });

      // Pause T+14 again so zero PENDING rows exist, then resume all: each CANCELLED row keeps its own settings
      await h.service.updateSchedulesForPublishRecord(rec.id, { enabled: false });
      const resumedDistinct = await h.service.updateSchedulesForPublishRecord(rec.id, {
        enabled: true,
      });
      expect(resumedDistinct.find((s) => s.milestoneDay === 14)).toMatchObject({
        status: 'PENDING',
        sampleCount: 3,
        includeControlPrompts: true,
      });
      expect(resumedDistinct.find((s) => s.milestoneDay === 30)).toMatchObject({
        status: 'PENDING',
        sampleCount: 1,
        includeControlPrompts: false,
      });
    });
  });

  it('Tier 5 iter2 regression: creating a brand-new missing milestone inherits from CANCELLED (3, true) rather than stale COMPLETED T+7 (1, false)', async () => {
    const h = createHarness();
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const rec = h.seedPublishRecord({
      id: 'pub_mixed_create_missing',
      publishedAt,
    });

    await runInTenant('tenant_a', async () => {
      await h.service.ensureSchedulesForPublishRecord(rec, {
        milestones: [7, 14],
        sampleCount: 1,
        includeControlPrompts: false,
      });

      for (const sched of h.schedules.values()) {
        if (sched.milestoneDay === 7) {
          sched.status = 'COMPLETED';
          sched.sampleCount = 1;
          sched.includeControlPrompts = false;
        } else if (sched.milestoneDay === 14) {
          sched.status = 'CANCELLED';
          sched.sampleCount = 3;
          sched.includeControlPrompts = true;
        }
      }

      // Create brand-new T+30 when T+7 is COMPLETED (1, false) and T+14 is CANCELLED (3, true)
      const updated = await h.service.updateSchedulesForPublishRecord(rec.id, {
        enabled: true,
        milestones: [30],
      });

      expect(updated.find((s) => s.milestoneDay === 30)).toMatchObject({
        status: 'PENDING',
        sampleCount: 3,
        includeControlPrompts: true,
      });
      // T+14 was not requested, remains CANCELLED (3, true)
      expect(updated.find((s) => s.milestoneDay === 14)).toMatchObject({
        status: 'CANCELLED',
        sampleCount: 3,
        includeControlPrompts: true,
      });
    });
  });
});
