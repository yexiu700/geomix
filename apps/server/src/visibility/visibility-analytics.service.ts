import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  VISIBILITY_ENGINE_LABELS,
  classifyCitationSource,
  computeVisibilityPct,
  isEngineAllowedForMarket,
  isVisibilityEngine,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  type CitationSourceKind,
  type GeoMarket,
  type ProfileForMetrics,
  type VisibilityCitationListResponse,
  type VisibilityCitationSourceBreakdown,
  type VisibilityCitationSummaryItem,
  type VisibilityEngineKey,
  type VisibilityFanOutItem,
  type VisibilityOpportunitiesResponse,
  type VisibilityOpportunityGapItem,
  type VisibilityOverviewResponse,
  type VisibilityV2CitationQuery,
  type VisibilityV2OpportunitiesQuery,
  type VisibilityV2OverviewQuery,
} from '@geomix/shared';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import {
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  type VisibilityConfig,
} from './visibility.config';
import {
  buildDailyTrend,
  buildEngineBreakdown,
  computeOverviewMetricsAndGroups,
  higherPrioritySourceKind,
  isEffectiveBrandMention,
  parseProfileCompetitors,
  parseStoredCompetitorHits,
  shanghaiWindowFromQuery,
  type OverviewProfileContext,
} from './visibility.mapper';

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

function normalizePromptKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertMarketEngine(engine: VisibilityEngineKey | undefined, market: GeoMarket): void {
  if (!engine) return;
  if (!isEngineAllowedForMarket(engine, market)) {
    const label = VISIBILITY_ENGINE_LABELS[engine] ?? engine;
    throw new ApiError(
      400,
      API_ERROR.BAD_REQUEST,
      `AI 引擎「${label}」不属于当前市场（${market}）`,
    );
  }
}

function buildSingleMarketOverviewContext(market: {
  id: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
}): OverviewProfileContext {
  const competitors = parseProfileCompetitors(market.competitors);
  const profileForMetrics: ProfileForMetrics = {
    brandName: market.localBrandName,
    brandAliases: market.aliases,
    ownedDomains: market.ownedDomains,
    competitors,
  };
  return {
    resolvedProfileId: market.id,
    profilesById: new Map([[market.id, profileForMetrics]]),
    brandEntries: [
      {
        brandName: market.localBrandName,
        profileIds: [market.id],
        profileForMetrics,
      },
    ],
    fallbackProfileForMetrics: profileForMetrics,
  };
}

