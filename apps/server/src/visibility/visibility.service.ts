import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  CITATION_SOURCE_KINDS,
  QUESTION_TEXT_MAX,
  VISIBILITY_BRAND_NAME_MAX,
  VISIBILITY_MAX_COMPETITORS,
  classifyCitationSource,
  computeAvgPosition,
  computeVisibilityPct,
  escapeLikeLiteral,
  isCitationSourceKind,
  isVisibilityEngine,
  isVisibilitySentiment,
  normalizeQuestionKey,
  normalizeVisibilityDomain,
  recomputeRunMetrics,
  toShanghaiDateKey,
  type CitationSourceKind,
  type CompetitorHit,
  type ImportQuestionsInput,
  type ImportQuestionsResult,
  type ProfileForMetrics,
  type VisibilityCitationListResponse,
  type VisibilityCitationQuery,
  type VisibilityCitationRecord,
  type VisibilityCitationSourceBreakdown,
  type VisibilityCitationSummaryItem,
  type VisibilityCompetitor,
  type VisibilityEngineBreakdownItem,
  type VisibilityEngineKey,
  type VisibilityFanOutItem,
  type VisibilityObservationRecord,
  type VisibilityOpportunitiesQuery,
  type VisibilityOpportunitiesResponse,
  type VisibilityOpportunityGapItem,
  type VisibilityOverviewQuery,
  type VisibilityOverviewResponse,
  type VisibilityProfileCreateWithPrefillInput,
  type VisibilityProfileListResponse,
  type VisibilityProfileRecord,
  type VisibilityProfileUpdateInput,
  type VisibilityRunCreateInput,
  type VisibilityRunDetailRecord,
  type VisibilityRunListQuery,
  type VisibilityRunListResponse,
  type VisibilityRunRecord,
  type VisibilityTrendPoint,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS, isUniqueViolation } from '../billing/billing.sql';
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
  VISIBILITY_RUN_ENQUEUER,
  parseProfileCompetitors,
  type VisibilityRunEnqueuer,
} from './visibility-run.runner';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

