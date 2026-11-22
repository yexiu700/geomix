import { describe, expect, it, vi } from 'vitest';
import { API_ERROR, BILLING_ERROR } from '@geomix/shared';
import type { BillingService } from '../billing/billing.service';
import type { QuotaService } from '../billing/quota.service';
import type { BrandsService } from '../brands/brands.service';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import type { PrismaService } from '../prisma/prisma.service';
import type { StudioGenerationService } from './studio-generation.service';
import { StudioService } from './studio.service';

describe('StudioService adversarial guards (B-03, B-06)', () => {
  it('handles concurrent createBatchJob P2002 race without closing winner reservation and validates replay briefs (B-03)', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const now = new Date();
    const winnerRow = {
      id: 'gb_winner',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_cn',
      briefIds: ['b1', 'b2'],
      total: 2,
      doneCount: 0,
      failCount: 0,
      unitPrice: 10,
      reservationId: 'res_batch_1',
      status: 'QUEUED',
      lastError: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      brandMarket: { market: 'CN' },
    };

    let findBatchCalls = 0;
    const prisma = {
      scoped: {
        geoBatchJob: {
          findFirst: vi.fn(async () => {
            findBatchCalls += 1;
            // Call 1 (initial id check): null; Call 2 (replayedByReservation): null; Call 3 (catch P2002 winner): winnerRow
            return findBatchCalls >= 3 ? winnerRow : null;
          }),
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        geoBrief: {
          findMany: vi.fn(async () => [
            { id: 'b1', status: 'OPEN', targetPrompt: '问题1', suggestedTitle: '标题1' },
            { id: 'b2', status: 'OPEN', targetPrompt: '问题2', suggestedTitle: '标题2' },
          ]),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
        promptPreference: {
          findFirst: vi.fn(async () => null),
        },
      },
      base: {
        $transaction: vi.fn(async () => {
          throw p2002;
        }),
      },
    } as unknown as PrismaService;

    const brands = {
      resolveBrandMarket: vi.fn(async () => ({
        brand: { id: 'brand_a', name: '星辰存储', category: 'NAS' },
        market: {
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
    } as unknown as BrandsService;

    const billing = {
      unitPrice: vi.fn(async () => 10),
      reserve: vi.fn(async () => ({
        id: 'res_batch_1',
        status: 'OPEN',
        frozen: 20,
        shadow: false,
      })),
      close: vi.fn(async () => undefined),
    } as unknown as BillingService;

    const service = new StudioService(
      prisma,
      brands,
      billing,
      {} as QuotaService,
      new ComplianceService(),
      new FreeActionRateLimiter(),
      {} as StudioGenerationService,
    );

    const replayed = await service.createBatchJob(
      'brand_a',
      { market: 'CN', briefIds: ['b1', 'b2'] },
      'same-batch-idem-key',
      { tenantId: 'tenant_a', userId: 'u_1' },
    );

    expect(replayed.id).toBe('gb_winner');
    expect(billing.close).not.toHaveBeenCalled();

    // Mismatched briefs on concurrent P2002 must throw 409 and still NOT close winner's reservation
    findBatchCalls = 0;
    (prisma.scoped.geoBrief.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'b3', status: 'OPEN', targetPrompt: '问题3', suggestedTitle: '标题3' },
      { id: 'b4', status: 'OPEN', targetPrompt: '问题4', suggestedTitle: '标题4' },
    ]);
    await expect(
      service.createBatchJob(
        'brand_a',
        { market: 'CN', briefIds: ['b3', 'b4'] },
        'same-batch-idem-key',
        { tenantId: 'tenant_a', userId: 'u_1' },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: BILLING_ERROR.CONFLICT,
    });
    expect(billing.close).not.toHaveBeenCalled();
  });

  it('rejects prohibited contentHtml in updateArticle with 403/40302 and scans CN superlatives (B-06)', async () => {
    const updatedPayloads: Array<Record<string, unknown>> = [];
    const now = new Date();
    const existingArticle = {
      id: 'ga_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_cn',
      briefId: null,
      batchJobId: null,
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      title: '四盘位 NAS 选购指南',
      targetPrompt: '家用四盘位 NAS 推荐',
      outlineJson: [],
      contentMarkdown: '## 结论\n\n星辰存储支持双 2.5GbE 网口。',
      contentHtml: '<p>星辰存储支持双 2.5GbE 网口。</p>',
      schemaJsonLd: {},
      geoScore: 80,
      geoScoreDetail: {},
      tags: [],
      status: 'DRAFT',
      model: 'fake',
      tokensIn: 10,
      tokensOut: 20,
      complianceFlags: [],
      createdAt: now,
      updatedAt: now,
      brand: { id: 'brand_a', name: '星辰存储', category: '家用 NAS' },
      brandMarket: {
        id: 'bm_cn',
        market: 'CN',
        locale: 'zh-CN',
        localBrandName: '星辰存储',
        ownedDomains: ['star.example'],
      },
      brief: null,
    };

    const prisma = {
      scoped: {
        geoArticle: {
          findFirst: vi.fn(async () => existingArticle),
          update: vi.fn(async (args: { data: Record<string, unknown> }) => {
            updatedPayloads.push(args.data);
            return { ...existingArticle, ...args.data };
          }),
        },
        promptPreference: {
          findFirst: vi.fn(async () => null),
        },
        brandFact: {
          findMany: vi.fn(async () => []),
        },
      },
    } as unknown as PrismaService;

    const service = new StudioService(
      prisma,
      {} as BrandsService,
      {} as BillingService,
      {} as QuotaService,
      new ComplianceService(),
      new FreeActionRateLimiter(),
      {} as StudioGenerationService,
    );

    await expect(
      service.updateArticle(
        'ga_1',
        { contentHtml: '<p>非法赌博 洗钱 内容</p>' },
        { tenantId: 'tenant_a', userId: 'u_1' },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(updatedPayloads).toHaveLength(0);

    await service.updateArticle(
      'ga_1',
      { contentHtml: '<p>这是全网第一的家用 NAS 方案</p>' },
      { tenantId: 'tenant_a', userId: 'u_1' },
    );
    expect(updatedPayloads).toHaveLength(1);
    expect(updatedPayloads[0]?.contentHtml).not.toContain('全网第一');
    expect(updatedPayloads[0]?.contentHtml).toContain('较为靠前');
    expect(Array.isArray(updatedPayloads[0]?.complianceFlags)).toBe(true);
    expect((updatedPayloads[0]?.complianceFlags as unknown[]).length).toBeGreaterThan(0);

    // B-06-R (1): Decimal & hex numeric HTML entities must be blocked (403/40302) for prohibited terms
    for (const entityPayload of [
      '<p>&#38750;&#27861;&#36172;&#21338; &#27927;&#38065;</p>',
      '<p>&#x975e;&#x6cd5;&#x8d4c;&#x535a;</p>',
    ]) {
      await expect(
        service.updateArticle(
          'ga_1',
          { contentHtml: entityPayload },
          { tenantId: 'tenant_a', userId: 'u_1' },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: API_ERROR.FORBIDDEN_INDUSTRY,
      });
    }

    // B-06-R (1b): Numeric-entity encoded CN superlatives must be caught & replaced
    await service.updateArticle(
      'ga_1',
      { contentHtml: '<p>这是&#20840;&#32593;&#31532;&#19968;家用方案</p>' },
      { tenantId: 'tenant_a', userId: 'u_1' },
    );
    const entitySuperlativeHtml = String(updatedPayloads[1]?.contentHtml ?? '');
    expect(entitySuperlativeHtml).not.toContain('&#20840;');
    expect(entitySuperlativeHtml).not.toContain('全网第一');
    expect(entitySuperlativeHtml).toContain('较为靠前');

    // B-06-R (2): <img alt="..."> must reject prohibited terms (403/40302) and replace CN superlatives
    await expect(
      service.updateArticle(
        'ga_1',
        {
          contentHtml: '<img src="/api/v2/brands/b1/media/m1/file" alt="非法赌博 洗钱 全网第一" />',
        },
        { tenantId: 'tenant_a', userId: 'u_1' },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });

    await service.updateArticle(
      'ga_1',
      { contentHtml: '<img src="/api/v2/brands/b1/media/m1/file" alt="全网第一静音NAS" />' },
      { tenantId: 'tenant_a', userId: 'u_1' },
    );
    const imgAltHtml = String(updatedPayloads[2]?.contentHtml ?? '');
    expect(imgAltHtml).not.toContain('全网第一');
    expect(imgAltHtml).toContain('alt="较为靠前静音NAS"');

    // B-06-R (3): Inline-tag split CN superlatives must be replaced with zero superlatives remaining
    const compliance = new ComplianceService();
    await service.updateArticle(
      'ga_1',
      { contentHtml: '<p>全网<b>第一</b>与国<em>家</em>级</p>' },
      { tenantId: 'tenant_a', userId: 'u_1' },
    );
    const splitHtml = String(updatedPayloads[3]?.contentHtml ?? '');
    expect(splitHtml).toContain('较为靠前');
    expect(splitHtml).toContain('行业内');
    expect(splitHtml).not.toContain('第一');
    expect(splitHtml).not.toContain('国家级');
    const postCheck = compliance.scan(splitHtml.replace(/<[^>]+>/g, ''), { market: 'CN' });
    expect(postCheck.geoFlags.filter((f) => f.severity === 'replaced')).toHaveLength(0);
  });
});
