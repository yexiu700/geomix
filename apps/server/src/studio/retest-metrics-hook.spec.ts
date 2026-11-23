import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  RetestMetricsHookService,
  computeScheduleMetricsSnapshot,
} from './retest-metrics-hook.service';

describe('RetestMetricsHookService brand & market scoping (B-04)', () => {
  it('enforces brandId and brandMarketId on schedule and publish record lookups so cross-brand/market records cannot be mutated', async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const scheduleFindCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_retest_1',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_cn',
          triggerType: 'RETEST',
          retestArticleId: 'art_brand_b',
          brandMarket: {
            id: 'bm_a_cn',
            market: 'CN',
            localBrandName: '品牌A',
            aliases: [],
            ownedDomains: ['branda.example'],
            competitors: [],
          },
          observations: [
            {
              id: 'obs_1',
              status: 'SUCCESS',
              promptText: '测试问题',
              answerText: '品牌A推荐',
              brandMentioned: true,
              brandPosition: 1,
              brandSentiment: 'positive',
              competitorHits: [],
              citations: [
                {
                  url: 'https://branda.example/guide',
                  domain: 'branda.example',
                  sourceKind: 'OWNED',
                  position: 1,
                },
              ],
            },
          ],
        })),
      },
      geoRetestSchedule: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          scheduleFindCalls.push(args.where);
          return [];
        }),
        update: vi.fn(async (args: Record<string, unknown>) => {
          updateCalls.push(args);
          return {};
        }),
      },
      geoPublishRecord: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          findManyCalls.push(args.where);
          return [];
        }),
        update: vi.fn(async (args: Record<string, unknown>) => {
          updateCalls.push(args);
          return {};
        }),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      },
    } as unknown as PrismaService;

    const hook = new RetestMetricsHookService(prisma);
    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_a_cn',
      runId: 'run_retest_1',
      triggerType: 'RETEST',
      retestArticleId: 'art_brand_b',
      status: 'COMPLETED',
      successCount: 1,
    });

    expect(scheduleFindCalls).toEqual([
      {
        tenantId: 'tenant_a',
        brandId: 'brand_a',
        brandMarketId: 'bm_a_cn',
        visibilityRunId: 'run_retest_1',
      },
    ]);
    expect(findManyCalls).toEqual([
      {
        tenantId: 'tenant_a',
        brandId: 'brand_a',
        brandMarketId: 'bm_a_cn',
        latestRetestRunId: 'run_retest_1',
      },
      {
        tenantId: 'tenant_a',
        brandId: 'brand_a',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_brand_b',
      },
    ]);
    expect(updateCalls).toEqual([]);
  });

  it('writes back GeoRetestSchedule (sampleCount=3) AND linked GeoPublishRecord atomically without falling back to unrelated publish records', async () => {
    const pubFindCalls: Array<Record<string, unknown>> = [];
    const pubUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const schedUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_sched_3x',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_cn',
          triggerType: 'RETEST',
          retestArticleId: 'art_1',
          brandMarket: {
            id: 'bm_a_cn',
            market: 'CN',
            localBrandName: '星辰存储',
            aliases: ['星辰'],
            ownedDomains: ['star.example'],
            competitors: [],
          },
          observations: [
            {
              id: 'obs_1',
              status: 'SUCCESS',
              promptText: '静音家用 NAS',
              answerText: '1. 星辰存储',
              brandMentioned: true,
              brandPosition: 1,
              brandSentiment: 'positive',
              competitorHits: [],
              citations: [],
            },
            {
              id: 'obs_2',
              status: 'SUCCESS',
              promptText: '静音家用 NAS',
              answerText: '2. 星辰存储',
              brandMentioned: true,
              brandPosition: 2,
              brandSentiment: 'positive',
              competitorHits: [],
              citations: [],
            },
            {
              id: 'obs_3',
              status: 'SUCCESS',
              promptText: '静音家用 NAS',
              answerText: '其他品牌',
              brandMentioned: false,
              brandPosition: null,
              brandSentiment: null,
              competitorHits: [],
              citations: [],
            },
          ],
        })),
      },
      geoRetestSchedule: {
        findMany: vi.fn(async () => [
          {
            id: 'sched_t7',
            status: 'RUNNING',
            publishRecordId: 'pub_old_channel',
            publishRecord: {
              id: 'pub_old_channel',
              publishedUrl: 'https://star.example/blog/nas',
            },
          },
        ]),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          schedUpdates.push(args);
          return args;
        }),
      },
      geoPublishRecord: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          pubFindCalls.push(args.where);
          return [];
        }),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          pubUpdates.push(args);
          return args;
        }),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      },
    } as unknown as PrismaService;

    const hook = new RetestMetricsHookService(prisma);
    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_a_cn',
      runId: 'run_sched_3x',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'COMPLETED',
      successCount: 3,
    });

    // Must NOT fall back to retestArticleId lookup when linked schedules exist
    expect(pubFindCalls).toHaveLength(1);
    expect(pubFindCalls[0]).toHaveProperty('latestRetestRunId', 'run_sched_3x');

    // Updates both linked publish record (4-field snapshot) and schedule (6-field snapshot with sampleCount=3, hitCount=2)
    expect(pubUpdates).toHaveLength(1);
    expect(pubUpdates[0]).toEqual({
      where: { id: 'pub_old_channel' },
      data: {
        latestRetestRunId: 'run_sched_3x',
        afterMetrics: {
          mentionRate: 66.7,
          avgPosition: 1.5,
          sentiment: 'positive',
          citationHit: false,
        },
      },
    });

    expect(schedUpdates).toHaveLength(1);
    expect(schedUpdates[0]?.where).toEqual({ id: 'sched_t7' });
    expect(schedUpdates[0]?.data).toMatchObject({
      status: 'COMPLETED',
      skipReason: null,
      metricsSnapshotJson: {
        mentionRate: 66.7,
        avgPosition: 1.5,
        sentiment: 'positive',
        citationHit: false,
        sampleCount: 3,
        hitCount: 2,
      },
    });
    expect(schedUpdates[0]?.data.executedAt).toBeInstanceOf(Date);
  });

  it('computeScheduleMetricsSnapshot degrades gracefully with zero citations (PRD D5, zero NaN)', () => {
    const snap = computeScheduleMetricsSnapshot(
      [
        {
          id: 'o1',
          status: 'SUCCESS',
          promptText: 'best silent nas',
          answerText: '1. AstraVault Pro',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          competitorHits: [],
          citations: [],
        },
        {
          id: 'o2',
          status: 'SUCCESS',
          promptText: 'best silent nas',
          answerText: '2. AstraVault Pro',
          brandMentioned: true,
          brandPosition: 3,
          brandSentiment: 'neutral',
          competitorHits: [],
          citations: [],
        },
        {
          id: 'o3',
          status: 'SUCCESS',
          promptText: 'best silent nas',
          answerText: 'Synology DS423+',
          brandMentioned: false,
          brandPosition: null,
          brandSentiment: null,
          competitorHits: [],
          citations: [],
        },
      ],
      {
        localBrandName: 'AstraVault',
        aliases: ['AstraVault Pro'],
        ownedDomains: ['astravault.example'],
        competitors: [],
      },
      'https://astravault.example/blog/silent-nas',
    );

    expect(snap).toEqual({
      mentionRate: 66.7,
      avgPosition: 2,
      sentiment: 'positive',
      citationHit: false,
      sampleCount: 3,
      hitCount: 2,
    });
    expect(Number.isNaN(snap?.mentionRate)).toBe(false);
    expect(Number.isNaN(snap?.avgPosition)).toBe(false);
  });

  it('never falls back to retestArticleId or mutates unrelated channel records when linked schedule is CANCELLED or already COMPLETED (BUG-1 / Probe 2c-2)', async () => {
    for (const scheduleStatus of ['CANCELLED', 'COMPLETED'] as const) {
      const pubRecords = [
        {
          id: 'pub_shopify',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_global',
          articleId: 'art_multi',
          publishedUrl: 'https://shop.example/blogs/news/nas',
          createdAt: new Date('2026-06-01T00:00:00Z'),
          latestRetestRunId: 'run_newer_on_shopify',
          afterMetrics: {
            mentionRate: 50,
            avgPosition: 2,
            sentiment: 'neutral',
            citationHit: false,
          },
        },
        {
          id: 'pub_wordpress',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_global',
          articleId: 'art_multi',
          publishedUrl: 'https://wp.example/nas-guide',
          createdAt: new Date('2026-06-02T00:00:00Z'),
          latestRetestRunId: null as string | null,
          afterMetrics: null as unknown,
        },
      ];

      const pubFindCalls: Array<Record<string, unknown>> = [];
      const pubUpdateSpy = vi.fn();
      const schedUpdateSpy = vi.fn();

      const tx = {
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_cancel_race',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_a_global',
            triggerType: 'RETEST',
            retestArticleId: 'art_multi',
            brandMarket: {
              id: 'bm_a_global',
              market: 'GLOBAL',
              localBrandName: 'AstraVault',
              aliases: [],
              ownedDomains: ['astravault.example'],
              competitors: [],
            },
            observations: [
              {
                id: 'obs_1',
                status: 'SUCCESS',
                promptText: 'best silent nas',
                answerText: '1. AstraVault',
                brandMentioned: true,
                brandPosition: 1,
                brandSentiment: 'positive',
                competitorHits: [],
                citations: [],
              },
            ],
          })),
        },
        geoRetestSchedule: {
          findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
            expect(args.where).toEqual({
              tenantId: 'tenant_a',
              brandId: 'brand_a',
              brandMarketId: 'bm_a_global',
              visibilityRunId: 'run_cancel_race',
            });
            return [
              {
                id: 'sched_shopify_linked',
                status: scheduleStatus,
                publishRecordId: 'pub_shopify',
                publishRecord: {
                  id: 'pub_shopify',
                  publishedUrl: 'https://shop.example/blogs/news/nas',
                },
              },
            ];
          }),
          update: schedUpdateSpy,
        },
        geoPublishRecord: {
          findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
            pubFindCalls.push(args.where);
            return pubRecords.filter(
              (rec) =>
                (!args.where.latestRetestRunId ||
                  rec.latestRetestRunId === args.where.latestRetestRunId) &&
                (!args.where.articleId || rec.articleId === args.where.articleId),
            );
          }),
          update: pubUpdateSpy,
        },
      };

      const prisma = {
        base: {
          $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        },
      } as unknown as PrismaService;

      const hook = new RetestMetricsHookService(prisma);
      await hook.onVisibilityRunComplete({
        tenantId: 'tenant_a',
        brandId: 'brand_a',
        brandMarketId: 'bm_a_global',
        runId: 'run_cancel_race',
        triggerType: 'RETEST',
        retestArticleId: 'art_multi',
        status: 'COMPLETED',
        successCount: 1,
      });

      // Fallback by articleId MUST NOT execute when any linked schedule exists
      expect(pubFindCalls).toEqual([
        {
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_global',
          latestRetestRunId: 'run_cancel_race',
        },
      ]);
      // Neither schedule nor WordPress (or Shopify) publish record may be mutated
      expect(schedUpdateSpy).not.toHaveBeenCalled();
      expect(pubUpdateSpy).not.toHaveBeenCalled();
      expect(pubRecords[1]!.latestRetestRunId).toBeNull();
      expect(pubRecords[1]!.afterMetrics).toBeNull();
    }
  });
});
