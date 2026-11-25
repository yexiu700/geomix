import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { BrandsService } from '../brands/brands.service';
import { createIsolatedTestContext, type IsolatedTestContext } from '../common/test-db';
import type { PrismaService } from '../prisma/prisma.service';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import type { VisibilityService } from '../visibility/visibility.service';
import type { VisibilityConfig } from '../visibility/visibility.config';
import {
  RetestSchedulerService,
  computeMonthlyRetestBudgetUsage,
  type RetestRunCreator,
} from './retest-scheduler.service';

describe('Monthly Retest Budget Soft Cap (SKIPPED_BUDGET_CAP, Shanghai Month Window, SHADOW Accounting & ActionHome)', () => {
  it('enforces Asia/Shanghai natural month boundary and SHADOW PointLog.listPrice + in-flight run accounting', async () => {
    const schedules = [
      // Previous Shanghai month: 2026-10-31 23:59:59+08:00 -> MUST NOT count for 2026-11
      {
        id: 'sched_prev_month',
        status: 'COMPLETED',
        visibilityRunId: 'run_prev',
        executedAt: new Date('2026-10-31T15:59:59.000Z'),
        updatedAt: new Date('2026-10-31T15:59:59.000Z'),
      },
      // Exact start of Nov in Asia/Shanghai: 2026-11-01 00:00:00+08:00 -> MUST count
      {
        id: 'sched_nov_settled',
        status: 'COMPLETED',
        visibilityRunId: 'run_nov_1',
        executedAt: new Date('2026-10-31T16:00:00.000Z'),
        updatedAt: new Date('2026-10-31T16:00:00.000Z'),
      },
      // In-flight schedule in Nov -> counts estimated totalChecks * unitPrice
      {
        id: 'sched_nov_inflight',
        status: 'RUNNING',
        visibilityRunId: 'run_nov_2',
        executedAt: null,
        updatedAt: new Date('2026-11-02T04:00:00.000Z'),
      },
      // Skipped schedule in Nov -> increments skippedCount
      {
        id: 'sched_nov_skipped',
        status: 'SKIPPED_BUDGET_CAP',
        visibilityRunId: null,
        executedAt: new Date('2026-11-03T04:00:00.000Z'),
        updatedAt: new Date('2026-11-03T04:00:00.000Z'),
      },
      // Excluded currently-claimed schedule -> MUST NOT self-count
      {
        id: 'sched_current',
        status: 'RUNNING',
        visibilityRunId: 'run_current',
        executedAt: null,
        updatedAt: new Date('2026-11-05T04:00:00.000Z'),
      },
    ];

    const runs = [
      {
        id: 'run_prev',
        status: 'COMPLETED',
        reservationId: 'res_prev',
        totalChecks: 5,
        doneCount: 5,
        unitPrice: 2,
      },
      {
        id: 'run_nov_1',
        status: 'COMPLETED',
        reservationId: 'res_nov_1',
        totalChecks: 3,
        doneCount: 3,
        unitPrice: 2,
      },
      {
        id: 'run_nov_2',
        status: 'QUEUED',
        reservationId: 'res_nov_2',
        totalChecks: 2,
        doneCount: 0,
        unitPrice: 2,
      },
    ];

    // SHADOW billing settles PointLog with delta=0 and full listPrice=6
    const pointLogs = [
      { reservationId: 'res_nov_1', listPrice: 6 },
      { reservationId: 'res_prev', listPrice: 10 },
    ];

    const scoped = {
      geoRetestSchedule: { findMany: vi.fn(async () => schedules) },
      visibilityRun: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          runs.filter((r) => args.where.id.in.includes(r.id)),
        ),
      },
      pointLog: {
        findMany: vi.fn(async (args: { where: { reservationId: { in: string[] } } }) =>
          pointLogs.filter((l) => args.where.reservationId.in.includes(l.reservationId)),
        ),
      },
    } as unknown as PrismaService['scoped'];

    const summary = await computeMonthlyRetestBudgetUsage(scoped, {
      brandId: 'brand_1',
      brandMarketId: 'bm_global',
      capPoints: 15,
      now: new Date('2026-11-10T08:00:00.000Z'),
      excludeScheduleId: 'sched_current',
    });

    expect(summary).toEqual({
      monthKey: '2026-11',
      capPoints: 15,
      usedPoints: 10, // 6 (settled listPrice) + 4 (in-flight 2*2)
      remainingPoints: 5,
      skippedCount: 1,
    });
  });

  it('marks over-cap schedules SKIPPED_BUDGET_CAP in SHADOW mode, enforces same-sweep cap across consecutive schedules, and allows execution once cap is cleared', async () => {
    let cap: number | null = 5;
    const now = new Date('2026-11-10T08:00:00.000Z');
    const dueSchedules = [
      {
        id: 'sched_1',
        tenantId: 'tenant_a',
        brandId: 'brand_1',
        brandMarketId: 'bm_global',
        publishRecordId: 'pub_1',
        milestoneDay: 7,
        sampleCount: 1,
        includeControlPrompts: false,
        status: 'PENDING',
        visibilityRunId: null as string | null,
        skipReason: null as string | null,
        executedAt: null as Date | null,
        updatedAt: now,
        dueAt: new Date('2026-11-09T00:00:00.000Z'),
        tenant: {
          id: 'tenant_a',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        },
      },
      {
        id: 'sched_2',
        tenantId: 'tenant_a',
        brandId: 'brand_1',
        brandMarketId: 'bm_global',
        publishRecordId: 'pub_2',
        milestoneDay: 14,
        sampleCount: 1,
        includeControlPrompts: false,
        status: 'PENDING',
        visibilityRunId: null as string | null,
        skipReason: null as string | null,
        executedAt: null as Date | null,
        updatedAt: now,
        dueAt: new Date('2026-11-09T01:00:00.000Z'),
        tenant: {
          id: 'tenant_a',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        },
      },
    ];

    const createdRuns: Array<{
      id: string;
      status: string;
      reservationId: string | null;
      totalChecks: number;
      doneCount: number;
      unitPrice: number;
    }> = [];

    const scoped = {
      geoRetestSchedule: {
        findMany: vi.fn(async () => dueSchedules),
        updateMany: vi.fn(
          async (args: {
            where: { id: string; status?: string };
            data: Record<string, unknown>;
          }) => {
            const target = dueSchedules.find(
              (s) =>
                s.id === args.where.id && (!args.where.status || s.status === args.where.status),
            );
            if (!target) return { count: 0 };
            // Mirror Prisma's real @updatedAt wall-clock behavior: only use `now` when explicitly passed.
            const nextUpdatedAt =
              args.data.updatedAt instanceof Date
                ? args.data.updatedAt
                : new Date('2026-12-20T00:00:00.000Z');
            Object.assign(target, args.data, { updatedAt: nextUpdatedAt });
            return { count: 1 };
          },
        ),
      },
      geoPublishRecord: {
        findFirst: vi.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          brandId: 'brand_1',
          brandMarketId: 'bm_global',
          articleId: 'art_1',
          article: {
            id: 'art_1',
            title: 'HeliosPower Field Test',
            targetPrompt: 'Best portable power station',
            productLineId: 'pl_lineA',
          },
          brandMarket: {
            id: 'bm_global',
            market: 'GLOBAL',
            localBrandName: 'NovaTech',
            controlPrompts: [],
            monthlyRetestPointCap: cap,
          },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      visibilityRun: {
        findFirst: vi.fn(
          async (args: { where: { id: string } }) =>
            createdRuns.find((r) => r.id === args.where.id) ?? null,
        ),
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          createdRuns.filter((r) => args.where.id.in.includes(r.id)),
        ),
      },
      pointLog: {
        findMany: vi.fn(async () => []),
      },
    };

    const base = {
      geoRetestSchedule: {
        findMany: vi.fn(async (args: { where: { status: string } }) =>
          dueSchedules.filter((s) => s.status === args.where.status),
        ),
      },
    };

    const billing = {
      unitPrice: vi.fn(async () => 2),
      wallet: vi.fn(async () => ({ billingMode: 'SHADOW' as const, available: 0 })),
    } as unknown as BillingService;

    let runSeq = 1;
    const runLifecycle: RetestRunCreator = {
      createRun: vi.fn(async (_brandId, input) => {
        const id = `run_auto_${runSeq++}`;
        createdRuns.push({
          id,
          status: 'QUEUED',
          reservationId: null,
          totalChecks:
            (input.prompts?.length ?? 1) * input.engines.length * (input.sampleCount ?? 1),
          doneCount: 0,
          unitPrice: 2,
        });
        return { id } as never;
      }),
    };

    const visibilityConfig: VisibilityConfig = {
      featureEnabled: true,
      collector: 'fake',
      judge: 'fake',
      engines: {
        cn: ['deepseek', 'doubao'],
        global: ['chatgpt', 'perplexity'],
      },
    } as unknown as VisibilityConfig;

    const engineHealth = {
      getAvailability: vi.fn(async () => ({
        engines: [
          { key: 'chatgpt', available: true },
          { key: 'perplexity', available: true },
        ],
      })),
    };

    const service = new RetestSchedulerService(
      { scoped, base } as unknown as PrismaService,
      billing,
      engineHealth as never,
      runLifecycle,
      visibilityConfig,
    );

    // Cap = 5 pts, each run costs 2 engines * 1 sample * 2 pts = 4 pts:
    // sched_1 triggers (4 <= 5), sched_2 is skipped (4 + 4 = 8 > 5) with SKIPPED_BUDGET_CAP!
    const report = await service.runDueSweep({ now });
    expect(report).toMatchObject({
      scanned: 2,
      claimed: 2,
      triggered: 1,
      skippedBudgetCap: 1,
      skippedInsufficientPoints: 0,
    });
    expect(dueSchedules[1]!.status).toBe('SKIPPED_BUDGET_CAP');
    expect(dueSchedules[1]!.visibilityRunId).toBeNull();
    expect(dueSchedules[1]!.skipReason).toContain('2026-11');
    expect(dueSchedules[1]!.skipReason).toContain('4/5');

    // Verify productLineId was forwarded to runLifecycle.createRun
    expect((runLifecycle.createRun as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      productLineId: 'pl_lineA',
      triggerType: 'RETEST',
    });

    // Clear cap -> new pending schedule executes cleanly
    cap = null;
    dueSchedules.push({
      id: 'sched_3',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_global',
      publishRecordId: 'pub_3',
      milestoneDay: 30,
      sampleCount: 1,
      includeControlPrompts: false,
      status: 'PENDING',
      visibilityRunId: null,
      skipReason: null,
      executedAt: null,
      updatedAt: now,
      dueAt: new Date('2026-11-09T02:00:00.000Z'),
      tenant: {
        id: 'tenant_a',
        isActive: true,
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });

    const reportAfterClear = await service.runDueSweep({ now });
    expect(reportAfterClear).toMatchObject({
      scanned: 1,
      triggered: 1,
      skippedBudgetCap: 0,
    });
  });

  it('GeoDeliveryService.getActionHome exposes top-level retestBudget, includes SKIPPED_BUDGET_CAP in upcomingRetests, and filters by productLineId', async () => {
    const now = new Date();
    const briefFindMany = vi.fn(async () => []);
    const articleFindMany = vi.fn(async () => []);
    const scheduleFindMany = vi.fn(async (args: { where?: { OR?: unknown[] } }) => {
      // Budget query asks for status: { in: ['RUNNING', 'COMPLETED', 'SKIPPED_BUDGET_CAP'] }
      if (args.where && 'status' in args.where) {
        return [
          {
            id: 'sched_skip',
            status: 'SKIPPED_BUDGET_CAP',
            visibilityRunId: null,
            executedAt: now,
            updatedAt: now,
          },
        ];
      }
      return [
        {
          id: 'sched_skip',
          publishRecordId: 'pub_1',
          milestoneDay: 7,
          sampleCount: 1,
          dueAt: now,
          status: 'SKIPPED_BUDGET_CAP',
          skipReason: '本月自动复测预算已满',
          publishRecord: {
            id: 'pub_1',
            articleId: 'art_1',
            channel: 'Shopify',
            article: { title: 'HeliosPower Guide' },
          },
        },
      ];
    });

    const prisma = {
      scoped: {
        geoBrief: { findMany: briefFindMany },
        geoArticle: { findMany: articleFindMany },
        geoPublishRecord: { findMany: vi.fn(async () => []) },
        geoRetestSchedule: { findMany: scheduleFindMany },
        visibilityRun: { findMany: vi.fn(async () => []) },
        pointLog: { findMany: vi.fn(async () => []) },
      },
    } as unknown as PrismaService;

    const brands = {
      resolveBrandMarket: vi.fn(async () => ({
        brand: { id: 'brand_1', name: 'NovaTech' },
        market: { id: 'bm_global', market: 'GLOBAL' as const, monthlyRetestPointCap: 20 },
      })),
    } as unknown as BrandsService;

    const visibility = {
      overview: vi.fn(async () => ({
        metrics: {
          visibilityPct: 60,
          shareOfVoice: { brandSharePct: 40 },
          avgPosition: 1.5,
          ownedCitationRatePct: 25,
          completedChecks: 8,
        },
      })),
    } as unknown as VisibilityService;

    const delivery = new GeoDeliveryService(prisma, brands, visibility);
    const home = await delivery.getActionHome('brand_1', {
      market: 'GLOBAL',
      days: 14,
      productLineId: 'pl_lineA',
    });

    expect(home.productLineId).toBe('pl_lineA');
    expect(home.retestBudget).toMatchObject({
      capPoints: 20,
      usedPoints: 0,
      remainingPoints: 20,
      skippedCount: 1,
    });
    expect(home.retestBudget?.monthKey).toMatch(/^\d{4}-\d{2}$/);
    expect('retestBudget' in (home.distributionSummary ?? {})).toBe(false);
    expect(home.distributionSummary?.upcomingRetests[0]?.status).toBe('SKIPPED_BUDGET_CAP');
    expect(visibility.overview).toHaveBeenCalledWith('brand_1', {
      market: 'GLOBAL',
      days: 14,
      productLineId: 'pl_lineA',
    });
    expect(briefFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productLineId: 'pl_lineA' }),
      }),
    );
    expect(articleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productLineId: 'pl_lineA' }),
      }),
    );
  });

  it('enforces intra-sweep budget cap with futureNow across month mismatch without double-counting already-indexed DB runs', async () => {
    const futureNow = new Date('2027-01-09T05:40:07.680Z');
    const wallClockOtherMonth = new Date('2026-11-25T05:40:07.907Z');
    const dueSchedules = ['sched_a', 'sched_b', 'sched_c'].map((id, idx) => ({
      id,
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_global',
      publishRecordId: `pub_${idx + 1}`,
      milestoneDay: [7, 14, 30][idx]!,
      sampleCount: 1,
      includeControlPrompts: false,
      status: 'PENDING',
      visibilityRunId: null as string | null,
      skipReason: null as string | null,
      executedAt: null as Date | null,
      updatedAt: wallClockOtherMonth,
      dueAt: new Date('2027-01-08T00:00:00.000Z'),
      tenant: {
        id: 'tenant_a',
        isActive: true,
        expiresAt: new Date('2028-01-01T00:00:00.000Z'),
      },
    }));

    const createdRuns: Array<{
      id: string;
      status: string;
      reservationId: string | null;
      totalChecks: number;
      doneCount: number;
      unitPrice: number;
    }> = [];

    const scoped = {
      geoRetestSchedule: {
        findMany: vi.fn(async () => dueSchedules),
        updateMany: vi.fn(
          async (args: {
            where: { id: string; status?: string };
            data: Record<string, unknown>;
          }) => {
            const target = dueSchedules.find(
              (s) =>
                s.id === args.where.id && (!args.where.status || s.status === args.where.status),
            );
            if (!target) return { count: 0 };
            const nextUpdatedAt =
              args.data.updatedAt instanceof Date ? args.data.updatedAt : wallClockOtherMonth;
            Object.assign(target, args.data, { updatedAt: nextUpdatedAt });
            return { count: 1 };
          },
        ),
      },
      geoPublishRecord: {
        findFirst: vi.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          brandId: 'brand_1',
          brandMarketId: 'bm_global',
          articleId: 'art_1',
          article: {
            id: 'art_1',
            title: 'HeliosPower Field Test',
            targetPrompt: 'Best portable power station',
            productLineId: null,
          },
          brandMarket: {
            id: 'bm_global',
            market: 'GLOBAL',
            localBrandName: 'NovaTech',
            controlPrompts: [],
            // Cap = 20 pts, each run = 2 engines * 1 sample * 5 pts = 10 pts:
            // sched_a (10 <= 20) triggers, sched_b (10 + 10 <= 20) triggers (proving NO double count),
            // sched_c (20 + 10 > 20) is skipped!
            monthlyRetestPointCap: 20,
          },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      visibilityRun: {
        findFirst: vi.fn(
          async (args: { where: { id: string } }) =>
            createdRuns.find((r) => r.id === args.where.id) ?? null,
        ),
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          createdRuns.filter((r) => args.where.id.in.includes(r.id)),
        ),
      },
      pointLog: {
        findMany: vi.fn(async () => []),
      },
    };

    const base = {
      geoRetestSchedule: {
        findMany: vi.fn(async (args: { where: { status: string } }) =>
          dueSchedules.filter((s) => s.status === args.where.status),
        ),
      },
    };

    let runSeq = 1;
    const runLifecycle: RetestRunCreator = {
      createRun: vi.fn(async (_brandId, input) => {
        const id = `run_future_${runSeq++}`;
        createdRuns.push({
          id,
          status: 'QUEUED',
          reservationId: null,
          totalChecks:
            (input.prompts?.length ?? 1) * input.engines.length * (input.sampleCount ?? 1),
          doneCount: 0,
          unitPrice: 5,
        });
        return { id } as never;
      }),
    };

    const service = new RetestSchedulerService(
      { scoped, base } as unknown as PrismaService,
      {
        unitPrice: vi.fn(async () => 5),
        wallet: vi.fn(async () => ({ billingMode: 'SHADOW' as const, available: 0 })),
      } as unknown as BillingService,
      {
        getAvailability: vi.fn(async () => ({
          engines: [
            { key: 'chatgpt', available: true },
            { key: 'perplexity', available: true },
          ],
        })),
      } as never,
      runLifecycle,
      { featureEnabled: true } as unknown as VisibilityConfig,
    );

    const report = await service.runDueSweep({ now: futureNow });
    expect(report).toMatchObject({
      scanned: 3,
      claimed: 3,
      triggered: 2,
      skippedBudgetCap: 1,
    });
    expect(dueSchedules[0]!.updatedAt.toISOString()).toBe(futureNow.toISOString());
    expect(dueSchedules[1]!.updatedAt.toISOString()).toBe(futureNow.toISOString());
    expect(dueSchedules[2]!.status).toBe('SKIPPED_BUDGET_CAP');
    expect(dueSchedules[2]!.skipReason).toContain('2027-01');
    expect(dueSchedules[2]!.skipReason).toContain('20/20');
  });
});