@Injectable()
export class VisibilityAnalyticsService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
  }

  private assertFeatureEnabled(): void {
    if (!this.config.featureEnabled) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'AI可见性监测功能未启用');
    }
  }

  private async resolveBrandOwnedDomains(
    brandId: string,
    currentDomains: readonly string[],
  ): Promise<string[]> {
    const findMany = this.prisma.scoped.brandMarket?.findMany;
    if (typeof findMany !== 'function') {
      return Array.from(new Set(currentDomains));
    }
    const markets = await findMany({
      where: { brandId },
      select: { ownedDomains: true },
    });
    return Array.from(
      new Set([...currentDomains, ...markets.flatMap((m) => m.ownedDomains ?? [])]),
    );
  }

  async overview(
    brandId: string,
    query: VisibilityV2OverviewQuery,
  ): Promise<VisibilityOverviewResponse> {
    this.assertFeatureEnabled();
    requireTenant();

    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);
    assertMarketEngine(query.engine, market.market);

    const ownedDomains = await this.resolveBrandOwnedDomains(brand.id, market.ownedDomains ?? []);
    const overviewCtx = buildSingleMarketOverviewContext({
      ...market,
      ownedDomains,
    });
    const window = shanghaiWindowFromQuery({
      days: query.days,
      from: query.from,
      to: query.to,
    });

    const observations = await this.prisma.scoped.visibilityObservation.findMany({
      where: {
        brandId: brand.id,
        brandMarketId: market.id,
        status: 'SUCCESS',
        ...(query.engine ? { engine: query.engine } : {}),
        OR: [
          { checkedAt: { gte: window.startUtc, lte: window.endUtc } },
          { checkedAt: null, createdAt: { gte: window.startUtc, lte: window.endUtc } },
        ],
      },
      orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
      include: {
        citations: {
          orderBy: { position: 'asc' },
        },
      },
    });

    const { metrics, brandGroups } = computeOverviewMetricsAndGroups(observations, overviewCtx);
    const trend = buildDailyTrend(observations, window.keys, overviewCtx, query.engine);
    const byEngine = buildEngineBreakdown(observations, overviewCtx);

    return {
      profileId: market.id,
      brandId: brand.id,
      brandMarketId: market.id,
      market: market.market,
      metrics,
      trend,
      byEngine,
      brandGroups,
    };
  }

  async listCitations(
    brandId: string,
    query: VisibilityV2CitationQuery,
  ): Promise<VisibilityCitationListResponse> {
    this.assertFeatureEnabled();
    requireTenant();

    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);
    assertMarketEngine(query.engine, market.market);

    const competitors = parseProfileCompetitors(market.competitors);
    const ownedDomains = await this.resolveBrandOwnedDomains(brand.id, market.ownedDomains ?? []);
    const competitorDomains = competitors.flatMap((comp) => comp.domains ?? []);

    const window = shanghaiWindowFromQuery({
      days: query.days,
      from: query.from,
      to: query.to,
    });

    const rows = await this.prisma.scoped.visibilityCitation.findMany({
      where: {
        observation: {
          brandId: brand.id,
          brandMarketId: market.id,
          status: 'SUCCESS',
          ...(query.engine ? { engine: query.engine } : {}),
          OR: [
            { checkedAt: { gte: window.startUtc, lte: window.endUtc } },
            { checkedAt: null, createdAt: { gte: window.startUtc, lte: window.endUtc } },
          ],
        },
      },
      include: {
        observation: {
          select: {
            id: true,
            promptText: true,
          },
        },
      },
    });

    const sourceBreakdown: VisibilityCitationSourceBreakdown = {
      OWNED: 0,
      COMPETITOR: 0,
      AUTHORITY: 0,
      SOCIAL: 0,
      ECOMMERCE: 0,
      OTHER: 0,
    };

    const domainAgg = new Map<
      string,
      {
        sourceKind: CitationSourceKind;
        citationCount: number;
        questionKeys: Set<string>;
        urls: Map<string, { url: string; title: string | null; count: number }>;
      }
    >();

    let filteredCitationsCount = 0;

    for (const row of rows) {
      const domain = normalizeVisibilityDomain(row.domain || row.url);
      if (!domain) continue;

      // Always reclassify dynamically against live BrandMarket owned/competitor domains (T3-21).
      const resolvedKind: CitationSourceKind = classifyCitationSource(row.url || domain, {
        ownedDomains,
        competitorDomains,
      });

      sourceBreakdown[resolvedKind] += 1;

      if (query.sourceKind && resolvedKind !== query.sourceKind) {
        continue;
      }

      filteredCitationsCount += 1;
      const promptKey = `p:${normalizePromptKey(row.observation.promptText)}`;

      let bucket = domainAgg.get(domain);
      if (!bucket) {
        bucket = {
          sourceKind: resolvedKind,
          citationCount: 0,
          questionKeys: new Set<string>(),
          urls: new Map(),
        };
        domainAgg.set(domain, bucket);
      } else {
        bucket.sourceKind = higherPrioritySourceKind(bucket.sourceKind, resolvedKind);
      }

      bucket.citationCount += 1;
      bucket.questionKeys.add(promptKey);

      const urlEntry = bucket.urls.get(row.url);
      if (urlEntry) {
        urlEntry.count += 1;
        if (!urlEntry.title && row.title) {
          urlEntry.title = row.title;
        }
      } else {
        bucket.urls.set(row.url, {
          url: row.url,
          title: row.title ?? null,
          count: 1,
        });
      }
    }

    const allItems: VisibilityCitationSummaryItem[] = [...domainAgg.entries()]
      .map(([domain, bucket]) => ({
        domain,
        sourceKind: bucket.sourceKind,
        citationCount: bucket.citationCount,
        questionCount: bucket.questionKeys.size,
        topUrls: [...bucket.urls.values()]
          .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.url.localeCompare(b.url)))
          .slice(0, 10),
      }))
      .sort((left, right) => {
        if (right.citationCount !== left.citationCount) {
          return right.citationCount - left.citationCount;
        }
        if (right.questionCount !== left.questionCount) {
          return right.questionCount - left.questionCount;
        }
        return left.domain.localeCompare(right.domain);
      });

    const start = (query.page - 1) * query.pageSize;
    const paged = allItems.slice(start, start + query.pageSize);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total: allItems.length,
      totalCitations: filteredCitationsCount,
      sourceBreakdown,
      items: paged,
    };
  }

  async citations(
    brandId: string,
    query: VisibilityV2CitationQuery,
  ): Promise<VisibilityCitationListResponse> {
    return this.listCitations(brandId, query);
  }

  async opportunities(
    brandId: string,
    query: VisibilityV2OpportunitiesQuery,
  ): Promise<VisibilityOpportunitiesResponse> {
    this.assertFeatureEnabled();
    requireTenant();

    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);
    assertMarketEngine(query.engine, market.market);

    const overviewCtx = buildSingleMarketOverviewContext(market);
    const window = shanghaiWindowFromQuery({
      days: query.days,
      from: query.from,
      to: query.to,
    });

    const observations = await this.prisma.scoped.visibilityObservation.findMany({
      where: {
        brandId: brand.id,
        brandMarketId: market.id,
        status: 'SUCCESS',
        ...(query.engine ? { engine: query.engine } : {}),
        OR: [
          { checkedAt: { gte: window.startUtc, lte: window.endUtc } },
          { checkedAt: null, createdAt: { gte: window.startUtc, lte: window.endUtc } },
        ],
      },
      orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        brandMarketId: true,
        promptText: true,
        answerText: true,
        engine: true,
        brandMentioned: true,
        competitorHits: true,
        fanOutQueries: true,
        checkedAt: true,
        createdAt: true,
      },
    });

    const gapMap = new Map<
      string,
      {
        promptText: string;
        competitors: Set<string>;
        engines: Set<VisibilityEngineKey>;
        observationCount: number;
        latestCheckedAtMs: number;
      }
    >();

    const fanOutMap = new Map<
      string,
      {
        query: string;
        frequency: number;
        mentionedCount: number;
        sourcePrompts: Set<string>;
        engines: Set<VisibilityEngineKey>;
      }
    >();

    for (const obs of observations) {
      const cleanedPrompt = obs.promptText.replace(/\s+/g, ' ').trim();
      const engineKey = isVisibilityEngine(obs.engine) ? obs.engine : null;
      const obsTimeMs = (obs.checkedAt ?? obs.createdAt).getTime();
      const profCtx =
        overviewCtx.profilesById.get(obs.brandMarketId) ?? overviewCtx.fallbackProfileForMetrics;
      const effectiveBrandMentioned = isEffectiveBrandMention(obs, {
        brandName: profCtx.brandName,
        brandAliases: profCtx.brandAliases,
        competitorNames: (profCtx.competitors ?? []).map((c) => c.name),
      });

      if (!effectiveBrandMentioned && cleanedPrompt) {
        const hits = parseStoredCompetitorHits(obs.competitorHits);
        const mentionedComps = hits.filter((h) => h.mentioned).map((h) => h.name);
        if (mentionedComps.length > 0) {
          const promptKey = normalizePromptKey(cleanedPrompt);
          if (promptKey) {
            let bucket = gapMap.get(promptKey);
            if (!bucket) {
              bucket = {
                promptText: cleanedPrompt,
                competitors: new Set<string>(),
                engines: new Set<VisibilityEngineKey>(),
                observationCount: 0,
                latestCheckedAtMs: obsTimeMs,
              };
              gapMap.set(promptKey, bucket);
            } else if (obsTimeMs > bucket.latestCheckedAtMs) {
              bucket.latestCheckedAtMs = obsTimeMs;
            }
            for (const comp of mentionedComps) {
              bucket.competitors.add(comp);
            }
            if (engineKey) {
              bucket.engines.add(engineKey);
            }
            bucket.observationCount += 1;
          }
        }
      }

      // Always normalize & deduplicate fanOutQueries on read (F10 Fix 1).
      const normalizedQueries = normalizeFanOutQueries(obs.fanOutQueries ?? [], obs.promptText);
      for (const cleanedQuery of normalizedQueries) {
        const qKey = cleanedQuery.toLowerCase();

        let bucket = fanOutMap.get(qKey);
        if (!bucket) {
          bucket = {
            query: cleanedQuery,
            frequency: 0,
            mentionedCount: 0,
            sourcePrompts: new Set<string>(),
            engines: new Set<VisibilityEngineKey>(),
          };
          fanOutMap.set(qKey, bucket);
        }
        bucket.frequency += 1;
        if (effectiveBrandMentioned) {
          bucket.mentionedCount += 1;
        }
        if (cleanedPrompt && bucket.sourcePrompts.size < 3) {
          bucket.sourcePrompts.add(cleanedPrompt);
        }
        if (engineKey) {
          bucket.engines.add(engineKey);
        }
      }
    }

    const gaps: VisibilityOpportunityGapItem[] = [...gapMap.values()]
      .map((bucket) => ({
        promptText: bucket.promptText,
        questionId: null,
        competitors: [...bucket.competitors],
        engines: [...bucket.engines],
        observationCount: bucket.observationCount,
        latestCheckedAt: new Date(bucket.latestCheckedAtMs).toISOString(),
      }))
      .sort((left, right) => {
        if (right.competitors.length !== left.competitors.length) {
          return right.competitors.length - left.competitors.length;
        }
        if (right.observationCount !== left.observationCount) {
          return right.observationCount - left.observationCount;
        }
        return left.promptText.localeCompare(right.promptText, 'zh-CN');
      })
      .slice(0, query.limit);

    const fanOutQueries: VisibilityFanOutItem[] = [...fanOutMap.values()]
      .map((bucket) => ({
        query: bucket.query,
        frequency: bucket.frequency,
        sourcePrompts: [...bucket.sourcePrompts],
        engines: [...bucket.engines],
        brandMentionedPct: computeVisibilityPct(bucket.mentionedCount, bucket.frequency),
      }))
      .sort((left, right) => {
        if (right.frequency !== left.frequency) {
          return right.frequency - left.frequency;
        }
        return left.query.localeCompare(right.query, 'zh-CN');
      })
      .slice(0, query.limit);

    return { gaps, fanOutQueries };
  }
}
