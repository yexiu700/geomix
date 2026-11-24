import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_FACT_TOP_K_CHUNKS,
  GEO_BRIEF_ID_PATTERN,
  canonicalizeRewriteUrl,
  classifyCitationSource,
  computeGeoBriefPriorityScore,
  extractArticleFromHtml,
  extractSourceHeadingsFromHtml,
  extractSourceHeadingsFromText,
  matchesDomain,
  normalizeFanOutQueries,
  normalizePastedSource,
  normalizeVisibilityDomain,
  stripHtmlToText,
  targetFormatsForMarket,
  type BrandFactSlot,
  type CitationSourceKind,
  type CreateNearMissBoostBriefInput,
  type GeoBriefGenerateInput,
  type GeoBriefListQuery,
  type GeoBriefListResponse,
  type GeoBriefRecord,
  type GeoBriefUpdateInput,
  type GeoMarket,
  type ParsedGeoBriefFromCitationUrlInput,
} from '@geomix/shared';
import { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readBriefGenerateRateLimit,
  readNearMissBoostRateLimit,
} from '../common/free-action-rate-limiter';
import { PublicFetchService } from '../infra/adapters.module';
import { ComplianceService } from '../infra/compliance';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { UrlPolicyError, assertPublicUrl, parseSsrfAllowlist } from '../infra/ssrf';
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
import { diagnoseNearMissPageHtml, type NearMissPageDiagnosis } from './near-miss-diagnosis';

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

function assertSafePublicBriefUrl(raw: string): { rawUrl: string; canonicalUrl: string } {
  const rawUrl = assertHttpCitationUrl(raw);
  try {
    const parsedPublicUrl = assertPublicUrl(rawUrl, {
      allowlist: parseSsrfAllowlist('', { includeDefaults: false }),
    });
    let host = parsedPublicUrl.hostname.trim().toLowerCase();
    if (!host || host.length > 255) {
      throw new UrlPolicyError('internal_host');
    }
    while (host.endsWith('.')) {
      host = host.slice(0, -1);
    }
    if (
      !host ||
      host.length > 255 ||
      host.startsWith('.') ||
      host.includes('..') ||
      (!host.includes('.') && !host.includes(':'))
    ) {
      throw new UrlPolicyError('internal_host');
    }
  } catch (error) {
    if (error instanceof UrlPolicyError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标地址不允许访问');
    }
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '参考引用链接格式不正确');
  }
  return { rawUrl, canonicalUrl: canonicalizeRewriteUrl(rawUrl) };
}

