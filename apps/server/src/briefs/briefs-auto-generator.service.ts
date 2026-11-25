import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  BRAND_FACT_TOP_K_CHUNKS,
  NEAR_MISS_TIER_LABELS,
  compareGeoBriefPriority,
  computeGeoBriefPriorityScore,
  normalizeFanOutQueries,
  readProductLineMarketCompetitors,
  resolveEffectiveCategory,
  type BrandFactSlot,
  type CitationSourceKind,
  type GeoBriefSource,
  type GeoMarket,
} from '@geomix/shared';
import { TX_OPTIONS } from '../billing/billing.sql';
import { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { ApiError } from '../common/api-error';
import { LlmService, assertCompletionAllowed, type LlmMessage } from '../infra/llm';
import { ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import type {
  OnVisibilityRunCompleteHook,
  VisibilityRunCompleteEvent,
} from '../visibility/visibility-run.runner';
import {
  buildDeterministicBriefDraft,
  cleanPromptForDisplay,
  dedupeTrimmed,
  extractJsonCandidate,
  finalizeRealLlmBriefDraft,
  llmBriefOutputSchema,
  parseObservationCompetitorHits,
  type BriefDraft,
  type BriefMatchedFact,
  type BriefSignalCitation,
  type BriefSignalObservation,
  type BriefSynthesisContext,
} from './briefs.mapper';
import { NEAR_MISS_GAP_LABELS } from './near-miss-diagnosis';

const MAX_AUTO_BRIEFS_PER_RUN = 5;

export type AutoBriefCandidate = {
  sourceType: GeoBriefSource;
  priorityScore: number;
  targetPrompt: string;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  sourceCitationTitle: string | null;
  competitorFocus: string[];
  targetFanOuts: string[];
  observations: BriefSignalObservation[];
  citations: BriefSignalCitation[];
};

function toCitationSourceKind(raw: string): CitationSourceKind {
  switch (raw) {
    case 'OWNED':
    case 'COMPETITOR':
    case 'SOCIAL':
    case 'AUTHORITY':
    case 'ECOMMERCE':
    case 'OTHER':
      return raw;
    default:
      return 'OTHER';
  }
}

function toBrandFactSlot(raw: string): BrandFactSlot {
  switch (raw) {
    case 'PRODUCT_SPECS':
    case 'DIFFERENTIATORS':
    case 'CREDENTIALS':
    case 'CASE_STUDIES':
    case 'EXTRA_DOC':
      return raw;
    default:
      return 'EXTRA_DOC';
  }
}

function normalizePromptKey(promptText: string): string {
  return promptText.trim().toLowerCase().replace(/\s+/g, ' ');
}

function collectCompetitorFocus(
  observations: readonly BriefSignalObservation[],
  fallbackCompetitors: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const obs of observations) {
    for (const hit of parseObservationCompetitorHits(obs.competitorHits)) {
      if (!hit.mentioned) continue;
      counts.set(hit.name, (counts.get(hit.name) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  if (ranked.length > 0) {
    return ranked.slice(0, 6);
  }
  return dedupeTrimmed(fallbackCompetitors, 6);
}

/**
 * 纯函数：将单次 VisibilityRun 的有效观测记录聚类为 P1–P5 优先级候选列表（Top 1–5）。
 * 保持严格 PRD §4.3 优先级：P1 AUTO_GAP (90-100) > P2 SENTIMENT_RISK (80-89) >
 * P3 LOW_RANK (70-79) > P5 CITATION_COUNTER (60-75) / P4 FANOUT_CLUSTER (60-69) > fallback (55)。
 */
export function clusterVisibilityRunCandidates(input: {
  observations: readonly BriefSignalObservation[];
  fallbackCompetitors?: readonly string[];
  maxCandidates?: number;
}): AutoBriefCandidate[] {
  const maxCandidates = Math.max(1, Math.min(10, input.maxCandidates ?? MAX_AUTO_BRIEFS_PER_RUN));
  const fallbackCompetitors = input.fallbackCompetitors ?? [];
  if (input.observations.length === 0) return [];

  const groups = new Map<string, BriefSignalObservation[]>();
  for (const obs of input.observations) {
    const key = normalizePromptKey(obs.promptText);
    const list = groups.get(key) ?? [];
    list.push(obs);
    groups.set(key, list);
  }

  const candidates: AutoBriefCandidate[] = [];
  const coveredPromptKeys = new Set<string>();
  const allCitations: Array<{ citation: BriefSignalCitation; obs: BriefSignalObservation }> = [];
  const allFanOuts: string[] = [];

  for (const [promptKey, obsList] of groups.entries()) {
    const targetPrompt = obsList[0]!.promptText.trim();
    const obsIds = obsList.map((o) => o.id);
    const groupCitations = obsList.flatMap((o) => o.citations);
    for (const obs of obsList) {
      for (const cite of obs.citations) {
        allCitations.push({ citation: cite, obs });
      }
      allFanOuts.push(...obs.fanOutQueries);
    }

    const groupFanOuts = normalizeFanOutQueries(obsList.flatMap((o) => o.fanOutQueries));
    const brandMentionedObs = obsList.filter((o) => o.brandMentioned === true);
    const brandMentionedCount = brandMentionedObs.length;

    let competitorEngineHits = 0;
    for (const obs of obsList) {
      const hits = parseObservationCompetitorHits(obs.competitorHits);
      if (hits.some((h) => h.mentioned)) {
        competitorEngineHits += 1;
      }
    }
    const competitorFocus = collectCompetitorFocus(obsList, fallbackCompetitors);

    const negativeCount = brandMentionedObs.filter((o) => o.brandSentiment === 'negative').length;
    const mixedCount = brandMentionedObs.filter((o) => o.brandSentiment === 'mixed').length;
    const positions = brandMentionedObs
      .map((o) => o.brandPosition)
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    const avgPosition =
      positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : null;

    // P1: AUTO_GAP (90-100)
    if (brandMentionedCount === 0) {
      candidates.push({
        sourceType: 'AUTO_GAP',
        priorityScore: computeGeoBriefPriorityScore({
          sourceType: 'AUTO_GAP',
          competitorEngineHits,
          competitorCount: competitorFocus.length,
        }),
        targetPrompt,
        sourceObservationIds: obsIds,
        sourceCitationUrl: null,
        sourceCitationTitle: null,
        competitorFocus,
        targetFanOuts: groupFanOuts.slice(0, 8),
        observations: obsList,
        citations: groupCitations,
      });
      coveredPromptKeys.add(promptKey);
      continue;
    }

    // P2: SENTIMENT_RISK (80-89)
    if (negativeCount > 0 || mixedCount > 0) {
      candidates.push({
        sourceType: 'SENTIMENT_RISK',
        priorityScore: computeGeoBriefPriorityScore({
          sourceType: 'SENTIMENT_RISK',
          negativeCount,
          mixedCount,
        }),
        targetPrompt,
        sourceObservationIds: obsIds,
        sourceCitationUrl: null,
        sourceCitationTitle: null,
        competitorFocus,
        targetFanOuts: groupFanOuts.slice(0, 8),
        observations: obsList,
        citations: groupCitations,
      });
      coveredPromptKeys.add(promptKey);
      continue;
    }

    // P3: LOW_RANK (70-79)
    if (avgPosition !== null && avgPosition >= 3) {
      candidates.push({
        sourceType: 'LOW_RANK',
        priorityScore: computeGeoBriefPriorityScore({
          sourceType: 'LOW_RANK',
          avgPosition,
          competitorEngineHits,
        }),
        targetPrompt,
        sourceObservationIds: obsIds,
        sourceCitationUrl: null,
        sourceCitationTitle: null,
        competitorFocus,
        targetFanOuts: groupFanOuts.slice(0, 8),
        observations: obsList,
        citations: groupCitations,
      });
      coveredPromptKeys.add(promptKey);
      continue;
    }

    // P4 (per-prompt): FANOUT_CLUSTER (60-69)
    if (groupFanOuts.length >= 3) {
      candidates.push({
        sourceType: 'FANOUT_CLUSTER',
        priorityScore: computeGeoBriefPriorityScore({
          sourceType: 'FANOUT_CLUSTER',
          fanOutCount: groupFanOuts.length,
        }),
        targetPrompt,
        sourceObservationIds: obsIds,
        sourceCitationUrl: null,
        sourceCitationTitle: null,
        competitorFocus,
        targetFanOuts: groupFanOuts.slice(0, 8),
        observations: obsList,
        citations: groupCitations,
      });
      coveredPromptKeys.add(promptKey);
    }
  }

  // P5: CITATION_COUNTER (60-75) — non-owned high-frequency or competitor citation when owned citations = 0
  const totalOwnedCitations = allCitations.filter((c) => c.citation.sourceKind === 'OWNED').length;
  if (totalOwnedCitations === 0 && allCitations.length > 0) {
    const urlBuckets = new Map<
      string,
      {
        citation: BriefSignalCitation;
        count: number;
        obsMap: Map<string, BriefSignalObservation>;
      }
    >();
    for (const { citation, obs } of allCitations) {
      if (citation.sourceKind === 'OWNED') continue;
      const key = citation.url.trim();
      if (!key) continue;
      const existing = urlBuckets.get(key);
      if (existing) {
        existing.count += 1;
        existing.obsMap.set(obs.id, obs);
      } else {
        urlBuckets.set(key, {
          citation,
          count: 1,
          obsMap: new Map([[obs.id, obs]]),
        });
      }
    }

    const topCounter = [...urlBuckets.values()]
      .filter((entry) => entry.count >= 2 || entry.citation.sourceKind === 'COMPETITOR')
      .sort((a, b) => {
        const compDiff =
          (b.citation.sourceKind === 'COMPETITOR' ? 1 : 0) -
          (a.citation.sourceKind === 'COMPETITOR' ? 1 : 0);
        if (compDiff !== 0) return compDiff;
        return b.count - a.count;
      })[0];

    if (topCounter) {
      const obsList = [...topCounter.obsMap.values()];
      const prompt = obsList[0]!.promptText.trim();
      candidates.push({
        sourceType: 'CITATION_COUNTER',
        priorityScore: computeGeoBriefPriorityScore({
          sourceType: 'CITATION_COUNTER',
          citationCount: topCounter.count,
          ownedCitationCount: 0,
          isCompetitorSource: topCounter.citation.sourceKind === 'COMPETITOR',
        }),
        targetPrompt: prompt,
        sourceObservationIds: obsList.map((o) => o.id),
        sourceCitationUrl: topCounter.citation.url,
        sourceCitationTitle: topCounter.citation.title,
        competitorFocus: collectCompetitorFocus(obsList, fallbackCompetitors),
        targetFanOuts: normalizeFanOutQueries(obsList.flatMap((o) => o.fanOutQueries)).slice(0, 8),
        observations: obsList,
        citations: obsList.flatMap((o) => o.citations),
      });
    }
  }

  // Run-wide P4 FANOUT_CLUSTER if still room and uncovered fan-out queries >= 3
  const dedupedRunFanOuts = normalizeFanOutQueries(allFanOuts);
  const hasFanOutCandidate = candidates.some((c) => c.sourceType === 'FANOUT_CLUSTER');
  if (!hasFanOutCandidate && dedupedRunFanOuts.length >= 3) {
    const uncoveredObs = input.observations.filter(
      (o) => !coveredPromptKeys.has(normalizePromptKey(o.promptText)),
    );
    const seedObs = uncoveredObs.length > 0 ? uncoveredObs : [...input.observations];
    candidates.push({
      sourceType: 'FANOUT_CLUSTER',
      priorityScore: computeGeoBriefPriorityScore({
        sourceType: 'FANOUT_CLUSTER',
        fanOutCount: dedupedRunFanOuts.length,
      }),
      targetPrompt: seedObs[0]!.promptText.trim(),
      sourceObservationIds: seedObs.map((o) => o.id),
      sourceCitationUrl: null,
      sourceCitationTitle: null,
      competitorFocus: collectCompetitorFocus(seedObs, fallbackCompetitors),
      targetFanOuts: dedupedRunFanOuts.slice(0, 8),
      observations: seedObs,
      citations: seedObs.flatMap((o) => o.citations),
    });
  }

  // Fallback consolidation brief if all observations were already #1 positive with owned citations
  if (candidates.length === 0) {
    const firstObs = input.observations[0]!;
    const sourceType: GeoBriefSource = dedupedRunFanOuts.length >= 2 ? 'FANOUT_CLUSTER' : 'MANUAL';
    candidates.push({
      sourceType,
      priorityScore: computeGeoBriefPriorityScore({
        sourceType,
        fanOutCount: dedupedRunFanOuts.length,
      }),
      targetPrompt: firstObs.promptText.trim(),
      sourceObservationIds: input.observations.map((o) => o.id),
      sourceCitationUrl: null,
      sourceCitationTitle: null,
      competitorFocus: collectCompetitorFocus(input.observations, fallbackCompetitors),
      targetFanOuts: dedupedRunFanOuts.slice(0, 8),
      observations: [...input.observations],
      citations: input.observations.flatMap((o) => o.citations),
    });
  }

  return candidates.sort(compareGeoBriefPriority).slice(0, maxCandidates);
}

function buildBriefSynthesisMessages(
  ctx: BriefSynthesisContext,
  strictRetry: boolean,
): LlmMessage[] {
  const isGlobal = ctx.market === 'GLOBAL';
  const languageRules = isGlobal
    ? [
        '- market=GLOBAL: diagnosisSummary MUST be concise Chinese (2-3 sentences for the Chinese operator).',
        '- suggestedTitle MUST be native English (FTC-compliant; natural terms like Best/Top are allowed).',
        '- EVERY outlineH2[i].heading MUST be native English.',
        '- targetFormat MUST be "GLOBAL_AUTHORITY_GUIDE" or "GLOBAL_COMMUNITY_DISCUSSION".',
        '- recommendedChannels MUST ONLY include global channels (Independent Blog/Docs (llms.txt + JSON-LD), Reddit, Quora, Trustpilot/G2, Independent Review Media) and NEVER Chinese platforms.',
      ]
    : [
        '- market=CN: diagnosisSummary、suggestedTitle、outlineH2 全部输出简体中文。',
        '- targetFormat 必须为 "CN_DEEP_REVIEW" 或 "CN_COMMUNITY_QA"。',
        '- recommendedChannels 推荐国内高权阵地（字节头条/抖音图文、知乎、什么值得买、微信公众号、小红书、官网）。',
      ];

  const systemContent = [
    '你是 GeoMix Diagnosis-to-Brief 写作诊断引擎，负责将 AI 可见度观测信号转化为高引用 GEO 写作意见卡。',
    '请仅输出严格合法的 JSON 对象（不要输出 Markdown 解释），结构如下：',
    '{"diagnosisSummary":"2-3句中文归因","recommendedRecipe":"AUTHORITY_GUIDE|COMPARISON_MATRIX|OBJECTION_FAQ|CITATION_COUNTER","targetFormat":"...","suggestedTitle":"标题","outlineH2":[{"heading":"H2标题","intent":"写作意图","fanOutRef":"可选拆解词"}],"missingFactHints":["缺失事实补强建议"],"recommendedChannels":[{"channel":"渠道名","reason":"推荐理由"}]}',
    '强制约束：',
    '- outlineH2 至少包含 3–5 个清晰 H2 小节。',
    '- 若引用源列表为空，请基于回答正文、竞品露出差距与品牌事实卡生成高质量意见，严禁输出空大纲或报错。',
    ...(ctx.sourceType === 'CITATION_COUNTER'
      ? [
          '- sourceType=CITATION_COUNTER 时，recommendedRecipe 必须固定为 "CITATION_COUNTER"，outlineH2 须覆盖并超越竞品高引用页议题骨架，强制注入我方已匹配品牌事实卡的实测参数与对比表。',
        ]
      : []),
    ...(ctx.sourceType === 'NEAR_MISS_BOOST'
      ? [
          '- sourceType=NEAR_MISS_BOOST 时，须针对已诊断出的页面结构缺口（首段直答、参数对比表、FAQ/JSON-LD、核心品牌事实覆盖）给出可直接落地的补强修改大纲，并优先注入已匹配的品牌事实卡数据。',
        ]
      : []),
    ...languageRules,
    ...(strictRetry
      ? [
          '上一次输出不符合 JSON 或双市场语种要求，本次务必返回纯 JSON 对象并严格满足上述语种与字段约束。',
        ]
      : []),
  ].join('\n');

  const obsLines = ctx.observations.slice(0, 6).map((obs, idx) => {
    const compNames = parseObservationCompetitorHits(obs.competitorHits)
      .filter((h) => h.mentioned)
      .map((h) => (h.position ? `${h.name}(#${h.position})` : h.name));
    const snippet = (obs.answerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    return `#${idx + 1} [${obs.engine}] mentioned=${String(obs.brandMentioned)} pos=${obs.brandPosition ?? 'null'} sentiment=${obs.brandSentiment ?? 'none'} competitors=${compNames.join(',') || 'none'} citations=${obs.citations.length} snippet=${snippet}`;
  });

  const factLines = ctx.matchedFacts
    .slice(0, 6)
    .map((f) => `[${f.slot}] ${f.title}: ${f.content.slice(0, 240)}`);
  const citeLines = ctx.citations
    .slice(0, 8)
    .map((c) => `[${c.sourceKind}] ${c.domain} ${c.title ?? ''} ${c.url}`);
  const sourceHeadingLines = (ctx.sourceArticleHeadings ?? [])
    .slice(0, 8)
    .map((heading, idx) => `${idx + 1}. ${heading}`);
  const sourceExcerpt = ctx.sourceArticleExcerpt?.trim().slice(0, 4000) ?? '';

  const nearMissBlock = ctx.nearMiss
    ? [
        '--- Near-Miss 机会层级与页面缺口诊断 ---',
        `层级：${ctx.nearMiss.tier}（${NEAR_MISS_TIER_LABELS[ctx.nearMiss.tier]}）`,
        ...(ctx.nearMiss.diagnosis
          ? [
              `抓取状态：${ctx.nearMiss.diagnosis.fetchStatus}${ctx.nearMiss.diagnosis.fetchFallbackReason ? `（${ctx.nearMiss.diagnosis.fetchFallbackReason}）` : ''}`,
              `已检出结构缺口：${
                ctx.nearMiss.diagnosis.missingGaps.length > 0
                  ? ctx.nearMiss.diagnosis.missingGaps
                      .map((g) => `${g}(${NEAR_MISS_GAP_LABELS[g]})`)
                      .join('、')
                  : '无明显基础结构缺口'
              }`,
              `已检测 JSON-LD 类型：${ctx.nearMiss.diagnosis.jsonLdTypes.join(', ') || '无'}`,
              `品牌事实覆盖：${ctx.nearMiss.diagnosis.coveredFactCount}/${ctx.nearMiss.diagnosis.totalFactCount}（正文提及品牌=${String(ctx.nearMiss.diagnosis.brandMentionedOnPage)}）`,
            ]
          : []),
      ].join('\n')
    : '';

  const userContent = [
    `品牌：${ctx.brandName}（当地品牌名：${ctx.localBrandName}，品类：${ctx.category}，市场：${ctx.market}）`,
    `信号来源：${ctx.sourceType}（优先级：${ctx.priorityScore}）`,
    `目标问题：${cleanPromptForDisplay(ctx.targetPrompt) || `${ctx.localBrandName} ${ctx.category}`}`,
    ctx.sourceCitationUrl ? `目标高引用链接：${ctx.sourceCitationUrl}` : '',
    ctx.sourceCitationTitle ? `目标页标题：${ctx.sourceCitationTitle}` : '',
    ctx.competitorFocus.length > 0 ? `重点竞品：${ctx.competitorFocus.join('、')}` : '',
    ctx.targetFanOuts.length > 0 ? `搜索拆解子词：${ctx.targetFanOuts.join('、')}` : '',
    nearMissBlock,
    sourceHeadingLines.length > 0
      ? `--- 目标参考页议题骨架 ---\n${sourceHeadingLines.join('\n')}`
      : '',
    sourceExcerpt ? `--- 目标参考页正文摘录 ---\n${sourceExcerpt}` : '',
    obsLines.length > 0 ? `--- AI 回答观测摘要 ---\n${obsLines.join('\n')}` : '',
    citeLines.length > 0
      ? `--- 引用来源（共 ${ctx.citations.length} 条）---\n${citeLines.join('\n')}`
      : '--- 引用来源：无外部引用（D16 回答与事实降级） ---',
    factLines.length > 0
      ? `--- 已匹配品牌事实卡 ---\n${factLines.join('\n')}`
      : '--- 已匹配品牌事实卡：暂无 ---',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function parseCompetitorNamesFromJson(raw: Prisma.JsonValue): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) {
      names.push(name.trim());
    }
  }
  return dedupeTrimmed(names, 10);
}

@Injectable()
export class BriefsAutoGeneratorService implements OnVisibilityRunCompleteHook {
  readonly name = 'geo-brief-auto-generator';

  private readonly logger = new Logger(BriefsAutoGeneratorService.name);
  private readonly inflightRuns = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(BrandFactIndexRunner) private readonly factIndexRunner: BrandFactIndexRunner,
  ) {}

  async onVisibilityRunComplete(event: VisibilityRunCompleteEvent): Promise<void> {
    if (
      event.triggerType === 'RETEST' ||
      event.status === 'FAILED' ||
      event.status === 'CANCELLED' ||
      event.successCount <= 0
    ) {
      return;
    }

    const inflightKey = `${event.tenantId}:${event.runId}`;
    if (this.inflightRuns.has(inflightKey)) {
      return;
    }
    this.inflightRuns.add(inflightKey);

    try {
      const run = await this.prisma.base.visibilityRun.findFirst({
        where: { id: event.runId, tenantId: event.tenantId },
        include: {
          productLine: true,
          brand: {
            select: {
              id: true,
              name: true,
              category: true,
              facts: {
                select: { slot: true, content: true, productLineId: true },
              },
              markets: {
                select: { ownedDomains: true },
              },
            },
          },
          brandMarket: {
            select: {
              id: true,
              market: true,
              localBrandName: true,
              localCategory: true,
              competitors: true,
              ownedDomains: true,
            },
          },
          observations: {
            where: { status: 'SUCCESS' },
            include: {
              citations: {
                orderBy: { position: 'asc' },
              },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
          _count: {
            select: { geoBriefs: true },
          },
        },
      });

      if (
        !run ||
        run.triggerType === 'RETEST' ||
        run.briefsGeneratedAt !== null ||
        run._count.geoBriefs > 0 ||
        run.observations.length === 0
      ) {
        return;
      }

      const market: GeoMarket = run.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
      const effectiveProductLineId = run.productLineId ?? null;
      const effectiveCategory = resolveEffectiveCategory(
        run.brand,
        { market, localCategory: run.brandMarket.localCategory ?? null },
        run.productLine ?? null,
      );
      const lineCompetitors = run.productLine
        ? readProductLineMarketCompetitors(run.productLine.competitorsJson, market)
        : [];
      const fallbackCompetitors =
        lineCompetitors.length > 0
          ? lineCompetitors.map((c) => c.name)
          : parseCompetitorNamesFromJson(run.brandMarket.competitors);
      const ownedDomains = dedupeTrimmed(
        [
          ...(Array.isArray(run.brandMarket.ownedDomains) ? run.brandMarket.ownedDomains : []),
          ...(Array.isArray(run.brand.markets)
            ? run.brand.markets.flatMap((m) =>
                Array.isArray(m.ownedDomains) ? m.ownedDomains : [],
              )
            : []),
        ],
        30,
      );
      const scopedBrandFacts = effectiveProductLineId
        ? run.brand.facts.filter(
            (f) => f.productLineId == null || f.productLineId === effectiveProductLineId,
          )
        : run.brand.facts;
      const presentFactSlots = new Set<BrandFactSlot>(
        scopedBrandFacts
          .filter((f) => typeof f.content === 'string' && f.content.trim().length > 0)
          .map((f) => toBrandFactSlot(f.slot)),
      );

      const signalObservations: BriefSignalObservation[] = run.observations.map((obs) => ({
        id: obs.id,
        runId: obs.runId,
        promptText: obs.promptText,
        engine: obs.engine,
        answerText: obs.answerText,
        brandMentioned: obs.brandMentioned,
        brandPosition: obs.brandPosition,
        brandSentiment: obs.brandSentiment,
        competitorHits: obs.competitorHits,
        fanOutQueries: obs.fanOutQueries,
        citations: obs.citations.map((c) => ({
          url: c.url,
          domain: c.domain,
          title: c.title,
          sourceKind: toCitationSourceKind(c.sourceKind),
          ...(typeof c.position === 'number' ? { position: c.position } : {}),
        })),
      }));

      const candidates = clusterVisibilityRunCandidates({
        observations: signalObservations,
        fallbackCompetitors,
        maxCandidates: MAX_AUTO_BRIEFS_PER_RUN,
      });
      if (candidates.length === 0) {
        return;
      }

      const preparedRows: Array<{ candidate: AutoBriefCandidate; draft: BriefDraft }> = [];
      for (const candidate of candidates) {
        const queryText = [
          cleanPromptForDisplay(candidate.targetPrompt),
          ...candidate.targetFanOuts.slice(0, 4),
          ...candidate.competitorFocus.slice(0, 3),
        ]
          .filter(Boolean)
          .join(' ');

        const retrieved = await this.factIndexRunner.retrieveRelevantBrandFacts(
          event.tenantId,
          run.brandId,
          queryText,
          BRAND_FACT_TOP_K_CHUNKS,
          effectiveProductLineId,
        );
        const matchedFacts: BriefMatchedFact[] = retrieved.map((r) => ({
          factId: r.factId,
          slot: r.slot,
          title: r.title,
          content: r.content,
        }));

        const synthCtx: BriefSynthesisContext = {
          market,
          brandName: run.brand.name,
          localBrandName: run.brandMarket.localBrandName || run.brand.name,
          category: effectiveCategory,
          sourceType: candidate.sourceType,
          priorityScore: candidate.priorityScore,
          targetPrompt: candidate.targetPrompt,
          sourceRunId: run.id,
          sourceObservationIds: candidate.sourceObservationIds,
          sourceCitationUrl: candidate.sourceCitationUrl,
          sourceCitationTitle: candidate.sourceCitationTitle,
          competitorFocus: candidate.competitorFocus,
          targetFanOuts: candidate.targetFanOuts,
          observations: candidate.observations,
          citations: candidate.citations,
          ownedDomains,
          matchedFacts,
          presentFactSlots,
        };

        const digest = createHash('sha256')
          .update(
            `${run.id}:${candidate.sourceType}:${candidate.targetPrompt}:${candidate.sourceCitationUrl ?? ''}`,
          )
          .digest('hex')
          .slice(0, 16);
        const idempotencyKey = `geo_brief_run:${run.id.slice(0, 24)}:${digest}`;
        const draft = await this.synthesizeSingleBrief(event.tenantId, synthCtx, idempotencyKey);
        preparedRows.push({ candidate, draft });
      }

      const now = new Date();
      await this.prisma.base.$transaction(async (tx) => {
        const stamped = await tx.visibilityRun.updateMany({
          where: {
            id: run.id,
            tenantId: event.tenantId,
            briefsGeneratedAt: null,
          },
          data: {
            briefsGeneratedAt: now,
          },
        });
        if (stamped.count !== 1) {
          return;
        }

        const existingCount = await tx.geoBrief.count({
          where: { tenantId: event.tenantId, sourceRunId: run.id },
        });
        if (existingCount > 0) {
          return;
        }

        for (const { candidate, draft } of preparedRows) {
          await tx.geoBrief.create({
            data: {
              tenantId: event.tenantId,
              brandId: run.brandId,
              brandMarketId: run.brandMarketId,
              productLineId: effectiveProductLineId,
              sourceType: candidate.sourceType,
              sourceRunId: run.id,
              sourceObservationIds: candidate.sourceObservationIds,
              sourceCitationUrl: candidate.sourceCitationUrl,
              targetPrompt: candidate.targetPrompt,
              priorityScore: candidate.priorityScore,
              diagnosisSummary: draft.diagnosisSummary,
              recommendedRecipe: draft.recommendedRecipe,
              targetFormat: draft.targetFormat,
              suggestedTitle: draft.suggestedTitle,
              outlineH2: draft.outlineH2 as unknown as Prisma.InputJsonValue,
              targetFanOuts: draft.targetFanOuts,
              competitorFocus: draft.competitorFocus,
              matchedFactIds: draft.matchedFactIds,
              missingFactHints: draft.missingFactHints,
              recommendedChannels: draft.recommendedChannels as unknown as Prisma.InputJsonValue,
              status: 'OPEN',
            },
          });
        }
      }, TX_OPTIONS);
    } catch (error) {
      this.logger.warn(
        `auto-brief generation aborted for run=${event.runId}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      throw error;
    } finally {
      this.inflightRuns.delete(inflightKey);
    }
  }

  /**
   * 复用单条意见卡综合能力（供自动 Hook 与 HTTP on-demand `POST /briefs/generate` 共享）：
   * - 严格执行 #321 `assertCompletionAllowed`，禁止在全局 STRICT 或真实模型失败时静默退回假模板；
   * - 真实模型返回非法 JSON / 违背双市场语种要求时最多重试 1 次，仍失败抛 502；
   * - 仅在允许 fake 模式的开发/单测/E2E 环境执行确定性有据综合（含 D16 空引用降级）。
   */
  async synthesizeSingleBrief(
    tenantId: string,
    ctx: BriefSynthesisContext,
    idempotencyKey?: string,
  ): Promise<BriefDraft> {
    const baseKey =
      idempotencyKey ??
      `geo_brief:${ctx.market}:${createHash('sha256')
        .update(`${ctx.targetPrompt}:${ctx.sourceType}:${ctx.sourceCitationUrl ?? ''}`)
        .digest('hex')
        .slice(0, 16)}:${randomBytes(4).toString('hex')}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptKey = attempt === 0 ? baseKey : `${baseKey.slice(0, 118)}:r1`;
      let completion;
      try {
        completion = await this.llm.complete({
          tenantId,
          scene: 'geo_brief',
          messages: buildBriefSynthesisMessages(ctx, attempt > 0),
          idempotencyKey: attemptKey,
          temperature: 0.2,
          maxTokens: 2048,
          disableThinking: true,
        });

        assertCompletionAllowed({
          completion,
          llm: this.llm,
          scene: 'geo_brief',
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof ProviderError) {
          if (error.reason === 'fake_fallback_rejected') {
            throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, error.message);
          }
          throw new ApiError(
            502,
            API_ERROR.UPSTREAM_UNAVAILABLE,
            error.message || 'GEO 写作意见生成服务暂时不可用，请稍后重试',
          );
        }
        throw new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, 'GEO 写作意见生成失败，请稍后重试');
      }

      if (completion.fake) {
        return buildDeterministicBriefDraft(ctx);
      }

      try {
        const jsonObj = extractJsonCandidate(completion.text);
        const parsed = llmBriefOutputSchema.safeParse(jsonObj);
        if (parsed.success) {
          const finalized = finalizeRealLlmBriefDraft(parsed.data, ctx);
          if (finalized) {
            return finalized;
          }
        }
      } catch {
        // retry once on malformed JSON
      }
    }

    throw new ApiError(
      502,
      API_ERROR.UPSTREAM_UNAVAILABLE,
      '大模型返回的写作意见格式异常，未降级假模板，请稍后重试',
    );
  }
}
