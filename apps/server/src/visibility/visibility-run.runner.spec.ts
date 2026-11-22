import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/api-error';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VisibilityCollectorService } from './visibility-collector.service';
import type { VisibilityJudgeService } from './visibility-judge.service';
import { VisibilityRunRunner } from './visibility-run.runner';

describe('VisibilityRunRunner billing settle rollback (B-01)', () => {
  it('rolls back persisted SUCCESS observation, citations, and doneCount to FAILED when billing.settle throws', async () => {
    const state = {
      runStatus: 'RUNNING',
      doneCount: 0,
      failCount: 0,
      lastError: null as string | null,
      obsStatus: 'PENDING' as 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED',
      answerText: null as string | null,
      citationsCount: 0,
    };

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_1',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_cn',
          name: 'Test Run',
          triggerType: 'MANUAL',
          retestArticleId: null,
          status: state.runStatus,
          totalChecks: 1,
          doneCount: state.doneCount,
          failCount: state.failCount,
          unitPrice: 2,
          reservationId: 'res_closed_1',
        })),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const d = args.data;
          if (typeof d.status === 'string') state.runStatus = d.status;
          if (d.doneCount && typeof d.doneCount === 'object') {
            const dc = d.doneCount as { increment?: number; decrement?: number };
            if (dc.increment) state.doneCount += dc.increment;
            if (dc.decrement) state.doneCount -= dc.decrement;
          }
          if (d.failCount && typeof d.failCount === 'object') {
            const fc = d.failCount as { increment?: number };
            if (fc.increment) state.failCount += fc.increment;
          }
          if (typeof d.lastError === 'string') state.lastError = d.lastError;
          return {};
        }),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') state.runStatus = args.data.status;
          return { count: 1 };
        }),
      },
      visibilityObservation: {
        findMany: vi.fn(async () => (state.obsStatus === 'PENDING' ? [{ id: 'obs_1' }] : [])),
        findFirst: vi.fn(async (args: { where?: { status?: string } }) => {
          if (args.where?.status && args.where.status !== state.obsStatus) return null;
          return { id: 'obs_1', status: state.obsStatus };
        }),
        count: vi.fn(async () => (state.obsStatus === 'RUNNING' ? 1 : 0)),
        updateMany: vi.fn(
          async (args: {
            where?: { status?: string; checkedAt?: { lt?: Date } };
            data: Record<string, unknown>;
          }) => {
            if (args.where?.status && args.where.status !== state.obsStatus) {
              return { count: 0 };
            }
            if (args.where?.checkedAt?.lt) {
              return { count: 0 };
            }
            if (typeof args.data.status === 'string') {
              state.obsStatus = args.data.status as typeof state.obsStatus;
            }
            return { count: 1 };
          },
        ),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') {
            state.obsStatus = args.data.status as typeof state.obsStatus;
          }
          if ('answerText' in args.data) {
            state.answerText = (args.data.answerText as string | null) ?? null;
          }
          return {};
        }),
        groupBy: vi.fn(async () => [{ status: state.obsStatus, _count: { _all: 1 } }]),
      },
      visibilityCitation: {
        deleteMany: vi.fn(async () => {
          state.citationsCount = 0;
          return { count: 1 };
        }),
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          state.citationsCount = args.data.length;
          return { count: args.data.length };
        }),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_1',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_cn',
            name: 'Test Run',
            triggerType: 'MANUAL',
            retestArticleId: null,
            status: state.runStatus,
            unitPrice: 2,
            reservationId: 'res_closed_1',
            brandMarket: {
              id: 'bm_cn',
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: '星辰存储',
              aliases: [],
              ownedDomains: ['star.example'],
              competitors: [],
            },
          })),
        },
        visibilityObservation: {
          findFirst: vi.fn(async () => ({
            id: 'obs_1',
            engine: 'doubao',
            promptText: '家用四盘位 NAS 推荐',
          })),
        },
        pointReservation: {
          findFirst: vi.fn(async () => ({ id: 'res_closed_1', status: 'CLOSED' })),
        },
      },
    } as unknown as PrismaService;

    const billing = {
      settle: vi.fn(async () => {
        throw new ApiError(400, 40001, '冻结单已结单');
      }),
      releaseUnit: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as BillingService;

    const collector = {
      collect: vi.fn(async () => ({
        collectorKind: 'fake',
        answerText: '星辰存储表现优秀',
        fanOutQueries: ['四盘位 NAS'],
        citations: [{ url: 'https://star.example/nas', title: '星辰', snippet: '实测' }],
      })),
    } as unknown as VisibilityCollectorService;

    const judge = {
      evaluate: vi.fn(async () => ({
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        brandPassage: '星辰存储表现优秀',
        competitorHits: [],
        judgeModel: 'fake',
        tokensIn: 10,
        tokensOut: 10,
      })),
    } as unknown as VisibilityJudgeService;

    const runner = new VisibilityRunRunner(prisma, billing, collector, judge);
    await runner.process({ tenantId: 'tenant_a', runId: 'run_1' });

    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(state.obsStatus).toBe('FAILED');
    expect(state.answerText).toBeNull();
    expect(state.citationsCount).toBe(0);
    expect(state.doneCount).toBe(0);
    expect(state.failCount).toBe(1);
    expect(state.runStatus).toBe('FAILED');
  });
});
