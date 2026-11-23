import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  VISIBILITY_ENGINE_LABELS,
  escapeLikeLiteral,
  findDisallowedMarketEngines,
  recomputeRunMetrics,
  toShanghaiDateKey,
  type GeoMarket,
  type ParsedVisibilityRunV2CreateInput,
  type VisibilityObservationRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunListResponse,
  type VisibilityRunRecord,
  type VisibilityTriggerType,
  type VisibilityV2RunListQuery,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS, isUniqueViolation } from '../billing/billing.sql';
import { BrandsService } from '../brands/brands.service';
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

export type VisibilityRunCreateWithSamplingInput = ParsedVisibilityRunV2CreateInput & {
  sampleCount?: 1 | 3;
};

@Injectable()
export class VisibilityRunLifecycleService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
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

  private async resolveRunScope(
    brandId: string,
    market?: GeoMarket,
  ): Promise<{ brandId: string; brandMarketId?: string }> {
    if (market) {
      const resolved = await this.brands.resolveBrandMarket(brandId, market);
      return { brandId: resolved.brand.id, brandMarketId: resolved.market.id };
    }
    const brand = await this.brands.getById(brandId);
    return { brandId: brand.id };
  }

  async listRuns(
    brandId: string,
    query: VisibilityV2RunListQuery,
  ): Promise<VisibilityRunListResponse> {
    this.assertFeatureEnabled();
    requireTenant();

    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);

    const where: Prisma.VisibilityRunWhereInput = {
      brandId: brand.id,
      brandMarketId: market.id,
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
      this.prisma.scoped.visibilityRun.count({ where }),
      this.prisma.scoped.visibilityRun.findMany({
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

    const items = await this.presentRuns(rows);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items,
    };
  }

  async getRunDetail(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    requireTenant();
    const scope = await this.resolveRunScope(brandId, market);
    return this.detailInScope(runId, scope);
  }

  async detailForTenant(
    _tenantId: string,
    runId: string,
    scope?: { brandId?: string; brandMarketId?: string },
  ): Promise<VisibilityRunDetailRecord> {
    return this.detailInScope(runId, scope);
  }

  private async detailInScope(
    runId: string,
    scope?: { brandId?: string; brandMarketId?: string },
  ): Promise<VisibilityRunDetailRecord> {
    const row = await this.prisma.scoped.visibilityRun.findFirst({
      where: {
        id: runId,
        ...(scope?.brandId ? { brandId: scope.brandId } : {}),
        ...(scope?.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
      },
      include: {
        brandMarket: {
          include: {
            brand: {
              select: {
                name: true,
                markets: { select: { ownedDomains: true } },
              },
            },
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

    const [baseRecord] = await this.presentRuns([row]);

    const competitors = parseProfileCompetitors(row.brandMarket.competitors);
    const siblingMarkets =
      (row.brandMarket.brand as { markets?: Array<{ ownedDomains?: string[] }> } | null)?.markets ??
      [];
    const ownedDomains = Array.from(
      new Set([
        ...row.brandMarket.ownedDomains,
        ...siblingMarkets.flatMap((m) => m.ownedDomains ?? []),
      ]),
    );
    const competitorDomains = competitors.flatMap((comp) => comp.domains);

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
        ownedDomains,
        competitors,
      },
    );

    const relevanceCtx = {
      brandName: row.brandMarket.localBrandName,
      brandAliases: row.brandMarket.aliases,
      competitorNames: competitors.map((comp) => comp.name),
    };
    const citationContext = { ownedDomains, competitorDomains };
    const observations: VisibilityObservationRecord[] = row.observations.map((obs) =>
      presentObservationRecord(obs, relevanceCtx, {
        market: row.brandMarket.market,
        citationContext,
      }),
    );

    return {
      ...baseRecord!,
      visibilityPct: metrics.visibilityPct,
      metrics,
      observations,
    };
  }

  async createRun(
    brandId: string,
    input: VisibilityRunCreateWithSamplingInput,
    idempotencyKey: string,
    userId: string,
    queryMarket?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const runId = deriveVisibilityRunId(tenantId, idempotencyKey);

    if (queryMarket && input.market && queryMarket !== input.market) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '查询参数 market 与请求体 market 不一致');
    }
    const effectiveMarket = input.market ?? queryMarket;
    const { brand, market } = await this.brands.resolveBrandMarket(brandId, effectiveMarket);

    const engines = [...new Set(input.engines)];
    const disallowedEngines = findDisallowedMarketEngines(engines, market.market);
    if (disallowedEngines.length > 0) {
      const labels = disallowedEngines.map((key) => VISIBILITY_ENGINE_LABELS[key] ?? key);
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `所选 AI 引擎不属于当前市场（${market.market}）：${labels.join('、')}`,
      );
    }

    const promptList = dedupeStringsCaseInsensitive(input.prompts);
    if (promptList.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请至少提供一条有效的监测问题');
    }

    const rawSampleCount = input.sampleCount ?? 1;
    if (rawSampleCount !== 1 && rawSampleCount !== 3) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '采样次数仅支持 1 次或 3 次');
    }
    const sampleCount: 1 | 3 = rawSampleCount;
    const expectedTotalChecks = promptList.length * engines.length * sampleCount;

    const triggerType: VisibilityTriggerType = input.triggerType ?? 'MANUAL';
    const retestArticleId = input.retestArticleId ?? null;

    const assertMatchingReplay = (row: {
      brandId: string;
      brandMarketId: string;
      engines: string[];
      prompts: string[];
      triggerType: VisibilityTriggerType;
      retestArticleId: string | null;
      totalChecks?: number;
    }) => {
      if (
        row.brandId !== brand.id ||
        row.brandMarketId !== market.id ||
        row.engines.join(',') !== engines.join(',') ||
        row.prompts.join('\n') !== promptList.join('\n') ||
        row.triggerType !== triggerType ||
        (row.retestArticleId ?? null) !== retestArticleId ||
        (typeof row.totalChecks === 'number' && row.totalChecks !== expectedTotalChecks)
      ) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '幂等键已被不同参数的监测任务占用');
      }
    };

    const existing = await this.prisma.scoped.visibilityRun.findFirst({
      where: { id: runId },
      select: {
        id: true,
        brandId: true,
        brandMarketId: true,
        engines: true,
        prompts: true,
        triggerType: true,
        retestArticleId: true,
        totalChecks: true,
      },
    });
    if (existing) {
      assertMatchingReplay(existing);
      return this.detailInScope(existing.id, { brandId: brand.id, brandMarketId: market.id });
    }

    if (retestArticleId) {
      const retestArticle = await this.prisma.scoped.geoArticle.findFirst({
        where: { id: retestArticleId, brandId: brand.id, brandMarketId: market.id },
        select: { id: true },
      });
      if (!retestArticle) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在或不属于当前品牌市场');
      }
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

    const runName = (
      input.name?.trim() || `${market.localBrandName}-可见性监测-${toShanghaiDateKey(new Date())}`
    ).slice(0, 80);

    await this.compliance.assertAllowed({
      text: [runName, ...promptList].join('\n'),
      action: 'visibility_run_create',
      tenantId,
      userId,
    });

    const unitPrice = await this.billing.unitPrice('visibility_check');
    const totalChecks = expectedTotalChecks;
    const totalPoints = totalChecks * unitPrice;

    const reservation = await this.billing.reserve({
      tenantId,
      refType: 'visibility_run',
      refId: runId,
      amount: totalPoints,
    });

    const replayedByReservation = await this.prisma.scoped.visibilityRun.findFirst({
      where: { id: runId },
      select: {
        id: true,
        brandId: true,
        brandMarketId: true,
        engines: true,
        prompts: true,
        triggerType: true,
        retestArticleId: true,
        totalChecks: true,
      },
    });
    if (replayedByReservation) {
      assertMatchingReplay(replayedByReservation);
      return this.detailInScope(replayedByReservation.id, {
        brandId: brand.id,
        brandMarketId: market.id,
      });
    }
    if (reservation.status === 'CLOSED') {
      throw new ApiError(
        409,
        BILLING_ERROR.CONFLICT,
        '该幂等键对应的监测任务已结束，请更换新的 Idempotency-Key 重试',
      );
    }

    try {
      await this.prisma.base.$transaction(async (tx) => {
        await tx.visibilityRun.create({
          data: {
            id: runId,
            tenantId,
            brandId: brand.id,
            brandMarketId: market.id,
            name: runName,
            engines,
            prompts: promptList,
            triggerType,
            retestArticleId,
            totalChecks,
            doneCount: 0,
            failCount: 0,
            unitPrice,
            reservationId: reservation.id,
            status: 'QUEUED',
          },
        });

        const sampleIndices = Array.from({ length: sampleCount }, (_, idx) => idx + 1);
        await tx.visibilityObservation.createMany({
          data: promptList.flatMap((promptText) =>
            engines.flatMap((engine) =>
              sampleIndices.map((sampleIndex) => ({
                tenantId,
                runId,
                brandId: brand.id,
                brandMarketId: market.id,
                promptText,
                engine,
                sampleIndex,
                status: 'PENDING' as const,
                collectorKind: this.config.collector,
              })),
            ),
          ),
        });
      }, TX_OPTIONS);

      await this.enqueuer.enqueueVisibilityRun({ tenantId, runId });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.prisma.scoped.visibilityRun.findFirst({
          where: { id: runId },
          select: {
            id: true,
            brandId: true,
            brandMarketId: true,
            engines: true,
            prompts: true,
            triggerType: true,
            retestArticleId: true,
            totalChecks: true,
          },
        });
        if (!winner) {
          throw error;
        }
        assertMatchingReplay(winner);
        return this.detailInScope(winner.id, { brandId: brand.id, brandMarketId: market.id });
      }
      await this.prisma.scoped.visibilityRun.deleteMany({ where: { id: runId } });
      await this.billing.close({ tenantId, reservationId: reservation.id });
      throw error;
    }

    return this.detailInScope(runId, { brandId: brand.id, brandMarketId: market.id });
  }

  async pauseRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    requireTenant();
    const scope = await this.resolveRunScope(brandId, market);

    const run = await this.prisma.scoped.visibilityRun.findFirst({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
      },
      select: { id: true, status: true },
    });
    if (!run) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (run.status === 'PAUSED') {
      return this.detailInScope(runId, scope);
    }
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '当前任务状态不支持暂停');
    }

    await this.prisma.scoped.visibilityRun.updateMany({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      data: { status: 'PAUSED' },
    });
    return this.detailInScope(runId, scope);
  }

  async resumeRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const scope = await this.resolveRunScope(brandId, market);

    const run = await this.prisma.scoped.visibilityRun.findFirst({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
      },
      select: { id: true, status: true },
    });
    if (!run) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (run.status === 'QUEUED' || run.status === 'RUNNING') {
      return this.detailInScope(runId, scope);
    }
    if (run.status !== 'PAUSED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅已暂停的监测任务支持继续运行');
    }

    await this.prisma.scoped.visibilityRun.updateMany({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
        status: 'PAUSED',
      },
      data: { status: 'QUEUED' },
    });
    await this.enqueuer.enqueueVisibilityRun({ tenantId, runId });
    return this.detailInScope(runId, scope);
  }

  async cancelRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const scope = await this.resolveRunScope(brandId, market);

    const run = await this.prisma.scoped.visibilityRun.findFirst({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
      },
      select: { id: true, status: true, reservationId: true },
    });
    if (!run) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (run.status === 'CANCELLED') {
      return this.detailInScope(runId, scope);
    }
    if (run.status === 'COMPLETED' || run.status === 'PARTIAL' || run.status === 'FAILED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '监测任务已结束，无需终止');
    }

    const now = new Date();
    const runningLeft = await this.prisma.base.$transaction(async (tx) => {
      await tx.visibilityRun.updateMany({
        where: { id: runId, tenantId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        data: { status: 'CANCELLED', finishedAt: now },
      });
      await tx.visibilityObservation.updateMany({
        where: { runId, tenantId, status: 'PENDING' },
        data: { status: 'SKIPPED', checkedAt: now },
      });
      return tx.visibilityObservation.count({
        where: { runId, tenantId, status: 'RUNNING' },
      });
    }, TX_OPTIONS);

    if (runningLeft === 0) {
      const reservation = run.reservationId
        ? await this.prisma.scoped.pointReservation.findFirst({
            where: { id: run.reservationId },
            select: { id: true, status: true },
          })
        : await this.prisma.scoped.pointReservation.findFirst({
            where: { refType: 'visibility_run', refId: runId },
            select: { id: true, status: true },
          });
      if (reservation && reservation.status === 'OPEN') {
        await this.billing.close({ tenantId, reservationId: reservation.id });
      }
    }

    return this.detailInScope(runId, scope);
  }

  async deleteRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<{ deleted: number }> {
    this.assertFeatureEnabled();
    requireTenant();
    const scope = await this.resolveRunScope(brandId, market);

    const existing = await this.prisma.scoped.visibilityRun.findFirst({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
      },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测任务不存在');
    }
    if (
      existing.status === 'QUEUED' ||
      existing.status === 'RUNNING' ||
      existing.status === 'PAUSED'
    ) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选任务中包含排队中、运行中或已暂停的任务，请先终止后再删除',
      );
    }

    const runningObsCount = await this.prisma.scoped.visibilityObservation.count({
      where: {
        runId: existing.id,
        status: 'RUNNING',
      },
    });
    if (runningObsCount > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '存在仍在执行中的监测请求，请等待数秒收尾后再删除',
      );
    }

    const result = await this.prisma.scoped.visibilityRun.deleteMany({
      where: {
        id: runId,
        brandId: scope.brandId,
        ...(scope.brandMarketId ? { brandMarketId: scope.brandMarketId } : {}),
      },
    });
    return { deleted: result.count };
  }

  async bulkDeleteRuns(
    brandId: string,
    ids: string[],
    market?: GeoMarket,
  ): Promise<{ deleted: number }> {
    this.assertFeatureEnabled();
    requireTenant();
    const { brand, market: bm } = await this.brands.resolveBrandMarket(brandId, market);

    const activeCount = await this.prisma.scoped.visibilityRun.count({
      where: {
        brandId: brand.id,
        brandMarketId: bm.id,
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

    const runningObsCount = await this.prisma.scoped.visibilityObservation.count({
      where: {
        brandId: brand.id,
        brandMarketId: bm.id,
        runId: { in: ids },
        status: 'RUNNING',
      },
    });
    if (runningObsCount > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '存在仍在执行中的监测请求，请等待数秒收尾后再删除',
      );
    }

    const result = await this.prisma.scoped.visibilityRun.deleteMany({
      where: { brandId: brand.id, brandMarketId: bm.id, id: { in: ids } },
    });
    return { deleted: result.count };
  }

  async presentRuns(rows: LoadedRunRow[]): Promise<VisibilityRunRecord[]> {
    if (rows.length === 0) return [];

    const reservationIds = rows
      .map((r) => r.reservationId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const reservations =
      reservationIds.length > 0
        ? await this.prisma.scoped.pointReservation.findMany({
            where: { id: { in: reservationIds } },
            select: { id: true, frozen: true, settled: true, released: true },
          })
        : [];
    const reservationById = new Map(reservations.map((r) => [r.id, r]));

    return rows.map((row) =>
      presentRunRecord(row, row.reservationId ? reservationById.get(row.reservationId) : undefined),
    );
  }
}
