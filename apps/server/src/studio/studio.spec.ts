import { describe, expect, it, vi } from 'vitest';
import {
  detectLocaleLeakage,
  resolveLocaleWritingDirective,
  type SupportedLocale,
} from '@geomix/shared';
import { ComplianceService } from '../infra/compliance';
import { LlmService, type LlmMessage } from '../infra/llm';
import type { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { StudioGenerationService } from './studio-generation.service';
import { GeoBatchRunner } from './geo-batch.runner';
import { presentGeoArticle } from './studio.mapper';
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

  describe('M3B multi-locale writing, directives, leakage guard & batch propagation (#370)', () => {
    it('injects resolveLocaleWritingDirective prompts across locales and passes ja-JP Kanji+Kana with 0 false positives', async () => {
      const capturedMessages: Array<{ locale: SupportedLocale; messages: LlmMessage[] }> = [];
      const sampleBodyByLocale: Record<SupportedLocale, string> = {
        'zh-CN':
          '星辰存储 N4 满载实测 18.5dB。\n\n## 核心规格\n\n| 指标 | 星辰存储 |\n| --- | --- |\n| 噪音 | 18.5dB |\n\n## 常见问题解答（FAQ）\n**问：适合客厅吗？**\n答：实测 18.5dB 适合静音部署。',
        'en-US':
          'AstraVault delivers 18.5dB quiet load performance.\n\n## Specs\n\n| Metric | AstraVault |\n| --- | --- |\n| Noise | 18.5dB |\n\n## Frequently Asked Questions (FAQ)\n**Q: Quiet?**\nA: Measured 18.5dB.',
        'en-GB':
          'AstraVault delivers optimised 18.5dB load acoustics for UK studios.\n\n## Verified Specs\n\n| Metric | AstraVault |\n| --- | --- |\n| Noise | 18.5dB |\n\n## Frequently Asked Questions (FAQ)\n**Q: Quiet?**\nA: Measured 18.5dB.',
        'de-DE':
          'AstraVault erreicht 18.5dB unter Last und bietet geprüfte Effizienz für Büros.\n\n## Geprüfte Spezifikationen\n\n| Kriterium | AstraVault |\n| --- | --- |\n| Geräusch | 18.5dB |\n\n## Häufig gestellte Fragen (FAQ)\n**F: Leise im Dauerbetrieb?**\nA: Gemessen wurden 18.5dB.',
        'ja-JP':
          'AstraVault は検証済みの実測データ（18.5dB、14W）を備えた静音ストレージです。\n\n## 検証済みスペック比較\n\n| 評価項目 | AstraVault |\n| --- | --- |\n| 動作音 | 18.5dB |\n\n## よくある質問（FAQ）\n**Q: リビングでも静かですか？**\nA: 高負荷時でも 18.5dB で快適に運用できます。',
        'es-ES':
          'AstraVault alcanza 18.5dB bajo carga con especificaciones verificadas.\n\n## Especificaciones verificadas\n\n| Métrica | AstraVault |\n| --- | --- |\n| Ruido | 18.5dB |\n\n## Preguntas frecuentes (FAQ)\n**P: ¿Es silencioso?**\nR: Registra 18.5dB medidos.',
        'fr-FR':
          'AstraVault atteint 18.5dB en charge avec des spécifications vérifiées.\n\n## Spécifications vérifiées\n\n| Critère | AstraVault |\n| --- | --- |\n| Bruit | 18.5dB |\n\n## Questions fréquentes (FAQ)\n**Q : Est-il silencieux ?**\nR : Mesuré à 18.5dB.',
      };

      let activeLocale: SupportedLocale = 'en-US';
      const llm = {
        usesFakePrimary: vi.fn(() => false),
        isFakeAllowed: vi.fn(() => false),
        streamComplete: vi.fn(
          async (opts: { messages: LlmMessage[]; onDelta: (c: string) => void }) => {
            capturedMessages.push({ locale: activeLocale, messages: opts.messages });
            const text = sampleBodyByLocale[activeLocale];
            opts.onDelta(text);
            return {
              provider: 'stub-real',
              model: 'stub-real-1',
              fake: false,
              text,
              tokensIn: 120,
              tokensOut: 220,
            };
          },
        ),
      } as unknown as LlmService;

      const gen = new StudioGenerationService(llm, new ComplianceService(), makeFactRunner([]));

      for (const locale of ['en-GB', 'de-DE', 'ja-JP', 'es-ES', 'fr-FR', 'zh-CN'] as const) {
        activeLocale = locale;
        const isCn = locale === 'zh-CN';
        const res = await gen.generateArticle({
          tenantId: 'tenant_demo',
          articleId: `ga_real_${locale}`,
          brand: { id: 'b1', name: '星辰存储', category: 'Home NAS' },
          market: {
            id: isCn ? 'mkt_cn' : 'mkt_global',
            market: isCn ? 'CN' : 'GLOBAL',
            locale: isCn ? 'zh-CN' : 'en-US',
            region: isCn ? 'CN' : 'US',
            localBrandName: isCn ? '星辰存储' : 'AstraVault',
            aliases: ['星辰存储'],
            ownedDomains: ['astravault.example.com'],
            competitors: ['Synology'],
          },
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: isCn ? 'CN_DEEP_REVIEW' : 'GLOBAL_AUTHORITY_GUIDE',
          targetLocale: locale,
          targetPrompt: isCn ? '静音 NAS 推荐' : 'Quiet 4-bay NAS 2026',
          outlineH2: [],
          targetFanOuts: [],
          factSnippets: [],
          matchedFactIds: [],
          reservationShadow: false,
        });

        expect(res.targetLocale).toBe(locale);
        const graph = (
          res.evaluation.schemaJsonLd as { '@graph'?: Array<{ inLanguage?: string }> }
        )['@graph'];
        expect(graph?.[0]?.inLanguage).toBe(locale);
      }

      for (const entry of capturedMessages) {
        const directive = resolveLocaleWritingDirective(entry.locale);
        const sysPrompt = entry.messages[0]?.content ?? '';
        expect(sysPrompt).toContain(directive.writingLanguageInstruction);
        expect(sysPrompt).toContain(directive.complianceInstruction);
        expect(sysPrompt).toContain(directive.faqHeading);
        if (entry.locale !== 'en-US') {
          expect(sysPrompt).not.toContain('Write in fluent native English');
        }
      }
    });

    it('blocks Latin CJK leak and ja-JP Simplified Chinese leak while whitelisting Chinese brand names', async () => {
      const makeRealLlm = (body: string) =>
        ({
          usesFakePrimary: vi.fn(() => false),
          isFakeAllowed: vi.fn(() => false),
          streamComplete: vi.fn(async () => ({
            provider: 'stub-real',
            model: 'stub-real-1',
            fake: false,
            text: body,
            tokensIn: 100,
            tokensOut: 150,
          })),
          complete: vi.fn(async () => ({
            provider: 'stub-real',
            model: 'stub-real-1',
            fake: false,
            text: body,
            tokensIn: 60,
            tokensOut: 80,
          })),
        }) as unknown as LlmService;

      const baseMarket = {
        id: 'mkt_global',
        market: 'GLOBAL' as const,
        locale: 'en-US',
        region: 'US',
        localBrandName: 'AstraVault',
        aliases: ['星辰存储'],
        ownedDomains: ['astravault.example.com'],
        competitors: ['Synology'],
      };

      // 1. de-DE with leaked Chinese prose -> blocked with locale_leakage_blocked
      const genDeLeak = new StudioGenerationService(
        makeRealLlm(
          'AstraVault bietet 18.5dB. 这里混入了未翻译的中文评测结论。\n\n## Häufig gestellte Fragen (FAQ)\n**F: Gut?**\nA: Ja.',
        ),
        new ComplianceService(),
        makeFactRunner([]),
      );
      await expect(
        genDeLeak.generateArticle({
          tenantId: 't1',
          articleId: 'ga_de_leak',
          brand: { id: 'b1', name: '星辰存储', category: 'Home NAS' },
          market: baseMarket,
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetLocale: 'de-DE',
          targetPrompt: 'Leises NAS 2026',
          outlineH2: [],
          targetFanOuts: [],
          factSnippets: [],
          matchedFactIds: [],
          reservationShadow: false,
        }),
      ).rejects.toMatchObject({ kind: 'contract', reason: 'locale_leakage_blocked' });

      // 2. ja-JP with Simplified Chinese exclusive chars -> blocked with locale_leakage_blocked
      const genJaScLeak = new StudioGenerationService(
        makeRealLlm(
          'AstraVault 评测结果非常优秀，适合家庭选择使用。\n\n## よくある質問（FAQ）\n**Q: どうですか？**\nA: 评测结论很好。',
        ),
        new ComplianceService(),
        makeFactRunner([]),
      );
      await expect(
        genJaScLeak.generateArticle({
          tenantId: 't1',
          articleId: 'ga_ja_sc_leak',
          brand: { id: 'b1', name: '星辰存储', category: 'Home NAS' },
          market: baseMarket,
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetLocale: 'ja-JP',
          targetPrompt: '静音 NAS 比較',
          outlineH2: [],
          targetFanOuts: [],
          factSnippets: [],
          matchedFactIds: [],
          reservationShadow: false,
        }),
      ).rejects.toMatchObject({ kind: 'contract', reason: 'locale_leakage_blocked' });

      // 3. de-DE mentioning official Chinese brand name (星辰存储 in brand.name/aliases) -> passes!
      const genDeBrandOk = new StudioGenerationService(
        makeRealLlm(
          'AstraVault (星辰存储) erreicht 18.5dB bei 14W im Dauerbetrieb.\n\n## Messwerte\n\n| Kriterium | Wert |\n| --- | --- |\n| Geräusch | 18.5dB |\n\n## Häufig gestellte Fragen (FAQ)\n**F: Leise?**\nA: Ja, 18.5dB.',
        ),
        new ComplianceService(),
        makeFactRunner([]),
      );
      const okRes = await genDeBrandOk.generateArticle({
        tenantId: 't1',
        articleId: 'ga_de_brand_ok',
        brand: { id: 'b1', name: '星辰存储', category: 'Home NAS' },
        market: baseMarket,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetLocale: 'de-DE',
        targetPrompt: 'Leises NAS 2026',
        outlineH2: [],
        targetFanOuts: [],
        factSnippets: [],
        matchedFactIds: [],
        reservationShadow: false,
      });
      expect(okRes.targetLocale).toBe('de-DE');
      expect(okRes.contentMarkdown).toContain('星辰存储');

      // 4. Inline rewriteSection in de-DE with leaked Chinese -> blocked
      await expect(
        genDeLeak.rewriteSection({
          tenantId: 't1',
          articleId: 'ga_de_rw_leak',
          brand: { id: 'b1', name: '星辰存储', category: 'Home NAS' },
          market: baseMarket,
          targetLocale: 'de-DE',
          action: 'CONCISE_ANSWER',
          selectedText: 'AstraVault arbeitet leise mit 18.5dB.',
        }),
      ).rejects.toMatchObject({ kind: 'contract', reason: 'locale_leakage_blocked' });
    });

    it('generates clean fake drafts (geoScore >= 85, 0 leakage) for en-GB/de-DE/ja-JP/es-ES/fr-FR even with Chinese customToneNote', async () => {
      const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
      const gen = new StudioGenerationService(llm, new ComplianceService(), makeFactRunner([]));

      for (const locale of ['en-GB', 'de-DE', 'ja-JP', 'es-ES', 'fr-FR'] as const) {
        const res = await gen.generateArticle({
          tenantId: 't1',
          articleId: `ga_fake_${locale}`,
          brand: { id: 'b1', name: '星辰存储', category: 'Home NAS' },
          market: {
            id: 'mkt_global',
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
          targetLocale: locale,
          targetPrompt: 'Quiet 4-bay NAS 2026',
          outlineH2: [],
          targetFanOuts: [],
          factSnippets: [],
          matchedFactIds: [],
          customToneNote: '保持客观技术评测口吻',
          reservationShadow: true,
        });

        expect(res.targetLocale).toBe(locale);
        expect(res.evaluation.geoScore).toBeGreaterThanOrEqual(85);
        const leakage = detectLocaleLeakage(`${res.title}\n${res.contentMarkdown}`, locale, [
          '星辰存储',
          'AstraVault',
          'DXP4800',
          'Synology',
        ]);
        expect(leakage.leaked).toBe(false);
        const graph = (
          res.evaluation.schemaJsonLd as { '@graph'?: Array<{ inLanguage?: string }> }
        )['@graph'];
        expect(graph?.[0]?.inLanguage).toBe(locale);
      }
    });

    it('persists targetLocale through GeoBatchRunner into geoArticle.create', async () => {
      const createdArticles: Array<{ id: string; targetLocale?: string | null }> = [];
      const tx = {
        geoBatchJob: {
          findFirst: vi.fn(async () => ({
            id: 'gb_locale_ja',
            tenantId: 'tenant_demo',
            brandId: 'brand_1',
            brandMarketId: 'mkt_global',
            briefIds: ['brief_ja_1'],
            total: 1,
            doneCount: 0,
            failCount: 0,
            unitPrice: 10,
            reservationId: 'res_batch_ja',
            status: 'QUEUED',
            lastError: null,
            brand: { id: 'brand_1', name: 'AstraVault', category: 'Home NAS' },
            brandMarket: {
              id: 'mkt_global',
              market: 'GLOBAL',
              locale: 'en-US',
              supportedLocales: ['en-US', 'ja-JP'],
              region: 'US',
              localBrandName: 'AstraVault',
              localCategory: 'Home NAS',
              aliases: [],
              ownedDomains: ['astravault.example.com'],
              competitors: [{ name: 'Synology' }],
            },
          })),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        promptPreference: { findUnique: vi.fn(async () => null) },
        geoArticle: {
          findMany: vi.fn(async () => []),
          create: vi.fn(async (args: { data: { id: string; targetLocale?: string | null } }) => {
            createdArticles.push({
              id: args.data.id,
              targetLocale: args.data.targetLocale ?? null,
            });
            return args.data;
          }),
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        pointReservation: {
          findFirst: vi.fn(async () => ({ id: 'res_batch_ja', shadow: true, status: 'OPEN' })),
        },
        geoBrief: {
          findFirst: vi.fn(async () => ({
            id: 'brief_ja_1',
            tenantId: 'tenant_demo',
            brandId: 'brand_1',
            brandMarketId: 'mkt_global',
            status: 'OPEN',
            targetPrompt: 'Quiet 4-bay NAS 2026',
            suggestedTitle: 'AstraVault 静音 NAS 比較ガイド',
            recommendedRecipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
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
        settleGeoWriteUnit: vi.fn(async () => undefined),
        releaseUnit: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as BillingService;
      const quota = { applyArticleEvent: vi.fn(async () => undefined) } as unknown as QuotaService;
      const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
      const compliance = new ComplianceService();
      const generation = new StudioGenerationService(llm, compliance, makeFactRunner([]));
      const runner = new GeoBatchRunner(prisma, billing, quota, generation, compliance);

      await runner.process({
        tenantId: 'tenant_demo',
        jobId: 'gb_locale_ja',
        targetLocale: 'ja-JP',
      });

      expect(createdArticles).toHaveLength(1);
      expect(createdArticles[0]?.targetLocale).toBe('ja-JP');
    });

    it('Iter 2 Fix 5: unwraps outer markdown fences, JSON-LD blocks, orphaned Schema.org headings & leading H1 BEFORE injecting localized structural markers', async () => {
      const compliance = new ComplianceService();
      const baseMarket = {
        id: 'mkt_global_de',
        market: 'GLOBAL' as const,
        locale: 'en-US',
        region: 'DE',
        localBrandName: 'UGREEN',
        localCategory: 'Home NAS',
        aliases: [],
        ownedDomains: ['ugreen.example.com'],
        competitors: ['Synology'],
      };

      const runWithRealRaw = async (rawText: string) => {
        const llm = {
          usesFakePrimary: () => false,
          hasFakeFallback: () => false,
          streamComplete: vi.fn(async () => ({
            provider: 'deepseek',
            model: 'deepseek-chat',
            fake: false,
            text: rawText,
            tokensIn: 80,
            tokensOut: 120,
          })),
        } as unknown as LlmService;
        const gen = new StudioGenerationService(llm, compliance, makeFactRunner([]));
        return gen.generateArticle({
          tenantId: 'tenant_demo',
          articleId: 'ga_de_probe',
          brand: { id: 'b_1', name: 'UGREEN', category: 'Home NAS' },
          market: baseMarket,
          targetLocale: 'de-DE',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'Leises Heim-NAS Vergleich',
          outlineH2: [],
          targetFanOuts: [],
          matchedFactIds: [],
          factSnippets: [],
          customForbiddenWords: [],
          reservationShadow: true,
        });
      };

      // Probe 1: outer ```markdown fence without FAQ -> unwrapped cleanly, localized FAQ added, no <pre><code> trap, no English FAQ
      const resFence = await runWithRealRaw(
        '```markdown\n## Geprüfte Hardware-Spezifikationen\n\nUGREEN bietet 18.5dB Laufruhe und 14W Stromverbrauch.\n```',
      );
      expect(resFence.contentMarkdown).not.toContain('```markdown');
      expect(resFence.contentHtml).not.toContain('<pre><code>');
      expect(resFence.contentMarkdown).toContain('## Häufig gestellte Fragen (FAQ)');
      expect(resFence.contentMarkdown).not.toContain('## Frequently Asked Questions (FAQ)');

      // Probe 2: inline JSON-LD FAQPage with no Markdown FAQ -> JSON-LD stripped, localized FAQ injected, zero English FAQ
      const resJsonLdFaq = await runWithRealRaw(
        '## Geprüfte Hardware-Spezifikationen\n\nUGREEN erreicht 18.5dB und 14W im Dauerbetrieb.\n\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>',
      );
      expect(resJsonLdFaq.contentMarkdown).not.toContain('application/ld+json');
      expect(resJsonLdFaq.contentMarkdown).toContain('## Häufig gestellte Fragen (FAQ)');
      expect(resJsonLdFaq.contentMarkdown).not.toContain('## Frequently Asked Questions (FAQ)');

      // Probe 3: orphaned ## Schema.org + fenced JSON-LD with prose FAQ -> stripped, localized Key Takeaways injected, zero English Key Takeaways
      const resOrphanSchema = await runWithRealRaw(
        'UGREEN erreicht 18.5dB und 14W (siehe FAQ-Abschnitt der Dokumentation).\n\n## Schema.org\n```json\n{"@context":"https://schema.org","@type":"Article"}\n```',
      );
      expect(resOrphanSchema.contentMarkdown).not.toContain('## Schema.org');
      expect(resOrphanSchema.contentMarkdown).toContain('## Wichtigste geprüfte Erkenntnisse');
      expect(resOrphanSchema.contentMarkdown).not.toContain('## Key Takeaways');

      // Probe 4: leading # H1 without ## heading -> H1 stripped cleanly, localized H2 prepended without duplicate # H1
      const resLeadingH1 = await runWithRealRaw(
        '# UGREEN NAS Testbericht 2026\n\nUGREEN erreicht 18.5dB und 14W im Dauerbetrieb.',
      );
      expect(resLeadingH1.contentMarkdown).not.toMatch(/^#\s+UGREEN NAS Testbericht 2026/m);
      expect(resLeadingH1.contentMarkdown).toContain('## Wichtigste geprüfte Erkenntnisse');
      expect(resLeadingH1.contentMarkdown).toContain('## Häufig gestellte Fragen (FAQ)');
      expect(resLeadingH1.contentMarkdown).not.toContain('## Key Takeaways');
      expect(resLeadingH1.contentMarkdown).not.toContain('## Frequently Asked Questions (FAQ)');
    });

    it('Iter 2 Fix 6 & Fix 9: preserves sanitized fakeResult.title on GLOBAL Chinese title input and trims targetLocale in presentGeoArticle', async () => {
      const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
      const compliance = new ComplianceService();
      const gen = new StudioGenerationService(llm, compliance, makeFactRunner([]));

      for (const locale of ['en-US', 'de-DE'] as const) {
        const res = await gen.streamArticle({
          tenantId: 'tenant_demo',
          articleId: `ga_fake_cn_title_${locale}`,
          brand: { id: 'b_1', name: 'UGREEN', category: 'Home NAS' },
          market: {
            id: 'mkt_global',
            market: 'GLOBAL',
            locale: 'en-US',
            region: 'US',
            localBrandName: 'UGREEN',
            localCategory: 'Home NAS',
            aliases: [],
            ownedDomains: ['ugreen.example.com'],
            competitors: ['Synology'],
          },
          targetLocale: locale,
          recipe: 'COMPARISON_MATRIX',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'UGREEN vs Synology 4-bay NAS',
          title: '绿联与群晖对比评测',
          outlineH2: [],
          targetFanOuts: [],
          matchedFactIds: [],
          factSnippets: [],
          customForbiddenWords: [],
          reservationShadow: true,
          onDelta: () => undefined,
        });
        expect(res.targetLocale).toBe(locale);
        expect(detectLocaleLeakage(res.title, locale, ['UGREEN', 'Synology']).leaked).toBe(false);
        expect(res.title).not.toContain('绿联与群晖对比评测');
      }

      // Clean localized title is preserved verbatim
      const cleanRes = await gen.streamArticle({
        tenantId: 'tenant_demo',
        articleId: 'ga_fake_clean_title',
        brand: { id: 'b_1', name: 'UGREEN', category: 'Home NAS' },
        market: {
          id: 'mkt_global',
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: 'UGREEN',
          localCategory: 'Home NAS',
          aliases: [],
          ownedDomains: ['ugreen.example.com'],
          competitors: ['Synology'],
        },
        targetLocale: 'de-DE',
        recipe: 'COMPARISON_MATRIX',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetPrompt: 'UGREEN vs Synology 4-bay NAS',
        title: 'UGREEN vs Synology: Geprüfter 4-Bay NAS Vergleich 2026',
        outlineH2: [],
        targetFanOuts: [],
        matchedFactIds: [],
        factSnippets: [],
        customForbiddenWords: [],
        reservationShadow: true,
        onDelta: () => undefined,
      });
      expect(cleanRes.title).toBe('UGREEN vs Synology: Geprüfter 4-Bay NAS Vergleich 2026');

      // Fix 9: presentGeoArticle trims targetLocale whitespace
      const now = new Date();
      const presented = presentGeoArticle({
        id: 'ga_trim_1',
        brandId: 'b_1',
        brandMarketId: 'mkt_global',
        briefId: null,
        batchJobId: null,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetLocale: '  ja-JP  ',
        title: 'UGREEN NAS 比較',
        targetPrompt: 'Quiet NAS',
        outlineJson: [],
        contentMarkdown: '## まとめ',
        contentHtml: '<h2>まとめ</h2>',
        schemaJsonLd: {},
        llmsTxtSnippet: null,
        geoScore: 88,
        geoScoreDetail: {},
        tags: [],
        status: 'DRAFT',
        model: 'fake',
        tokensIn: 10,
        tokensOut: 20,
        complianceFlags: [],
        createdAt: now,
        updatedAt: now,
        brandMarket: { market: 'GLOBAL' },
      });
      expect(presented.targetLocale).toBe('ja-JP');
    });
  });
});
