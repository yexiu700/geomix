import { describe, expect, it, vi } from 'vitest';
import { computeWilsonInterval } from '@geomix/shared';
import type { BrandsService } from '../brands/brands.service';
import { readGeoEvaluateRateLimit } from '../common/free-action-rate-limiter';
import type { RetestSchedulerService } from '../distribution/retest-scheduler.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VisibilityService } from '../visibility/visibility.service';
import { GeoDeliveryService } from './geo-delivery.service';
import {
  RetestMetricsHookService,
  computeRetestMetricSnapshot,
  type RetestBrandMarketLike,
  type RetestObservationLike,
} from './retest-metrics-hook.service';

const MARKET_CN: RetestBrandMarketLike = {
  localBrandName: '星辰存储',
  aliases: ['星辰', 'DXP4800'],
  ownedDomains: ['xingchennas.example'],
  competitors: [{ name: '群晖', aliases: ['Synology'], domains: ['synology.com'] }],
};

function makeObs(overrides: Partial<RetestObservationLike> = {}): RetestObservationLike {
  return {
    id: 'obs_1',
    status: 'SUCCESS',
    promptText: '四盘位静音家用 NAS 推荐',
    answerText: '1. 星辰存储 DXP4800 静音 18.5dB，2. 群晖 DS423+。',
    brandMentioned: true,
    brandPosition: 1,
    brandSentiment: 'positive',
    competitorHits: [{ name: '群晖', mentioned: true, position: 2, sentiment: 'neutral' }],
    citations: [
      {
        url: 'https://xingchennas.example/guides/nas',
        domain: 'xingchennas.example',
        sourceKind: 'OWNED',
      },
    ],
    ...overrides,
  };
}

describe('computeRetestMetricSnapshot', () => {
  it('returns null when there are no SUCCESS observations', () => {
    expect(computeRetestMetricSnapshot([], MARKET_CN)).toBeNull();
    expect(computeRetestMetricSnapshot([makeObs({ status: 'FAILED' })], MARKET_CN)).toBeNull();
  });

  it('computes 0% mention / null position / false citationHit on gap baseline', () => {
    const gap = makeObs({
      answerText: '1. 群晖 DS423+ 稳定可靠，2. 极空间 Z4Pro 易上手。',
      brandMentioned: false,
      brandPosition: null,
      brandSentiment: null,
      citations: [
        {
          url: 'https://www.zhihu.com/question/123',
          domain: 'zhihu.com',
          sourceKind: 'SOCIAL',
        },
      ],
    });
    const snap = computeRetestMetricSnapshot([gap], MARKET_CN, 'https://www.zhihu.com/p/999');
    expect(snap).toEqual({
      mentionRate: 0,
      avgPosition: null,
      sentiment: null,
      citationHit: false,
    });
  });

  it('computes 100% mention / position 1 / positive / citationHit on RETEST improvement', () => {
    const snap = computeRetestMetricSnapshot(
      [makeObs()],
      MARKET_CN,
      'https://xingchennas.example/guides/nas',
    );
    expect(snap).toEqual({
      mentionRate: 100,
      avgPosition: 1,
      sentiment: 'positive',
      citationHit: true,
    });
  });

  it('sets citationHit=true when third-party publishedUrl is cited exactly (ignoring trailing slash)', () => {
    const obs = makeObs({
      citations: [
        {
          url: 'https://zhuanlan.zhihu.com/p/888999/',
          domain: 'zhuanlan.zhihu.com',
          sourceKind: 'SOCIAL',
        },
      ],
    });
    const snap = computeRetestMetricSnapshot(
      [obs],
      MARKET_CN,
      'https://zhuanlan.zhihu.com/p/888999',
    );
    expect(snap?.citationHit).toBe(true);
  });
});

