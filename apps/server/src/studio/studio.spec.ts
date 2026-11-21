import { describe, expect, it, vi } from 'vitest';
import { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import type { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { StudioGenerationService } from './studio-generation.service';
import { GeoBatchRunner } from './geo-batch.runner';
import type { PrismaService } from '../prisma/prisma.service';
import type { BillingService } from '../billing/billing.service';
import type { QuotaService } from '../billing/quota.service';

function makeFactRunner(
  snippets: Array<{ factId: string; slot: 'PRODUCT_SPECS'; title: string; content: string }>,
) {
  return {
    retrieveRelevantBrandFacts: vi.fn(async () =>
      snippets.map((s) => ({ ...s, source: 'direct' as const })),
    ),
  } as unknown as BrandFactIndexRunner;
}

describe('StudioGenerationService & GeoBatchRunner unit tests', () => {
  it('generates cross-lingual native English GLOBAL draft preserving Best/Top/100% from Chinese BrandFacts', async () => {
    const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const compliance = new ComplianceService();
    const facts = makeFactRunner([
      {
        factId: 'fact_cn_1',
        slot: 'PRODUCT_SPECS',
        title: '核心硬件参数',
        content:
          '搭载 Intel N100 处理器，实测满载噪音 18.5dB，待机功耗 14W，双 2.5GbE 网口，最高扩展 96TB，通过 ISO9001 认证。',
      },
    ]);
    const gen = new StudioGenerationService(llm, compliance, facts);
    const deltas: string[] = [];

    const result = await gen.streamArticle({
      tenantId: 'tenant_demo',
      articleId: 'ga_global_cross_001',
      brand: { id: 'brand_1', name: '星辰存储', category: 'Home NAS' },
      market: {
        id: 'mkt_global_1',
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        localBrandName: 'AstraVault',
        aliases: ['DXP4800'],
        ownedDomains: ['astravault.example.com'],
        competitors: ['Synology'],
      },
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      targetPrompt: 'Best 4-bay quiet home NAS 2026',
      outlineH2: [],
      targetFanOuts: ['18.5dB noise', '2.5GbE'],
      factSnippets: await gen.retrieveFacts('tenant_demo', 'brand_1', 'quiet home NAS'),
      matchedFactIds: ['fact_cn_1'],
      customForbiddenWords: ['BannedBuzzword'],
      reservationShadow: false,
      onDelta: (chunk) => {
        deltas.push(chunk);
      },
    });

    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(result.contentMarkdown).toContain('Best');
    expect(result.contentMarkdown).toContain('Top');
    expect(result.contentMarkdown).toContain('100%');
    expect(result.contentMarkdown).toContain('AstraVault');
    expect(result.contentMarkdown).toContain('18.5dB');
    expect(result.contentMarkdown).not.toContain('常见问题');
    expect(result.contentHtml).toContain('<table>');
    expect(result.complianceFlags.some((f) => f.code === 'AD_LAW_SUPERLATIVE')).toBe(false);
    expect(result.evaluation.geoScore).toBeGreaterThanOrEqual(85);
    expect(result.evaluation.llmsTxtSnippet).toContain('# AstraVault');
  });

  it('emits clickable [待补充：...] capsule on [E2E_MISSING_FACT] and throws upstream error on [E2E_LLM_FAIL]', async () => {
    const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const compliance = new ComplianceService();
    const gen = new StudioGenerationService(llm, compliance, makeFactRunner([]));

    const missingRes = await gen.generateArticle({
      tenantId: 'tenant_demo',
      articleId: 'ga_missing_001',
      brand: { id: 'b1', name: '星辰存储', category: '家用 NAS' },
      market: {
        id: 'm1',
        market: 'CN',
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: '星辰存储',
        aliases: [],
        ownedDomains: ['star.example.com'],
        competitors: ['竞品A'],
      },
      recipe: 'COMPARISON_MATRIX',
      targetFormat: 'CN_DEEP_REVIEW',
      targetPrompt: '[E2E_MISSING_FACT] 四盘位 NAS 功耗实测',
      outlineH2: [],
      targetFanOuts: [],
      factSnippets: [],
      matchedFactIds: [],
      reservationShadow: true,
    });
    expect(missingRes.contentMarkdown).toContain('[待补充：如待机功耗 W]');

    await expect(
      gen.generateArticle({
        tenantId: 'tenant_demo',
        articleId: 'ga_fail_001',
        brand: { id: 'b1', name: '星辰存储', category: '家用 NAS' },
        market: {
          id: 'm1',
          market: 'CN',
          locale: 'zh-CN',
          region: 'CN',
          localBrandName: '星辰存储',
          aliases: [],
          ownedDomains: [],
          competitors: [],
        },
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '[E2E_LLM_FAIL] 触发上游故障',
        outlineH2: [],
        targetFanOuts: [],
        factSnippets: [],
        matchedFactIds: [],
        reservationShadow: false,
      }),
    ).rejects.toMatchObject({ kind: 'upstream', reason: 'e2e_llm_fail' });
  });

  it('rejects fake output when global BILLING_MODE=STRICT (#321)', async () => {
    const prevMode = process.env.BILLING_MODE;
    process.env.BILLING_MODE = 'STRICT';
    try {
      const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
      const gen = new StudioGenerationService(llm, new ComplianceService(), makeFactRunner([]));
      await expect(
        gen.generateArticle({
          tenantId: 'tenant_demo',
          articleId: 'ga_strict_reject_01',
          brand: { id: 'b1', name: '星辰', category: 'NAS' },
          market: {
            id: 'm1',
            market: 'CN',
            locale: 'zh-CN',
            region: 'CN',
            localBrandName: '星辰',
            aliases: [],
            ownedDomains: [],
            competitors: [],
          },
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '家用 NAS 怎么选',
          outlineH2: [],
          targetFanOuts: [],
          factSnippets: [],
          matchedFactIds: [],
          reservationShadow: false,
        }),
      ).rejects.toMatchObject({ kind: 'upstream', reason: 'fake_fallback_rejected' });
    } finally {
      if (prevMode === undefined) delete process.env.BILLING_MODE;
      else process.env.BILLING_MODE = prevMode;
    }
  });

  it('processes GeoBatchRunner partial failure with exact per-item settle and refund', async () => {
    const settledUnits: string[] = [];
    const releasedUnits: string[] = [];
    let closedReservation: string | null = null;
    const createdArticles: Array<{ id: string; briefId: string | null }> = [];
    const briefStatuses = new Map<string, string>([
      ['brief_ok', 'WRITING'],
      ['brief_fail', 'WRITING'],
    ]);
    let jobStatus = 'QUEUED';
    let jobDone = 0;
    let jobFail = 0;

    const tx = {
      geoBatchJob: {
        findFirst: vi.fn(async () => ({
          id: 'gb_partial_01',
          tenantId: 'tenant_demo',
          brandId: 'brand_1',
          brandMarketId: 'mkt_cn',
          briefIds: ['brief_ok', 'brief_fail'],
          total: 2,
          doneCount: jobDone,
          failCount: jobFail,
          unitPrice: 10,
          reservationId: 'res_batch_01',
          status: jobStatus,
          lastError: null,
          brand: { id: 'brand_1', name: '星辰存储', category: '家用 NAS' },
          brandMarket: {
            id: 'mkt_cn',
            market: 'CN',
            locale: 'zh-CN',
            region: 'CN',
            localBrandName: '星辰存储',
            aliases: [],
            ownedDomains: ['star.example.com'],
            competitors: [{ name: '竞品A', aliases: [], domains: [] }],
          },
        })),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') jobStatus = args.data.status;
          if (typeof args.data.doneCount === 'number') jobDone = args.data.doneCount;
          if (typeof args.data.failCount === 'number') jobFail = args.data.failCount;
          return { count: 1 };
        }),
      },
      promptPreference: { findUnique: vi.fn(async () => null) },
      geoArticle: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async (args: { data: { id: string; briefId: string | null } }) => {
          createdArticles.push({ id: args.data.id, briefId: args.data.briefId });
          return args.data;
        }),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      pointReservation: {
        findFirst: vi.fn(async () => ({ id: 'res_batch_01', shadow: false, status: 'OPEN' })),
      },
      geoBrief: {
        findFirst: vi.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          tenantId: 'tenant_demo',
          brandId: 'brand_1',
          brandMarketId: 'mkt_cn',
          status: briefStatuses.get(args.where.id) ?? 'OPEN',
          targetPrompt:
            args.where.id === 'brief_fail' ? '[E2E_LLM_FAIL] 触发失败' : '四盘位家用 NAS 推荐',
          suggestedTitle: args.where.id === 'brief_fail' ? '失败测试' : '四盘位静音指南',
          recommendedRecipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          outlineH2: [],
          targetFanOuts: [],
          sourceCitationUrl: null,
        })),
        updateMany: vi.fn(async (args: { where: { id: string }; data: { status: string } }) => {
          briefStatuses.set(args.where.id, args.data.status);
          return { count: 1 };
        }),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      },
    } as unknown as PrismaService;

    const billing = {
      settleGeoWriteUnit: vi.fn(async (args: { unitKey: string }) => {
        settledUnits.push(args.unitKey);
      }),
      releaseUnit: vi.fn(async (args: { unitKey: string }) => {
        releasedUnits.push(args.unitKey);
      }),
      close: vi.fn(async (args: { reservationId: string }) => {
        closedReservation = args.reservationId;
      }),
    } as unknown as BillingService;

    const quota = {
      applyArticleEvent: vi.fn(async () => undefined),
    } as unknown as QuotaService;

    const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const compliance = new ComplianceService();
    const generation = new StudioGenerationService(llm, compliance, makeFactRunner([]));
    const runner = new GeoBatchRunner(prisma, billing, quota, generation, compliance);

    await runner.process({ tenantId: 'tenant_demo', jobId: 'gb_partial_01' });

    expect(createdArticles).toHaveLength(1);
    expect(createdArticles[0]?.briefId).toBe('brief_ok');
    expect(settledUnits).toEqual(['geo_batch:gb_partial_01:brief_ok']);
    expect(releasedUnits).toEqual(['geo_batch:gb_partial_01:brief_fail']);
    expect(closedReservation).toBe('res_batch_01');
    expect(briefStatuses.get('brief_ok')).toBe('DONE');
    expect(briefStatuses.get('brief_fail')).toBe('OPEN');
    expect(jobStatus).toBe('PARTIAL');
    expect(jobDone).toBe(1);
    expect(jobFail).toBe(1);
  });

  it('never leaks [FAKE] deltas for STRICT tenant even when global BILLING_MODE=SHADOW + LLM_FALLBACK_FAKE=true (#321 Probe 2.4d)', async () => {
    const prevMode = process.env.BILLING_MODE;
    process.env.BILLING_MODE = 'SHADOW';
    try {
      const llm = LlmService.fromEnv(
        {
          BILLING_MODE: 'SHADOW',
          LLM_FALLBACK_FAKE: 'true',
          DEEPSEEK_API_KEY: 'test-key',
          LLM_PROVIDERS: JSON.stringify({
            providers: {
              deepseek: {
                kind: 'openai',
                baseUrl: 'https://192.0.2.10/v1',
                apiKeyEnv: 'DEEPSEEK_API_KEY',
                cheapModel: 'deepseek-chat',
                qualityModel: 'deepseek-chat',
              },
            },
            route: { geo_write: { primary: 'deepseek', backup: [] } },
          }),
        },
        {
          streamTransport: async () => ({
            status: 503,
            headers: {},
            body: null,
            close: async () => undefined,
          }),
          resolver: {
            async resolve() {
              return [{ address: '192.0.2.10', family: 4 }];
            },
          },
          retryDelayMs: 0,
        },
      );
      const gen = new StudioGenerationService(llm, new ComplianceService(), makeFactRunner([]));
      const emittedDeltas: string[] = [];

      await expect(
        gen.streamArticle({
          tenantId: 'tenant_strict',
          articleId: 'ga_probe_24d_studio',
          brand: { id: 'b1', name: '星辰', category: 'NAS' },
          market: {
            id: 'm1',
            market: 'CN',
            locale: 'zh-CN',
            region: 'CN',
            localBrandName: '星辰',
            aliases: [],
            ownedDomains: [],
            competitors: [],
          },
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '四盘位 NAS 推荐',
          outlineH2: [],
          targetFanOuts: [],
          factSnippets: [],
          matchedFactIds: [],
          reservationShadow: false,
          onDelta: (chunk) => {
            emittedDeltas.push(chunk);
          },
        }),
      ).rejects.toMatchObject({ kind: 'upstream', reason: 'fake_fallback_rejected' });

      expect(emittedDeltas).toHaveLength(0);
    } finally {
      if (prevMode === undefined) delete process.env.BILLING_MODE;
      else process.env.BILLING_MODE = prevMode;
    }
  });

  it('skips previously RELEASED unitKeys on GeoBatchRunner BullMQ retry and preserves failCount', async () => {
    const settledUnits: string[] = [];
    const releasedUnits: string[] = [];
    const createdArticles: Array<{ id: string; briefId: string | null }> = [];
    let jobStatus = 'RUNNING';
    let jobDone = 1;
    let jobFail = 0;

    const tx = {
      geoBatchJob: {
        findFirst: vi.fn(async () => ({
          id: 'gb_retry_01',
          tenantId: 'tenant_demo',
          brandId: 'brand_1',
          brandMarketId: 'mkt_cn',
          briefIds: ['brief_done', 'brief_prev_failed', 'brief_remaining'],
          total: 3,
          doneCount: 1,
          failCount: 1,
          unitPrice: 10,
          reservationId: 'res_retry_01',
          status: 'RUNNING',
          lastError: 'prior error',
          brand: { id: 'brand_1', name: '星辰存储', category: '家用 NAS' },
          brandMarket: {
            id: 'mkt_cn',
            market: 'CN',
            locale: 'zh-CN',
            region: 'CN',
            localBrandName: '星辰存储',
            aliases: [],
            ownedDomains: ['star.example.com'],
            competitors: [],
          },
        })),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') jobStatus = args.data.status;
          if (typeof args.data.doneCount === 'number') jobDone = args.data.doneCount;
          if (typeof args.data.failCount === 'number') jobFail = args.data.failCount;
          return { count: 1 };
        }),
      },
      promptPreference: { findUnique: vi.fn(async () => null) },
      geoArticle: {
        findMany: vi.fn(async () => [{ id: 'ga_done', briefId: 'brief_done' }]),
        create: vi.fn(async (args: { data: { id: string; briefId: string | null } }) => {
          createdArticles.push({ id: args.data.id, briefId: args.data.briefId });
          return args.data;
        }),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      pointReservation: {
        findFirst: vi.fn(async () => ({ id: 'res_retry_01', shadow: false, status: 'OPEN' })),
      },
      pointLog: {
        findMany: vi.fn(async () => [{ unitKey: 'geo_batch:gb_retry_01:brief_prev_failed' }]),
      },
      geoBrief: {
        findFirst: vi.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          tenantId: 'tenant_demo',
          brandId: 'brand_1',
          brandMarketId: 'mkt_cn',
          status: 'WRITING',
          targetPrompt: '家用 NAS 选购指南',
          suggestedTitle: '家用 NAS 选购指南',
          recommendedRecipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          outlineH2: [],
          targetFanOuts: [],
          sourceCitationUrl: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      },
    } as unknown as PrismaService;

    const billing = {
      settleGeoWriteUnit: vi.fn(async (args: { unitKey: string }) => {
        settledUnits.push(args.unitKey);
      }),
      releaseUnit: vi.fn(async (args: { unitKey: string }) => {
        releasedUnits.push(args.unitKey);
      }),
      close: vi.fn(async () => undefined),
    } as unknown as BillingService;

    const quota = {
      applyArticleEvent: vi.fn(async () => undefined),
    } as unknown as QuotaService;

    const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const compliance = new ComplianceService();
    const generation = new StudioGenerationService(llm, compliance, makeFactRunner([]));
    const runner = new GeoBatchRunner(prisma, billing, quota, generation, compliance);

    await runner.process({ tenantId: 'tenant_demo', jobId: 'gb_retry_01' });

    expect(createdArticles.map((a) => a.briefId)).toEqual(['brief_remaining']);
    expect(settledUnits).toEqual(['geo_batch:gb_retry_01:brief_remaining']);
    expect(releasedUnits).toEqual([]);
    expect(jobStatus).toBe('PARTIAL');
    expect(jobDone).toBe(2);
    expect(jobFail).toBe(1);
  });
});
