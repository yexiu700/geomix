import { describe, expect, it, vi } from 'vitest';
import { computeDifferenceInDifferences, computeWilsonInterval } from '@geomix/shared';
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
      wilson: computeWilsonInterval(2, 3),
      confidenceLevel: 'LOW',
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

  it('S-03: transitions linked RUNNING GeoRetestSchedule rows to FAILED / CANCELLED when RETEST run fails or is cancelled with 0 successes', async () => {
    const updateManyCalls: Array<Record<string, unknown>> = [];

    for (const scenario of [
      {
        eventStatus: 'FAILED' as const,
        runStatus: 'FAILED',
        lastError: 'Upstream SonarGate 504 timeout',
        expectedStatus: 'FAILED',
        expectedReasonPart: 'SonarGate 504 timeout',
      },
      {
        eventStatus: 'CANCELLED' as const,
        runStatus: 'CANCELLED',
        lastError: null,
        expectedStatus: 'CANCELLED',
        expectedReasonPart: '已取消',
      },
    ]) {
      updateManyCalls.length = 0;
      const tx = {
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: `run_${scenario.eventStatus.toLowerCase()}`,
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_a_global',
            triggerType: 'RETEST',
            status: scenario.runStatus,
            lastError: scenario.lastError,
            retestArticleId: 'art_1',
            brandMarket: null,
            observations: [],
          })),
        },
        geoRetestSchedule: {
          updateMany: vi.fn(async (args: Record<string, unknown>) => {
            updateManyCalls.push(args);
            return { count: 1 };
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
        brandMarketId: 'bm_a_global',
        runId: `run_${scenario.eventStatus.toLowerCase()}`,
        triggerType: 'RETEST',
        retestArticleId: 'art_1',
        status: scenario.eventStatus,
        successCount: 0,
      });

      expect(updateManyCalls).toHaveLength(1);
      expect(updateManyCalls[0]).toMatchObject({
        where: {
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_global',
          visibilityRunId: `run_${scenario.eventStatus.toLowerCase()}`,
          status: { in: ['PENDING', 'RUNNING'] },
        },
        data: {
          status: scenario.expectedStatus,
        },
      });
      const data = updateManyCalls[0]!.data as { executedAt?: unknown; skipReason?: string };
      expect(data.executedAt).toBeInstanceOf(Date);
      expect(data.skipReason).toContain(scenario.expectedReasonPart);
    }
  });

  it('partitions target vs control observations, computes Wilson 95% CI + DiD net lift in [0,1] scale, and keeps afterMetrics target-only (#369)', async () => {
    const pubUpdates: Array<Record<string, unknown>> = [];
    const schedUpdates: Array<Record<string, unknown>> = [];
    const obsFindCalls: Array<Record<string, unknown>> = [];

    const targetPrompt = 'What is the best quiet 4-bay NAS for home studios?';
    const ctrl1 = 'Best backup router for home office';
    const ctrl2 = 'Best mechanical keyboard for developers';

    const makeObs = (
      id: string,
      promptText: string,
      mentioned: boolean,
      runId = 'run_retest_did',
    ) => ({
      id,
      runId,
      status: 'SUCCESS',
      promptText,
      answerText: mentioned ? 'AstraVault DXP4800 is recommended.' : 'Generic alternatives exist.',
      brandMentioned: mentioned,
      brandPosition: mentioned ? 1 : null,
      brandSentiment: mentioned ? 'positive' : 'neutral',
      competitorHits: [],
      citations: [],
      createdAt: new Date('2026-07-10T00:00:00Z'),
    });

    // 6 target observations (4 hits -> 66.7%, MEDIUM Wilson) + 6 control observations (2 hits -> 33.3%)
    const runObservations = [
      makeObs('t1', targetPrompt, true),
      makeObs('t2', targetPrompt, true),
      makeObs('t3', targetPrompt, true),
      makeObs('t4', targetPrompt, true),
      makeObs('t5', targetPrompt, false),
      makeObs('t6', targetPrompt, false),
      makeObs('c1', ctrl1, true),
      makeObs('c2', ctrl1, false),
      makeObs('c3', ctrl1, false),
      makeObs('c4', ctrl2, true),
      makeObs('c5', ctrl2, false),
      makeObs('c6', ctrl2, false),
    ];

    // Baseline control observations (1/5 -> 20% baseline control mention rate)
    const baselineControlObs = [
      makeObs('bc1', ctrl1, true, 'run_prior_ctrl'),
      makeObs('bc2', ctrl1, false, 'run_prior_ctrl'),
      makeObs('bc3', ctrl1, false, 'run_prior_ctrl'),
      makeObs('bc4', ctrl2, false, 'run_prior_ctrl'),
      makeObs('bc5', ctrl2, false, 'run_prior_ctrl'),
    ];

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_retest_did',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_global',
          triggerType: 'RETEST',
          status: 'COMPLETED',
          retestArticleId: 'art_1',
          prompts: [targetPrompt, ctrl1, ctrl2],
          brandMarket: {
            id: 'bm_a_global',
            market: 'GLOBAL',
            localBrandName: 'AstraVault',
            aliases: ['AstraVault Pro'],
            ownedDomains: ['astravault.example'],
            competitors: [],
            controlPrompts: [ctrl1, ctrl2],
          },
          observations: runObservations,
        })),
      },
      geoRetestSchedule: {
        findMany: vi.fn(async () => [
          {
            id: 'sched_did_7',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_a_global',
            publishRecordId: 'pub_did',
            milestoneDay: 7,
            sampleCount: 3,
            includeControlPrompts: true,
            status: 'RUNNING',
            visibilityRunId: 'run_retest_did',
            publishRecord: {
              id: 'pub_did',
              publishedUrl: 'https://astravault.example/blog/silent-nas',
              baselineRunId: 'run_base_target_only',
              beforeMetrics: {
                mentionRate: 20,
                avgPosition: 3,
                sentiment: 'neutral',
                citationHit: false,
              },
              publishedAt: new Date('2026-07-01T00:00:00Z'),
              article: { targetPrompt },
            },
          },
        ]),
        update: vi.fn(async (args: Record<string, unknown>) => {
          schedUpdates.push(args);
          return args;
        }),
      },
      geoPublishRecord: {
        findMany: vi.fn(async () => [
          {
            id: 'pub_did',
            publishedUrl: 'https://astravault.example/blog/silent-nas',
          },
        ]),
        update: vi.fn(async (args: Record<string, unknown>) => {
          pubUpdates.push(args);
          return args;
        }),
      },
      visibilityObservation: {
        findMany: vi.fn(async (args: { where: { runId?: unknown } }) => {
          obsFindCalls.push(args as unknown as Record<string, unknown>);
          // Priority 1 (baselineRunId) has no control observations -> triggers Priority 2 fallback!
          if (args.where.runId === 'run_base_target_only') {
            return [makeObs('base_t1', targetPrompt, false, 'run_base_target_only')];
          }
          return baselineControlObs;
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
      brandMarketId: 'bm_a_global',
      runId: 'run_retest_did',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'COMPLETED',
      successCount: runObservations.length,
    });

    // afterMetrics MUST reflect strictly the 6 target observations (66.7%), NOT polluted by control prompts (50%)
    expect(pubUpdates).toHaveLength(1);
    expect((pubUpdates[0]!.data as { afterMetrics: unknown }).afterMetrics).toEqual({
      mentionRate: 66.7,
      avgPosition: 1,
      sentiment: 'positive',
      citationHit: false,
    });

    expect(obsFindCalls).toHaveLength(2); // Priority 1 miss -> Priority 2 hit
    expect(schedUpdates).toHaveLength(1);

    const schedData = schedUpdates[0]!.data as {
      status: string;
      metricsSnapshotJson: Record<string, unknown>;
      controlMetricsJson: Record<string, unknown>;
    };
    expect(schedData.status).toBe('COMPLETED');
    expect(schedData.metricsSnapshotJson).toEqual({
      mentionRate: 66.7,
      avgPosition: 1,
      sentiment: 'positive',
      citationHit: false,
      sampleCount: 6,
      hitCount: 4,
      wilson: computeWilsonInterval(4, 6),
      confidenceLevel: 'MEDIUM',
    });

    const expectedDid = computeDifferenceInDifferences({
      treatmentBaseline: 0.2,
      treatmentCurrent: 0.667,
      controlBaseline: 0.2,
      controlCurrent: 0.333,
    });
    expect(expectedDid.netLift).toBeCloseTo(0.334, 4);
    expect(expectedDid.direction).toBe('POSITIVE');

    expect(schedData.controlMetricsJson).toEqual({
      controlPrompts: [ctrl1, ctrl2],
      baselineMentionRate: 20,
      currentMentionRate: 33.3,
      sampleCount: 6,
      hitCount: 2,
      wilson: computeWilsonInterval(2, 6),
      did: expectedDid,
    });
  });

  it('gracefully persists baselineMentionRate=null and did=null when no baseline control observations exist, and skips control lookup when includeControlPrompts=false', async () => {
    const ctrl = 'Best backup router for home office';
    const targetPrompt = 'Best silent NAS';

    const obsFindMany = vi.fn(async () => []);
    const schedUpdates: Array<Record<string, unknown>> = [];

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_no_base',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_a_global',
          triggerType: 'RETEST',
          status: 'COMPLETED',
          prompts: [targetPrompt, ctrl],
          brandMarket: {
            id: 'bm_a_global',
            market: 'GLOBAL',
            localBrandName: 'AstraVault',
            aliases: [],
            ownedDomains: ['astravault.example'],
            competitors: [],
            controlPrompts: [ctrl],
          },
          observations: [
            {
              id: 't1',
              status: 'SUCCESS',
              promptText: targetPrompt,
              answerText: 'AstraVault is great.',
              brandMentioned: true,
              brandPosition: 1,
              brandSentiment: 'positive',
              competitorHits: [],
              citations: [],
            },
            {
              id: 'c1',
              status: 'SUCCESS',
              promptText: ctrl,
              answerText: 'No brand here.',
              brandMentioned: false,
              brandPosition: null,
              brandSentiment: 'neutral',
              competitorHits: [],
              citations: [],
            },
          ],
        })),
      },
      geoRetestSchedule: {
        findMany: vi.fn(async () => [
          {
            id: 'sched_with_ctrl',
            publishRecordId: 'pub_1',
            includeControlPrompts: true,
            status: 'RUNNING',
            visibilityRunId: 'run_no_base',
            publishRecord: {
              id: 'pub_1',
              publishedUrl: 'https://astravault.example/post',
              baselineRunId: null,
              beforeMetrics: {
                mentionRate: 50,
                avgPosition: 2,
                sentiment: 'neutral',
                citationHit: false,
              },
              publishedAt: new Date('2026-07-01T00:00:00Z'),
              article: { targetPrompt },
            },
          },
          {
            id: 'sched_without_ctrl',
            publishRecordId: 'pub_2',
            includeControlPrompts: false,
            status: 'RUNNING',
            visibilityRunId: 'run_no_base',
            publishRecord: {
              id: 'pub_2',
              publishedUrl: 'https://astravault.example/post-2',
              baselineRunId: null,
              beforeMetrics: null,
              publishedAt: new Date('2026-07-01T00:00:00Z'),
              article: { targetPrompt },
            },
          },
        ]),
        update: vi.fn(async (args: Record<string, unknown>) => {
          schedUpdates.push(args);
          return args;
        }),
      },
      geoPublishRecord: {
        findMany: vi.fn(async () => []),
        update: vi.fn(async (args: Record<string, unknown>) => args),
      },
      visibilityObservation: {
        findMany: obsFindMany,
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
      runId: 'run_no_base',
      triggerType: 'RETEST',
      retestArticleId: null,
      status: 'COMPLETED',
      successCount: 2,
    });

    // obsFindMany called only once (for sched_with_ctrl), NOT for sched_without_ctrl
    expect(obsFindMany).toHaveBeenCalledTimes(1);
    expect(schedUpdates).toHaveLength(2);

    const withCtrl = schedUpdates.find((u) => (u.where as { id: string }).id === 'sched_with_ctrl')!
      .data as { controlMetricsJson?: Record<string, unknown> };
    expect(withCtrl.controlMetricsJson).toMatchObject({
      controlPrompts: [ctrl],
      baselineMentionRate: null,
      currentMentionRate: 0,
      sampleCount: 1,
      hitCount: 0,
      did: null,
    });

    const withoutCtrl = schedUpdates.find(
      (u) => (u.where as { id: string }).id === 'sched_without_ctrl',
    )!.data as { controlMetricsJson?: unknown };
    expect(withoutCtrl.controlMetricsJson).toBeUndefined();
  });

  it('keeps GeoPublishRecord.afterMetrics strictly target-only on BullMQ replay after COMPLETED and when schedule was CANCELLED mid-flight (#369 iter2)', async () => {
    const targetPrompt = 'What is the best silent 4-bay NAS?';
    const ctrl1 = 'Best Wi-Fi 7 mesh router';
    const ctrl2 = 'Best ergonomic desk chair';

    const makeObs = (id: string, promptText: string, mentioned: boolean) => ({
      id,
      runId: 'run_replay_ctrl',
      status: 'SUCCESS',
      promptText,
      answerText: mentioned ? 'AstraVault is the top choice.' : 'Other products exist.',
      brandMentioned: mentioned,
      brandPosition: mentioned ? 1 : null,
      brandSentiment: mentioned ? 'positive' : 'neutral',
      competitorHits: [],
      citations: [],
      createdAt: new Date('2026-07-10T00:00:00Z'),
    });

    // 3 target hits (100%) + 6 control misses (0%) -> pooled would be 33.3%!
    const observations = [
      makeObs('t1', targetPrompt, true),
      makeObs('t2', targetPrompt, true),
      makeObs('t3', targetPrompt, true),
      makeObs('c1', ctrl1, false),
      makeObs('c2', ctrl1, false),
      makeObs('c3', ctrl1, false),
      makeObs('c4', ctrl2, false),
      makeObs('c5', ctrl2, false),
      makeObs('c6', ctrl2, false),
    ];

    for (const terminalStatus of ['COMPLETED', 'CANCELLED'] as const) {
      const pubUpdates: Array<{ where: { id: string }; data: { afterMetrics?: unknown } }> = [];
      const schedUpdateSpy = vi.fn();

      const tx = {
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_replay_ctrl',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_a_global',
            triggerType: 'RETEST',
            status: 'COMPLETED',
            retestArticleId: 'art_1',
            prompts: [targetPrompt, ctrl1, ctrl2],
            brandMarket: {
              id: 'bm_a_global',
              market: 'GLOBAL',
              localBrandName: 'AstraVault',
              aliases: [],
              ownedDomains: ['astravault.example'],
              competitors: [],
              controlPrompts: [ctrl1, ctrl2],
            },
            observations,
          })),
        },
        geoRetestSchedule: {
          findMany: vi.fn(async () => [
            {
              id: `sched_${terminalStatus.toLowerCase()}`,
              tenantId: 'tenant_a',
              brandId: 'brand_a',
              brandMarketId: 'bm_a_global',
              publishRecordId: 'pub_replay',
              milestoneDay: 7,
              sampleCount: 3,
              includeControlPrompts: true,
              status: terminalStatus,
              visibilityRunId: 'run_replay_ctrl',
              publishRecord: {
                id: 'pub_replay',
                publishedUrl: 'https://astravault.example/blog/nas',
                baselineRunId: null,
                beforeMetrics: null,
                publishedAt: new Date('2026-07-01T00:00:00Z'),
                article: { targetPrompt },
              },
            },
          ]),
          update: schedUpdateSpy,
        },
        geoPublishRecord: {
          findMany: vi.fn(async () => [
            {
              id: 'pub_replay',
              publishedUrl: 'https://astravault.example/blog/nas',
            },
          ]),
          update: vi.fn(
            async (args: { where: { id: string }; data: { afterMetrics?: unknown } }) => {
              pubUpdates.push(args);
              return args;
            },
          ),
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
        runId: 'run_replay_ctrl',
        triggerType: 'RETEST',
        retestArticleId: 'art_1',
        status: 'COMPLETED',
        successCount: observations.length,
      });

      // Terminal schedule must not be overwritten
      expect(schedUpdateSpy).not.toHaveBeenCalled();
      // afterMetrics must remain strictly target-only (100%), NEVER control-polluted (33.3%)
      expect(pubUpdates).toHaveLength(1);
      expect(pubUpdates[0]?.data.afterMetrics).toEqual({
        mentionRate: 100,
        avgPosition: 1,
        sentiment: 'positive',
        citationHit: false,
      });
    }
  });
});
