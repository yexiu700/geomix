import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_FACT_TOP_K_CHUNKS,
  GEO_BRIEF_ID_PATTERN,
  computeGeoBriefPriorityScore,
  normalizeFanOutQueries,
  targetFormatsForMarket,
  type BrandFactSlot,
  type CitationSourceKind,
  type GeoBriefGenerateInput,
  type GeoBriefListQuery,
  type GeoBriefListResponse,
  type GeoBriefRecord,
  type GeoBriefUpdateInput,
  type GeoMarket,
} from '@geomix/shared';
import { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readBriefGenerateRateLimit,
} from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { BriefsAutoGeneratorService } from './briefs-auto-generator.service';
import {
  cleanPromptForDisplay,
  dedupeTrimmed,
  parseObservationCompetitorHits,
  presentBrief,
  type BriefMatchedFact,
  type BriefSignalCitation,
  type BriefSignalObservation,
  type BriefSynthesisContext,
} from './briefs.mapper';

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

function assertHttpCitationUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '参考引用链接格式不正确');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '参考引用链接仅支持 http 或 https 协议');
  }
  return trimmed;
}

@Injectable()
export class BriefsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Inject(BrandFactIndexRunner) private readonly factIndexRunner: BrandFactIndexRunner,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(FreeActionRateLimiter) private readonly rateLimiter: FreeActionRateLimiter,
    @Inject(BriefsAutoGeneratorService) private readonly synthesizer: BriefsAutoGeneratorService,
  ) {}

  async list(brandId: string, query: GeoBriefListQuery): Promise<GeoBriefListResponse> {
    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);
    const sourceRunId = query.sourceRunId ?? query.runId;

    const where: Prisma.GeoBriefWhereInput = {
      brandId: brand.id,
      brandMarketId: market.id,
      ...(query.status
        ? { status: query.status }
        : query.includeDismissed === true
          ? {}
          : { status: { not: 'DISMISSED' } }),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(sourceRunId ? { sourceRunId } : {}),
    };

    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.scoped.geoBrief.findMany({
        where,
        orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
        include: {
          brandMarket: { select: { market: true } },
        },
      }),
      this.prisma.scoped.geoBrief.count({ where }),
    ]);

    return {
      items: rows.map((row) => presentBrief(row, market.market)),
      total,
    };
  }

  async getById(briefId: string): Promise<GeoBriefRecord> {
    const row = await this.prisma.scoped.geoBrief.findFirst({
      where: { id: briefId },
      include: {
        brandMarket: { select: { market: true } },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作意见不存在');
    }
    return presentBrief(row);
  }

  async generate(
    tenantId: string,
    userId: string,
    brandId: string,
    input: GeoBriefGenerateInput,
    queryMarket?: GeoMarket,
  ): Promise<GeoBriefRecord> {
    if (queryMarket && input.market && queryMarket !== input.market) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '查询参数与请求体的 market 不一致');
    }

    const { brand, market } = await this.brands.resolveBrandMarket(
      brandId,
      input.market ?? queryMarket,
    );

    const obsIds = Array.from(
      new Set((input.observationIds ?? []).map((id) => id.trim()).filter(Boolean)),
    ).slice(0, 50);
    for (const obsId of obsIds) {
      if (!GEO_BRIEF_ID_PATTERN.test(obsId)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '观测记录编号格式不正确');
      }
    }

    const citationUrl = input.citationUrl ? assertHttpCitationUrl(input.citationUrl) : null;
    const fanOutQueries = normalizeFanOutQueries(input.fanOutQueries ?? []).slice(0, 20);
    const customPrompt = input.customPrompt?.trim() || null;

    if (obsIds.length === 0 && !citationUrl && fanOutQueries.length === 0 && !customPrompt) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '请至少提供一条观测记录、引用链接、搜索拆解词或目标问题',
      );
    }

    if (
      input.sourceType === 'MANUAL' &&
      !customPrompt &&
      fanOutQueries.length === 0 &&
      !citationUrl
    ) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '自由选题模式请提供目标问题');
    }

    let observations: BriefSignalObservation[] = [];
    let matchedCitationTitle: string | null = null;
    let extraCitations: BriefSignalCitation[] = [];

    if (obsIds.length > 0) {
      const loadedObs = await this.prisma.scoped.visibilityObservation.findMany({
        where: {
          id: { in: obsIds },
          brandId: brand.id,
          brandMarketId: market.id,
        },
        include: {
          citations: {
            orderBy: { position: 'asc' },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      if (loadedObs.length !== obsIds.length) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分观测记录不存在或不属于当前品牌市场');
      }

      observations = loadedObs.map((obs) => ({
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
        })),
      }));
    } else if (citationUrl) {
      const storedCitations = await this.prisma.scoped.visibilityCitation.findMany({
        where: {
          url: citationUrl,
          observation: {
            brandId: brand.id,
            brandMarketId: market.id,
          },
        },
        include: {
          observation: true,
        },
        take: 10,
      });

      if (storedCitations.length > 0) {
        matchedCitationTitle =
          storedCitations.find((c) => c.title && c.title.trim())?.title?.trim() ?? null;
        extraCitations = storedCitations.map((c) => ({
          url: c.url,
          domain: c.domain,
          title: c.title,
          sourceKind: toCitationSourceKind(c.sourceKind),
        }));
        const obsMap = new Map<string, BriefSignalObservation>();
        for (const item of storedCitations) {
          const obs = item.observation;
          if (!obsMap.has(obs.id)) {
            obsMap.set(obs.id, {
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
              citations: [],
            });
          }
          obsMap.get(obs.id)!.citations.push({
            url: item.url,
            domain: item.domain,
            title: item.title,
            sourceKind: toCitationSourceKind(item.sourceKind),
          });
        }
        observations = [...obsMap.values()];
      } else {
        let host = citationUrl;
        try {
          host = new URL(citationUrl).hostname;
        } catch {
          // keep fallback
        }
        extraCitations = [
          {
            url: citationUrl,
            domain: host,
            title: customPrompt,
            sourceKind: 'OTHER',
          },
        ];
      }
    }

    const userTextForCompliance = [customPrompt ?? '', ...fanOutQueries].filter(Boolean).join('\n');
    if (userTextForCompliance) {
      await this.compliance.assertAllowed({
        text: userTextForCompliance,
        action: 'geo_brief_generate',
        tenantId,
        userId,
      });
    }

    // 免费防刷限流（0 点扣费；放在归属校验之后、LLM 调用之前）
    this.rateLimiter.assertAllowed('geo_brief', tenantId, readBriefGenerateRateLimit());

    const allCitations =
      observations.length > 0 ? observations.flatMap((o) => o.citations) : extraCitations;
    const mergedFanOuts = normalizeFanOutQueries([
      ...fanOutQueries,
      ...observations.flatMap((o) => o.fanOutQueries),
    ]).slice(0, 20);

    const competitorCounts = new Map<string, number>();
    let competitorEngineHits = 0;
    for (const obs of observations) {
      const hits = parseObservationCompetitorHits(obs.competitorHits);
      if (hits.some((h) => h.mentioned)) competitorEngineHits += 1;
      for (const hit of hits) {
        if (hit.mentioned) {
          competitorCounts.set(hit.name, (competitorCounts.get(hit.name) ?? 0) + 1);
        }
      }
    }
    const observedCompetitors = [...competitorCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
    const marketCompetitors = market.competitors.map((c) => c.name);
    const competitorFocus = dedupeTrimmed(
      observedCompetitors.length > 0 ? observedCompetitors : marketCompetitors,
      10,
    );

    const targetPrompt = deriveTargetPrompt({
      customPrompt,
      observations,
      fanOutQueries: mergedFanOuts,
      citationUrl,
      citationTitle: matchedCitationTitle,
      localBrandName: market.localBrandName || brand.name,
      category: brand.category,
      market: market.market,
    });

    const sourceRunId = observations[0]?.runId ?? null;
    const sourceObservationIds = Array.from(
      new Set(
        (obsIds.length > 0 ? obsIds : observations.map((o) => o.id))
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ).slice(0, 50);
    const resolvedCitationUrl =
      citationUrl ??
      (input.sourceType === 'CITATION_COUNTER'
        ? (allCitations.find((c) => c.sourceKind !== 'OWNED')?.url ?? null)
        : null);

    const negativeCount = observations.filter(
      (o) => o.brandMentioned && o.brandSentiment === 'negative',
    ).length;
    const mixedCount = observations.filter(
      (o) => o.brandMentioned && o.brandSentiment === 'mixed',
    ).length;
    const positions = observations
      .filter((o) => o.brandMentioned && typeof o.brandPosition === 'number')
      .map((o) => o.brandPosition as number);
    const avgPosition =
      positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : null;
    const ownedCitationCount = allCitations.filter((c) => c.sourceKind === 'OWNED').length;
    const isCompetitorSource = allCitations.some((c) => c.sourceKind === 'COMPETITOR');

    const priorityScore = computeGeoBriefPriorityScore({
      sourceType: input.sourceType,
      competitorEngineHits,
      competitorCount: competitorFocus.length,
      negativeCount,
      mixedCount,
      avgPosition,
      citationCount: Math.max(1, allCitations.length),
      ownedCitationCount,
      isCompetitorSource,
      fanOutCount: mergedFanOuts.length,
    });

    const [factSlotRows, retrievedFacts] = await Promise.all([
      this.prisma.scoped.brandFact.findMany({
        where: { brandId: brand.id },
        select: { slot: true, content: true },
      }),
      this.factIndexRunner.retrieveRelevantBrandFacts(
        tenantId,
        brand.id,
        [
          cleanPromptForDisplay(targetPrompt),
          ...mergedFanOuts.slice(0, 4),
          ...competitorFocus.slice(0, 3),
        ]
          .filter(Boolean)
          .join(' '),
        BRAND_FACT_TOP_K_CHUNKS,
      ),
    ]);

    const presentFactSlots = new Set<BrandFactSlot>(
      factSlotRows
        .filter((row) => typeof row.content === 'string' && row.content.trim().length > 0)
        .map((row) => toBrandFactSlot(row.slot)),
    );
    const matchedFacts: BriefMatchedFact[] = retrievedFacts.map((item) => ({
      factId: item.factId,
      slot: item.slot,
      title: item.title,
      content: item.content,
    }));

    const synthCtx: BriefSynthesisContext = {
      market: market.market,
      brandName: brand.name,
      localBrandName: market.localBrandName || brand.name,
      category: brand.category,
      sourceType: input.sourceType,
      priorityScore,
      targetPrompt,
      sourceRunId,
      sourceObservationIds,
      sourceCitationUrl: resolvedCitationUrl,
      sourceCitationTitle: matchedCitationTitle,
      competitorFocus,
      targetFanOuts: mergedFanOuts,
      observations,
      citations: allCitations,
      matchedFacts,
      presentFactSlots,
    };

    const draft = await this.synthesizer.synthesizeSingleBrief(tenantId, synthCtx);

    const created = await this.prisma.scoped.geoBrief.create({
      data: {
        tenantId,
        brandId: brand.id,
        brandMarketId: market.id,
        sourceType: input.sourceType,
        sourceRunId,
        sourceObservationIds,
        sourceCitationUrl: resolvedCitationUrl,
        targetPrompt,
        priorityScore,
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
      include: {
        brandMarket: { select: { market: true } },
      },
    });

    return presentBrief(created, market.market);
  }

  async update(
    tenantId: string,
    userId: string,
    briefId: string,
    input: GeoBriefUpdateInput,
  ): Promise<GeoBriefRecord> {
    const existing = await this.prisma.scoped.geoBrief.findFirst({
      where: { id: briefId },
      include: {
        brandMarket: { select: { market: true } },
      },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作意见不存在');
    }

    const market: GeoMarket = existing.brandMarket?.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    if (input.targetFormat && !targetFormatsForMarket(market).includes(input.targetFormat)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `目标阵地形态 ${input.targetFormat} 与当前市场 ${market} 不匹配`,
      );
    }

    const textParts: string[] = [];
    if (input.suggestedTitle) textParts.push(input.suggestedTitle);
    if (input.outlineH2) {
      for (const item of input.outlineH2) {
        textParts.push(item.heading, item.intent);
        if (item.fanOutRef) textParts.push(item.fanOutRef);
      }
    }
    if (input.targetFanOuts) textParts.push(...input.targetFanOuts);
    if (input.missingFactHints) textParts.push(...input.missingFactHints);

    if (textParts.length > 0) {
      await this.compliance.assertAllowed({
        text: textParts.join('\n'),
        action: 'geo_brief_update',
        tenantId,
        userId,
      });
    }

    const data: Prisma.GeoBriefUpdateInput = {};
    if (input.status !== undefined) data.status = input.status;
    if (input.recommendedRecipe !== undefined) data.recommendedRecipe = input.recommendedRecipe;
    if (input.targetFormat !== undefined) data.targetFormat = input.targetFormat;
    if (input.suggestedTitle !== undefined) data.suggestedTitle = input.suggestedTitle.trim();
    if (input.outlineH2 !== undefined) {
      data.outlineH2 = input.outlineH2 as unknown as Prisma.InputJsonValue;
    }
    if (input.targetFanOuts !== undefined) {
      data.targetFanOuts = normalizeFanOutQueries(input.targetFanOuts).slice(0, 20);
    }
    if (input.competitorFocus !== undefined) {
      data.competitorFocus = dedupeTrimmed(input.competitorFocus, 10);
    }
    if (input.missingFactHints !== undefined) {
      data.missingFactHints = dedupeTrimmed(input.missingFactHints, 10);
    }

    const updated = await this.prisma.scoped.geoBrief.update({
      where: { id: existing.id },
      data,
      include: {
        brandMarket: { select: { market: true } },
      },
    });

    return presentBrief(updated, market);
  }
}

function deriveTargetPrompt(input: {
  customPrompt: string | null;
  observations: readonly BriefSignalObservation[];
  fanOutQueries: readonly string[];
  citationUrl: string | null;
  citationTitle: string | null;
  localBrandName: string;
  category: string;
  market: GeoMarket;
}): string {
  if (input.customPrompt) {
    return input.customPrompt.slice(0, 300);
  }
  if (input.observations[0]?.promptText?.trim()) {
    return input.observations[0].promptText.trim().slice(0, 300);
  }
  if (input.fanOutQueries.length > 0) {
    const topTerms = input.fanOutQueries.slice(0, 3).join(' / ');
    if (input.market === 'GLOBAL') {
      return `Best ${input.category} Guide: ${topTerms} (${input.localBrandName})`.slice(0, 300);
    }
    return `${topTerms}：${input.localBrandName}${input.category}专题选购与实测解答`.slice(0, 300);
  }
  if (input.citationTitle) {
    return input.citationTitle.slice(0, 300);
  }
  if (input.citationUrl) {
    let host = input.citationUrl;
    try {
      host = new URL(input.citationUrl).hostname;
    } catch {
      // keep raw
    }
    if (input.market === 'GLOBAL') {
      return `Best ${input.category} Comparison & Review (${input.localBrandName} vs ${host})`.slice(
        0,
        300,
      );
    }
    return `超越 ${host} 的 ${input.localBrandName}${input.category}深度实测与参数对比`.slice(
      0,
      300,
    );
  }
  return input.market === 'GLOBAL'
    ? `Best ${input.category} Buying Guide featuring ${input.localBrandName}`.slice(0, 300)
    : `${input.localBrandName}${input.category}权威选购指南`.slice(0, 300);
}