function mapNonSsrfFetchFallbackReason(error: unknown): string {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case PROVIDER_KIND.TIMEOUT:
        return '目标网页访问超时';
      case PROVIDER_KIND.NOT_PUBLIC:
        return '目标网页需要登录或访问受限';
      case PROVIDER_KIND.ROBOTS:
        return '目标站点 robots.txt 限制抓取';
      case PROVIDER_KIND.CONTRACT:
      case PROVIDER_KIND.TOO_LARGE:
        return '目标网页非标准 HTML 或体积超限';
      case PROVIDER_KIND.UPSTREAM:
      default:
        return '目标网页暂时无法直连抓取';
    }
  }
  return '目标网页暂时无法直连抓取';
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
    @Inject(PublicFetchService) private readonly publicFetch: PublicFetchService,
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
          ...(typeof c.position === 'number' ? { position: c.position } : {}),
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
          ...(typeof c.position === 'number' ? { position: c.position } : {}),
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
            ...(typeof item.position === 'number' ? { position: item.position } : {}),
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
      ownedDomains: market.ownedDomains,
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

  async fromCitationUrl(
    tenantId: string,
    userId: string,
    brandId: string,
    input: ParsedGeoBriefFromCitationUrlInput,
    queryMarket?: GeoMarket,
  ): Promise<GeoBriefRecord> {
    if (queryMarket && input.market && queryMarket !== input.market) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '查询参数与请求体的 market 不一致');
    }

    const { brand, market } = await this.brands.resolveBrandMarket(
      brandId,
      input.market ?? queryMarket,
    );

    const validatedUrl = input.citationUrl ? assertSafePublicBriefUrl(input.citationUrl) : null;
    const rawCitationUrl = validatedUrl?.rawUrl ?? null;
    const citationUrl = validatedUrl?.canonicalUrl ?? null;

    const pastedContent = input.pastedContent?.trim() || null;
    const pastedTitle = input.pastedTitle?.trim() || undefined;
    const explicitPrompt = input.targetPrompt?.trim() || null;

    const userTextForCompliance = [explicitPrompt ?? '', pastedTitle ?? '', pastedContent ?? '']
      .filter(Boolean)
      .join('\n');
    if (userTextForCompliance) {
      await this.compliance.assertAllowed({
        text: userTextForCompliance,
        action: 'geo_brief_counter',
        market: market.market,
        tenantId,
        userId,
      });
    }

    // 免费防刷限流（0 点扣费；放在归属校验、SSRF 语法校验与合规校验之后、远程抓取/LLM 之前）
    this.rateLimiter.assertAllowed('geo_brief', tenantId, readBriefGenerateRateLimit());

    let sourceTitle = '';
    let sourceText = '';
    let sourceHeadings: string[] = [];
    const usedPastedFallback = Boolean(pastedContent);

    if (pastedContent) {
      const normalized = normalizePastedSource({
        pastedTitle,
        pastedContent,
      });
      if (normalized.charCount < 10) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '粘贴参考正文内容过短，请至少提供 20 字有效正文',
        );
      }
      sourceTitle = normalized.title;
      sourceText = normalized.contentText;
      sourceHeadings = extractSourceHeadingsFromText(pastedContent);
    } else if (citationUrl) {
      let page: { url: string; body: string };
      try {
        page = await this.publicFetch.fetch(citationUrl);
      } catch (error) {
        if (error instanceof ProviderError) {
          if (error.kind === PROVIDER_KIND.SSRF) {
            throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标地址不允许访问');
          }
          if (error.kind === PROVIDER_KIND.NOT_PUBLIC && error.reason === 'login_wall') {
            throw new ApiError(
              422,
              API_ERROR.UPSTREAM_UNAVAILABLE,
              '目标网页需要登录或人机验证，无法直接抓取，请改用「粘贴参考正文」继续反制',
            );
          }
          if (error.kind === PROVIDER_KIND.TIMEOUT) {
            throw new ApiError(
              422,
              API_ERROR.UPSTREAM_UNAVAILABLE,
              '目标网页访问超时，请改用「粘贴参考正文」继续反制',
            );
          }
          if (error.kind === PROVIDER_KIND.ROBOTS) {
            throw new ApiError(
              422,
              API_ERROR.UPSTREAM_UNAVAILABLE,
              '目标站点 robots.txt 限制抓取，请改用「粘贴参考正文」继续反制',
            );
          }
          throw new ApiError(
            422,
            API_ERROR.UPSTREAM_UNAVAILABLE,
            '目标网页受反爬限制无法直接抓取，请改用「粘贴参考正文」继续反制',
          );
        }
        throw new ApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '目标网页抓取失败，请改用「粘贴参考正文」继续反制',
        );
      }

      const extracted = extractArticleFromHtml(page.body, page.url);
      const fallbackPlain =
        extracted.charCount < 20 ? stripHtmlToText(page.body).trim() : extracted.contentText;
      const nonWhitespaceCount = Array.from(fallbackPlain.replace(/\s+/g, '')).length;
      if (nonWhitespaceCount < 20) {
        throw new ApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '目标网页正文过短或为动态渲染页，请改用「粘贴参考正文」继续反制',
        );
      }
      sourceTitle = extracted.title;
      sourceText = extracted.charCount >= 20 ? extracted.contentText : fallbackPlain.slice(0, 6000);
      sourceHeadings = extractSourceHeadingsFromHtml(page.body);

      await this.compliance.assertAllowed({
        text: [sourceTitle, sourceText.slice(0, 4000)].filter(Boolean).join('\n'),
        action: 'geo_brief_counter_source',
        market: market.market,
        tenantId,
        userId,
      });
    } else {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请提供目标网页链接或粘贴参考正文');
    }

    let observations: BriefSignalObservation[] = [];
    let extraCitations: BriefSignalCitation[] = [];

    if (citationUrl) {
      const candidateUrls = Array.from(
        new Set([citationUrl, ...(rawCitationUrl ? [rawCitationUrl] : [])]),
      );
      const storedCitations = await this.prisma.scoped.visibilityCitation.findMany({
        where: {
          url: { in: candidateUrls },
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
        extraCitations = storedCitations.map((c) => ({
          url: c.url,
          domain: c.domain,
          title: c.title,
          sourceKind: toCitationSourceKind(c.sourceKind),
          ...(typeof c.position === 'number' ? { position: c.position } : {}),
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
            ...(typeof item.position === 'number' ? { position: item.position } : {}),
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
        const sourceKind = classifyCitationSource(host, {
          ownedDomains: market.ownedDomains,
          competitorDomains: market.competitors.flatMap((c) => c.domains),
        });
        extraCitations = [
          {
            url: citationUrl,
            domain: host,
            title: sourceTitle || explicitPrompt,
            sourceKind: sourceKind === 'OTHER' ? 'COMPETITOR' : sourceKind,
          },
        ];
      }
    }

    const allCitations =
      observations.length > 0 ? observations.flatMap((o) => o.citations) : extraCitations;
    const mergedFanOuts = normalizeFanOutQueries([
      ...observations.flatMap((o) => o.fanOutQueries),
      ...sourceHeadings.slice(0, 6),
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
      customPrompt: explicitPrompt,
      observations,
      fanOutQueries: [],
      citationUrl,
      citationTitle: sourceTitle && sourceTitle !== '未命名源文章' ? sourceTitle : null,
      localBrandName: market.localBrandName || brand.name,
      category: brand.category,
      market: market.market,
    });

    const sourceRunId = observations[0]?.runId ?? null;
    const sourceObservationIds = Array.from(
      new Set(observations.map((o) => o.id).filter(Boolean)),
    ).slice(0, 50);

    const ownedCitationCount = allCitations.filter((c) => c.sourceKind === 'OWNED').length;
    const isCompetitorSource =
      allCitations.some((c) => c.sourceKind === 'COMPETITOR') || Boolean(citationUrl);

    const priorityScore = computeGeoBriefPriorityScore({
      sourceType: 'CITATION_COUNTER',
      competitorEngineHits,
      competitorCount: competitorFocus.length,
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
          sourceTitle,
          ...sourceHeadings.slice(0, 4),
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
      sourceType: 'CITATION_COUNTER',
      priorityScore,
      targetPrompt,
      sourceRunId,
      sourceObservationIds,
      sourceCitationUrl: citationUrl,
      sourceCitationTitle: sourceTitle || null,
      sourceArticleHeadings: sourceHeadings,
      sourceArticleExcerpt: sourceText.slice(0, 4000),
      usedPastedFallback,
      competitorFocus,
      targetFanOuts: mergedFanOuts,
      observations,
      citations: allCitations,
      ownedDomains: market.ownedDomains,
      matchedFacts,
      presentFactSlots,
    };

    const draft = await this.synthesizer.synthesizeSingleBrief(tenantId, synthCtx);

    const created = await this.prisma.scoped.geoBrief.create({
      data: {
        tenantId,
        brandId: brand.id,
        brandMarketId: market.id,
        sourceType: 'CITATION_COUNTER',
        sourceRunId,
        sourceObservationIds,
        sourceCitationUrl: citationUrl,
        targetPrompt,
        priorityScore,
        diagnosisSummary: draft.diagnosisSummary,
        recommendedRecipe: 'CITATION_COUNTER',
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

  async fromNearMiss(
    tenantId: string,
    userId: string,
    brandId: string,
    input: CreateNearMissBoostBriefInput,
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
    for (const id of obsIds) {
      if (!GEO_BRIEF_ID_PATTERN.test(id)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '观测记录编号不合法');
      }
    }

    // Synchronous SSRF pre-check BEFORE rate limiting and remote network fetch
    const validatedUrl = input.sourceUrl ? assertSafePublicBriefUrl(input.sourceUrl) : null;
    const canonicalSourceUrl = validatedUrl?.canonicalUrl ?? null;

    let observations: BriefSignalObservation[] = [];
    if (obsIds.length > 0) {
      const loadedObs = await this.prisma.scoped.visibilityObservation.findMany({
        where: {
          id: { in: obsIds },
          brandId: brand.id,
          brandMarketId: market.id,
        },
        include: {
          citations: { orderBy: { position: 'asc' } },
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
          ...(typeof c.position === 'number' ? { position: c.position } : {}),
        })),
      }));
    }

    const targetPrompt = input.targetPrompt.trim().slice(0, 300);
    const inputSourceTitle = input.sourceTitle?.trim() || null;

    await this.compliance.assertAllowed({
      text: [targetPrompt, inputSourceTitle ?? ''].filter(Boolean).join('\n'),
      action: 'geo_brief_near_miss',
      market: market.market,
      tenantId,
      userId,
    });

    // 免费防刷限流（0 点扣费；放在归属校验、SSRF 语法校验与合规校验之后、远程抓取/LLM 之前）
    this.rateLimiter.assertAllowed('near_miss_boost', tenantId, readNearMissBoostRateLimit());

    const factRows = await this.prisma.scoped.brandFact.findMany({
      where: { brandId: brand.id },
      select: { id: true, slot: true, title: true, content: true },
    });

    const nonEmptyFactRows = factRows.filter(
      (row) => typeof row.content === 'string' && row.content.trim().length > 0,
    );
    const presentFactSlots = new Set<BrandFactSlot>(
      nonEmptyFactRows.map((row) => toBrandFactSlot(row.slot)),
    );

    let diagnosis: NearMissPageDiagnosis;
    if (canonicalSourceUrl) {
      try {
        const page = await this.publicFetch.fetch(canonicalSourceUrl);
        diagnosis = diagnoseNearMissPageHtml({
          rawHtml: page.body,
          pageUrl: page.url,
          brandNames: [brand.name, market.localBrandName, ...(market.aliases ?? [])],
          brandFacts: nonEmptyFactRows.map((row) => ({
            id: row.id ?? '',
            slot: row.slot,
            title: row.title ?? '',
            content: row.content,
          })),
        });
        if (diagnosis.pageTitle || diagnosis.extractedExcerpt) {
          await this.compliance.assertAllowed({
            text: [diagnosis.pageTitle ?? '', diagnosis.extractedExcerpt.slice(0, 4000)]
              .filter(Boolean)
              .join('\n'),
            action: 'geo_brief_near_miss_source',
            market: market.market,
            tenantId,
            userId,
          });
        }
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (error instanceof ProviderError && error.kind === PROVIDER_KIND.SSRF) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标地址不允许访问');
        }
        diagnosis = {
          fetched: false,
          fetchStatus: 'FETCH_FALLBACK',
          fetchFallbackReason: mapNonSsrfFetchFallbackReason(error),
          pageTitle: inputSourceTitle,
          hasDirectAnswer: false,
          hasComparisonTable: false,
          hasFaqSection: false,
          hasStructuredJsonLd: false,
          jsonLdTypes: [],
          brandMentionedOnPage: false,
          coveredFactCount: 0,
          totalFactCount: nonEmptyFactRows.length,
          missingGaps: [
            'MISSING_DIRECT_ANSWER',
            'MISSING_COMPARISON_TABLE',
            'MISSING_FAQ_OR_SCHEMA',
            'LOW_BRAND_FACT_COVERAGE',
          ],
          existingHeadings: [],
          extractedExcerpt: '',
        };
      }
    } else {
      diagnosis = {
        fetched: false,
        fetchStatus: 'SKIPPED_NO_URL',
        pageTitle: inputSourceTitle,
        hasDirectAnswer: false,
        hasComparisonTable: false,
        hasFaqSection: false,
        hasStructuredJsonLd: false,
        jsonLdTypes: [],
        brandMentionedOnPage: false,
        coveredFactCount: 0,
        totalFactCount: nonEmptyFactRows.length,
        missingGaps: [
          'MISSING_DIRECT_ANSWER',
          'MISSING_COMPARISON_TABLE',
          'MISSING_FAQ_OR_SCHEMA',
          'LOW_BRAND_FACT_COVERAGE',
        ],
        existingHeadings: [],
        extractedExcerpt: '',
      };
    }

    const resolvedSourceTitle = inputSourceTitle || diagnosis.pageTitle || null;
    const competitorCounts = new Map<string, number>();
    for (const obs of observations) {
      for (const hit of parseObservationCompetitorHits(obs.competitorHits)) {
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

    const retrievedFacts = await this.factIndexRunner.retrieveRelevantBrandFacts(
      tenantId,
      brand.id,
      [
        cleanPromptForDisplay(targetPrompt),
        resolvedSourceTitle ?? '',
        ...diagnosis.existingHeadings.slice(0, 4),
        ...competitorFocus.slice(0, 3),
      ]
        .filter(Boolean)
        .join(' '),
      BRAND_FACT_TOP_K_CHUNKS,
    );
    const matchedFacts: BriefMatchedFact[] = retrievedFacts.map((item) => ({
      factId: item.factId,
      slot: item.slot,
      title: item.title,
      content: item.content,
    }));

    const sourceHost = canonicalSourceUrl ? normalizeVisibilityDomain(canonicalSourceUrl) : '';
    const ownedDomains = (market.ownedDomains ?? [])
      .map((d) => normalizeVisibilityDomain(d))
      .filter(Boolean);
    const isOwnedUrl =
      Boolean(sourceHost) && ownedDomains.some((owned) => matchesDomain(sourceHost, owned));
    const isOwnedNearMiss = canonicalSourceUrl
      ? isOwnedUrl || input.tier === 'CRAWLED_NOT_CITED'
      : input.tier === 'CRAWLED_NOT_CITED' || input.tier === 'MENTIONED_NOT_OWNED';
    const wasOpened = input.tier === 'OPENED_NOT_CITED';

    const priorityScore = computeGeoBriefPriorityScore({
      sourceType: 'NEAR_MISS_BOOST',
      wasOpened,
      isOwnedNearMiss,
      citationCount: Math.max(observations.length, canonicalSourceUrl ? 1 : 0),
    });

    let allCitations: BriefSignalCitation[] = observations.flatMap((o) => o.citations);
    if (allCitations.length === 0 && canonicalSourceUrl) {
      const host = sourceHost || canonicalSourceUrl;
      const sourceKind = classifyCitationSource(canonicalSourceUrl, {
        ownedDomains,
        competitorDomains: market.competitors.flatMap((c) => c.domains),
      });
      allCitations = [
        {
          url: canonicalSourceUrl,
          domain: host,
          title: resolvedSourceTitle,
          sourceKind,
        },
      ];
    }

    const mergedFanOuts = normalizeFanOutQueries([
      ...observations.flatMap((o) => o.fanOutQueries),
      ...diagnosis.existingHeadings.slice(0, 6),
    ]).slice(0, 20);

    const sourceRunId = observations[0]?.runId ?? null;
    const sourceObservationIds = observations.map((o) => o.id).slice(0, 50);

    const synthCtx: BriefSynthesisContext = {
      market: market.market,
      brandName: brand.name,
      localBrandName: market.localBrandName || brand.name,
      category: brand.category,
      sourceType: 'NEAR_MISS_BOOST',
      priorityScore,
      targetPrompt,
      sourceRunId,
      sourceObservationIds,
      sourceCitationUrl: canonicalSourceUrl,
      sourceCitationTitle: resolvedSourceTitle,
      sourceArticleHeadings: diagnosis.existingHeadings,
      sourceArticleExcerpt: diagnosis.extractedExcerpt.slice(0, 4000),
      competitorFocus,
      targetFanOuts: mergedFanOuts,
      observations,
      citations: allCitations,
      ownedDomains: market.ownedDomains,
      matchedFacts,
      presentFactSlots,
      nearMiss: {
        tier: input.tier,
        diagnosis,
      },
    };

    const draft = await this.synthesizer.synthesizeSingleBrief(tenantId, synthCtx);

    const created = await this.prisma.scoped.geoBrief.create({
      data: {
        tenantId,
        brandId: brand.id,
        brandMarketId: market.id,
        sourceType: 'NEAR_MISS_BOOST',
        sourceRunId,
        sourceObservationIds,
        sourceCitationUrl: canonicalSourceUrl,
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
