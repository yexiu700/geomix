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

  const txCreateManyObs = vi.fn(async (_args?: unknown) => ({ count: 1 }));
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
      pointReservation: {
        findMany: vi.fn(async () => []),
      },
    },
    base: {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          visibilityRun: { create: txCreateRun },
          visibilityObservation: { createMany: txCreateManyObs },
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
    txCreateManyObs,
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
      select: { id: true, productLineId: true },
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

  it('supports sampleCount=1 (default) and sampleCount=3 with sampleIndex 1..3 and scaled billing reserve', async () => {
    const buildDetailRow = (totalChecks: number, engines: string[], prompts: string[]) => ({
      id: 'vr_detail',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_cn',
      name: '采样测试',
      engines,
      prompts,
      triggerType: 'RETEST',
      retestArticleId: null,
      totalChecks,
      doneCount: 0,
      failCount: 0,
      unitPrice: 2,
      reservationId: 'res_vis_1',
      status: 'QUEUED',
      lastError: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      startedAt: null,
      finishedAt: null,
      brandMarket: {
        id: 'bm_cn',
        market: 'CN',
        localBrandName: '星辰存储',
        aliases: [],
        ownedDomains: ['star.example'],
        competitors: [],
        brand: { name: '星辰存储', markets: [{ ownedDomains: ['star.example'] }] },
      },
      observations: [],
    });

    // sampleCount=3: 1 prompt * 2 engines * 3 samples = 6 checks, 12 points
    const fx3 = buildFixture();
    let callIdx = 0;
    (fx3.prisma.scoped.visibilityRun.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        callIdx += 1;
        // 1st pre-check & 2nd post-reserve return null; 3rd detailInScope returns row
        return callIdx >= 3
          ? buildDetailRow(6, ['doubao', 'deepseek'], ['2026 四盘位家用 NAS 推荐'])
          : null;
      },
    );

    await runInTenant('tenant_a', async () => {
      await fx3.service.createRun(
        'brand_a',
        {
          market: 'CN',
          engines: ['doubao', 'deepseek'],
          prompts: ['2026 四盘位家用 NAS 推荐'],
          triggerType: 'RETEST',
          sampleCount: 3,
        },
        'sample-3-key',
        'system',
        'CN',
      );
    });

    expect(fx3.billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ amount: 12 }));
    expect(fx3.txCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalChecks: 6 }),
      }),
    );
    const createManyArg = fx3.txCreateManyObs.mock.calls[0]?.[0] as unknown as {
      data: Array<{ engine: string; sampleIndex: number }>;
    };
    expect(createManyArg.data).toHaveLength(6);
    expect(
      createManyArg.data.filter((r) => r.engine === 'doubao').map((r) => r.sampleIndex),
    ).toEqual([1, 2, 3]);
    expect(
      createManyArg.data.filter((r) => r.engine === 'deepseek').map((r) => r.sampleIndex),
    ).toEqual([1, 2, 3]);

    // Default sampleCount=1 emits sampleIndex: 1
    const fx1 = buildFixture();
    let callIdx1 = 0;
    (fx1.prisma.scoped.visibilityRun.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        callIdx1 += 1;
        return callIdx1 >= 3 ? buildDetailRow(1, ['doubao'], ['四盘位 NAS']) : null;
      },
    );
    await runInTenant('tenant_a', async () => {
      await fx1.service.createRun(
        'brand_a',
        {
          market: 'CN',
          engines: ['doubao'],
          prompts: ['四盘位 NAS'],
          triggerType: 'MANUAL',
        },
        'sample-1-key',
        'user_1',
        'CN',
      );
    });
    expect(fx1.billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ amount: 2 }));
    const createMany1 = fx1.txCreateManyObs.mock.calls[0]?.[0] as unknown as {
      data: Array<{ sampleIndex: number }>;
    };
    expect(createMany1.data).toHaveLength(1);
    expect(createMany1.data[0]?.sampleIndex).toBe(1);
  });

  it('rejects invalid sampleCount with 400 and rejects replay with mismatched sampleCount with 409', async () => {
    const fxInvalid = buildFixture();
    await runInTenant('tenant_a', async () => {
      await expect(
        fxInvalid.service.createRun(
          'brand_a',
          {
            market: 'CN',
            engines: ['doubao'],
            prompts: ['四盘位 NAS'],
            triggerType: 'RETEST',
            sampleCount: 2 as unknown as 1 | 3,
          },
          'bad-sample-key',
          'user_1',
          'CN',
        ),
      ).rejects.toMatchObject({
        status: 400,
        code: API_ERROR.BAD_REQUEST,
      });
    });

    const fxReplay = buildFixture({
      existingRun: {
        id: 'vr_existing',
        brandId: 'brand_a',
        brandMarketId: 'bm_cn',
        engines: ['doubao'],
        prompts: ['四盘位 NAS'],
        triggerType: 'RETEST',
        retestArticleId: null,
        totalChecks: 1, // originally sampleCount=1
      },
    });
    await runInTenant('tenant_a', async () => {
      await expect(
        fxReplay.service.createRun(
          'brand_a',
          {
            market: 'CN',
            engines: ['doubao'],
            prompts: ['四盘位 NAS'],
            triggerType: 'RETEST',
            sampleCount: 3, // replay with sampleCount=3 -> expectedTotalChecks=3 !== 1
          },
          'replay-sample-mismatch',
          'user_1',
          'CN',
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: BILLING_ERROR.CONFLICT,
      });
    });
  });
});
