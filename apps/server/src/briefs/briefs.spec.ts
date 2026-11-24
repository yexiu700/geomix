import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CN_RECOMMENDED_CHANNELS,
  GLOBAL_RECOMMENDED_CHANNELS,
  type BrandFactSlot,
  type GeoBriefSource,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import type { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import type { PublicFetchService } from '../infra/adapters.module';
import type { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import type { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import type { BrandsService } from '../brands/brands.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BriefsAutoGeneratorService,
  clusterVisibilityRunCandidates,
} from './briefs-auto-generator.service';
import {
  buildCitationDrivenRecommendedChannels,
  buildDeterministicBriefDraft,
  cleanPromptForDisplay,
  finalizeRealLlmBriefDraft,
  inferProviderHintForChannel,
  parseStoredChannels,
  type BriefSignalObservation,
  type BriefSynthesisContext,
} from './briefs.mapper';
import { BriefsService } from './briefs.service';

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

  it('aggregates GLOBAL VisibilityCitations into ranked channels with providerHint, priority, max 3 citedExampleUrls, owned & CN domain exclusion', () => {
    const globalCtx: BriefSynthesisContext = {
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_global_cite',
      sourceObservationIds: ['obs_g1'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet 4-bay NAS'],
      observations: [],
      ownedDomains: ['nebulanas.example.com'],
      citations: [
        // Owned domain (must be excluded even if sourceKind was OTHER)
        {
          url: 'https://blog.nebulanas.example.com/quiet-nas',
          domain: 'blog.nebulanas.example.com',
          title: 'Official Blog',
          sourceKind: 'OTHER',
          position: 1,
        },
        // CN domain in GLOBAL market (must be excluded)
        {
          url: 'https://www.zhihu.com/question/999999',
          domain: 'zhihu.com',
          title: '知乎讨论',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        // E-commerce listing (must be excluded from publishing buckets)
        {
          url: 'https://www.amazon.com/dp/B0EXAMPLE',
          domain: 'amazon.com',
          title: 'Amazon Listing',
          sourceKind: 'ECOMMERCE',
          position: 1,
        },
        // Reddit x4 across 4 URLs + 1 duplicate with utm params -> top 3 URLs ordered by count/position
        {
          url: 'https://www.reddit.com/r/HomeServer/comments/t2/thread_two/',
          domain: 'reddit.com',
          title: 'Thread 2',
          sourceKind: 'SOCIAL',
          position: 4,
        },
        {
          url: 'https://www.reddit.com/r/HomeServer/comments/t1/thread_one/',
          domain: 'reddit.com',
          title: 'Thread 1',
          sourceKind: 'SOCIAL',
          position: 2,
        },
        {
          url: 'https://www.reddit.com/r/HomeServer/comments/t1/thread_one/?utm_source=perplexity',
          domain: 'reddit.com',
          title: 'Thread 1 dup',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        {
          url: 'https://old.reddit.com/r/DataHoarder/comments/t3/thread_three/',
          domain: 'old.reddit.com',
          title: 'Thread 3',
          sourceKind: 'SOCIAL',
          position: 3,
        },
        {
          url: 'https://www.reddit.com/r/HomeLab/comments/t4/thread_four/',
          domain: 'reddit.com',
          title: 'Thread 4',
          sourceKind: 'SOCIAL',
          position: 6,
        },
        // Authority review media x2 -> Independent Review Media (PR_PACKET, HIGH)
        {
          url: 'https://www.techradar.com/best/best-nas-devices',
          domain: 'techradar.com',
          title: 'Best NAS Devices',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
        {
          url: 'https://www.rtings.com/nas/reviews/best/home',
          domain: 'rtings.com',
          title: 'Best Home NAS',
          sourceKind: 'AUTHORITY',
          position: 2,
        },
        // Quora x1 -> Quora (QUORA_ASSIST, MEDIUM)
        {
          url: 'https://www.quora.com/Which-4-bay-NAS-is-the-quietest',
          domain: 'quora.com',
          title: 'Quietest 4-bay NAS',
          sourceKind: 'SOCIAL',
          position: 5,
        },
      ],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    const channels = buildCitationDrivenRecommendedChannels(globalCtx);
    expect(channels.length).toBeGreaterThanOrEqual(3);
    expect(channels[0]!.channel).toBe('Reddit');
    expect(channels[0]!.providerHint).toBe('REDDIT_ASSIST');
    expect(channels[0]!.priority).toBe('HIGH');
    expect(channels[0]!.citedExampleUrls).toHaveLength(3);
    // Most cited Reddit URL (t1, count=2) must rank first
    expect(channels[0]!.citedExampleUrls![0]).toBe(
      'https://www.reddit.com/r/HomeServer/comments/t1/thread_one/',
    );

    expect(channels[1]!.channel).toBe('Independent Review Media');
    expect(channels[1]!.providerHint).toBe('PR_PACKET');
    expect(channels[1]!.priority).toBe('HIGH');
    expect(channels[1]!.citedExampleUrls).toEqual([
      'https://www.techradar.com/best/best-nas-devices',
      'https://www.rtings.com/nas/reviews/best/home',
    ]);

    expect(channels[2]!.channel).toBe('Quora');
    expect(channels[2]!.providerHint).toBe('QUORA_ASSIST');
    expect(channels[2]!.priority).toBe('MEDIUM');

    // Owned-site anchor appended cleanly with no duplicate channel names and zero CN leakage
    const owned = channels.find((c) => c.channel === 'Independent Blog/Docs (llms.txt + JSON-LD)');
    expect(owned).toBeDefined();
    expect(owned!.providerHint).toBe('WORDPRESS');
    expect(owned!.citedExampleUrls).toBeUndefined();

    const uniqueNames = new Set(channels.map((c) => c.channel.toLowerCase()));
    expect(uniqueNames.size).toBe(channels.length);
    for (const ch of channels) {
      expect(ch.channel).not.toMatch(/知乎|小红书|什么值得买/);
      expect(ch.reason).not.toMatch(/知乎|小红书|什么值得买/);
      for (const u of ch.citedExampleUrls ?? []) {
        expect(u).not.toContain('zhihu.com');
        expect(u).not.toContain('nebulanas.example.com');
      }
    }
  });

  it('aggregates CN VisibilityCitations into CN community & media channels and falls back cleanly on empty citations', () => {
    const cnCtx: BriefSynthesisContext = {
      market: 'CN',
      brandName: '星云存储',
      localBrandName: '星云存储',
      category: '家用 NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 92,
      targetPrompt: '2026 静音四盘位家用 NAS 推荐',
      sourceRunId: 'run_cn_cite',
      sourceObservationIds: ['obs_c1'],
      sourceCitationUrl: null,
      competitorFocus: ['竞品A'],
      targetFanOuts: ['静音NAS'],
      observations: [],
      ownedDomains: ['xingyun.example.cn'],
      citations: [
        {
          url: 'https://www.xingyun.example.cn/nas',
          domain: 'xingyun.example.cn',
          title: '官网',
          sourceKind: 'OWNED',
          position: 1,
        },
        {
          url: 'https://zhuanlan.zhihu.com/p/1001',
          domain: 'zhuanlan.zhihu.com',
          title: '知乎评测1',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        {
          url: 'https://www.zhihu.com/question/2002',
          domain: 'zhihu.com',
          title: '知乎问答2',
          sourceKind: 'SOCIAL',
          position: 2,
        },
        {
          url: 'https://www.zhihu.com/question/2003',
          domain: 'zhihu.com',
          title: '知乎问答3',
          sourceKind: 'SOCIAL',
          position: 3,
        },
        {
          url: 'https://post.smzdm.com/p/3003/',
          domain: 'post.smzdm.com',
          title: '值得买实测',
          sourceKind: 'SOCIAL',
          position: 3,
        },
        {
          url: 'https://www.36kr.com/p/4004',
          domain: '36kr.com',
          title: '36氪行业评测',
          sourceKind: 'AUTHORITY',
          position: 2,
        },
        {
          url: 'https://www.ithome.com/0/500/5005.htm',
          domain: 'ithome.com',
          title: 'IT之家评测',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
      ],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    const channels = buildCitationDrivenRecommendedChannels(cnCtx);
    expect(channels[0]!.channel).toBe('知乎');
    expect(channels[0]!.providerHint).toBe('CN_COMMUNITY_ASSIST');
    expect(channels[0]!.priority).toBe('HIGH');
    expect(channels[0]!.citedExampleUrls).toHaveLength(3);
    expect(channels[1]!.channel).toBe('第三方评测媒体');
    expect(channels[1]!.providerHint).toBe('PR_PACKET');
    expect(channels[1]!.priority).toBe('HIGH');
    expect(channels[1]!.citedExampleUrls).toHaveLength(2);
    expect(channels[2]!.channel).toBe('什么值得买');
    expect(channels[2]!.providerHint).toBe('CN_COMMUNITY_ASSIST');
    expect(channels[2]!.priority).toBe('MEDIUM');

    // Empty/owned-only citations fall back gracefully with providerHint & no citedExampleUrls
    const fallback = buildCitationDrivenRecommendedChannels({
      ...cnCtx,
      citations: [
        {
          url: 'https://www.xingyun.example.cn/nas',
          domain: 'xingyun.example.cn',
          title: '官网',
          sourceKind: 'OWNED',
          position: 1,
        },
      ],
    });
    expect(fallback.length).toBeGreaterThanOrEqual(2);
    for (const ch of fallback) {
      expect(CN_RECOMMENDED_CHANNELS).toContain(ch.channel);
      expect(ch.providerHint).toBeDefined();
      expect(ch.citedExampleUrls).toBeUndefined();
    }
    expect(inferProviderHintForChannel('LinkedIn / X', 'GLOBAL')).toBe('SOCIAL_THREAD_ASSIST');
  });

  it('preserves providerHint, priority, and safe deduped citedExampleUrls (max 3) in parseStoredChannels and finalizeRealLlmBriefDraft', () => {
    const parsed = parseStoredChannels([
      {
        channel: 'Reddit',
        reason: 'AI engines cited Reddit 3 times.',
        providerHint: 'REDDIT_ASSIST',
        priority: 'HIGH',
        citedExampleUrls: [
          'https://www.reddit.com/r/HomeServer/comments/a1/',
          'https://www.reddit.com/r/HomeServer/comments/a1/?utm_medium=ai',
          'javascript:alert(1)',
          'https://www.reddit.com/r/HomeServer/comments/a2/',
          'https://www.reddit.com/r/HomeServer/comments/a3/',
          'https://www.reddit.com/r/HomeServer/comments/a4/',
        ],
      },
      {
        channel: 'InvalidMeta',
        reason: 'Bad providerHint and priority should be stripped cleanly',
        providerHint: 'NON_EXISTENT_PROVIDER',
        priority: 'CRITICAL',
        citedExampleUrls: ['ftp://invalid.example.com/file'],
      },
    ]);

    expect(parsed).toEqual([
      {
        channel: 'Reddit',
        reason: 'AI engines cited Reddit 3 times.',
        providerHint: 'REDDIT_ASSIST',
        priority: 'HIGH',
        citedExampleUrls: [
          'https://www.reddit.com/r/HomeServer/comments/a1/',
          'https://www.reddit.com/r/HomeServer/comments/a2/',
          'https://www.reddit.com/r/HomeServer/comments/a3/',
        ],
      },
      {
        channel: 'InvalidMeta',
        reason: 'Bad providerHint and priority should be stripped cleanly',
      },
    ]);

    const finalized = finalizeRealLlmBriefDraft(
      {
        diagnosisSummary: '该问题下 AI 主要引用 Reddit 讨论帖，我方品牌未获提及。',
        suggestedTitle: '2026 Best Quiet 4-Bay Home NAS Guide: NebulaNAS Benchmarks',
        outlineH2: [
          { heading: 'Direct Answer: Quiet 4-Bay NAS Shortlist', intent: 'Give quick verdict' },
          { heading: 'Verified Acoustic & Power Benchmarks', intent: 'Show lab specs' },
          { heading: 'Buyer FAQ & Trade-Offs', intent: 'Answer follow-up queries' },
        ],
        recommendedChannels: [
          { channel: 'LinkedIn / X', reason: 'Share verified lab charts with IT buyers.' },
        ],
      },
      {
        market: 'GLOBAL',
        brandName: '星云存储',
        localBrandName: 'NebulaNAS',
        category: 'Home NAS',
        sourceType: 'AUTO_GAP',
        priorityScore: 95,
        targetPrompt: 'Best quiet 4-bay home NAS 2026',
        sourceRunId: 'run_1',
        sourceObservationIds: ['obs_1'],
        sourceCitationUrl: null,
        competitorFocus: ['Synology'],
        targetFanOuts: ['quiet 4-bay NAS'],
        observations: [],
        citations: [
          {
            url: 'https://www.reddit.com/r/HomeServer/comments/xyz/nas_noise/',
            domain: 'reddit.com',
            title: 'Quiet NAS Discussion',
            sourceKind: 'SOCIAL',
            position: 1,
          },
          {
            url: 'https://www.reddit.com/r/DataHoarder/comments/xyz2/nas_power/',
            domain: 'reddit.com',
            title: 'NAS Power Discussion',
            sourceKind: 'SOCIAL',
            position: 2,
          },
        ],
        matchedFacts: [],
        presentFactSlots: new Set(),
      },
    );

    expect(finalized).not.toBeNull();
    expect(finalized!.recommendedChannels[0]!.channel).toBe('Reddit');
    expect(finalized!.recommendedChannels[0]!.providerHint).toBe('REDDIT_ASSIST');
    expect(finalized!.recommendedChannels[0]!.priority).toBe('HIGH');
    expect(finalized!.recommendedChannels[0]!.citedExampleUrls).toHaveLength(2);
    expect(finalized!.recommendedChannels.some((c) => c.channel === 'LinkedIn / X')).toBe(true);
  });

  it('persists citation-driven recommendedChannels (with providerHint & citedExampleUrls) in onVisibilityRunComplete', async () => {
    let stampedAt: Date | null = null;
    const createdBriefs: Array<Record<string, unknown>> = [];

    const prismaFake = {
      base: {
        visibilityRun: {
          findFirst: vi.fn().mockImplementation(async () => ({
            id: 'run_cite_persist',
            tenantId: 't_1',
            brandId: 'b_1',
            brandMarketId: 'bm_global',
            triggerType: 'MANUAL',
            briefsGeneratedAt: stampedAt,
            brand: {
              id: 'b_1',
              name: '星云存储',
              category: 'Home NAS',
              facts: [{ slot: 'PRODUCT_SPECS', content: '21 dB load noise, 9W idle' }],
              markets: [{ ownedDomains: ['nebulanas.example.com'] }],
            },
            brandMarket: {
              id: 'bm_global',
              market: 'GLOBAL',
              localBrandName: 'NebulaNAS',
              competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
              ownedDomains: ['nebulanas.example.com'],
            },
            observations: [
              makeObs({
                id: 'obs_cite_1',
                runId: 'run_cite_persist',
                promptText: 'Best quiet 4-bay home NAS 2026',
                engine: 'perplexity',
                brandMentioned: false,
                citations: [
                  {
                    url: 'https://www.reddit.com/r/HomeServer/comments/p1/quiet_nas/',
                    domain: 'reddit.com',
                    title: 'Quiet NAS Thread 1',
                    sourceKind: 'SOCIAL',
                    position: 1,
                  },
                  {
                    url: 'https://www.reddit.com/r/HomeServer/comments/p2/nas_noise/',
                    domain: 'reddit.com',
                    title: 'Quiet NAS Thread 2',
                    sourceKind: 'SOCIAL',
                    position: 2,
                  },
                  {
                    url: 'https://nebulanas.example.com/guide',
                    domain: 'nebulanas.example.com',
                    title: 'Owned Guide',
                    sourceKind: 'OTHER',
                    position: 1,
                  },
                ],
              }),
            ],
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
      retrieveRelevantBrandFacts: vi.fn().mockResolvedValue([]),
    } as unknown as BrandFactIndexRunner;

    const service = new BriefsAutoGeneratorService(prismaFake, llm, factRunner);
    await service.onVisibilityRunComplete({
      tenantId: 't_1',
      brandId: 'b_1',
      brandMarketId: 'bm_global',
      runId: 'run_cite_persist',
      triggerType: 'MANUAL',
      retestArticleId: null,
      status: 'COMPLETED',
      successCount: 1,
    });

    expect(createdBriefs.length).toBeGreaterThanOrEqual(1);
    const channels = createdBriefs[0]!.recommendedChannels as Array<Record<string, unknown>>;
    expect(channels[0]?.channel).toBe('Reddit');
    expect(channels[0]?.providerHint).toBe('REDDIT_ASSIST');
    expect(channels[0]?.priority).toBe('HIGH');
    expect(channels[0]?.citedExampleUrls).toEqual([
      'https://www.reddit.com/r/HomeServer/comments/p1/quiet_nas/',
      'https://www.reddit.com/r/HomeServer/comments/p2/nas_noise/',
    ]);
    for (const ch of channels) {
      for (const u of (ch.citedExampleUrls as string[] | undefined) ?? []) {
        expect(u).not.toContain('nebulanas.example.com');
      }
    }
  });

  it('rejects private/loopback/metadata SSRF URLs in buildCitationDrivenRecommendedChannels and parseStoredChannels (Challenger 2 Defect 1)', () => {
    const ssrfCtx: BriefSynthesisContext = {
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_ssrf',
      sourceObservationIds: ['obs_s1'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet NAS'],
      observations: [],
      ownedDomains: [],
      citations: [
        {
          url: 'http://127.0.0.1:8080/internal',
          domain: '127.0.0.1',
          title: 'Loopback',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
        {
          url: 'http://169.254.169.254/latest/meta-data/',
          domain: '',
          title: 'Cloud Metadata',
          sourceKind: 'OTHER',
          position: 1,
        },
        {
          url: 'http://localhost:3000/secret',
          domain: 'reddit.com',
          title: 'Localhost',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        {
          url: 'http://[::1]/admin',
          domain: 'reddit.com',
          title: 'IPv6 Loopback',
          sourceKind: 'SOCIAL',
          position: 1,
        },
      ],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    const channels = buildCitationDrivenRecommendedChannels(ssrfCtx);
    // All 4 private/loopback/metadata citations are rejected -> clean fallback with zero citedExampleUrls
    for (const ch of channels) {
      expect(ch.citedExampleUrls).toBeUndefined();
      expect(ch.reason).not.toMatch(/127\.0\.0\.1|169\.254\.169\.254|localhost|::1/);
    }

    const parsed = parseStoredChannels([
      {
        channel: 'Reddit',
        reason: 'Cited threads',
        providerHint: 'REDDIT_ASSIST',
        priority: 'HIGH',
        citedExampleUrls: [
          'http://127.0.0.1/secret',
          'http://localhost:3000/admin',
          'http://169.254.169.254/latest/meta-data/',
          'http://[::1]/admin',
          'http://internal-service/path',
          'https://www.reddit.com/r/HomeServer/comments/safe1/',
        ],
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.citedExampleUrls).toEqual([
      'https://www.reddit.com/r/HomeServer/comments/safe1/',
    ]);
  });

  it('enforces strict GLOBAL market isolation against mismatched CN URLs, CN ecommerce tagged OTHER, and romanized/CJK LLM channels (Challenger 2 Defect 2)', () => {
    const globalCtx: BriefSynthesisContext = {
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_iso',
      sourceObservationIds: ['obs_iso'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet NAS'],
      observations: [],
      ownedDomains: [],
      citations: [
        // Mismatched CN url under non-CN domain
        {
          url: 'https://www.zhihu.com/question/999',
          domain: 'reddit.com',
          title: 'Mismatched Zhihu URL',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        // CN e-commerce domain tagged OTHER
        {
          url: 'https://item.jd.com/12345.html',
          domain: 'jd.com',
          title: 'JD Listing',
          sourceKind: 'OTHER',
          position: 1,
        },
      ],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    const channels = buildCitationDrivenRecommendedChannels(globalCtx);
    for (const ch of channels) {
      expect(ch.reason).not.toContain('jd.com');
      for (const url of ch.citedExampleUrls ?? []) {
        expect(url).not.toContain('zhihu.com');
        expect(url).not.toContain('jd.com');
      }
    }

    const finalized = finalizeRealLlmBriefDraft(
      {
        diagnosisSummary: '该问题下海外引擎未提及品牌，需加强英文评测与社区覆盖。',
        suggestedTitle: '2026 Best Quiet 4-Bay Home NAS Guide: NebulaNAS Benchmarks',
        outlineH2: [
          { heading: 'Direct Answer: Quiet 4-Bay NAS Shortlist', intent: 'Give quick verdict' },
          { heading: 'Verified Acoustic & Power Benchmarks', intent: 'Show lab specs' },
          { heading: 'Buyer FAQ & Trade-Offs', intent: 'Answer follow-up queries' },
        ],
        recommendedChannels: [
          { channel: '知乎', reason: '知乎问答' },
          { channel: 'Zhihu', reason: 'Top Chinese Q&A site' },
          { channel: 'B站', reason: '发布开箱视频评测' },
          { channel: 'Reddit', reason: '建议在 Reddit 发布英文实测对比帖' },
          { channel: '官网', reason: '官网发布英文指南' },
          { channel: 'LinkedIn / X', reason: 'Share verified lab charts with IT buyers.' },
        ],
      },
      {
        ...globalCtx,
        citations: [],
      },
    );

    expect(finalized).not.toBeNull();
    expect(finalized!.recommendedChannels.map((c) => c.channel)).toEqual(['LinkedIn / X']);
  });

  it('prevents duplicate channel keys on >80-char prefix collision and untrimmed direct finalizeRealLlmBriefDraft inputs (Challenger 2 Defects 3 & 4)', () => {
    const parsed = parseStoredChannels([
      { channel: `${'A'.repeat(80)}111`, reason: 'First channel' },
      { channel: `${'A'.repeat(80)}222`, reason: 'Second channel' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.channel).toBe('A'.repeat(80));
    expect(parsed[0]!.reason).toBe('First channel');

    const finalized = finalizeRealLlmBriefDraft(
      {
        diagnosisSummary: '该问题下 AI 主要引用 Reddit 讨论帖。',
        suggestedTitle: '2026 Best Quiet 4-Bay Home NAS Guide: NebulaNAS Benchmarks',
        outlineH2: [
          { heading: 'Direct Answer: Quiet 4-Bay NAS Shortlist', intent: 'Give quick verdict' },
          { heading: 'Verified Acoustic & Power Benchmarks', intent: 'Show lab specs' },
          { heading: 'Buyer FAQ & Trade-Offs', intent: 'Answer follow-up queries' },
        ],
        recommendedChannels: [
          { channel: '  Reddit  ', reason: 'Duplicate with surrounding whitespace' },
          { channel: '  quora ', reason: 'First quora entry' },
          { channel: 'Quora', reason: 'Case-duplicate quora entry' },
        ],
      },
      {
        market: 'GLOBAL',
        brandName: '星云存储',
        localBrandName: 'NebulaNAS',
        category: 'Home NAS',
        sourceType: 'AUTO_GAP',
        priorityScore: 95,
        targetPrompt: 'Best quiet 4-bay home NAS 2026',
        sourceRunId: 'run_dup',
        sourceObservationIds: ['obs_dup'],
        sourceCitationUrl: null,
        competitorFocus: ['Synology'],
        targetFanOuts: ['quiet NAS'],
        observations: [],
        citations: [
          {
            url: 'https://www.reddit.com/r/HomeServer/comments/dup1/',
            domain: 'reddit.com',
            title: 'Reddit thread',
            sourceKind: 'SOCIAL',
            position: 1,
          },
        ],
        matchedFacts: [],
        presentFactSlots: new Set(),
      },
    );

    expect(finalized).not.toBeNull();
    const names = finalized!.recommendedChannels.map((c) => c.channel.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(finalized!.recommendedChannels.map((c) => c.channel)).toEqual([
      'Reddit',
      'Independent Blog/Docs (llms.txt + JSON-LD)',
      'quora',
    ]);
  });

  it('falls back to cite.url on whitespace/malformed cite.domain and canonicalizes query param order & www. prefix (Challenger 2 Defects 5 & 6)', () => {
    const channels = buildCitationDrivenRecommendedChannels({
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_norm',
      sourceObservationIds: ['obs_norm'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet NAS'],
      observations: [],
      ownedDomains: [],
      citations: [
        {
          url: 'https://www.quora.com/Best-NAS',
          domain: '   ',
          title: 'Quora NAS',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        {
          url: 'https://www.rtings.com/nas/best',
          domain: 'not-a-valid-domain',
          title: 'RTINGS Best NAS',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
        {
          url: 'https://www.reddit.com/r/nas/1?a=1&b=2',
          domain: 'reddit.com',
          title: 'Reddit 1A',
          sourceKind: 'SOCIAL',
          position: 2,
        },
        {
          url: 'https://reddit.com/r/nas/1?b=2&a=1',
          domain: 'reddit.com',
          title: 'Reddit 1B',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        {
          url: 'https://WWW.REDDIT.COM./r/nas/1?a=1&b=2',
          domain: 'reddit.com',
          title: 'Reddit 1C Trailing Dot',
          sourceKind: 'SOCIAL',
          position: 3,
        },
      ],
      matchedFacts: [],
      presentFactSlots: new Set(),
    });

    const reddit = channels.find((c) => c.channel === 'Reddit');
    const quora = channels.find((c) => c.channel === 'Quora');
    const media = channels.find((c) => c.channel === 'Independent Review Media');

    expect(quora).toBeDefined();
    expect(quora!.citedExampleUrls).toEqual(['https://www.quora.com/Best-NAS']);
    expect(media).toBeDefined();
    expect(media!.citedExampleUrls).toEqual(['https://www.rtings.com/nas/best']);
    expect(reddit).toBeDefined();
    // All 3 Reddit URLs (?a=1&b=2 with www., ?b=2&a=1 without www., and trailing DNS dot) deduplicate into 1 canonical URL
    expect(reddit!.citedExampleUrls).toHaveLength(1);
  });

  it('completes in < 50ms on 50,000-char dot/slash ReDoS inputs while preserving valid trailing-dot, port, and IDN canonicalization (Challenger 2 Iter-5 Defect 1)', () => {
    const N = 50_000;
    const redosUrl = `https://a${'.'.repeat(N)}b/path${'/'.repeat(N)}end`;
    const redosDomain = `a${'.'.repeat(N)}b`;
    const subCapDotUrl = `https://a${'.'.repeat(180)}b/path${'/'.repeat(1_500)}end`;

    const startedAt = performance.now();
    const channels = buildCitationDrivenRecommendedChannels({
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_redos',
      sourceObservationIds: ['obs_redos'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet NAS'],
      observations: [],
      ownedDomains: ['münchen.example.com', redosDomain],
      citations: [
        {
          url: redosUrl,
          domain: redosDomain,
          title: 'ReDoS URL + Domain',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
        {
          url: '',
          domain: redosDomain,
          title: 'ReDoS Domain Only',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
        {
          url: subCapDotUrl,
          domain: `a${'.'.repeat(180)}b`,
          title: 'Sub-2048 Dot Run',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
        // Valid trailing-dot & port domains must still canonicalize cleanly
        {
          url: 'https://WWW.REDDIT.COM.:443/r/nas/comments/p1/',
          domain: 'WWW.REDDIT.COM.:443',
          title: 'Reddit Port + Trailing Dot',
          sourceKind: 'SOCIAL',
          position: 1,
        },
        {
          url: 'https://www.reddit.com/r/nas/comments/p2/',
          domain: 'reddit.com...',
          title: 'Reddit Multi Trailing Dots',
          sourceKind: 'SOCIAL',
          position: 2,
        },
        // Owned IDN & CN IDN must still be excluded
        {
          url: 'https://xn--mnchen-3ya.example.com/blog',
          domain: 'xn--mnchen-3ya.example.com',
          title: 'Owned IDN',
          sourceKind: 'OTHER',
          position: 1,
        },
        {
          url: 'https://测试.cn/review',
          domain: '测试.cn',
          title: 'CN IDN',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
      ],
      matchedFacts: [],
      presentFactSlots: new Set(),
    });

    const parsed = parseStoredChannels([
      {
        channel: 'Reddit',
        reason: 'Cited threads',
        providerHint: 'REDDIT_ASSIST',
        priority: 'HIGH',
        citedExampleUrls: [
          redosUrl,
          subCapDotUrl,
          `https://www.reddit.com/r/nas/path${'/'.repeat(1_800)}end`,
          'https://WWW.REDDIT.COM./r/nas/comments/p1/',
        ],
      },
    ]);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(50);

    const reddit = channels.find((c) => c.channel === 'Reddit');
    expect(reddit).toBeDefined();
    expect(reddit!.priority).toBe('HIGH');
    expect(reddit!.citedExampleUrls).toEqual([
      'https://WWW.REDDIT.COM.:443/r/nas/comments/p1/',
      'https://www.reddit.com/r/nas/comments/p2/',
    ]);
    for (const ch of channels) {
      expect(ch.reason).not.toContain('xn--mnchen-3ya.example.com');
      expect(ch.reason).not.toContain('xn--0zwm56d.cn');
      for (const u of ch.citedExampleUrls ?? []) {
        expect(u).not.toContain('....');
      }
    }

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.citedExampleUrls).toEqual([
      `https://www.reddit.com/r/nas/path${'/'.repeat(1_800)}end`,
      'https://WWW.REDDIT.COM./r/nas/comments/p1/',
    ]);
  });

  it('prevents spoofed cite.domain paired with CN-in-GLOBAL, owned, or ecommerce cite.url from creating or inflating channel buckets (Challenger 2 Iter-5 Advisory B)', () => {
    const baseCtx: Omit<BriefSynthesisContext, 'citations'> = {
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_spoof',
      sourceObservationIds: ['obs_spoof'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet NAS'],
      observations: [],
      ownedDomains: ['https://www.nebulanas.example.com:443/products'],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    const spoofedCitations = [
      {
        url: 'https://www.zhihu.com/question/999',
        domain: 'reddit.com',
        title: 'Spoofed Zhihu as Reddit',
        sourceKind: 'SOCIAL' as const,
        position: 1,
      },
      {
        url: 'https://shop.nebulanas.example.com/spoof',
        domain: 'reddit.com',
        title: 'Spoofed Owned as Reddit',
        sourceKind: 'SOCIAL' as const,
        position: 1,
      },
      {
        url: 'https://www.amazon.com/dp/B0SPOOF',
        domain: 'reddit.com',
        title: 'Spoofed Ecommerce as Reddit',
        sourceKind: 'SOCIAL' as const,
        position: 1,
      },
    ];

    // Only spoofed citations -> zero citation-backed buckets (falls back cleanly with no citedExampleUrls or evidence count)
    const fallbackOnly = buildCitationDrivenRecommendedChannels({
      ...baseCtx,
      citations: spoofedCitations,
    });
    for (const ch of fallbackOnly) {
      expect(ch.citedExampleUrls).toBeUndefined();
      expect(ch.reason).not.toMatch(/AI engines cited Reddit/i);
    }

    // Spoofed citations + 1 real Reddit citation -> count stays 1 (MEDIUM), NOT inflated to HIGH
    const mixed = buildCitationDrivenRecommendedChannels({
      ...baseCtx,
      citations: [
        ...spoofedCitations,
        {
          url: 'https://www.reddit.com/r/HomeServer/comments/real1/',
          domain: 'reddit.com',
          title: 'Real Reddit Thread',
          sourceKind: 'SOCIAL',
          position: 2,
        },
      ],
    });
    const reddit = mixed.find((c) => c.channel === 'Reddit');
    expect(reddit).toBeDefined();
    expect(reddit!.priority).toBe('MEDIUM');
    expect(reddit!.reason).toContain('1 time');
    expect(reddit!.citedExampleUrls).toEqual([
      'https://www.reddit.com/r/HomeServer/comments/real1/',
    ]);
  });

  it('rejects double-trailing-dot single-label and malformed SSRF hosts in BriefsService.fromCitationUrl with 400 before calling publicFetch (Challenger 2 Iter-5 Advisory A)', async () => {
    const publicFetch = {
      fetch: vi.fn(),
    } as unknown as PublicFetchService;
    const brands = {
      resolveBrandMarket: vi.fn().mockResolvedValue({
        brand: { id: 'b_1', name: 'NebulaNAS', category: 'Home NAS' },
        market: { id: 'bm_1', market: 'GLOBAL', localBrandName: 'NebulaNAS', ownedDomains: [] },
      }),
    } as unknown as BrandsService;

    const service = new BriefsService(
      {} as PrismaService,
      brands,
      {} as BrandFactIndexRunner,
      {} as ComplianceService,
      {} as FreeActionRateLimiter,
      {} as BriefsAutoGeneratorService,
      publicFetch,
    );

    const maliciousUrls = [
      'http://internal-host../a',
      'http://internal-host.../a',
      'http://foo..bar.com/a',
      `http://${'a'.repeat(260)}.example.com/a`,
    ];

    for (const citationUrl of maliciousUrls) {
      await expect(
        service.fromCitationUrl('t_1', 'u_1', 'b_1', {
          citationUrl,
        }),
      ).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(publicFetch.fetch).not.toHaveBeenCalled();
  });

  it('eliminates WHATWG URL parser differentials (backslash, extra-slash, single-colon), skips non-HTTP(S) schemes, and preserves valid bare-domain/IDN canonicalization (Iter-7)', () => {
    const baseCtx: Omit<BriefSynthesisContext, 'citations'> = {
      market: 'GLOBAL',
      brandName: '星云存储',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'AUTO_GAP',
      priorityScore: 95,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: 'run_whatwg_parity',
      sourceObservationIds: ['obs_whatwg_1'],
      sourceCitationUrl: null,
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet NAS'],
      observations: [],
      ownedDomains: ['https://www.nebulanas.example.com:443/products', 'münchen.example.com'],
      matchedFacts: [],
      presentFactSlots: new Set(),
    };

    const parserDifferentialCitations: BriefSynthesisContext['citations'] = [
      {
        url: 'https://www.zhihu.com\\@reddit.com/question/999',
        domain: 'reddit.com',
        title: 'Backslash CN with reddit domain',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https://www.zhihu.com\\@reddit.com/question/999',
        domain: '',
        title: 'Backslash CN with empty domain',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https://shop.nebulanas.example.com\\@reddit.com/spoof',
        domain: 'reddit.com',
        title: 'Backslash owned',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https://www.amazon.com\\@reddit.com/dp/B0SPOOF',
        domain: 'reddit.com',
        title: 'Backslash ecommerce',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https:/www.zhihu.com/question/999',
        domain: 'reddit.com',
        title: 'Single slash CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https:zhihu.com/q/1',
        domain: 'reddit.com',
        title: 'Single colon CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https:///www.zhihu.com/question/999',
        domain: 'reddit.com',
        title: 'Triple slash CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https:////www.zhihu.com/question/999',
        domain: 'reddit.com',
        title: 'Quad slash CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https:\\\\www.zhihu.com/question/999',
        domain: 'reddit.com',
        title: 'Backslash scheme CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https:\\\\shop.nebulanas.example.com/spoof',
        domain: 'reddit.com',
        title: 'Backslash scheme owned',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'https://www.zhihu.com\\foo..bar',
        domain: 'reddit.com',
        title: 'Backslash dotdot path CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: `https://www.zhihu.com\\${'a'.repeat(300)}`,
        domain: 'reddit.com',
        title: 'Backslash 300-char path CN',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      // Non-HTTP(S) schemes paired with valid cite.domain must be skipped cleanly
      {
        url: 'javascript:alert(1)',
        domain: 'reddit.com',
        title: 'JS scheme spoof',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'file:///etc/passwd',
        domain: 'reddit.com',
        title: 'File scheme spoof',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'data:text/html,<script>alert(1)</script>',
        domain: 'reddit.com',
        title: 'Data scheme spoof',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: 'ftp://reddit.com/archive.tar.gz',
        domain: 'reddit.com',
        title: 'FTP scheme spoof',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      // Malformed/non-public bare domains must also be rejected
      {
        url: '',
        domain: 'a..b.com',
        title: 'Consecutive dots',
        sourceKind: 'AUTHORITY',
        position: 1,
      },
      {
        url: '',
        domain: '.reddit.com',
        title: 'Leading dot',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: '',
        domain: '[::1]',
        title: 'Bracket IPv6',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: '',
        domain: '[reddit.com]garbage',
        title: 'Bracket trailing garbage',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: '',
        domain: 'mailto:a@reddit.com',
        title: 'Mailto bare domain',
        sourceKind: 'SOCIAL',
        position: 1,
      },
      {
        url: '',
        domain: '测试.cn',
        title: 'CN IDN bare domain in GLOBAL',
        sourceKind: 'AUTHORITY',
        position: 1,
      },
      {
        url: '',
        domain: 'münchen.example.com',
        title: 'Owned IDN bare domain',
        sourceKind: 'AUTHORITY',
        position: 1,
      },
    ];

    // Attack-only input -> zero citation-backed buckets (falls back cleanly, zero citedExampleUrls)
    const attackOnly = buildCitationDrivenRecommendedChannels({
      ...baseCtx,
      citations: parserDifferentialCitations,
    });
    for (const ch of attackOnly) {
      expect(ch.citedExampleUrls).toBeUndefined();
      expect(ch.reason).not.toMatch(/AI engines cited/i);
      expect(ch.reason).not.toContain('zhihu.com');
      expect(ch.reason).not.toContain('nebulanas.example.com');
      expect(ch.reason).not.toContain('amazon.com');
    }

    // Attack payloads mixed with valid citations (including non-URL string + valid domain, mobile subdomain with port, IDN with port+path)
    const mixed = buildCitationDrivenRecommendedChannels({
      ...baseCtx,
      citations: [
        ...parserDifferentialCitations,
        {
          url: 'https://www.reddit.com/r/HomeServer/comments/clean_thread/',
          domain: 'm.reddit.com:8443',
          title: 'Valid Mobile Reddit',
          sourceKind: 'SOCIAL',
          position: 2,
        },
        {
          url: 'not-a-valid-url',
          domain: 'rtings.com',
          title: 'Valid Domain with Non-URL Text',
          sourceKind: 'AUTHORITY',
          position: 2,
        },
        {
          url: 'https://büro-test.example.org:8443/review',
          domain: 'büro-test.example.org:8443/review',
          title: 'Valid Non-CN IDN Review',
          sourceKind: 'AUTHORITY',
          position: 3,
        },
        // Backslash-obfuscated URL on a valid domain must NOT leak into citedExampleUrls
        {
          url: 'https://www.quora.com\\@evil.com/Best-NAS',
          domain: 'quora.com',
          title: 'Backslash Quora',
          sourceKind: 'SOCIAL',
          position: 3,
        },
      ],
    });

    const reddit = mixed.find((c) => c.channel === 'Reddit');
    expect(reddit).toBeDefined();
    expect(reddit!.priority).toBe('MEDIUM');
    expect(reddit!.reason).toContain('1 time');
    expect(reddit!.citedExampleUrls).toEqual([
      'https://www.reddit.com/r/HomeServer/comments/clean_thread/',
    ]);

    const media = mixed.find((c) => c.channel === 'Independent Review Media');
    expect(media).toBeDefined();
    expect(media!.priority).toBe('HIGH');
    expect(media!.reason).toContain('2 times');
    expect(media!.reason).toContain('rtings.com');
    expect(media!.reason).toContain('xn--bro-test-65a.example.org');
    expect(media!.citedExampleUrls).toEqual(['https://büro-test.example.org:8443/review']);

    const quora = mixed.find((c) => c.channel === 'Quora');
    expect(quora).toBeDefined();
    expect(quora!.citedExampleUrls).toBeUndefined();

    for (const ch of mixed) {
      for (const u of ch.citedExampleUrls ?? []) {
        expect(u).not.toContain('\\');
        expect(u).not.toContain('zhihu.com');
        expect(u).not.toContain('nebulanas.example.com');
        expect(u).not.toContain('amazon.com');
      }
    }

    // parseStoredChannels must also reject backslash URLs
    const stored = parseStoredChannels([
      {
        channel: 'Reddit',
        reason: 'Cited discussions',
        providerHint: 'REDDIT_ASSIST',
        priority: 'HIGH',
        citedExampleUrls: [
          'https://www.reddit.com\\@evil.com/r/nas',
          'https:\\\\www.zhihu.com/question/999',
          'https://www.reddit.com/r/HomeServer/comments/clean_thread/',
        ],
      },
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.citedExampleUrls).toEqual([
      'https://www.reddit.com/r/HomeServer/comments/clean_thread/',
    ]);
  });
});
