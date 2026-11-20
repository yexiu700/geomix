import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  classifyCitationSource,
  computeVisibilityPct,
  isCitationSourceKind,
  isVisibilityEngine,
  normalizeVisibilityDomain,
  type CitationSourceKind,
  type ImportQuestionsInput,
  type ImportQuestionsResult,
  type VisibilityCitationListResponse,
  type VisibilityCitationQuery,
  type VisibilityCitationSourceBreakdown,
  type VisibilityCitationSummaryItem,
  type VisibilityEngineKey,
  type VisibilityFanOutItem,
  type VisibilityOpportunitiesQuery,
  type VisibilityOpportunitiesResponse,
  type VisibilityOpportunityGapItem,
  type VisibilityOverviewQuery,
  type VisibilityOverviewResponse,
} from '@geomix/shared';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
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
  parseStoredCompetitorHits,
  shanghaiWindowFromQuery,
} from './visibility.mapper';
import { VisibilityProfileService } from './visibility-profile.service';

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

@Injectable()
export class VisibilityAnalyticsService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly _quota: QuotaService,
    @Inject(ComplianceService) private readonly _compliance: ComplianceService,
    @Inject(VisibilityProfileService) private readonly profileService: VisibilityProfileService,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
  }

  private assertFeatureEnabled(): void {
    if (!this.config.featureEnabled) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'AI可见性监测功能未启用');
    }
  }

  async overview(query: VisibilityOverviewQuery): Promise<VisibilityOverviewResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const overviewCtx = await this.profileService.loadOverviewProfileContexts(
      tenantId,
      query.profileId,
    );
    const window = shanghaiWindowFromQuery({
      days: query.days,
      from: query.from,
      to: query.to,
    });

    const observations = await this.prisma.base.visibilityObservation.findMany({
      where: {
        tenantId,
        status: 'SUCCESS',
        ...(query.profileId ? { brandMarketId: query.profileId } : {}),
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
      profileId: overviewCtx.resolvedProfileId,
      brandMarketId: overviewCtx.resolvedProfileId,
      metrics,
      trend,
      byEngine,
      brandGroups,
    };
  }

  async listCitations(query: VisibilityCitationQuery): Promise<VisibilityCitationListResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const { profileForMetrics } = await this.profileService.resolveProfileContext(
      tenantId,
      query.profileId,
    );
    const ownedDomains = profileForMetrics.ownedDomains ?? [];
    const competitorDomains = (profileForMetrics.competitors ?? []).flatMap(
      (comp) => comp.domains ?? [],
    );

    const window = shanghaiWindowFromQuery({
      days: query.days,
      from: query.from,
      to: query.to,
    });

    const rows = await this.prisma.base.visibilityCitation.findMany({
      where: {
        tenantId,
        observation: {
          tenantId,
          status: 'SUCCESS',
          ...(query.profileId ? { brandMarketId: query.profileId } : {}),
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

      const resolvedKind: CitationSourceKind = isCitationSourceKind(row.sourceKind)
        ? row.sourceKind
        : classifyCitationSource(row.url || domain, { ownedDomains, competitorDomains });

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

  async citations(query: VisibilityCitationQuery): Promise<VisibilityCitationListResponse> {
    return this.listCitations(query);
  }

  async opportunities(
    query: VisibilityOpportunitiesQuery,
  ): Promise<VisibilityOpportunitiesResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const overviewCtx = await this.profileService.loadOverviewProfileContexts(
      tenantId,
      query.profileId,
    );

    const window = shanghaiWindowFromQuery({
      days: query.days,
      from: query.from,
      to: query.to,
    });

    const observations = await this.prisma.base.visibilityObservation.findMany({
      where: {
        tenantId,
        status: 'SUCCESS',
        ...(query.profileId ? { brandMarketId: query.profileId } : {}),
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

      for (const rawQuery of obs.fanOutQueries ?? []) {
        if (typeof rawQuery !== 'string') continue;
        const cleanedQuery = rawQuery.replace(/\s+/g, ' ').trim();
        if (!cleanedQuery) continue;
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

  async importOpportunityQuestions(
    _input: ImportQuestionsInput,
    _userId: string,
  ): Promise<ImportQuestionsResult> {
    this.assertFeatureEnabled();
    requireTenant();
    throw new ApiError(410, API_ERROR.BAD_REQUEST, '旧版问题库已下线，请直接使用 GEO 写作意见卡');
  }
}
