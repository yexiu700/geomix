import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { QuotaService } from '../billing/quota.service';
import type { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import type { BrandsService } from '../brands/brands.service';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import type { LlmService } from '../infra/llm';
import type { PrismaService } from '../prisma/prisma.service';
import { mergeProductLineBrandAliases } from '../visibility/visibility.mapper';
import { GeoBatchRunner } from './geo-batch.runner';
import { StudioGenerationService } from './studio-generation.service';
import { StudioService } from './studio.service';

describe('Studio & Visibility Product-Line Competitors + GLOBAL CJK Guard', () => {
  it('GeoBatchRunner resolves brief.productLine.competitorsJson per market and falls back to brandMarket.competitors when empty', async () => {
    const generateArticle = vi.fn(async () => ({
      title: 'Generated Title',
      contentMarkdown: '## Overview\n\nGenerated content.',
      contentHtml: '<h2>Overview</h2><p>Generated content.</p>',
      evaluation: {
        geoScore: 88,
        geoScoreDetail: {},
        schemaJsonLd: {},
        llmsTxtSnippet: 'snippet',
      },
      model: 'fake',
      tokensIn: 10,
      tokensOut: 20,
      complianceFlags: [],
    }));

    const briefWithLine = {
      id: 'brief_line',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      productLineId: 'pl_power',
      productLine: {
        id: 'pl_power',
        name: '户外电源线',
        localNamesJson: { GLOBAL: 'HeliosPower' },
        category: '便携储能电源',
        localCategoriesJson: { GLOBAL: 'Portable Power Station' },
        competitorsJson: {
          GLOBAL: [{ name: 'EcoFlow', aliases: [], domains: ['ecoflow.example'] }],
          CN: [{ name: '正浩', aliases: [], domains: [] }],
        },
      },
      status: 'OPEN',
      targetPrompt: 'Best portable power station 2026',
      suggestedTitle: 'HeliosPower vs EcoFlow',
      recommendedRecipe: 'COMPARISON',
      targetFormat: 'OFFICIAL_GUIDE',
      outlineH2: [{ heading: 'Overview' }],
      targetFanOuts: ['2048Wh capacity'],
      sourceCitationUrl: null,
    };

    const briefFallback = {
      id: 'brief_fallback',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      productLineId: 'pl_empty_comp',
      productLine: {
        id: 'pl_empty_comp',
        name: 'Home NAS',
        localNamesJson: { GLOBAL: 'HeliosNAS' },
        category: 'Home NAS',
        localCategoriesJson: { GLOBAL: 'Home NAS' },
        competitorsJson: { GLOBAL: [] },
      },
      status: 'OPEN',
      targetPrompt: 'Best quiet home NAS 2026',
      suggestedTitle: 'HeliosNAS Guide',
      recommendedRecipe: 'DIRECT_ANSWER',
      targetFormat: 'OFFICIAL_GUIDE',
      outlineH2: [{ heading: 'Overview' }],
      targetFanOuts: ['28dB noise'],
      sourceCitationUrl: null,
    };

    const job = {
      id: 'job_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      briefIds: ['brief_line', 'brief_fallback'],
      status: 'QUEUED',
      unitPrice: 0,
      reservationId: null,
      lastError: null,
      brand: { id: 'brand_a', name: 'NovaTech', category: 'Smart Hardware' },
      brandMarket: {
        id: 'bm_global',
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        localBrandName: 'NovaTech',
        localCategory: 'Smart Hardware',
        aliases: ['Nova'],
        ownedDomains: ['novatech.example'],
        competitors: [{ name: 'BrandWideComp', aliases: [], domains: ['brandwide.example'] }],
        supportedLocales: ['en-US'],
      },
    };

    const tx = {
      geoBatchJob: {
        findFirst: vi.fn(async () => job),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      promptPreference: { findUnique: vi.fn(async () => null) },
      geoArticle: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 'art_1' })),
      },
      geoBrief: {
        findFirst: vi.fn(async (args: { where: { id: string } }) =>
          args.where.id === 'brief_line' ? briefWithLine : briefFallback,
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      },
    } as unknown as PrismaService;

    const generation = {
      retrieveFacts: vi.fn(async () => []),
      generateArticle,
    } as unknown as StudioGenerationService;

    const runner = new GeoBatchRunner(
      prisma,
      {
        settleUnit: vi.fn(async () => undefined),
        releaseUnit: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as BillingService,
      { applyArticleEvent: vi.fn(async () => undefined) } as unknown as QuotaService,
      generation,
      new ComplianceService(),
    );

    await runner.process({ tenantId: 'tenant_a', jobId: 'job_1' });

    expect(generateArticle).toHaveBeenCalledTimes(2);
    expect(
      (generateArticle.mock.calls[0] as unknown as [{ market: { competitors: string[] } }])[0]
        .market.competitors,
    ).toEqual(['EcoFlow']);
    expect(
      (generateArticle.mock.calls[1] as unknown as [{ market: { competitors: string[] } }])[0]
        .market.competitors,
    ).toEqual(['BrandWideComp']);
  });

  it('StudioService.rewriteSection resolves productLine.competitorsJson and falls back to brandMarket.competitors when empty', async () => {
    const rewriteSectionMock = vi.fn(async () => ({
      rewrittenText: 'Rewritten comparison vs Jackery.',
      complianceFlags: [],
      model: 'fake',
      tokensIn: 10,
      tokensOut: 20,
    }));

    const baseArticle = {
      id: 'art_line',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      productLineId: 'pl_power',
      targetLocale: 'en-US',
      brand: { id: 'brand_a', name: 'NovaTech', category: 'Smart Hardware' },
      brandMarket: {
        id: 'bm_global',
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        localBrandName: 'NovaTech',
        aliases: ['Nova'],
        ownedDomains: ['novatech.example'],
        competitors: [{ name: 'BrandWideComp', aliases: [], domains: [] }],
      },
      productLine: {
        id: 'pl_power',
        name: '户外电源线',
        localNamesJson: { GLOBAL: 'HeliosPower' },
        category: '便携储能电源',
        localCategoriesJson: { GLOBAL: 'Portable Power Station' },
        competitorsJson: {
          GLOBAL: [{ name: 'Jackery', aliases: [], domains: ['jackery.example'] }],
        },
      },
    };

    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(baseArticle)
      .mockResolvedValueOnce({
        ...baseArticle,
        productLine: { ...baseArticle.productLine, competitorsJson: { GLOBAL: [] } },
      });

    const prisma = {
      scoped: {
        geoArticle: { findFirst },
        promptPreference: { findFirst: vi.fn(async () => null) },
      },
    } as unknown as PrismaService;

    const service = new StudioService(
      prisma,
      {} as BrandsService,
      {} as BillingService,
      {} as QuotaService,
      new ComplianceService(),
      new FreeActionRateLimiter(),
      { rewriteSection: rewriteSectionMock } as unknown as StudioGenerationService,
    );

    await service.rewriteSection(
      'art_line',
      {
        action: 'TO_TABLE',
        selectedText: 'HeliosPower delivers 2048Wh output.',
      },
      { tenantId: 'tenant_a', userId: 'u_1' },
    );

    await service.rewriteSection(
      'art_line',
      {
        action: 'TO_TABLE',
        selectedText: 'HeliosPower delivers 2048Wh output.',
      },
      { tenantId: 'tenant_a', userId: 'u_1' },
    );

    expect(rewriteSectionMock).toHaveBeenCalledTimes(2);
    expect(
      (rewriteSectionMock.mock.calls[0] as unknown as [{ market: { competitors: string[] } }])[0]
        .market.competitors,
    ).toEqual(['Jackery']);
    expect(
      (rewriteSectionMock.mock.calls[1] as unknown as [{ market: { competitors: string[] } }])[0]
        .market.competitors,
    ).toEqual(['BrandWideComp']);
  });

  it('StudioGenerationService.rewriteSection blocks Chinese productLine.name and CJK localNamesJson.GLOBAL on GLOBAL market', async () => {
    const llm = {
      usesFakePrimary: () => false,
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'NovaTech 家用NAS线 delivers reliable 28dB home storage.',
          model: 'mock-live',
          tokensIn: 20,
          tokensOut: 20,
          fake: false,
        })
        .mockResolvedValueOnce({
          text: 'NovaTech 中文海外名 delivers reliable 28dB home storage.',
          model: 'mock-live',
          tokensIn: 20,
          tokensOut: 20,
          fake: false,
        })
        .mockResolvedValueOnce({
          text: 'NovaTech NovaNAS Pro delivers reliable 28dB home storage compared to Synology.',
          model: 'mock-live',
          tokensIn: 20,
          tokensOut: 20,
          fake: false,
        }),
    } as unknown as LlmService;

    const generation = new StudioGenerationService(llm, new ComplianceService(), {
      retrieveRelevantBrandFacts: vi.fn(async () => []),
    } as unknown as BrandFactIndexRunner);

    const commonParams = {
      tenantId: 'tenant_a',
      articleId: 'art_1',
      brand: { id: 'brand_a', name: 'NovaTech', category: 'Smart Hardware' },
      market: {
        id: 'bm_global',
        market: 'GLOBAL' as const,
        locale: 'en-US',
        region: 'US',
        localBrandName: 'NovaTech',
        aliases: ['Nova'],
        ownedDomains: ['novatech.example'],
        competitors: ['Synology'],
      },
      productLineId: 'pl_nas',
      targetLocale: 'en-US' as const,
      action: 'ADD_EVIDENCE' as const,
      selectedText: 'NovaNAS Pro runs quietly.',
    };

    // 1. Echoing Chinese productLine.name MUST be rejected
    await expect(
      generation.rewriteSection({
        ...commonParams,
        productLine: {
          id: 'pl_nas',
          name: '家用NAS线',
          localNamesJson: { GLOBAL: 'NovaNAS Pro' },
          category: '家庭 NAS',
          localCategoriesJson: { GLOBAL: 'Home NAS' },
        },
      }),
    ).rejects.toThrow(/未翻译|中文|CJK/);

    // 2. Echoing CJK localNamesJson.GLOBAL MUST be rejected
    await expect(
      generation.rewriteSection({
        ...commonParams,
        productLine: {
          id: 'pl_nas',
          name: '家用NAS线',
          localNamesJson: { GLOBAL: '中文海外名' },
          category: '家庭 NAS',
          localCategoriesJson: { GLOBAL: 'Home NAS' },
        },
      }),
    ).rejects.toThrow(/未翻译|中文|CJK/);

    // 3. Clean English localNamesJson.GLOBAL + competitor passes
    const clean = await generation.rewriteSection({
      ...commonParams,
      productLine: {
        id: 'pl_nas',
        name: '家用NAS线',
        localNamesJson: { GLOBAL: 'NovaNAS Pro' },
        category: '家庭 NAS',
        localCategoriesJson: { GLOBAL: 'Home NAS' },
      },
    });
    expect(clean.rewrittenText).toContain('NovaNAS Pro');
  });

  it('mergeProductLineBrandAliases excludes CJK productLine.name and CJK localNamesJson.GLOBAL on GLOBAL while preserving them on CN', () => {
    const productLine = {
      name: '家用NAS线',
      localNamesJson: { CN: '星曜私有云', GLOBAL: 'NovaNAS Pro' },
    };
    expect(mergeProductLineBrandAliases(['Nova'], productLine, 'GLOBAL')).toEqual([
      'Nova',
      'NovaNAS Pro',
    ]);
    expect(mergeProductLineBrandAliases(['Nova'], productLine, 'CN')).toEqual([
      'Nova',
      '家用NAS线',
      '星曜私有云',
    ]);

    const badGlobalLine = {
      name: '家用NAS线',
      localNamesJson: { GLOBAL: '中文海外名' },
    };
    expect(mergeProductLineBrandAliases(['Nova'], badGlobalLine, 'GLOBAL')).toEqual(['Nova']);
  });
});
