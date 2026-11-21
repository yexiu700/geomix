import { describe, expect, it, vi } from 'vitest';
import { API_ERROR, AUTH_ERROR, BILLING_ERROR } from '@geomix/shared';
import { runInTenant } from '../tenant/tenant-context';
import type { BillingService } from '../billing/billing.service';
import type { BrandsService } from '../brands/brands.service';
import { ComplianceService } from '../infra/compliance';
import type { PrismaService } from '../prisma/prisma.service';
import { readVisibilityConfig } from './visibility.config';
import { VisibilityRunLifecycleService } from './visibility-run-lifecycle.service';
import type { VisibilityRunEnqueuer } from './visibility-run.runner';

function buildFixture(overrides?: {
  reservationStatus?: 'OPEN' | 'CLOSED';
  existingRun?: Record<string, unknown> | null;
  retestArticle?: { id: string } | null;
  txError?: unknown;
  winnerOnConflict?: Record<string, unknown> | null;
}) {
  let findRunCalls = 0;
  const visibilityRunFindFirst = vi.fn(async () => {
    findRunCalls += 1;
    if (overrides?.winnerOnConflict && findRunCalls >= 3) {
      return overrides.winnerOnConflict;
    }
    return overrides?.existingRun ?? null;
  });

  const geoArticleFindFirst = vi.fn(async () =>
    overrides?.retestArticle === undefined ? null : overrides.retestArticle,
  );

  const txCreateRun = vi.fn(async () => {
    if (overrides?.txError) throw overrides.txError;
    return { id: 'vr_created' };
  });

  let runningObsCount = 0;
  const visibilityRunCount = vi.fn(async () => 0);
  const visibilityRunDeleteMany = vi.fn(async () => ({ count: 1 }));
  const visibilityObservationCount = vi.fn(async () => runningObsCount);

  const prisma = {
    scoped: {
      visibilityRun: {
        count: visibilityRunCount,
        findFirst: visibilityRunFindFirst,
        deleteMany: visibilityRunDeleteMany,
      },
      visibilityObservation: {
        count: visibilityObservationCount,
      },
      geoArticle: {
        findFirst: geoArticleFindFirst,
      },
    },
    base: {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          visibilityRun: { create: txCreateRun },
          visibilityObservation: { createMany: vi.fn(async () => ({ count: 1 })) },
        }),
      ),
    },
  } as unknown as PrismaService;

  const brands = {
    resolveBrandMarket: vi.fn(async (brandId: string, market?: string) => ({
      brand: { id: brandId, name: '星辰存储' },
      market: {
        id: market === 'GLOBAL' ? 'bm_global' : 'bm_cn',
        market: (market ?? 'CN') as 'CN' | 'GLOBAL',
        localBrandName: '星辰存储',
        aliases: [],
        ownedDomains: ['star.example'],
        competitors: [],
      },
    })),
  } as unknown as BrandsService;

  const billing = {
    unitPrice: vi.fn(async () => 2),
    reserve: vi.fn(async () => ({
      id: 'res_vis_1',
      status: overrides?.reservationStatus ?? 'OPEN',
      frozen: 2,
      shadow: false,
    })),
    close: vi.fn(async () => undefined),
  } as unknown as BillingService;

  const enqueuer: VisibilityRunEnqueuer = {
    enqueueVisibilityRun: vi.fn(async () => undefined),
  };

  const service = new VisibilityRunLifecycleService(
    prisma,
    brands,
    billing,
    new ComplianceService(),
    enqueuer,
    readVisibilityConfig({ VISIBILITY_ENABLED: 'true', VISIBILITY_COLLECTOR: 'fake' }),
  );

  return {
    service,
    prisma,
    billing,
    enqueuer,
    geoArticleFindFirst,
    txCreateRun,
    visibilityRunDeleteMany,
    setRunningObsCount: (count: number) => {
      runningObsCount = count;
    },
  };
}

