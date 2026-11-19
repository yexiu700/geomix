import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  QUESTION_TEXT_MAX,
  classifyCitationSource,
  computeVisibilityPct,
  isCitationSourceKind,
  isVisibilityEngine,
  matchesVisibilityProfileKeyword,
  normalizeQuestionKey,
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
import { TX_OPTIONS } from '../billing/billing.sql';
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
  parseProfileCompetitors,
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

@Injectable()
export class VisibilityAnalyticsService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
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
        ...(query.profileId ? { profileId: query.profileId } : {}),
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
          ...(query.profileId ? { profileId: query.profileId } : {}),
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
            questionId: true,
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
      const questionKey = row.observation.questionId
        ? `q:${row.observation.questionId}`
        : `p:${row.observation.promptText.replace(/\s+/g, ' ').trim().toLowerCase()}`;

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
      bucket.questionKeys.add(questionKey);

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
        ...(query.profileId ? { profileId: query.profileId } : {}),
        ...(query.engine ? { engine: query.engine } : {}),
        OR: [
          { checkedAt: { gte: window.startUtc, lte: window.endUtc } },
          { checkedAt: null, createdAt: { gte: window.startUtc, lte: window.endUtc } },
        ],
      },
      orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        profileId: true,
        questionId: true,
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
        questionId: string | null;
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
        overviewCtx.profilesById.get(obs.profileId) ?? overviewCtx.fallbackProfileForMetrics;
      const effectiveBrandMentioned = isEffectiveBrandMention(obs, {
        brandName: profCtx.brandName,
        brandAliases: profCtx.brandAliases,
        competitorNames: (profCtx.competitors ?? []).map((c) => c.name),
      });

      if (!effectiveBrandMentioned && cleanedPrompt) {
        const hits = parseStoredCompetitorHits(obs.competitorHits);
        const mentionedComps = hits.filter((h) => h.mentioned).map((h) => h.name);
        if (mentionedComps.length > 0) {
          const promptKey = normalizeQuestionKey(cleanedPrompt);
          if (promptKey) {
            let bucket = gapMap.get(promptKey);
            if (!bucket) {
              bucket = {
                promptText: cleanedPrompt,
                questionId: obs.questionId ?? null,
                competitors: new Set<string>(),
                engines: new Set<VisibilityEngineKey>(),
                observationCount: 0,
                latestCheckedAtMs: obsTimeMs,
              };
              gapMap.set(promptKey, bucket);
            } else {
              if (!bucket.questionId && obs.questionId) {
                bucket.questionId = obs.questionId;
              }
              if (obsTimeMs > bucket.latestCheckedAtMs) {
                bucket.latestCheckedAtMs = obsTimeMs;
              }
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
        questionId: bucket.questionId,
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
    input: ImportQuestionsInput,
    userId: string,
  ): Promise<ImportQuestionsResult> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const keywordRow = await this.prisma.base.keyword.findFirst({
      where: { id: input.keywordId, tenantId },
      select: { id: true, main: true, brands: true },
    });
    if (!keywordRow) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '训练主词不存在');
    }

    if (input.profileId) {
      const profile = await this.prisma.base.visibilityProfile.findFirst({
        where: { id: input.profileId, tenantId },
        select: {
          id: true,
          name: true,
          brandName: true,
          brandAliases: true,
          ownedDomains: true,
          competitors: true,
        },
      });
      if (!profile) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
      }
      if (
        keywordRow.brands.some((b) => b.trim().length > 0) &&
        !matchesVisibilityProfileKeyword(keywordRow, {
          id: profile.id,
          name: profile.name,
          brandName: profile.brandName,
          brandAliases: profile.brandAliases,
          ownedDomains: profile.ownedDomains,
          competitors: parseProfileCompetitors(profile.competitors),
        })
      ) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '所选目标主词不属于当前监测档案品牌，请先切换档案或选择同品牌主词',
        );
      }
    }

    const seenInput = new Set<string>();
    const uniqueTitles: string[] = [];
    let duplicateInInputCount = 0;

    for (const rawTitle of input.titles) {
      const cleaned = rawTitle.replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      if (cleaned.length > QUESTION_TEXT_MAX) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          `导入标题长度超过 ${QUESTION_TEXT_MAX} 个字符`,
        );
      }
      const key = normalizeQuestionKey(cleaned);
      if (!key) continue;
      if (seenInput.has(key)) {
        duplicateInInputCount += 1;
        continue;
      }
      seenInput.add(key);
      uniqueTitles.push(cleaned);
    }

    if (uniqueTitles.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请至少选择一条有效的待导入标题');
    }

    await this.compliance.assertAllowed({
      text: uniqueTitles.join('\n'),
      action: 'visibility_gap_import',
      tenantId,
      userId,
    });

    return this.prisma.base.$transaction(async (tx) => {
      const existing = await tx.question.findMany({
        where: { tenantId, keywordId: keywordRow.id },
        select: { text: true },
      });
      const existingKeys = new Set(existing.map((q) => normalizeQuestionKey(q.text)));

      const toInsert: string[] = [];
      let existingDupCount = 0;
      for (const title of uniqueTitles) {
        const key = normalizeQuestionKey(title);
        if (existingKeys.has(key)) {
          existingDupCount += 1;
          continue;
        }
        existingKeys.add(key);
        toInsert.push(title);
      }

      const skippedCount = duplicateInInputCount + existingDupCount;
      if (toInsert.length === 0) {
        return {
          insertedCount: 0,
          skippedCount,
          keywordId: keywordRow.id,
        };
      }

      const quotaRow = await tx.quota.findUnique({
        where: { tenantId_key: { tenantId, key: 'QUESTION' } },
      });
      if (quotaRow && quotaRow.used + BigInt(toInsert.length) > quotaRow.limit) {
        const remaining = Math.max(0, Number(quotaRow.limit - quotaRow.used));
        throw new ApiError(
          409,
          API_ERROR.QUOTA_EXCEEDED,
          `问题额度不足，当前还可添加 ${remaining} 条`,
        );
      }

      await this.quota.consume(tenantId, 'QUESTION', toInsert.length, tx);

      for (const text of toInsert) {
        await tx.question.create({
          data: {
            tenantId,
            keywordId: keywordRow.id,
            text,
            source: 'AI',
            included: false,
          },
        });
      }

      return {
        insertedCount: toInsert.length,
        skippedCount,
        keywordId: keywordRow.id,
      };
    }, TX_OPTIONS);
  }
}
