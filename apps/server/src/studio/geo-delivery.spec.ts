import { describe, expect, it, vi } from 'vitest';
import { readGeoEvaluateRateLimit } from '../common/free-action-rate-limiter';
import type { PrismaService } from '../prisma/prisma.service';
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
  it('skips MANUAL runs and runs with successCount <= 0 without touching Prisma', async () => {
    const txSpy = vi.fn();
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
    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      runId: 'run_empty',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'PARTIAL',
      successCount: 0,
    });
    expect(txSpy).not.toHaveBeenCalled();
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