describe('RetestMetricsHookService', () => {
  it('skips MANUAL runs without touching Prisma and transitions linked schedules to FAILED on 0-success RETEST runs without mutating GeoPublishRecord', async () => {
    const scheduleUpdateMany = vi.fn(async () => ({ count: 1 }));
    const publishRecordUpdate = vi.fn();
    const txSpy = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_empty',
            tenantId: 'tenant_a',
            brandId: 'brand_1',
            brandMarketId: 'bm_1',
            triggerType: 'RETEST',
            status: 'FAILED',
            lastError: 'All observations failed',
            retestArticleId: 'art_1',
            brandMarket: MARKET_CN,
            observations: [],
          })),
        },
        geoRetestSchedule: {
          updateMany: scheduleUpdateMany,
        },
        geoPublishRecord: {
          update: publishRecordUpdate,
        },
      });
    });
    const hook = new RetestMetricsHookService({
      base: { $transaction: txSpy },
    } as unknown as PrismaService);

    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      runId: 'run_manual',
      triggerType: 'MANUAL',
      retestArticleId: null,
      status: 'COMPLETED',
      successCount: 2,
    });
    expect(txSpy).not.toHaveBeenCalled();

    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      runId: 'run_empty',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'FAILED',
      successCount: 0,
    });
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(scheduleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_a',
          visibilityRunId: 'run_empty',
          status: { in: ['PENDING', 'RUNNING'] },
        }),
        data: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
    expect(publishRecordUpdate).not.toHaveBeenCalled();
  });

  it('writes afterMetrics on linked publish record and handles worker-first race fallback by retestArticleId with strict tenantId filter', async () => {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const seenFindFirstWheres: Array<Record<string, unknown>> = [];
    const seenRecordWheres: Array<Record<string, unknown>> = [];

    const runRow = {
      id: 'run_retest_1',
      tenantId: 'tenant_a',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      brandMarket: MARKET_CN,
      observations: [makeObs()],
    };

    const txMock = {
      visibilityRun: {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
          seenFindFirstWheres.push(args.where);
          return args.where.tenantId === 'tenant_a' ? runRow : null;
        }),
      },
      geoRetestSchedule: {
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({})),
      },
      geoPublishRecord: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          seenRecordWheres.push(args.where);
          // First call (by latestRetestRunId) simulates worker-first race -> empty!
          if ('latestRetestRunId' in args.where) return [];
          // Fallback by articleId + tenantId -> returns record
          if (args.where.tenantId === 'tenant_a' && args.where.articleId === 'art_1') {
            return [{ id: 'pub_1', publishedUrl: 'https://xingchennas.example/guides/nas' }];
          }
          return [];
        }),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: args.where.id, data: args.data });
          return args;
        }),
      },
    };

    const hook = new RetestMetricsHookService({
      base: {
        $transaction: async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
      },
    } as unknown as PrismaService);

    expect(hook.name).toBe('geo-retest-metrics-writeback');

    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      runId: 'run_retest_1',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'COMPLETED',
      successCount: 1,
    });

    expect(seenFindFirstWheres[0]).toEqual({ id: 'run_retest_1', tenantId: 'tenant_a' });
    expect(seenRecordWheres).toEqual([
      { tenantId: 'tenant_a', latestRetestRunId: 'run_retest_1' },
      { tenantId: 'tenant_a', articleId: 'art_1' },
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      id: 'pub_1',
      data: {
        latestRetestRunId: 'run_retest_1',
        afterMetrics: {
          mentionRate: 100,
          avgPosition: 1,
          sentiment: 'positive',
          citationHit: true,
        },
      },
    });

    // Cross-tenant event must not update Tenant A's record
    updates.length = 0;
    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_b',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      runId: 'run_retest_1',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'COMPLETED',
      successCount: 1,
    });
    expect(updates).toHaveLength(0);
  });
});

