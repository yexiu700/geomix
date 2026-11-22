import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { RetestMetricsHookService } from './retest-metrics-hook.service';

describe('RetestMetricsHookService brand & market scoping (B-04)', () => {
  it('enforces brandId and brandMarketId on both publish record lookups so cross-brand/market records cannot be mutated', async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
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
            ownedDomains: ['branda.example'],
          },
          observations: [
            {
              id: 'obs_1',
              status: 'SUCCESS',
              brandMentioned: true,
              brandPosition: 1,
              brandSentiment: 'positive',
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
});
