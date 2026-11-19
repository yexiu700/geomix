import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  escapeLikeLiteral,
  matchesVisibilityProfileKeyword,
  recomputeRunMetrics,
  toShanghaiDateKey,
  type VisibilityObservationRecord,
  type VisibilityRunCreateInput,
  type VisibilityRunDetailRecord,
  type VisibilityRunListQuery,
  type VisibilityRunListResponse,
  type VisibilityRunRecord,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS, isUniqueViolation } from '../billing/billing.sql';
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
  dedupeStringsCaseInsensitive,
  deriveVisibilityRunId,
  parseProfileCompetitors,
  presentObservationRecord,
  presentRunRecord,
} from './visibility.mapper';
import { VISIBILITY_RUN_ENQUEUER, type VisibilityRunEnqueuer } from './visibility-run.runner';

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

export type LoadedRunRow = Prisma.VisibilityRunGetPayload<{
  include: {
    profile: {
      select: { id: true; name: true; brandName: true; brandAliases: true; competitors: true };
    };
    keyword: { select: { id: true; main: true } };
    observations: {
      select: { status: true; brandMentioned: true; promptText: true; answerText: true };
    };
  };
}>;

@Injectable()
export class VisibilityRunLifecycleService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
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
          profile: {
            select: {
              id: true,
              name: true,
              brandName: true,
              brandAliases: true,
              competitors: true,
            },
          },
          keyword: { select: { id: true, main: true } },
          observations: {
            select: { status: true, brandMentioned: true, promptText: true, answerText: true },
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
          brandAliases: row.profile.brandAliases,
          competitors: row.profile.competitors,
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

    const relevanceCtx = {
      brandName: row.profile.brandName,
      brandAliases: row.profile.brandAliases,
      competitorNames: competitors.map((comp) => comp.name),
    };
    const observations: VisibilityObservationRecord[] = row.observations.map((obs) =>
      presentObservationRecord(obs, relevanceCtx),
    );

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
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选监测档案不存在');
    }

    const profileKeywordTarget = {
      id: profile.id,
      name: profile.name,
      brandName: profile.brandName,
      brandAliases: profile.brandAliases,
      ownedDomains: profile.ownedDomains,
      competitors: parseProfileCompetitors(profile.competitors),
    };

    if (input.keywordId) {
      const keyword = await this.prisma.base.keyword.findFirst({
        where: { id: input.keywordId, tenantId },
        select: { id: true, main: true, brands: true },
      });
      if (!keyword) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选训练主词不存在');
      }
      if (
        keyword.brands.some((b) => b.trim().length > 0) &&
        !matchesVisibilityProfileKeyword(keyword, profileKeywordTarget)
      ) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '所选训练主词不属于当前监测档案品牌，请重新选择或改填自定义问题',
        );
      }
    }

    const promptEntries: Array<{ questionId: string | null; promptText: string }> = [];
    const seenPrompts = new Set<string>();

    if (requestedQuestionIds.length > 0) {
      const questions = await this.prisma.base.question.findMany({
        where: { id: { in: requestedQuestionIds }, tenantId },
        select: { id: true, text: true, keywordId: true },
      });
      if (questions.length !== requestedQuestionIds.length) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分所选问题不存在或无权访问');
      }
      if (input.keywordId && questions.some((q) => q.keywordId !== input.keywordId)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '所选监测问题不属于当前关联训练主词');
      }
      if (!input.keywordId) {
        const distinctKeywordIds = [
          ...new Set(
            questions.map((q) => q.keywordId).filter((kid): kid is string => Boolean(kid)),
          ),
        ];
        const questionKeywords = await Promise.all(
          distinctKeywordIds.map((kid) =>
            this.prisma.base.keyword.findFirst({
              where: { id: kid, tenantId },
              select: { id: true, main: true, brands: true },
            }),
          ),
        );
        for (const qKw of questionKeywords) {
          if (
            qKw &&
            qKw.brands.some((b) => b.trim().length > 0) &&
            !matchesVisibilityProfileKeyword(qKw, profileKeywordTarget)
          ) {
            throw new ApiError(
              400,
              API_ERROR.BAD_REQUEST,
              '所选监测问题所属主词与当前监测档案品牌不匹配',
            );
          }
        }
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

  async presentRuns(tenantId: string, rows: LoadedRunRow[]): Promise<VisibilityRunRecord[]> {
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

    return rows.map((row) =>
      presentRunRecord(row, row.reservationId ? reservationById.get(row.reservationId) : undefined),
    );
  }
}