describe.runIf(process.env.GEOMIX_DB_INTEGRATION === '1')(
  'RetestSchedulerService real PG16 intra-sweep budget cap with explicit futureNow',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('retest_cap');
    }, 120_000);

    afterAll(async () => {
      await ctx?.close();
    }, 60_000);

    it('strictly triggers 1 and skips 1 (SKIPPED_BUDGET_CAP) on live PG16 when cap=15, est=10, and opts.now is in a future month', async () => {
      const { tenantId } = await ctx.createTenantUser({
        prefix: 'rcap',
        billingMode: 'SHADOW',
      });

      const brand = await ctx.prisma.base.brand.create({
        data: {
          tenantId,
          name: 'CapBrand',
          category: 'Smart Hardware',
        },
      });
      const brandMarket = await ctx.prisma.base.brandMarket.create({
        data: {
          tenantId,
          brandId: brand.id,
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: 'CapBrand',
          localCategory: 'Smart Hardware',
          ownedDomains: ['capbrand.example'],
          monthlyRetestPointCap: 15,
        },
      });
      const article = await ctx.prisma.base.geoArticle.create({
        data: {
          tenantId,
          brandId: brand.id,
          brandMarketId: brandMarket.id,
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          title: 'CapBrand Portable Power Guide',
          targetPrompt: 'Best portable power station 2027',
          outlineJson: [],
          contentMarkdown: '## Overview\n\nCapBrand field test.',
          contentHtml: '<h2>Overview</h2><p>CapBrand field test.</p>',
          status: 'PUBLISHED',
        },
      });
      const pub1 = await ctx.prisma.base.geoPublishRecord.create({
        data: {
          tenantId,
          brandId: brand.id,
          brandMarketId: brandMarket.id,
          articleId: article.id,
          channel: 'Shopify',
          publishedUrl: 'https://capbrand.example/guide-1',
        },
      });
      const pub2 = await ctx.prisma.base.geoPublishRecord.create({
        data: {
          tenantId,
          brandId: brand.id,
          brandMarketId: brandMarket.id,
          articleId: article.id,
          channel: 'WordPress',
          publishedUrl: 'https://capbrand.example/guide-2',
        },
      });

      const futureNow = new Date('2027-01-09T05:40:07.680Z');
      const s1 = await ctx.prisma.base.geoRetestSchedule.create({
        data: {
          tenantId,
          brandId: brand.id,
          brandMarketId: brandMarket.id,
          publishRecordId: pub1.id,
          milestoneDay: 7,
          sampleCount: 1,
          dueAt: new Date('2027-01-08T00:00:00.000Z'),
          status: 'PENDING',
        },
      });
      const s2 = await ctx.prisma.base.geoRetestSchedule.create({
        data: {
          tenantId,
          brandId: brand.id,
          brandMarketId: brandMarket.id,
          publishRecordId: pub2.id,
          milestoneDay: 14,
          sampleCount: 1,
          dueAt: new Date('2027-01-08T01:00:00.000Z'),
          status: 'PENDING',
        },
      });

      const runLifecycle: RetestRunCreator = {
        createRun: vi.fn(async (_brandId, input) => {
          const run = await ctx.prisma.base.visibilityRun.create({
            data: {
              tenantId,
              brandId: brand.id,
              brandMarketId: brandMarket.id,
              name: input.name ?? 'Scheduled Retest',
              engines: input.engines,
              prompts: input.prompts ?? ['Best portable power station 2027'],
              triggerType: 'RETEST',
              retestArticleId: article.id,
              status: 'QUEUED',
              totalChecks: (input.prompts?.length ?? 1) * input.engines.length,
              doneCount: 0,
              unitPrice: 5,
            },
          });
          return { id: run.id } as never;
        }),
      };

      const service = new RetestSchedulerService(
        ctx.prisma,
        {
          unitPrice: vi.fn(async () => 5),
          wallet: vi.fn(async () => ({ billingMode: 'SHADOW' as const, available: 0 })),
        } as unknown as BillingService,
        {
          getAvailability: vi.fn(async () => ({
            engines: [
              { key: 'chatgpt', available: true },
              { key: 'perplexity', available: true },
            ],
          })),
        } as never,
        runLifecycle,
        { featureEnabled: true } as unknown as VisibilityConfig,
      );

      const report = await service.runDueSweep({ now: futureNow });
      expect(report).toMatchObject({
        scanned: 2,
        claimed: 2,
        triggered: 1,
        skippedBudgetCap: 1,
      });

      const [after1, after2] = await Promise.all([
        ctx.prisma.base.geoRetestSchedule.findUniqueOrThrow({ where: { id: s1.id } }),
        ctx.prisma.base.geoRetestSchedule.findUniqueOrThrow({ where: { id: s2.id } }),
      ]);
      expect(after1.status).toBe('RUNNING');
      expect(after1.updatedAt.toISOString()).toBe(futureNow.toISOString());
      expect(after2.status).toBe('SKIPPED_BUDGET_CAP');
      expect(after2.skipReason).toContain('2027-01');
      expect(after2.skipReason).toContain('10/15');
    }, 60_000);
  },
);