export function deriveVisibilityRunId(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}::visibility_run::${idempotencyKey}`)
    .digest('hex')
    .slice(0, 28);
  return `vrun_${digest}`;
}

function dedupeStringsCaseInsensitive(items: readonly string[], excludeLower?: string): string[] {
  const seen = new Set<string>();
  if (excludeLower) seen.add(excludeLower.toLowerCase());
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function normalizeCompetitorsList(
  raw: ReadonlyArray<{
    name: string;
    aliases?: readonly string[];
    domains?: readonly string[];
  }>,
): VisibilityCompetitor[] {
  const seenNames = new Set<string>();
  const out: VisibilityCompetitor[] = [];
  for (const comp of raw) {
    if (out.length >= VISIBILITY_MAX_COMPETITORS) break;
    const name = comp.name.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const aliases = dedupeStringsCaseInsensitive(comp.aliases ?? [], name).slice(0, 20);
    const domainSet = new Set<string>();
    const domains: string[] = [];
    for (const dom of comp.domains ?? []) {
      const normalized = normalizeVisibilityDomain(dom);
      if (normalized && !domainSet.has(normalized)) {
        domainSet.add(normalized);
        domains.push(normalized);
      }
    }
    out.push({ name, aliases, domains: domains.slice(0, 20) });
  }
  return out;
}

function parseStoredCompetitorHits(raw: unknown): CompetitorHit[] {
  if (!Array.isArray(raw)) return [];
  const out: CompetitorHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string') continue;
    out.push({
      name: obj.name,
      mentioned: Boolean(obj.mentioned),
      position:
        typeof obj.position === 'number' && Number.isFinite(obj.position) && obj.position >= 1
          ? obj.position
          : null,
      sentiment:
        typeof obj.sentiment === 'string' && isVisibilitySentiment(obj.sentiment)
          ? obj.sentiment
          : null,
    });
  }
  return out;
}

function shanghaiWindowFromQuery(input: { days: number; from?: string; to?: string; now?: Date }): {
  keys: string[];
  startUtc: Date;
  endUtc: Date;
} {
  const now = input.now ?? new Date();
  if (input.from || input.to) {
    const endUtc = input.to ? new Date(input.to) : now;
    const startUtc = input.from
      ? new Date(input.from)
      : new Date(endUtc.getTime() - Math.max(1, input.days - 1) * DAY_MS);

    const keys: string[] = [];
    const safeStart = startUtc.getTime() <= endUtc.getTime() ? startUtc : endUtc;
    const safeEnd = startUtc.getTime() <= endUtc.getTime() ? endUtc : startUtc;
    const startShifted = new Date(safeStart.getTime() + SHANGHAI_OFFSET_MS);
    const endShifted = new Date(safeEnd.getTime() + SHANGHAI_OFFSET_MS);
    let cursorMs = Date.UTC(
      startShifted.getUTCFullYear(),
      startShifted.getUTCMonth(),
      startShifted.getUTCDate(),
    );
    const lastMs = Date.UTC(
      endShifted.getUTCFullYear(),
      endShifted.getUTCMonth(),
      endShifted.getUTCDate(),
    );
    while (cursorMs <= lastMs && keys.length < 366) {
      const d = new Date(cursorMs);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      keys.push(`${y}-${m}-${day}`);
      cursorMs += DAY_MS;
    }
    return { keys, startUtc: safeStart, endUtc: safeEnd };
  }

  const safeDays = Math.min(365, Math.max(1, Math.floor(input.days)));
  const shiftedNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const todayMidnightShanghaiAsUtcMs =
    Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) -
    SHANGHAI_OFFSET_MS;

  const startUtcMs = todayMidnightShanghaiAsUtcMs - (safeDays - 1) * DAY_MS;
  const endUtcMs = todayMidnightShanghaiAsUtcMs + DAY_MS - 1;

  const keys: string[] = [];
  for (let i = 0; i < safeDays; i += 1) {
    keys.push(toShanghaiDateKey(new Date(startUtcMs + i * DAY_MS)));
  }

  return {
    keys,
    startUtc: new Date(startUtcMs),
    endUtc: new Date(endUtcMs),
  };
}

type LoadedRunRow = Prisma.VisibilityRunGetPayload<{
  include: {
    profile: { select: { id: true; name: true; brandName: true } };
    keyword: { select: { id: true; main: true } };
    observations: {
      select: { status: true; brandMentioned: true };
    };
  };
}>;

@Injectable()
export class VisibilityService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(VISIBILITY_RUN_ENQUEUER) private readonly enqueuer: VisibilityRunEnqueuer,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
  }

  private assertFeatureEnabled(): void {
    if (!this.config.featureEnabled) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'AI可见性监测功能未启用');
    }
  }

  // ===================== Profiles CRUD =====================

  async listProfiles(): Promise<VisibilityProfileListResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const [profiles, keywords, knowledgeBases] = await Promise.all([
      this.prisma.base.visibilityProfile.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          _count: { select: { runs: true } },
        },
      }),
      this.prisma.base.keyword.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { id: true, main: true, brands: true },
      }),
      this.prisma.base.knowledgeBase.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { id: true, name: true, companyName: true, brandShort: true },
      }),
    ]);

    return {
      items: profiles.map((row) => this.presentProfile(row, row._count.runs)),
      prefillSources: {
        keywords,
        knowledgeBases,
      },
    };
  }

  async getProfile(id: string): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const row = await this.prisma.base.visibilityProfile.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { runs: true } } },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }
    return this.presentProfile(row, row._count.runs);
  }

  async createProfile(
    input: VisibilityProfileCreateWithPrefillInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    let resolvedBrandName = (input.brandName ?? '').trim();
    const extraAliases: string[] = [...(input.brandAliases ?? [])];

    if (input.importFromKeywordId) {
      const kw = await this.prisma.base.keyword.findFirst({
        where: { id: input.importFromKeywordId, tenantId },
        select: { id: true, main: true, brands: true },
      });
      if (!kw) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '用于预填的训练主词不存在');
      }
      const cleanBrands = kw.brands.map((b) => b.trim()).filter(Boolean);
      if (!resolvedBrandName && cleanBrands[0]) {
        resolvedBrandName = cleanBrands[0].slice(0, VISIBILITY_BRAND_NAME_MAX);
        extraAliases.push(...cleanBrands.slice(1));
      } else {
        extraAliases.push(...cleanBrands);
      }
    }

    if (input.importFromKbId) {
      const kb = await this.prisma.base.knowledgeBase.findFirst({
        where: { id: input.importFromKbId, tenantId },
        select: { id: true, name: true, companyName: true, brandShort: true },
      });
      if (!kb) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '用于预填的企业知识库不存在');
      }
      const kbTerms = [kb.brandShort, kb.companyName]
        .filter((val): val is string => typeof val === 'string' && val.trim().length > 0)
        .map((val) => val.trim());
      if (!resolvedBrandName && kbTerms[0]) {
        resolvedBrandName = kbTerms[0].slice(0, VISIBILITY_BRAND_NAME_MAX);
        extraAliases.push(...kbTerms.slice(1));
      } else {
        extraAliases.push(...kbTerms);
      }
    }

    if (!resolvedBrandName) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选来源暂无可用品牌词，请直接填写主品牌名称',
      );
    }

    const name = input.name.trim();
    const brandAliases = dedupeStringsCaseInsensitive(extraAliases, resolvedBrandName).slice(0, 20);
    const ownedDomains = [
      ...new Set(
        (input.ownedDomains ?? []).map((dom) => normalizeVisibilityDomain(dom)).filter(Boolean),
      ),
    ].slice(0, 20);
    const competitors = normalizeCompetitorsList(input.competitors ?? []);

    await this.compliance.assertAllowed({
      text: [
        name,
        resolvedBrandName,
        ...brandAliases,
        ...competitors.flatMap((comp) => [comp.name, ...comp.aliases]),
      ].join('\n'),
      action: 'visibility_profile_create',
      tenantId,
      userId,
    });

    const duplicate = await this.prisma.base.visibilityProfile.findFirst({
      where: { tenantId, name },
      select: { id: true },
    });
    if (duplicate) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
    }

    try {
      const created = await this.prisma.base.visibilityProfile.create({
        data: {
          tenantId,
          name,
          brandName: resolvedBrandName,
          brandAliases,
          ownedDomains,
          competitors: competitors as unknown as Prisma.InputJsonValue,
        },
      });
      return this.presentProfile(created, 0);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
      }
      throw error;
    }
  }

  async updateProfile(
    id: string,
    input: VisibilityProfileUpdateInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const existing = await this.prisma.base.visibilityProfile.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { runs: true } } },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextBrandName =
      input.brandName !== undefined ? input.brandName.trim() : existing.brandName;
    const nextAliases =
      input.brandAliases !== undefined
        ? dedupeStringsCaseInsensitive(input.brandAliases, nextBrandName).slice(0, 20)
        : dedupeStringsCaseInsensitive(existing.brandAliases, nextBrandName).slice(0, 20);
    const nextOwnedDomains =
      input.ownedDomains !== undefined
        ? [
            ...new Set(
              input.ownedDomains.map((dom) => normalizeVisibilityDomain(dom)).filter(Boolean),
            ),
          ].slice(0, 20)
        : existing.ownedDomains;
    const nextCompetitors =
      input.competitors !== undefined
        ? normalizeCompetitorsList(input.competitors)
        : parseProfileCompetitors(existing.competitors);

    await this.compliance.assertAllowed({
      text: [
        nextName,
        nextBrandName,
        ...nextAliases,
        ...nextCompetitors.flatMap((comp) => [comp.name, ...comp.aliases]),
      ].join('\n'),
      action: 'visibility_profile_update',
      tenantId,
      userId,
    });

    if (nextName !== existing.name) {
      const duplicate = await this.prisma.base.visibilityProfile.findFirst({
        where: { tenantId, name: nextName, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
      }
    }

    try {
      const updated = await this.prisma.base.visibilityProfile.update({
        where: { id },
        data: {
          name: nextName,
          brandName: nextBrandName,
          brandAliases: nextAliases,
          ownedDomains: nextOwnedDomains,
          competitors: nextCompetitors as unknown as Prisma.InputJsonValue,
        },
      });
      return this.presentProfile(updated, existing._count.runs);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
      }
      throw error;
    }
  }

  async deleteProfile(id: string): Promise<{ deleted: number }> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const existing = await this.prisma.base.visibilityProfile.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }

    const activeRuns = await this.prisma.base.visibilityRun.count({
      where: {
        tenantId,
        profileId: id,
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      },
    });
    if (activeRuns > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '该监测档案下仍有未结束的监测任务，请先终止或等待完成后再删除',
      );
    }

    await this.prisma.base.visibilityProfile.delete({ where: { id } });
    return { deleted: 1 };
  }

  // ===================== Runs CRUD & Control =====================

  async listRuns(query: VisibilityRunListQuery): Promise<VisibilityRunListResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    if (query.profileId) {
      const prof = await this.prisma.base.visibilityProfile.findFirst({
        where: { id: query.profileId, tenantId },
        select: { id: true },
      });
      if (!prof) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
      }
    }

    const where: Prisma.VisibilityRunWhereInput = {
      tenantId,
      ...(query.profileId ? { profileId: query.profileId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.keyword) {
      const pattern = escapeLikeLiteral(query.keyword);
      where.OR = [
        { name: { contains: pattern, mode: 'insensitive' } },
        { profile: { name: { contains: pattern, mode: 'insensitive' } } },
        { profile: { brandName: { contains: pattern, mode: 'insensitive' } } },
        { keyword: { main: { contains: pattern, mode: 'insensitive' } } },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [total, rows] = await Promise.all([
      this.prisma.base.visibilityRun.count({ where }),
      this.prisma.base.visibilityRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
        include: {
          profile: { select: { id: true, name: true, brandName: true } },
          keyword: { select: { id: true, main: true } },
          observations: {
            select: { status: true, brandMentioned: true },
          },
        },
      }),
    ]);

    const items = await this.presentRuns(tenantId, rows);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items,
    };
  }

  async getRunDetail(id: string): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    return this.detailForTenant(tenantId, id);
  }

  async detailForTenant(tenantId: string, id: string): Promise<VisibilityRunDetailRecord> {
    const row = await this.prisma.base.visibilityRun.findFirst({
      where: { id, tenantId },
      include: {
        profile: true,
        keyword: { select: { id: true, main: true } },
        observations: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: {
            citations: {
              orderBy: [{ position: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }

    const [baseRecord] = await this.presentRuns(tenantId, [
      {
        ...row,
        profile: {
          id: row.profile.id,
          name: row.profile.name,
          brandName: row.profile.brandName,
        },
      },
    ]);

    const competitors = parseProfileCompetitors(row.profile.competitors);
    const metrics = recomputeRunMetrics(
      row.observations.map((obs) => ({
        id: obs.id,
        status: obs.status,
        promptText: obs.promptText,
        answerText: obs.answerText,
        brandMentioned: obs.brandMentioned,
        brandPosition: obs.brandPosition,
        brandSentiment: obs.brandSentiment,
        competitorHits: obs.competitorHits,
        citations: obs.citations.map((cite) => ({
          url: cite.url,
          domain: cite.domain,
          sourceKind: cite.sourceKind,
        })),
      })),
      {
        brandName: row.profile.brandName,
        brandAliases: row.profile.brandAliases,
        ownedDomains: row.profile.ownedDomains,
        competitors,
      },
    );

    const observations: VisibilityObservationRecord[] = row.observations.map((obs) => ({
      id: obs.id,
      runId: obs.runId,
      profileId: obs.profileId,
      questionId: obs.questionId,
      promptText: obs.promptText,
      engine: isVisibilityEngine(obs.engine) ? obs.engine : obs.engine,
      status: obs.status,
      collectorKind: obs.collectorKind,
      answerText: obs.answerText,
      brandMentioned: obs.brandMentioned,
      brandPosition: obs.brandPosition,
      brandSentiment:
        obs.brandSentiment && isVisibilitySentiment(obs.brandSentiment) ? obs.brandSentiment : null,
      brandPassage: obs.brandPassage,
      competitorHits: parseStoredCompetitorHits(obs.competitorHits),
      fanOutQueries: obs.fanOutQueries,
      judgeModel: obs.judgeModel,
      tokensIn: obs.tokensIn,
      tokensOut: obs.tokensOut,
      error: obs.error,
      checkedAt: obs.checkedAt ? obs.checkedAt.toISOString() : null,
      createdAt: obs.createdAt.toISOString(),
      citations: obs.citations.map((cite): VisibilityCitationRecord => ({
        id: cite.id,
        url: cite.url,
        domain: cite.domain,
        title: cite.title,
        snippet: cite.snippet,
        sourceKind: isCitationSourceKind(cite.sourceKind) ? cite.sourceKind : 'OTHER',
        position: cite.position,
        createdAt: cite.createdAt.toISOString(),
      })),
    }));

    return {
      ...baseRecord!,
      visibilityPct: metrics.visibilityPct,
      metrics,
      observations,
    };
  }

  async createRun(
    input: VisibilityRunCreateInput,
    idempotencyKey: string,
    userId: string,
  ): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const runId = deriveVisibilityRunId(tenantId, idempotencyKey);

    const engines = [...new Set(input.engines)];
    const requestedQuestionIds = [...new Set(input.questionIds ?? [])];
    const customPrompts = dedupeStringsCaseInsensitive(input.customPrompts ?? []);

    const existing = await this.prisma.base.visibilityRun.findFirst({
      where: { id: runId, tenantId },
      select: { id: true, profileId: true, engines: true, questionIds: true },
    });
    if (existing) {
      if (
        existing.profileId !== input.profileId ||
        existing.engines.join(',') !== engines.join(',') ||
        existing.questionIds.join(',') !== requestedQuestionIds.join(',')
      ) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '幂等键已被不同参数的监测任务占用');
      }
      return this.detailForTenant(tenantId, existing.id);
    }

    const profile = await this.prisma.base.visibilityProfile.findFirst({
      where: { id: input.profileId, tenantId },
      select: { id: true, name: true, brandName: true },
    });
    if (!profile) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选监测档案不存在');
    }

    if (input.keywordId) {
      const keyword = await this.prisma.base.keyword.findFirst({
        where: { id: input.keywordId, tenantId },
        select: { id: true },
      });
      if (!keyword) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选训练主词不存在');
      }
    }

    const promptEntries: Array<{ questionId: string | null; promptText: string }> = [];
    const seenPrompts = new Set<string>();

    if (requestedQuestionIds.length > 0) {
      const questions = await this.prisma.base.question.findMany({
        where: { id: { in: requestedQuestionIds }, tenantId },
        select: { id: true, text: true },
      });
      if (questions.length !== requestedQuestionIds.length) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分所选问题不存在或无权访问');
      }
      const qById = new Map(questions.map((q) => [q.id, q]));
      for (const qId of requestedQuestionIds) {
        const q = qById.get(qId);
        if (!q) continue;
        const cleaned = q.text.replace(/\s+/g, ' ').trim();
        if (!cleaned) continue;
        const lower = cleaned.toLowerCase();
        if (seenPrompts.has(lower)) continue;
        seenPrompts.add(lower);
        promptEntries.push({ questionId: q.id, promptText: cleaned });
      }
    }

    for (const custom of customPrompts) {
      const cleaned = custom.replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (seenPrompts.has(lower)) continue;
      seenPrompts.add(lower);
      promptEntries.push({ questionId: null, promptText: cleaned });
    }

    if (promptEntries.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请至少提供一条有效的监测问题');
    }

    const runName = (
      input.name?.trim() || `${profile.brandName}-可见性监测-${toShanghaiDateKey(new Date())}`
    ).slice(0, 80);

    await this.compliance.assertAllowed({
      text: [runName, ...customPrompts].join('\n'),
      action: 'visibility_run_create',
      tenantId,
      userId,
    });

    const unitPrice = await this.billing.unitPrice('visibility_check');
    const totalChecks = promptEntries.length * engines.length;
    const totalPoints = totalChecks * unitPrice;

    const reservation = await this.billing.reserve({
      tenantId,
      refType: 'visibility_run',
      refId: runId,
      amount: totalPoints,
    });

    try {
      await this.prisma.base.$transaction(async (tx) => {
        await tx.visibilityRun.create({
          data: {
            id: runId,
            tenantId,
            profileId: profile.id,
            keywordId: input.keywordId ?? null,
            name: runName,
            engines,
            questionIds: requestedQuestionIds,
            totalChecks,
            doneCount: 0,
            failCount: 0,
            unitPrice,
            reservationId: reservation.id,
            status: 'QUEUED',
          },
        });

        await tx.visibilityObservation.createMany({
          data: promptEntries.flatMap((prompt) =>
            engines.map((engine) => ({
              tenantId,
              runId,
              profileId: profile.id,
              questionId: prompt.questionId,
              promptText: prompt.promptText,
              engine,
              status: 'PENDING' as const,
              collectorKind: this.config.collector,
            })),
          ),
        });
      }, TX_OPTIONS);

      await this.enqueuer.enqueueVisibilityRun({ tenantId, runId });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.detailForTenant(tenantId, runId);
      }
      await this.prisma.base.visibilityRun.deleteMany({ where: { id: runId, tenantId } });
      await this.billing.close({ tenantId, reservationId: reservation.id });
      throw error;
    }

    return this.detailForTenant(tenantId, runId);
  }

  async pauseRun(id: string): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const run = await this.prisma.base.visibilityRun.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!run) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (run.status === 'PAUSED') {
      return this.detailForTenant(tenantId, id);
    }
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '当前任务状态不支持暂停');
    }

    await this.prisma.base.visibilityRun.updateMany({
      where: { id, tenantId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'PAUSED' },
    });
    return this.detailForTenant(tenantId, id);
  }

  async resumeRun(id: string): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const run = await this.prisma.base.visibilityRun.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!run) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (run.status === 'QUEUED' || run.status === 'RUNNING') {
      return this.detailForTenant(tenantId, id);
    }
    if (run.status !== 'PAUSED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅已暂停的监测任务支持继续运行');
    }

    await this.prisma.base.visibilityRun.updateMany({
      where: { id, tenantId, status: 'PAUSED' },
      data: { status: 'QUEUED' },
    });
    await this.enqueuer.enqueueVisibilityRun({ tenantId, runId: id });
    return this.detailForTenant(tenantId, id);
  }

  async cancelRun(id: string): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const run = await this.prisma.base.visibilityRun.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, reservationId: true },
    });
    if (!run) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (run.status === 'CANCELLED') {
      return this.detailForTenant(tenantId, id);
    }
    if (run.status === 'COMPLETED' || run.status === 'PARTIAL' || run.status === 'FAILED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '监测任务已结束，无需终止');
    }

    const now = new Date();
    const runningLeft = await this.prisma.base.$transaction(async (tx) => {
      await tx.visibilityRun.updateMany({
        where: { id, tenantId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        data: { status: 'CANCELLED', finishedAt: now },
      });
      await tx.visibilityObservation.updateMany({
        where: { runId: id, tenantId, status: 'PENDING' },
        data: { status: 'SKIPPED', checkedAt: now },
      });
      return tx.visibilityObservation.count({
        where: { runId: id, tenantId, status: 'RUNNING' },
      });
    }, TX_OPTIONS);

    if (runningLeft === 0) {
      const reservation = run.reservationId
        ? await this.prisma.base.pointReservation.findFirst({
            where: { id: run.reservationId, tenantId },
            select: { id: true, status: true },
          })
        : await this.prisma.base.pointReservation.findFirst({
            where: { tenantId, refType: 'visibility_run', refId: id },
            select: { id: true, status: true },
          });
      if (reservation && reservation.status === 'OPEN') {
        await this.billing.close({ tenantId, reservationId: reservation.id });
      }
    }

    return this.detailForTenant(tenantId, id);
  }

  async bulkDeleteRuns(ids: string[]): Promise<{ deleted: number }> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const activeCount = await this.prisma.base.visibilityRun.count({
      where: {
        tenantId,
        id: { in: ids },
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      },
    });
    if (activeCount > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选任务中包含正在运行或已暂停的任务，请先终止后再删除',
      );
    }

    const result = await this.prisma.base.visibilityRun.deleteMany({
      where: { tenantId, id: { in: ids } },
    });
    return { deleted: result.count };
  }

  // ===================== Analytics: Overview & Citations =====================

  async overview(query: VisibilityOverviewQuery): Promise<VisibilityOverviewResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const { resolvedProfileId, profileForMetrics } = await this.resolveProfileContext(
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

    const metrics = recomputeRunMetrics(
      observations.map((obs) => ({
        id: obs.id,
        status: obs.status,
        promptText: obs.promptText,
        answerText: obs.answerText,
        brandMentioned: obs.brandMentioned,
        brandPosition: obs.brandPosition,
        brandSentiment: obs.brandSentiment,
        competitorHits: obs.competitorHits,
        citations: obs.citations.map((cite) => ({
          url: cite.url,
          domain: cite.domain,
          sourceKind: cite.sourceKind,
        })),
      })),
      profileForMetrics,
    );

    const trend = this.buildDailyTrend(observations, window.keys, query.engine);
    const engineBucket = new Map<
      VisibilityEngineKey,
      { completed: number; mentioned: number; positions: Array<number | null> }
    >();
    for (const obs of observations) {
      if (!isVisibilityEngine(obs.engine)) continue;
      let cell = engineBucket.get(obs.engine);
      if (!cell) {
        cell = { completed: 0, mentioned: 0, positions: [] };
        engineBucket.set(obs.engine, cell);
      }
      cell.completed += 1;
      if (obs.brandMentioned) {
        cell.mentioned += 1;
        cell.positions.push(obs.brandPosition);
      }
    }
    const byEngine: VisibilityEngineBreakdownItem[] = [...engineBucket.entries()]
      .map(([engine, cell]) => ({
        engine,
        completedChecks: cell.completed,
        mentionedChecks: cell.mentioned,
        visibilityPct: computeVisibilityPct(cell.mentioned, cell.completed),
        avgPosition: computeAvgPosition(cell.positions),
      }))
      .sort((a, b) => {
        if (b.visibilityPct !== a.visibilityPct) return b.visibilityPct - a.visibilityPct;
        return b.completedChecks - a.completedChecks;
      });

    return {
      profileId: resolvedProfileId,
      metrics,
      trend,
      byEngine,
    };
  }

  async citations(query: VisibilityCitationQuery): Promise<VisibilityCitationListResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const { profileForMetrics } = await this.resolveProfileContext(tenantId, query.profileId);
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

  async opportunities(
    query: VisibilityOpportunitiesQuery,
  ): Promise<VisibilityOpportunitiesResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    if (query.profileId) {
      await this.resolveProfileContext(tenantId, query.profileId);
    }

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
        questionId: true,
        promptText: true,
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

      if (!obs.brandMentioned && cleanedPrompt) {
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
        if (obs.brandMentioned) {
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
      select: { id: true, main: true },
    });
    if (!keywordRow) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '训练主词不存在');
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

  // ===================== Private Helpers =====================

  private presentProfile(
    row: {
      id: string;
      name: string;
      brandName: string;
      brandAliases: string[];
      ownedDomains: string[];
      competitors: Prisma.JsonValue;
      createdAt: Date;
      updatedAt: Date;
    },
    runCount?: number,
  ): VisibilityProfileRecord {
    return {
      id: row.id,
      name: row.name,
      brandName: row.brandName,
      brandAliases: row.brandAliases,
      ownedDomains: row.ownedDomains,
      competitors: parseProfileCompetitors(row.competitors),
      ...(runCount !== undefined ? { runCount } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async presentRuns(
    tenantId: string,
    rows: LoadedRunRow[],
  ): Promise<VisibilityRunRecord[]> {
    if (rows.length === 0) return [];

    const reservationIds = rows
      .map((r) => r.reservationId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const reservations =
      reservationIds.length > 0
        ? await this.prisma.base.pointReservation.findMany({
            where: { tenantId, id: { in: reservationIds } },
            select: { id: true, frozen: true, settled: true, released: true },
          })
        : [];
    const reservationById = new Map(reservations.map((r) => [r.id, r]));

    return rows.map((row) => {
      const completedObs = row.observations.filter((obs) => obs.status === 'SUCCESS');
      const mentionedObs = completedObs.filter((obs) => obs.brandMentioned);
      const skipCount = row.observations.filter((obs) => obs.status === 'SKIPPED').length;
      const resv = row.reservationId ? reservationById.get(row.reservationId) : undefined;

      return {
        id: row.id,
        profileId: row.profileId,
        profileName: row.profile.name,
        brandName: row.profile.brandName,
        keywordId: row.keywordId,
        keywordMain: row.keyword?.main ?? null,
        name: row.name,
        engines: row.engines.filter((e): e is VisibilityEngineKey => isVisibilityEngine(e)),
        questionIds: row.questionIds,
        totalChecks: row.totalChecks,
        doneCount: row.doneCount,
        failCount: row.failCount,
        skipCount,
        unitPrice: row.unitPrice,
        frozenPoints: resv?.frozen ?? row.totalChecks * row.unitPrice,
        settledPoints: resv?.settled ?? 0,
        releasedPoints: resv?.released ?? 0,
        reservationId: row.reservationId,
        status: row.status,
        lastError: row.lastError,
        visibilityPct: computeVisibilityPct(mentionedObs.length, completedObs.length),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      };
    });
  }

  private async resolveProfileContext(
    tenantId: string,
    profileId?: string,
  ): Promise<{ resolvedProfileId: string | null; profileForMetrics: ProfileForMetrics }> {
    if (profileId) {
      const profile = await this.prisma.base.visibilityProfile.findFirst({
        where: { id: profileId, tenantId },
      });
      if (!profile) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
      }
      return {
        resolvedProfileId: profile.id,
        profileForMetrics: {
          brandName: profile.brandName,
          brandAliases: profile.brandAliases,
          ownedDomains: profile.ownedDomains,
          competitors: parseProfileCompetitors(profile.competitors),
        },
      };
    }

    const profiles = await this.prisma.base.visibilityProfile.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (profiles.length === 0) {
      return {
        resolvedProfileId: null,
        profileForMetrics: {
          brandName: '本品牌',
          brandAliases: [],
          ownedDomains: [],
          competitors: [],
        },
      };
    }

    if (profiles.length === 1) {
      const only = profiles[0]!;
      return {
        resolvedProfileId: only.id,
        profileForMetrics: {
          brandName: only.brandName,
          brandAliases: only.brandAliases,
          ownedDomains: only.ownedDomains,
          competitors: parseProfileCompetitors(only.competitors),
        },
      };
    }

    const primary = profiles[0]!;
    const aliases = dedupeStringsCaseInsensitive(
      profiles.flatMap((p) => [p.brandName, ...p.brandAliases]),
      primary.brandName,
    );
    const ownedDomains = [...new Set(profiles.flatMap((p) => p.ownedDomains))];
    const competitors = normalizeCompetitorsList(
      profiles.flatMap((p) => parseProfileCompetitors(p.competitors)),
    );

    return {
      resolvedProfileId: null,
      profileForMetrics: {
        brandName: primary.brandName,
        brandAliases: aliases,
        ownedDomains,
        competitors,
      },
    };
  }

  private buildDailyTrend(
    observations: ReadonlyArray<{
      engine: string;
      brandMentioned: boolean;
      checkedAt: Date | null;
      createdAt: Date;
    }>,
    dateKeys: readonly string[],
    selectedEngine?: VisibilityEngineKey,
  ): VisibilityTrendPoint[] {
    const allByDate = new Map<string, { completed: number; mentioned: number }>();
    const byEngineDate = new Map<string, Map<string, { completed: number; mentioned: number }>>();

    for (const key of dateKeys) {
      allByDate.set(key, { completed: 0, mentioned: 0 });
    }

    for (const obs of observations) {
      const dateKey = toShanghaiDateKey(obs.checkedAt ?? obs.createdAt);
      const dayAll = allByDate.get(dateKey);
      if (dayAll) {
        dayAll.completed += 1;
        if (obs.brandMentioned) dayAll.mentioned += 1;
      }

      if (isVisibilityEngine(obs.engine)) {
        let engMap = byEngineDate.get(obs.engine);
        if (!engMap) {
          engMap = new Map(dateKeys.map((k) => [k, { completed: 0, mentioned: 0 }]));
          byEngineDate.set(obs.engine, engMap);
        }
        const cell = engMap.get(dateKey);
        if (cell) {
          cell.completed += 1;
          if (obs.brandMentioned) cell.mentioned += 1;
        }
      }
    }

    if (selectedEngine) {
      const engMap = byEngineDate.get(selectedEngine);
      return dateKeys.map((date) => {
        const cell = engMap?.get(date) ?? { completed: 0, mentioned: 0 };
        return {
          date,
          engine: selectedEngine,
          completedChecks: cell.completed,
          mentionedChecks: cell.mentioned,
          visibilityPct: computeVisibilityPct(cell.mentioned, cell.completed),
        };
      });
    }

    const points: VisibilityTrendPoint[] = [];
    for (const date of dateKeys) {
      const cell = allByDate.get(date) ?? { completed: 0, mentioned: 0 };
      points.push({
        date,
        engine: 'all',
        completedChecks: cell.completed,
        mentionedChecks: cell.mentioned,
        visibilityPct: computeVisibilityPct(cell.mentioned, cell.completed),
      });
    }

    for (const [engineKey, engMap] of byEngineDate.entries()) {
      if (!isVisibilityEngine(engineKey)) continue;
      for (const date of dateKeys) {
        const cell = engMap.get(date) ?? { completed: 0, mentioned: 0 };
        points.push({
          date,
          engine: engineKey,
          completedChecks: cell.completed,
          mentionedChecks: cell.mentioned,
          visibilityPct: computeVisibilityPct(cell.mentioned, cell.completed),
        });
      }
    }

    return points;
  }
}

function higherPrioritySourceKind(
  left: CitationSourceKind,
  right: CitationSourceKind,
): CitationSourceKind {
  const order: readonly CitationSourceKind[] = CITATION_SOURCE_KINDS;
  const leftIdx = order.indexOf(left);
  const rightIdx = order.indexOf(right);
  if (leftIdx < 0) return right;
  if (rightIdx < 0) return left;
  return leftIdx <= rightIdx ? left : right;
}