describe('readGeoEvaluateRateLimit', () => {
  it('returns 60/60s default and honors positive env overrides', () => {
    expect(readGeoEvaluateRateLimit({})).toEqual({ max: 60, windowMs: 60_000 });
    expect(
      readGeoEvaluateRateLimit({
        GEO_EVALUATE_RATE_LIMIT_MAX: '12',
        GEO_EVALUATE_RATE_LIMIT_WINDOW_SECONDS: '30',
      }),
    ).toEqual({ max: 12, windowMs: 30_000 });
    expect(
      readGeoEvaluateRateLimit({
        GEO_EVALUATE_RATE_LIMIT_MAX: '0',
        GEO_EVALUATE_RATE_LIMIT_WINDOW_SECONDS: '-5',
      }),
    ).toEqual({ max: 60, windowMs: 60_000 });
  });
});

describe('GeoDeliveryService v2.1 auto-retest & ActionHome distributionSummary', () => {
  it('createPublishRecord creates default T+7/14/30 schedules, honors enabled:false, deduplicates milestones, and delegates to injected RetestSchedulerService', async () => {
    const createdSchedules: Array<Record<string, unknown>> = [];
    const createdRecords: Array<Record<string, unknown>> = [];

    const prisma = {
      scoped: {
        geoArticle: {
          findFirst: vi.fn(async () => ({
            id: 'art_1',
            brandId: 'brand_1',
            brandMarketId: 'bm_1',
            targetPrompt: '四盘位 NAS',
            status: 'DRAFT',
            brandMarket: MARKET_CN,
          })),
          update: vi.fn(async () => ({})),
        },
        visibilityRun: {
          findFirst: vi.fn(async () => null),
        },
        geoPublishRecord: {
          create: vi.fn(async (args: { data: Record<string, unknown> }) => {
            const row = {
              id: `pub_${createdRecords.length + 1}`,
              ...args.data,
              crawlStatus: 'PENDING',
              crawlCheckedAt: null,
              crawlReportJson: null,
              createdAt: new Date('2026-10-01T00:00:00Z'),
            };
            createdRecords.push(row);
            return row;
          }),
        },
        geoRetestSchedule: {
          createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
            for (const item of args.data) {
              createdSchedules.push({
                id: `sched_${createdSchedules.length + 1}`,
                ...item,
                visibilityRunId: null,
                metricsSnapshotJson: null,
                skipReason: null,
                executedAt: null,
                createdAt: new Date('2026-10-01T00:00:00Z'),
                updatedAt: new Date('2026-10-01T00:00:00Z'),
              });
            }
            return { count: args.data.length };
          }),
          findMany: vi.fn(async (args: { where: { publishRecordId: string } }) =>
            createdSchedules
              .filter((s) => s.publishRecordId === args.where.publishRecordId)
              .sort((a, b) => Number(a.milestoneDay) - Number(b.milestoneDay)),
          ),
        },
      },
    } as unknown as PrismaService;

    const brands = {} as BrandsService;
    const visibility = {} as VisibilityService;
    const auth = { tenantId: 'tenant_a', userId: 'user_1', role: 'MERCHANT' as const };

    // Fallback path (no RetestSchedulerService injected)
    const service = new GeoDeliveryService(prisma, brands, visibility);
    const defaultRec = await service.createPublishRecord(
      'art_1',
      {
        publishedUrl: 'https://xingchennas.example/post-1',
        channel: 'Shopify',
        publishedAt: '2026-10-01T00:00:00.000Z',
        distributionTaskId: 'dt_1',
        indexNowSubmitted: true,
      },
      auth,
    );
    expect(defaultRec.distributionTaskId).toBe('dt_1');
    expect(defaultRec.indexNowSubmitted).toBe(true);
    expect(defaultRec.retestSchedules?.map((s) => s.milestoneDay)).toEqual([7, 14, 30]);
    expect(defaultRec.retestSchedules?.every((s) => s.sampleCount === 1)).toBe(true);

    // Disabled autoRetest
    const disabledRec = await service.createPublishRecord(
      'art_1',
      {
        publishedUrl: 'https://xingchennas.example/post-2',
        channel: 'WordPress',
        autoRetest: { enabled: false },
      },
      auth,
    );
    expect(disabledRec.retestSchedules).toEqual([]);

    // Custom duplicate milestones + sampleCount=3
    const customRec = await service.createPublishRecord(
      'art_1',
      {
        publishedUrl: 'https://xingchennas.example/post-3',
        channel: 'Webflow',
        autoRetest: { enabled: true, milestones: [30, 7, 7, 14], sampleCount: 3 },
      },
      auth,
    );
    expect(customRec.retestSchedules?.map((s) => [s.milestoneDay, s.sampleCount])).toEqual([
      [7, 3],
      [14, 3],
      [30, 3],
    ]);

    // Injected RetestSchedulerService delegation
    const ensureSpy = vi.fn(async () => []);
    const delegatedService = new GeoDeliveryService(prisma, brands, visibility, undefined, {
      ensureSchedulesForPublishRecord: ensureSpy,
    } as unknown as RetestSchedulerService);
    await delegatedService.createPublishRecord(
      'art_1',
      { publishedUrl: 'https://xingchennas.example/post-4', channel: 'Shopify' },
      auth,
    );
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it('getActionHome().distributionSummary returns prioritized crawlAlerts, upcomingRetests, and PRD D5 channelAttribution with zero NaN', async () => {
    const now = new Date();
    const recentChecked = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const olderChecked = new Date(now.getTime() - 10 * 60 * 60 * 1000);
    const dueSoon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    const alertRows = [
      {
        id: 'pub_warn',
        articleId: 'art_1',
        article: { title: 'Warn Article' },
        channel: 'WordPress',
        publishedUrl: 'https://example.com/warn',
        crawlStatus: 'WARNING',
        crawlCheckedAt: recentChecked,
        publishedAt: recentChecked,
        crawlReportJson: {
          checkedUrl: 'https://example.com/warn',
          httpStatus: 200,
          robotsTxtFound: true,
          robotsMatrix: [],
          metaNoindex: false,
          jsonLdTypes: [],
          jsonLdParseErrors: [],
          issues: ['页面未检测到 JSON-LD 结构化数据（Schema）'],
        },
      },
      {
        id: 'pub_block',
        articleId: 'art_2',
        article: { title: 'Blocked Article' },
        channel: 'Shopify',
        publishedUrl: 'https://example.com/blocked',
        crawlStatus: 'BLOCKED',
        crawlCheckedAt: olderChecked,
        publishedAt: olderChecked,
        crawlReportJson: {
          checkedUrl: 'https://example.com/blocked',
          httpStatus: 200,
          robotsTxtFound: true,
          robotsMatrix: [],
          metaNoindex: true,
          jsonLdTypes: ['Article'],
          jsonLdParseErrors: [],
          issues: ['robots.txt 拦截了以下爬虫：GPTBot'],
        },
      },
      {
        id: 'pub_fail',
        articleId: 'art_3',
        article: { title: 'Failed Article' },
        channel: 'Webflow',
        publishedUrl: 'https://example.com/failed',
        crawlStatus: 'FAILED',
        crawlCheckedAt: olderChecked,
        publishedAt: olderChecked,
        crawlReportJson: {
          checkedUrl: 'https://example.com/failed',
          httpStatus: 500,
          robotsTxtFound: false,
          robotsMatrix: [],
          metaNoindex: false,
          jsonLdTypes: [],
          jsonLdParseErrors: [],
          issues: [],
          errorMessage: '页面返回异常状态码 HTTP 500',
        },
      },
    ];

    const upcomingRows = [
      {
        id: 'sched_1',
        publishRecordId: 'pub_s1',
        milestoneDay: 7,
        sampleCount: 3,
        dueAt: dueSoon,
        status: 'PENDING',
        skipReason: null,
        publishRecord: {
          id: 'pub_s1',
          articleId: 'art_1',
          channel: 'Shopify',
          article: { title: 'Shopify Guide' },
        },
      },
      {
        id: 'sched_2',
        publishRecordId: 'pub_s2',
        milestoneDay: 14,
        sampleCount: 1,
        dueAt: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000), // backdated dueAt, recently skipped
        status: 'SKIPPED_INSUFFICIENT_POINTS',
        skipReason: '预计需要 6 点，当前可用 0 点',
        publishRecord: {
          id: 'pub_s2',
          articleId: 'art_2',
          channel: 'WordPress',
          article: { title: 'WP Guide' },
        },
      },
    ];

    const attributionRows = [
      // Channel 1: Shopify — 2 published, 1 crawl OK, 2 completed retests, 1 citation hit -> 0.5
      {
        id: 'pub_a1',
        channel: 'Shopify',
        crawlStatus: 'OK',
        latestRetestRunId: 'run_1',
        beforeMetrics: {
          mentionRate: 20,
          avgPosition: 4.0,
          sentiment: 'neutral',
          citationHit: false,
        },
        afterMetrics: null,
        retestSchedules: [
          {
            visibilityRunId: 'run_1',
            metricsSnapshotJson: {
              mentionRate: 60,
              avgPosition: 2.0,
              sentiment: 'positive',
              citationHit: true,
              sampleCount: 3,
              hitCount: 2,
            },
          },
        ],
      },
      {
        id: 'pub_a2',
        channel: 'Shopify',
        crawlStatus: 'WARNING',
        latestRetestRunId: 'run_2',
        beforeMetrics: {
          mentionRate: 40,
          avgPosition: 3.0,
          sentiment: 'neutral',
          citationHit: false,
        },
        afterMetrics: {
          mentionRate: 50,
          avgPosition: 2.0,
          sentiment: 'positive',
          citationHit: false,
        },
        retestSchedules: [],
      },
      // Channel 2: Reddit (PRD D5 zero upstream citations -> citationHitRate MUST be null, NOT 0!)
      {
        id: 'pub_b1',
        channel: 'Reddit',
        crawlStatus: 'OK',
        latestRetestRunId: 'run_no_cites',
        beforeMetrics: {
          mentionRate: 10,
          avgPosition: 5.0,
          sentiment: 'neutral',
          citationHit: false,
        },
        afterMetrics: {
          mentionRate: 35,
          avgPosition: 3.0,
          sentiment: 'positive',
          citationHit: false,
        },
        retestSchedules: [],
      },
      // Channel 3: Quora (upstream returned non-matching citations -> citationHitRate MUST be 0!)
      {
        id: 'pub_c1',
        channel: 'Quora',
        crawlStatus: 'PENDING',
        latestRetestRunId: 'run_with_other_cites',
        beforeMetrics: null,
        afterMetrics: {
          mentionRate: 30,
          avgPosition: null,
          sentiment: 'neutral',
          citationHit: false,
        },
        retestSchedules: [],
      },
    ];

    const prisma = {
      scoped: {
        geoBrief: { findMany: vi.fn(async () => []) },
        geoArticle: { findMany: vi.fn(async () => []) },
        geoPublishRecord: {
          findMany: vi.fn(
            async (args: {
              where?: { crawlStatus?: string | { in: string[] } };
              take?: number;
            }) => {
              const crawlFilter = args.where?.crawlStatus;
              if (!crawlFilter) return attributionRows;
              const matched = alertRows.filter((row) =>
                typeof crawlFilter === 'string'
                  ? row.crawlStatus === crawlFilter
                  : crawlFilter.in.includes(row.crawlStatus),
              );
              return args.take !== undefined ? matched.slice(0, args.take) : matched;
            },
          ),
        },
        geoRetestSchedule: {
          findMany: vi.fn(async () => upcomingRows),
        },
        visibilityObservation: {
          findMany: vi.fn(async () => [
            { runId: 'run_no_cites', citations: [] },
            { runId: 'run_with_other_cites', citations: [{ id: 'cite_third_party' }] },
          ]),
        },
      },
    } as unknown as PrismaService;

    const brands = {
      resolveBrandMarket: vi.fn(async () => ({
        brand: { id: 'brand_1', name: 'AstraVault' },
        market: { id: 'bm_global', market: 'GLOBAL' as const },
      })),
    } as unknown as BrandsService;

    const visibility = {
      overview: vi.fn(async () => ({
        metrics: {
          visibilityPct: 45,
          shareOfVoice: { brandSharePct: 30 },
          avgPosition: 2.3,
          ownedCitationRatePct: 20,
          completedChecks: 10,
        },
      })),
    } as unknown as VisibilityService;

    const service = new GeoDeliveryService(prisma, brands, visibility);
    const home = await service.getActionHome('brand_1', { market: 'GLOBAL', days: 14 });

    expect(home.distributionSummary).toBeDefined();
    // crawlAlerts sorted BLOCKED > FAILED > WARNING
    expect(home.distributionSummary!.crawlAlerts.map((a) => a.crawlStatus)).toEqual([
      'BLOCKED',
      'FAILED',
      'WARNING',
    ]);
    expect(home.distributionSummary!.crawlAlerts[1]?.issues).toEqual([
      '页面返回异常状态码 HTTP 500',
    ]);

    // upcomingRetests includes both PENDING and backdated SKIPPED_INSUFFICIENT_POINTS
    expect(home.distributionSummary!.upcomingRetests.map((u) => u.scheduleId)).toEqual([
      'sched_1',
      'sched_2',
    ]);
    expect(home.distributionSummary!.upcomingRetests[1]?.status).toBe(
      'SKIPPED_INSUFFICIENT_POINTS',
    );

    // channelAttribution — check all 11 fields, ratios in 0..1, PRD D5 zero-citation degradation, zero NaN
    const byChannel = new Map(
      home.distributionSummary!.channelAttribution.map((item) => [item.channel, item]),
    );
    expect(byChannel.get('Shopify')).toEqual({
      channel: 'Shopify',
      publishedCount: 2,
      crawlOkCount: 1,
      completedRetestCount: 2,
      citationHitCount: 1,
      citationHitRate: 0.5,
      citationHitWilson: computeWilsonInterval(1, 2),
      avgMentionRateDelta: 25,
      avgPosition: 2,
      avgPositionDelta: -1.5,
      positiveSentimentRate: 1,
      sentimentSummary: 'positive',
    });
    expect(byChannel.get('Reddit')).toEqual({
      channel: 'Reddit',
      publishedCount: 1,
      crawlOkCount: 1,
      completedRetestCount: 1,
      citationHitCount: 0,
      citationHitRate: null, // PRD D5: upstream returned 0 citations -> null!
      citationHitWilson: null,
      avgMentionRateDelta: 25,
      avgPosition: 3,
      avgPositionDelta: -2,
      positiveSentimentRate: 1,
      sentimentSummary: 'positive',
    });
    expect(byChannel.get('Quora')).toEqual({
      channel: 'Quora',
      publishedCount: 1,
      crawlOkCount: 0,
      completedRetestCount: 1,
      citationHitCount: 0,
      citationHitRate: 0, // upstream returned non-matching citations -> 0!
      citationHitWilson: computeWilsonInterval(0, 1),
      avgMentionRateDelta: null,
      avgPosition: null,
      avgPositionDelta: null,
      positiveSentimentRate: 0,
      sentimentSummary: 'neutral',
    });

    for (const row of home.distributionSummary!.channelAttribution) {
      for (const value of Object.values(row)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it('never evicts an older BLOCKED crawl alert when 21+ recent WARNING records exist (BUG-2 / Probe 3c-2)', async () => {
    const now = Date.now();
    const warningRecords = Array.from({ length: 21 }, (_, idx) => {
      const checkedAt = new Date(now - idx * 60_000);
      return {
        id: `warn_${idx}`,
        articleId: `art_warn_${idx}`,
        article: { title: `Warning Article ${idx}` },
        channel: 'WordPress',
        publishedUrl: `https://example.com/warn-${idx}`,
        crawlStatus: 'WARNING',
        crawlCheckedAt: checkedAt,
        publishedAt: checkedAt,
        crawlReportJson: {
          checkedUrl: `https://example.com/warn-${idx}`,
          httpStatus: 200,
          robotsTxtFound: true,
          robotsMatrix: [],
          metaNoindex: false,
          jsonLdTypes: [],
          jsonLdParseErrors: [],
          issues: ['页面未检测到 JSON-LD 结构化数据（Schema）'],
        },
      };
    });

    const olderBlockedAt = new Date(now - 48 * 60 * 60 * 1000);
    const blockedRecord = {
      id: 'blocked_older',
      articleId: 'art_blocked',
      article: { title: 'Critical Blocked Article' },
      channel: 'Shopify',
      publishedUrl: 'https://example.com/blocked-older',
      crawlStatus: 'BLOCKED',
      crawlCheckedAt: olderBlockedAt,
      publishedAt: olderBlockedAt,
      crawlReportJson: {
        checkedUrl: 'https://example.com/blocked-older',
        httpStatus: 403,
        robotsTxtFound: false,
        robotsMatrix: [],
        metaNoindex: false,
        jsonLdTypes: [],
        jsonLdParseErrors: [],
        issues: ['页面返回 HTTP 403，爬虫无法公开访问'],
      },
    };

    const allRecords = [...warningRecords, blockedRecord];

    const prisma = {
      scoped: {
        geoBrief: { findMany: vi.fn(async () => []) },
        geoArticle: { findMany: vi.fn(async () => []) },
        geoPublishRecord: {
          findMany: vi.fn(
            async (args: {
              where?: { crawlStatus?: string | { in: string[] } };
              take?: number;
            }) => {
              const crawlFilter = args.where?.crawlStatus;
              if (!crawlFilter) return [];
              const filtered = allRecords
                .filter((row) =>
                  typeof crawlFilter === 'string'
                    ? row.crawlStatus === crawlFilter
                    : crawlFilter.in.includes(row.crawlStatus),
                )
                .sort(
                  (a, b) =>
                    (b.crawlCheckedAt ?? b.publishedAt).getTime() -
                    (a.crawlCheckedAt ?? a.publishedAt).getTime(),
                );
              return args.take !== undefined ? filtered.slice(0, args.take) : filtered;
            },
          ),
        },
        geoRetestSchedule: { findMany: vi.fn(async () => []) },
        visibilityObservation: { findMany: vi.fn(async () => []) },
      },
    } as unknown as PrismaService;

    const brands = {
      resolveBrandMarket: vi.fn(async () => ({
        brand: { id: 'brand_1', name: 'AstraVault' },
        market: { id: 'bm_global', market: 'GLOBAL' as const },
      })),
    } as unknown as BrandsService;

    const visibility = {
      overview: vi.fn(async () => ({
        metrics: {
          visibilityPct: 45,
          shareOfVoice: { brandSharePct: 30 },
          avgPosition: 2.3,
          ownedCitationRatePct: 20,
          completedChecks: 10,
        },
      })),
    } as unknown as VisibilityService;

    const service = new GeoDeliveryService(prisma, brands, visibility);
    const home = await service.getActionHome('brand_1', { market: 'GLOBAL', days: 14 });

    const alerts = home.distributionSummary!.crawlAlerts;
    expect(alerts).toHaveLength(5);
    expect(alerts[0]?.publishRecordId).toBe('blocked_older');
    expect(alerts[0]?.crawlStatus).toBe('BLOCKED');
    expect(alerts.slice(1).map((a) => a.publishRecordId)).toEqual([
      'warn_0',
      'warn_1',
      'warn_2',
      'warn_3',
    ]);
  });
});
