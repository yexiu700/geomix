import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CN_RECOMMENDED_CHANNELS,
  GLOBAL_RECOMMENDED_CHANNELS,
  type BrandFactSlot,
  type GeoBriefSource,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { LlmService } from '../infra/llm';
import type { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BriefsAutoGeneratorService,
  clusterVisibilityRunCandidates,
} from './briefs-auto-generator.service';
import {
  buildDeterministicBriefDraft,
  cleanPromptForDisplay,
  type BriefSignalObservation,
  type BriefSynthesisContext,
} from './briefs.mapper';

function makeObs(overrides: Partial<BriefSignalObservation> = {}): BriefSignalObservation {
  return {
    id: overrides.id ?? 'obs_1',
    runId: overrides.runId ?? 'run_1',
    promptText: overrides.promptText ?? '2026 四盘位家用 NAS 推荐',
    engine: overrides.engine ?? 'deepseek',
    answerText: overrides.answerText ?? '推荐 CompA 和 CompB，静音且性价比高。',
    brandMentioned: overrides.brandMentioned ?? false,
    brandPosition: overrides.brandPosition ?? null,
    brandSentiment: overrides.brandSentiment ?? null,
    competitorHits:
      overrides.competitorHits ??
      ([
        { name: 'CompA', mentioned: true, position: 1 },
        { name: 'CompB', mentioned: true, position: 2 },
      ] as unknown as BriefSignalObservation['competitorHits']),
    fanOutQueries: overrides.fanOutQueries ?? ['静音NAS', '四盘位功耗', '家庭私有云'],
    citations: overrides.citations ?? [],
  };
}

