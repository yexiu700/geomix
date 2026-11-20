import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  VISIBILITY_ENGINE_LABELS,
  escapeLikeLiteral,
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
import { VisibilityEngineHealthService } from './visibility-engine-health.service';
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
    brandMarket: {
      select: {
        id: true;
        market: true;
        localBrandName: true;
        aliases: true;
        competitors: true;
        brand: { select: { name: true } };
      };
    };
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
    @Optional()
    @Inject(VisibilityEngineHealthService)
    private readonly engineHealth?: VisibilityEngineHealthService,
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
      const bm = await this.prisma.base.brandMarket.findFirst({
        where: { id: query.profileId, tenantId },
        select: { id: true },
      });
      if (!bm) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
      }
    }

    const where: Prisma.VisibilityRunWhereInput = {
      tenantId,
      ...(query.profileId ? { brandMarketId: query.profileId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.keyword) {
      const pattern = escapeLikeLiteral(query.keyword);
      where.OR = [
        { name: { contains: pattern, mode: 'insensitive' } },
        { brand: { name: { contains: pattern, mode: 'insensitive' } } },
        { brandMarket: { localBrandName: { contains: pattern, mode: 'insensitive' } } },
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
          brandMarket: {
            select: {
              id: true,
              market: true,
              localBrandName: true,
              aliases: true,
              competitors: true,
              brand: { select: { name: true } },
            },
          },
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
        brandMarket: {
          include: {
            brand: { select: { name: true } },
          },
        },
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

    const [baseRecord] = await this.presentRuns(tenantId, [row]);

    const competitors = parseProfileCompetitors(row.brandMarket.competitors);
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
        brandName: row.brandMarket.localBrandName,
        brandAliases: row.brandMarket.aliases,
        ownedDomains: row.brandMarket.ownedDomains,
        competitors,
      },
    );

    const relevanceCtx = {
      brandName: row.brandMarket.localBrandName,
      brandAliases: row.brandMarket.aliases,
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
    const customPrompts = dedupeStringsCaseInsensitive(input.customPrompts ?? []);

    const existing = await this.prisma.base.visibilityRun.findFirst({
      where: { id: runId, tenantId },
      select: { id: true, brandMarketId: true, engines: true, prompts: true },
    });
    if (existing) {
      if (
        existing.brandMarketId !== input.profileId ||
        existing.engines.join(',') !== engines.join(',') ||
        existing.prompts.join('\n') !== customPrompts.join('\n')
      ) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '幂等键已被不同参数的监测任务占用');
      }
      return this.detailForTenant(tenantId, existing.id);
    }

    if (this.engineHealth) {
      const offlineEngines = await this.engineHealth.getUnavailableEngines(engines);
      if (offlineEngines.length > 0) {
        const labels = offlineEngines.map((key) => VISIBILITY_ENGINE_LABELS[key] ?? key);
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          `以下 AI 引擎暂未上线：${labels.join('、')}，请取消勾选后重试`,
        );
      }
    }

    const brandMarket = await this.prisma.base.brandMarket.findFirst({
      where: { id: input.profileId, tenantId },
      select: {
        id: true,
        brandId: true,
        localBrandName: true,
        aliases: true,
        ownedDomains: true,
        competitors: true,
      },
    });
    if (!brandMarket) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选监测档案不存在');
    }

    const promptList: string[] = [];
    const seenPrompts = new Set<string>();
    for (const custom of customPrompts) {
      const cleaned = custom.replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (seenPrompts.has(lower)) continue;
      seenPrompts.add(lower);
      promptList.push(cleaned);
    }

    if (promptList.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请至少提供一条有效的监测问题');
    }

    const runName = (
      input.name?.trim() ||
      `${brandMarket.localBrandName}-可见性监测-${toShanghaiDateKey(new Date())}`
    ).slice(0, 80);

    await this.compliance.assertAllowed({
      text: [runName, ...promptList].join('\n'),
      action: 'visibility_run_create',
      tenantId,
      userId,
    });

    const unitPrice = await this.billing.unitPrice('visibility_check');
    const totalChecks = promptList.length * engines.length;
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
            brandId: brandMarket.brandId,
            brandMarketId: brandMarket.id,
            name: runName,
            engines,
            prompts: promptList,
            totalChecks,
            doneCount: 0,
            failCount: 0,
            unitPrice,
            reservationId: reservation.id,
            status: 'QUEUED',
          },
        });

        await tx.visibilityObservation.createMany({
          data: promptList.flatMap((promptText) =>
            engines.map((engine) => ({
              tenantId,
              runId,
              brandId: brandMarket.brandId,
              brandMarketId: brandMarket.id,
              promptText,
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
        '所选任务中包含排队中、运行中或已暂停的任务，请先终止后再删除',
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