describe('VisibilityRunLifecycleService adversarial guards (B-01, B-03, B-04)', () => {
  it('rejects replaying an Idempotency-Key whose reservation is already CLOSED after run deletion (B-01)', async () => {
    const { service, txCreateRun, enqueuer } = buildFixture({
      reservationStatus: 'CLOSED',
      existingRun: null,
    });

    await runInTenant('tenant_a', async () => {
      await expect(
        service.createRun(
          'brand_a',
          {
            market: 'CN',
            engines: ['doubao'],
            prompts: ['2026 四盘位家用 NAS 推荐'],
            triggerType: 'MANUAL',
          },
          'replayed-closed-key-01',
          'user_1',
          'CN',
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: BILLING_ERROR.CONFLICT,
      });
    });

    expect(txCreateRun).not.toHaveBeenCalled();
    expect(enqueuer.enqueueVisibilityRun).not.toHaveBeenCalled();
  });

  it('rejects mismatched queryMarket vs body.market with 400 and cross-brand/cross-market retestArticleId with 404 (B-04)', async () => {
    const { service, geoArticleFindFirst, billing } = buildFixture({
      retestArticle: null,
    });

    await runInTenant('tenant_a', async () => {
      await expect(
        service.createRun(
          'brand_a',
          {
            market: 'CN',
            engines: ['doubao'],
            prompts: ['静音四盘位 NAS'],
            triggerType: 'MANUAL',
          },
          'market-mismatch-key',
          'user_1',
          'GLOBAL',
        ),
      ).rejects.toMatchObject({
        status: 400,
        code: API_ERROR.BAD_REQUEST,
      });

      await expect(
        service.createRun(
          'brand_a',
          {
            market: 'CN',
            engines: ['doubao'],
            prompts: ['静音四盘位 NAS'],
            triggerType: 'RETEST',
            retestArticleId: 'art_brand_b',
          },
          'idor-retest-key',
          'user_1',
          'CN',
        ),
      ).rejects.toMatchObject({
        status: 404,
        code: AUTH_ERROR.NOT_FOUND,
      });
    });

    expect(geoArticleFindFirst).toHaveBeenCalledWith({
      where: { id: 'art_brand_b', brandId: 'brand_a', brandMarketId: 'bm_cn' },
      select: { id: true },
    });
    expect(billing.reserve).not.toHaveBeenCalled();
  });

  it('validates replay parameters on unique violation (P2002) and rejects mismatched winner with 409 without closing reservation (B-03)', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const { service, billing } = buildFixture({
      txError: p2002,
      winnerOnConflict: {
        id: 'vr_winner',
        brandId: 'brand_a',
        brandMarketId: 'bm_cn',
        engines: ['deepseek'],
        prompts: ['不同问题'],
        triggerType: 'MANUAL',
        retestArticleId: null,
      },
    });

    await runInTenant('tenant_a', async () => {
      await expect(
        service.createRun(
          'brand_a',
          {
            market: 'CN',
            engines: ['doubao'],
            prompts: ['2026 四盘位家用 NAS 推荐'],
            triggerType: 'MANUAL',
          },
          'concurrent-run-key',
          'user_1',
          'CN',
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: BILLING_ERROR.CONFLICT,
      });
    });

    expect(billing.close).not.toHaveBeenCalled();
  });

  it('blocks deleteRun and bulkDeleteRuns on a CANCELLED run while any observation is still RUNNING (B-12)', async () => {
    const { service, setRunningObsCount, visibilityRunDeleteMany } = buildFixture({
      existingRun: { id: 'vr_cancelled_1', status: 'CANCELLED' },
    });

    await runInTenant('tenant_a', async () => {
      setRunningObsCount(1);
      await expect(service.deleteRun('brand_a', 'vr_cancelled_1', 'CN')).rejects.toMatchObject({
        status: 400,
        code: API_ERROR.BAD_REQUEST,
      });
      await expect(
        service.bulkDeleteRuns('brand_a', ['vr_cancelled_1'], 'CN'),
      ).rejects.toMatchObject({
        status: 400,
        code: API_ERROR.BAD_REQUEST,
      });
      expect(visibilityRunDeleteMany).not.toHaveBeenCalled();

      setRunningObsCount(0);
      expect(await service.deleteRun('brand_a', 'vr_cancelled_1', 'CN')).toEqual({ deleted: 1 });
      expect(await service.bulkDeleteRuns('brand_a', ['vr_cancelled_1'], 'CN')).toEqual({
        deleted: 1,
      });
      expect(visibilityRunDeleteMany).toHaveBeenCalledTimes(2);
    });
  });
});