describe('BriefsAutoGeneratorService & briefs.mapper unit tests', () => {
  const originalBillingMode = process.env.BILLING_MODE;

  afterEach(() => {
    if (originalBillingMode === undefined) {
      delete process.env.BILLING_MODE;
    } else {
      process.env.BILLING_MODE = originalBillingMode;
    }
    vi.restoreAllMocks();
  });

  it('clusters P1-P5 signals in strict PRD §4.3 priority order including 1-engine gap runs', () => {
    const observations: BriefSignalObservation[] = [
      // P1 multi-engine AUTO_GAP
      makeObs({
        id: 'o_gap_1',
        promptText: '家用静音四盘位NAS推荐',
        engine: 'deepseek',
        brandMentioned: false,
      }),
      makeObs({
        id: 'o_gap_2',
        promptText: '家用静音四盘位NAS推荐',
        engine: 'doubao',
        brandMentioned: false,
      }),
      // P2 SENTIMENT_RISK (negative)
      makeObs({
        id: 'o_neg',
        promptText: '某某NAS噪音大吗',
        engine: 'deepseek',
        brandMentioned: true,
        brandPosition: 2,
        brandSentiment: 'negative',
      }),
      // P3 LOW_RANK
      makeObs({
        id: 'o_low',
        promptText: 'NAS 哪个牌子性价比高',
        engine: 'deepseek',
        brandMentioned: true,
        brandPosition: 4,
        brandSentiment: 'neutral',
      }),
      // P4 FANOUT_CLUSTER (mentioned #1 positive, >=3 fan-outs) + competitor citations for P5
      makeObs({
        id: 'o_fan',
        promptText: 'NAS 相册备份方案',
        engine: 'deepseek',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        fanOutQueries: ['家庭相册自动备份', '远程访问穿透', '功耗对比', '硬盘休眠'],
        citations: [
          {
            url: 'https://compa.example/nas-guide',
            domain: 'compa.example',
            title: 'CompA Guide',
            sourceKind: 'COMPETITOR',
          },
          {
            url: 'https://compa.example/nas-guide',
            domain: 'compa.example',
            title: 'CompA Guide',
            sourceKind: 'COMPETITOR',
          },
        ],
      }),
    ];

    const candidates = clusterVisibilityRunCandidates({ observations, maxCandidates: 5 });
    expect(candidates).toHaveLength(5);
    expect(candidates.map((c) => c.sourceType)).toEqual([
      'AUTO_GAP',
      'SENTIMENT_RISK',
      'LOW_RANK',
      'CITATION_COUNTER',
      'FANOUT_CLUSTER',
    ]);
    expect(candidates[0]!.priorityScore).toBeGreaterThanOrEqual(95);
    expect(candidates[1]!.priorityScore).toBeGreaterThanOrEqual(85);
    expect(candidates[1]!.priorityScore).toBeLessThanOrEqual(89);
    expect(candidates[2]!.priorityScore).toBeGreaterThanOrEqual(70);
    expect(candidates[2]!.priorityScore).toBeLessThanOrEqual(79);
    expect(candidates[3]!.priorityScore).toBeGreaterThanOrEqual(60);
    expect(candidates[3]!.priorityScore).toBeLessThanOrEqual(75);
    expect(candidates[4]!.priorityScore).toBeGreaterThanOrEqual(60);
    expect(candidates[4]!.priorityScore).toBeLessThanOrEqual(69);

    // Single-engine gap run still qualifies for P1 AUTO_GAP (90-94)
    const singleEngine = clusterVisibilityRunCandidates({
      observations: [makeObs({ id: 'o_single', engine: 'deepseek', brandMentioned: false })],
    });
    expect(singleEngine[0]?.sourceType).toBe('AUTO_GAP');
    expect(singleEngine[0]?.priorityScore).toBeGreaterThanOrEqual(90);
    expect(singleEngine[0]?.priorityScore).toBeLessThanOrEqual(94);
  });

  it('ranks higher-priority P5 CITATION_COUNTER at index 0 ahead of 5 P4 FANOUT_CLUSTER prompts', () => {
    const observations: BriefSignalObservation[] = Array.from({ length: 5 }, (_, i) =>
      makeObs({
        id: `fo_${i}`,
        promptText: `拆解词专题问题 ${i}`,
        engine: 'deepseek',
        answerText: '品牌位列首推。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        competitorHits: [] as unknown as BriefSignalObservation['competitorHits'],
        fanOutQueries: [`子词A${i}`, `子词B${i}`, `子词C${i}`],
        citations:
          i === 0
            ? [
                {
                  url: 'https://comp.example/hot',
                  domain: 'comp.example',
                  title: 'Hot Competitor Guide',
                  sourceKind: 'COMPETITOR',
                },
                {
                  url: 'https://comp.example/hot',
                  domain: 'comp.example',
                  title: 'Hot Competitor Guide',
                  sourceKind: 'COMPETITOR',
                },
              ]
            : [],
      }),
    );

    const candidates = clusterVisibilityRunCandidates({ observations, maxCandidates: 5 });
    expect(candidates).toHaveLength(5);
    expect(candidates[0]?.sourceType).toBe('CITATION_COUNTER');
    expect(candidates[0]?.priorityScore).toBeGreaterThanOrEqual(73);
    expect(candidates[0]?.priorityScore).toBeLessThanOrEqual(75);
    expect(candidates.slice(1).map((c) => c.sourceType)).toEqual([
      'FANOUT_CLUSTER',
      'FANOUT_CLUSTER',
      'FANOUT_CLUSTER',
      'FANOUT_CLUSTER',
    ]);
  });

  it('produces consolidation fallback when all observations are already #1 positive with owned citations', () => {
    const candidates = clusterVisibilityRunCandidates({
      observations: [
        makeObs({
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          fanOutQueries: ['低噪音运行'],
          citations: [
            {
              url: 'https://mybrand.example/blog',
              domain: 'mybrand.example',
              title: 'Official Guide',
              sourceKind: 'OWNED',
            },
          ],
        }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceType).toBe('MANUAL');
    expect(candidates[0]!.priorityScore).toBe(55);
  });

  it('degrades gracefully when citations are empty (D16) and enforces CN vs GLOBAL language/channel isolation', () => {
    expect(cleanPromptForDisplay('[TAG_ALPHA] [NO_CITES] Best 4-bay NAS 2026')).toBe(
      'Best 4-bay NAS 2026',
    );

    const cnCtx: BriefSynthesisContext = {
      market: 'CN',
      brandName: '星云存储',
      localBrandName: '星云存储',
      category: '家用 NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: '[TAG_A] 2026 安静省电的四盘位家用 NAS 推荐',
      sourceRunId: 'run_cn',
      sourceObservationIds: ['obs_cn'],
      sourceCitationUrl: null,
      competitorFocus: ['竞品甲', '竞品乙'],
      targetFanOuts: ['家用NAS噪音', '待机功耗实测'],
      observations: [makeObs({ citations: [] })],
      citations: [],
      matchedFacts: [
        {
          factId: 'fact_1',
          slot: 'PRODUCT_SPECS',
          title: '核心硬件参数',
          content: '满载噪音 21dB，待机功耗 9W',
        },
      ],
      presentFactSlots: new Set<BrandFactSlot>(['PRODUCT_SPECS']),
    };

    const cnDraft = buildDeterministicBriefDraft(cnCtx);
    expect(cnDraft.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);
    expect(cnDraft.diagnosisSummary).toContain('未返回外部引用链接');
    expect(cnDraft.suggestedTitle).toMatch(/[\u4e00-\u9fa5]/);
    expect(cnDraft.suggestedTitle).not.toContain('[TAG_A]');
    expect(cnDraft.suggestedTitle).not.toContain('2026 2026');
    expect(cnDraft.outlineH2.length).toBeGreaterThanOrEqual(3);
    expect(cnDraft.targetFormat).toBe('CN_DEEP_REVIEW');
    expect(cnDraft.matchedFactIds).toEqual(['fact_1']);
    expect(cnDraft.missingFactHints.length).toBeGreaterThanOrEqual(1);
    expect(cnDraft.recommendedChannels.length).toBeGreaterThanOrEqual(2);
    for (const ch of cnDraft.recommendedChannels) {
      expect(CN_RECOMMENDED_CHANNELS).toContain(ch.channel);
    }

    // Bare bracketed tag falls back cleanly to localBrandName + category instead of echoing raw tag
    expect(cleanPromptForDisplay('[TAG_ONLY]')).toBe('');
    const bareTagDraft = buildDeterministicBriefDraft({
      ...cnCtx,
      targetPrompt: '[TAG_ONLY]',
    });
    expect(bareTagDraft.suggestedTitle).not.toContain('[TAG_ONLY]');
    expect(bareTagDraft.suggestedTitle).toContain('星云存储');
    expect(bareTagDraft.diagnosisSummary).not.toContain('[TAG_ONLY]');
    expect(bareTagDraft.diagnosisSummary).toContain('星云存储家用 NAS');

    const globalCtx: BriefSynthesisContext = {
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'SENTIMENT_RISK',
      priorityScore: 87,
      targetPrompt: '[TAG_B] Best quiet 4-bay home NAS 2026 review',
      sourceRunId: 'run_global',
      sourceObservationIds: ['obs_global'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology', 'QNAP'],
      targetFanOuts: ['quiet 4-bay NAS noise level', 'home NAS power draw'],
      observations: [
        makeObs({
          engine: 'perplexity',
          brandMentioned: true,
          brandPosition: 2,
          brandSentiment: 'negative',
          citations: [],
        }),
      ],
      citations: [],
      matchedFacts: [],
      presentFactSlots: new Set<BrandFactSlot>(),
    };

    const globalDraft = buildDeterministicBriefDraft(globalCtx);
    expect(globalDraft.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);
    expect(globalDraft.suggestedTitle).toMatch(/[A-Za-z]{4,}/);
    expect(globalDraft.suggestedTitle).not.toContain('[TAG_B]');
    expect(globalDraft.outlineH2.length).toBeGreaterThanOrEqual(3);
    for (const h2 of globalDraft.outlineH2) {
      expect(h2.heading).toMatch(/[A-Za-z]{3,}/);
    }
    expect(globalDraft.targetFormat).toBe('GLOBAL_COMMUNITY_DISCUSSION');
    expect(globalDraft.recommendedChannels.length).toBeGreaterThanOrEqual(2);
    const forbiddenCn = ['小红书', '什么值得买', '知乎', '字节头条', '微信公众号'];
    for (const ch of globalDraft.recommendedChannels) {
      expect(GLOBAL_RECOMMENDED_CHANNELS).toContain(ch.channel);
      for (const cnWord of forbiddenCn) {
        expect(ch.channel).not.toContain(cnWord);
        expect(ch.reason).not.toContain(cnWord);
      }
    }

    // Leading token deduplication for GLOBAL AUTHORITY_GUIDE titles/outlines
    const globalGuideDraft = buildDeterministicBriefDraft({
      ...globalCtx,
      sourceType: 'AUTO_GAP',
      targetPrompt: '2026 Best quiet 4-bay home NAS 2026',
    });
    expect(globalGuideDraft.suggestedTitle).not.toMatch(/2026\s+2026/i);
    expect(globalGuideDraft.suggestedTitle).not.toMatch(/Best\s+Best/i);
    expect(globalGuideDraft.outlineH2[0]?.heading).not.toMatch(/Best\s+Best/i);
  });

  it('enforces #321: rejects fake fallback under global BILLING_MODE=STRICT and throws 502 on real LLM malformed JSON', async () => {
    const fakeLlm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const factRunner = {
      retrieveRelevantBrandFacts: vi.fn().mockResolvedValue([]),
    } as unknown as BrandFactIndexRunner;
    const prismaStub = { base: {} } as unknown as PrismaService;
    const service = new BriefsAutoGeneratorService(prismaStub, fakeLlm, factRunner);

    const ctx: BriefSynthesisContext = {
      market: 'CN',
      brandName: '星云存储',
      localBrandName: '星云存储',
      category: '家用 NAS',
      sourceType: 'MANUAL',
      priorityScore: 55,
      targetPrompt: '家用四盘位 NAS 选购建议',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: null,
      competitorFocus: [],
      targetFanOuts: [],
      observations: [],
      citations: [],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    process.env.BILLING_MODE = 'STRICT';
    await expect(service.synthesizeSingleBrief('t1', ctx)).rejects.toMatchObject({
      status: 503,
    });

    process.env.BILLING_MODE = 'SHADOW';
    const realMalformedLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: vi.fn().mockResolvedValue({
        text: 'not valid json at all',
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        tokensIn: 10,
        tokensOut: 10,
        latencyMs: 50,
        costMicro: 1,
      }),
    } as unknown as LlmService;
    const realService = new BriefsAutoGeneratorService(prismaStub, realMalformedLlm, factRunner);
    await expect(realService.synthesizeSingleBrief('t1', ctx)).rejects.toBeInstanceOf(ApiError);
    await expect(realService.synthesizeSingleBrief('t1', ctx)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('ensures atomic briefsGeneratedAt idempotency across concurrent/repeat hook calls and skips RETEST runs', async () => {
    let stampedAt: Date | null = null;
    const createdBriefs: Array<Record<string, unknown>> = [];

    const prismaFake = {
      base: {
        visibilityRun: {
          findFirst: vi.fn().mockImplementation(async () => ({
            id: 'run_idem',
            tenantId: 't_1',
            brandId: 'b_1',
            brandMarketId: 'bm_1',
            triggerType: 'MANUAL',
            briefsGeneratedAt: stampedAt,
            brand: {
              id: 'b_1',
              name: '星云存储',
              category: '家用 NAS',
              facts: [
                { slot: 'PRODUCT_SPECS', content: '21dB 满载噪音，9W 待机功耗' },
                { slot: 'CREDENTIALS', content: '   ' },
              ],
            },
            brandMarket: {
              id: 'bm_1',
              market: 'CN',
              localBrandName: '星云存储',
              competitors: [{ name: '竞品A', aliases: [], domains: [] }],
            },
            observations: [makeObs({ id: 'obs_1', runId: 'run_idem', citations: [] })],
            _count: { geoBriefs: createdBriefs.length },
          })),
        },
        $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            visibilityRun: {
              updateMany: vi
                .fn()
                .mockImplementation(async ({ data }: { data: { briefsGeneratedAt: Date } }) => {
                  if (stampedAt !== null) return { count: 0 };
                  stampedAt = data.briefsGeneratedAt;
                  return { count: 1 };
                }),
            },
            geoBrief: {
              count: vi.fn().mockImplementation(async () => createdBriefs.length),
              create: vi
                .fn()
                .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
                  createdBriefs.push(data);
                  return { id: `br_${createdBriefs.length}`, ...data };
                }),
            },
          };
          return fn(tx);
        }),
      },
    } as unknown as PrismaService;

    const llm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const factRunner = {
      retrieveRelevantBrandFacts: vi.fn().mockResolvedValue([
        {
          factId: 'fact_1',
          slot: 'PRODUCT_SPECS',
          title: '核心规格',
          content: '21dB 满载噪音',
          source: 'direct',
        },
      ]),
    } as unknown as BrandFactIndexRunner;

    const service = new BriefsAutoGeneratorService(prismaFake, llm, factRunner);

    // RETEST run is skipped completely
    await service.onVisibilityRunComplete({
      tenantId: 't_1',
      brandId: 'b_1',
      brandMarketId: 'bm_1',
      runId: 'run_retest',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'COMPLETED',
      successCount: 2,
    });
    expect(prismaFake.base.visibilityRun.findFirst).not.toHaveBeenCalled();

    // Concurrent calls on the same MANUAL run stamp once and insert once
    const event = {
      tenantId: 't_1',
      brandId: 'b_1',
      brandMarketId: 'bm_1',
      runId: 'run_idem',
      triggerType: 'MANUAL' as const,
      retestArticleId: null,
      status: 'COMPLETED' as const,
      successCount: 1,
    };
    await Promise.all([
      service.onVisibilityRunComplete(event),
      service.onVisibilityRunComplete(event),
    ]);
    expect(stampedAt).not.toBeNull();
    const firstStamp = stampedAt;
    const firstCount = createdBriefs.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);
    expect(createdBriefs[0]?.matchedFactIds).toEqual(['fact_1']);

    // Repeat call after stampedAt is set is a strict no-op
    await service.onVisibilityRunComplete(event);
    expect(stampedAt).toBe(firstStamp);
    expect(createdBriefs).toHaveLength(firstCount);

    // Verify sourceType is AUTO_GAP and whitespace-only CREDENTIALS fact still produces a missing hint
    expect(createdBriefs[0]?.sourceType as GeoBriefSource).toBe('AUTO_GAP');
    expect(
      (createdBriefs[0]?.missingFactHints as string[]).some((h) => h.includes('权威资质与背书')),
    ).toBe(true);
  });
});
