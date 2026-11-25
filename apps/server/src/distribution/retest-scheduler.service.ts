import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_DEFAULT_RETEST_CONTROL_PROMPTS,
  DEFAULT_RETEST_MILESTONE_DAYS,
  shanghaiCurrentMonthWindowUtc,
  type GeoMarket,
  type GeoRetestControlMetricsSnapshot,
  type GeoRetestScheduleDto,
  type RetestBudgetSummaryDto,
  type RetestSampleCount,
  type RetestScheduleConfigInput,
  type VisibilityRunDetailRecord,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  RetestMetricsHookService,
  computeControlMetricsSnapshot,
  computeRetestMetricSnapshot,
  computeScheduleMetricsSnapshot,
  findBaselineControlObservations,
  normalizeRetestPromptKey,
  partitionRetestObservations,
  type RetestBrandMarketLike,
  type RetestObservationLike,
  type VisibilityObservationFinder,
} from '../studio/retest-metrics-hook.service';
import {
  normalizeRetestMetricSnapshot,
  presentRetestSchedule,
  type GeoRetestScheduleRow,
} from '../studio/studio.mapper';
import { runInTenant } from '../tenant/tenant-context';
import {
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  type VisibilityConfig,
} from '../visibility/visibility.config';
import { deriveVisibilityRunId } from '../visibility/visibility.mapper';
import { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import {
  VisibilityRunLifecycleService,
  type VisibilityRunCreateWithSamplingInput,
} from '../visibility/visibility-run-lifecycle.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_BATCH_SIZE = 20;
const MAX_SWEEP_BATCH_SIZE = 100;
const STALE_RUNNING_ORPHAN_MS = 10 * 60 * 1000;
const STALE_COMPLETED_RECONCILE_GRACE_MS = 2 * 60 * 1000;

export const retestBudgetEstimateQuerySchema = z.object({
  sampleCount: z.coerce
    .number()
    .int()
    .refine((v): v is 1 | 3 => v === 1 || v === 3, '采样次数仅支持 1 或 3')
    .optional(),
  includeControlPrompts: z
    .preprocess((v) => {
      if (v === 'true' || v === true) return true;
      if (v === 'false' || v === false) return false;
      return v;
    }, z.boolean())
    .optional(),
  milestones: z
    .preprocess(
      (v) => {
        if (typeof v === 'string') {
          return v.split(',').map((s) => {
            const trimmed = s.trim();
            return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
          });
        }
        return v;
      },
      z.array(z.number().int().min(1).max(365)).min(1).max(6),
    )
    .optional(),
});

export type RetestBudgetEstimateQueryInput = z.input<typeof retestBudgetEstimateQuerySchema>;
export type ParsedRetestBudgetEstimateQuery = z.output<typeof retestBudgetEstimateQuerySchema>;

export type RetestBudgetEstimateDto = {
  publishRecordId: string;
  market: GeoMarket;
  targetPromptCount: number;
  configuredControlPromptCount: number;
  effectiveControlPromptCount: number;
  selectedControlPrompts: string[];
  totalPromptCount: number;
  activeEngineCount: number;
  sampleCount: RetestSampleCount;
  includeControlPrompts: boolean;
  unitPrice: number;
  perRunPoints: number;
  pendingMilestoneCount: number;
  totalEstimatedPoints: number;
  billingMode: 'SHADOW' | 'STRICT';
  walletAvailable: number;
  sufficientForNextRun: boolean;
  sufficientForAllPending: boolean;
};

export type RetestScheduleTargetRecord = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  publishedAt: Date;
};

export type AutoRetestConfigInput = {
  enabled?: boolean;
  milestones?: readonly number[];
  sampleCount?: 1 | 3;
  includeControlPrompts?: boolean;
};

export type RetestSweepOptions = {
  now?: Date;
  batchSize?: number;
};

export type RetestSweepReport = {
  scanned: number;
  claimed: number;
  triggered: number;
  skippedInsufficientPoints: number;
  skippedBudgetCap: number;
  skippedNoEngine: number;
  skippedInactiveTenant: number;
  failed: number;
};

/**
 * 统计指定品牌市场在当前 Asia/Shanghai 自然月内的自动复测预算消耗与超限跳过次数（100% 走 prisma.scoped）：
 * - 已完成（COMPLETED/PARTIAL）定时复测：优先累加 PointLog(status='SETTLED').listPrice（兼容 SHADOW 模式，与计费模式解耦），
 *   缺失日志时退回按 (doneCount || totalChecks) * unitPrice 估算；
 * - 执行中/排队中（RUNNING/QUEUED）定时复测：按 totalChecks * unitPrice 计入在途预算，避免同批次并发击穿上限；
 * - 失败/取消（FAILED/CANCELLED）计 0 点。
 */
export async function computeMonthlyRetestBudgetUsage(
  scopedPrisma: PrismaService['scoped'],
  params: {
    brandId: string;
    brandMarketId: string;
    capPoints: number | null;
    now?: Date;
    excludeScheduleId?: string;
    inSweepRuns?: ReadonlyArray<{
      scheduleId: string;
      runId: string;
      estimatedPoints: number;
    }>;
  },
): Promise<RetestBudgetSummaryDto> {
  const { monthKey, startUtc, endUtc } = shanghaiCurrentMonthWindowUtc(params.now ?? new Date());
  const capPoints =
    typeof params.capPoints === 'number' &&
    Number.isInteger(params.capPoints) &&
    params.capPoints > 0
      ? params.capPoints
      : null;

  const scheduleDelegate = (
    scopedPrisma as unknown as {
      geoRetestSchedule?: {
        findMany?: (args: unknown) => Promise<
          Array<{
            id: string;
            status: string;
            visibilityRunId: string | null;
            executedAt: Date | null;
            updatedAt: Date;
          }>
        >;
      };
    }
  ).geoRetestSchedule;

  if (typeof scheduleDelegate?.findMany !== 'function') {
    return {
      monthKey,
      capPoints,
      usedPoints: 0,
      remainingPoints: capPoints,
      skippedCount: 0,
    };
  }

  const rows = await scheduleDelegate.findMany({
    where: {
      brandId: params.brandId,
      brandMarketId: params.brandMarketId,
      ...(params.excludeScheduleId ? { id: { not: params.excludeScheduleId } } : {}),
      status: { in: ['RUNNING', 'COMPLETED', 'SKIPPED_BUDGET_CAP'] },
      OR: [
        { executedAt: { gte: startUtc, lt: endUtc } },
        { executedAt: null, updatedAt: { gte: startUtc, lt: endUtc } },
      ],
    },
    select: {
      id: true,
      status: true,
      visibilityRunId: true,
      executedAt: true,
      updatedAt: true,
    },
  });

  const startMs = startUtc.getTime();
  const endMs = endUtc.getTime();
  let skippedCount = 0;
  const runIdSet = new Set<string>();

  for (const row of rows) {
    if (params.excludeScheduleId && row.id === params.excludeScheduleId) {
      continue;
    }
    const ts = row.executedAt ?? row.updatedAt;
    if (!(ts instanceof Date) || ts.getTime() < startMs || ts.getTime() >= endMs) {
      continue;
    }
    if (row.status === 'SKIPPED_BUDGET_CAP') {
      skippedCount += 1;
      continue;
    }
    if (
      (row.status === 'COMPLETED' || row.status === 'RUNNING') &&
      typeof row.visibilityRunId === 'string' &&
      row.visibilityRunId.length > 0
    ) {
      runIdSet.add(row.visibilityRunId);
    }
  }

  let usedPoints = 0;
  const runIds = [...runIdSet];
  const runDelegate = (
    scopedPrisma as unknown as {
      visibilityRun?: {
        findMany?: (args: unknown) => Promise<
          Array<{
            id: string;
            status: string;
            reservationId: string | null;
            totalChecks: number;
            doneCount: number;
            unitPrice: number;
          }>
        >;
      };
    }
  ).visibilityRun;

  const seenDbRunIds = new Set<string>();
  if (runIds.length > 0 && typeof runDelegate?.findMany === 'function') {
    const runs = await runDelegate.findMany({
      where: {
        id: { in: runIds },
        brandId: params.brandId,
        brandMarketId: params.brandMarketId,
      },
      select: {
        id: true,
        status: true,
        reservationId: true,
        totalChecks: true,
        doneCount: true,
        unitPrice: true,
      },
    });

    const finishedReservationIds = [
      ...new Set(
        runs
          .filter(
            (r) =>
              (r.status === 'COMPLETED' || r.status === 'PARTIAL') &&
              typeof r.reservationId === 'string' &&
              r.reservationId.length > 0,
          )
          .map((r) => r.reservationId as string),
      ),
    ];

    const settledListPriceByResId = new Map<string, number>();
    const pointLogDelegate = (
      scopedPrisma as unknown as {
        pointLog?: {
          findMany?: (args: unknown) => Promise<
            Array<{
              reservationId: string | null;
              listPrice: number;
            }>
          >;
        };
      }
    ).pointLog;

    if (finishedReservationIds.length > 0 && typeof pointLogDelegate?.findMany === 'function') {
      const logs = await pointLogDelegate.findMany({
        where: {
          reservationId: { in: finishedReservationIds },
          status: 'SETTLED',
        },
        select: {
          reservationId: true,
          listPrice: true,
        },
      });
      for (const log of logs) {
        if (!log.reservationId) continue;
        settledListPriceByResId.set(
          log.reservationId,
          (settledListPriceByResId.get(log.reservationId) ?? 0) + Math.max(0, log.listPrice),
        );
      }
    }

    for (const run of runs) {
      seenDbRunIds.add(run.id);
      if (run.status === 'COMPLETED' || run.status === 'PARTIAL') {
        if (run.reservationId && settledListPriceByResId.has(run.reservationId)) {
          usedPoints += settledListPriceByResId.get(run.reservationId)!;
        } else {
          const checks = run.doneCount > 0 ? run.doneCount : run.totalChecks;
          usedPoints += Math.max(0, checks * run.unitPrice);
        }
      } else if (run.status === 'QUEUED' || run.status === 'RUNNING') {
        usedPoints += Math.max(0, run.totalChecks * run.unitPrice);
      }
    }
  }

  for (const entry of params.inSweepRuns ?? []) {
    if (params.excludeScheduleId && entry.scheduleId === params.excludeScheduleId) {
      continue;
    }
    if (seenDbRunIds.has(entry.runId)) {
      continue;
    }
    seenDbRunIds.add(entry.runId);
    usedPoints += Math.max(0, entry.estimatedPoints);
  }

  return {
    monthKey,
    capPoints,
    usedPoints,
    remainingPoints: capPoints !== null ? Math.max(0, capPoints - usedPoints) : null,
    skippedCount,
  };
}

export interface RetestRunCreator {
  createRun(
    brandId: string,
    input: VisibilityRunCreateWithSamplingInput,
    idempotencyKey: string,
    userId: string,
    queryMarket?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord>;
}

function normalizeMilestoneDays(raw: readonly number[] | undefined): number[] {
  const source = raw ?? DEFAULT_RETEST_MILESTONE_DAYS;
  return [...new Set(source.filter((d) => Number.isInteger(d) && d >= 1 && d <= 365))].sort(
    (a, b) => a - b,
  );
}

function safeSkipReason(error: unknown): string {
  if (error instanceof ApiError && error.message.trim()) {
    return error.message.trim().slice(0, 200);
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 200);
  }
  return '定时复测触发失败，请稍后重试';
}

export function selectRetestControlPrompts(
  targetPrompt: string,
  rawControlPrompts: readonly string[] | null | undefined,
  includeControlPrompts: boolean,
  maxCount: number = BRAND_DEFAULT_RETEST_CONTROL_PROMPTS,
): string[] {
  if (
    !includeControlPrompts ||
    !Number.isFinite(maxCount) ||
    maxCount <= 0 ||
    !Array.isArray(rawControlPrompts) ||
    rawControlPrompts.length === 0
  ) {
    return [];
  }
  const targetKey = normalizeRetestPromptKey(targetPrompt);
  const seen = new Set<string>(targetKey ? [targetKey] : []);
  const selected: string[] = [];
  for (const raw of rawControlPrompts) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().slice(0, 300);
    if (trimmed.length < 2) continue;
    const key = normalizeRetestPromptKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(trimmed);
    if (selected.length >= maxCount) break;
  }
  return selected;
}

export function computeRetestEstimatedPoints(params: {
  targetPromptCount: number;
  controlPromptCount: number;
  activeEngineCount: number;
  sampleCount: RetestSampleCount;
  unitPrice: number;
}): number {
  const prompts =
    Math.max(0, Math.floor(params.targetPromptCount)) +
    Math.max(0, Math.floor(params.controlPromptCount));
  const engines = Math.max(0, Math.floor(params.activeEngineCount));
  const samples = params.sampleCount === 3 ? 3 : 1;
  const price = Math.max(0, Math.floor(params.unitPrice));
  return prompts * engines * samples * price;
}

/**
 * 幂等创建指定发布记录的定时复测计划（默认 T+7/14/30，sampleCount=1，includeControlPrompts=false）。
 * 供 RetestSchedulerService 与 GeoDeliveryService 复用，避免模块间循环依赖。
 */
export async function ensureRetestSchedulesForPublishRecord(
  scopedPrisma: PrismaService['scoped'],
  record: RetestScheduleTargetRecord,
  autoRetestConfig?: AutoRetestConfigInput,
): Promise<GeoRetestScheduleDto[]> {
  if (autoRetestConfig?.enabled === false) {
    return [];
  }

  const milestones = normalizeMilestoneDays(autoRetestConfig?.milestones);
  if (milestones.length === 0) {
    return [];
  }

  const delegate = (
    scopedPrisma as unknown as {
      geoRetestSchedule?: {
        createMany?: (args: {
          data: Array<{
            tenantId: string;
            brandId: string;
            brandMarketId: string;
            publishRecordId: string;
            milestoneDay: number;
            sampleCount: number;
            includeControlPrompts: boolean;
            dueAt: Date;
            status: 'PENDING';
          }>;
          skipDuplicates: boolean;
        }) => Promise<{ count: number }>;
        findMany?: (args: {
          where: { publishRecordId: string };
          orderBy: Array<{ milestoneDay?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
        }) => Promise<GeoRetestScheduleRow[]>;
      };
    }
  ).geoRetestSchedule;

  if (typeof delegate?.createMany !== 'function' || typeof delegate?.findMany !== 'function') {
    return [];
  }

  const sampleCount: RetestSampleCount = autoRetestConfig?.sampleCount === 3 ? 3 : 1;
  const includeControlPrompts = Boolean(autoRetestConfig?.includeControlPrompts);

  await delegate.createMany({
    data: milestones.map((milestoneDay) => ({
      tenantId: record.tenantId,
      brandId: record.brandId,
      brandMarketId: record.brandMarketId,
      publishRecordId: record.id,
      milestoneDay,
      sampleCount,
      includeControlPrompts,
      dueAt: new Date(record.publishedAt.getTime() + milestoneDay * DAY_MS),
      status: 'PENDING' as const,
    })),
    skipDuplicates: true,
  });

  const rows = await delegate.findMany({
    where: { publishRecordId: record.id },
    orderBy: [{ milestoneDay: 'asc' }, { id: 'asc' }],
  });

  return rows.map(presentRetestSchedule);
}

/**
 * T+7/14/30 定时复测调度服务（Issue #352）：
 * - 默认按发布时间创建 T+7/14/30（sampleCount=1）复测节点，支持 1/3 采样与节点启停调整
 * - 后台 Sweep 仅使用 1 次 prisma.base.geoRetestSchedule.findMany 扫描到期节点，
 *   所有状态认领与写操作均在 runInTenant(tenantId) 中通过 prisma.scoped 完成
 * - 严格按 STRICT/SHADOW 计费规则校验点数余额，余额不足时安全标记 SKIPPED_INSUFFICIENT_POINTS（绝不透支）
 */
@Injectable()
export class RetestSchedulerService {
  private readonly logger = new Logger(RetestSchedulerService.name);
  private readonly visibilityConfig: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Optional()
    @Inject(VisibilityEngineHealthService)
    private readonly engineHealth?: VisibilityEngineHealthService,
    @Optional()
    @Inject(VisibilityRunLifecycleService)
    private readonly runLifecycle?: RetestRunCreator,
    @Optional()
    @Inject(VISIBILITY_CONFIG)
    visibilityConfig?: VisibilityConfig,
    @Optional()
    @Inject(RetestMetricsHookService)
    private readonly retestMetricsHook?: RetestMetricsHookService,
  ) {
    this.visibilityConfig = visibilityConfig ?? readVisibilityConfig(process.env);
  }

  async ensureSchedulesForPublishRecord(
    record: RetestScheduleTargetRecord,
    autoRetestConfig?: AutoRetestConfigInput,
  ): Promise<GeoRetestScheduleDto[]> {
    return ensureRetestSchedulesForPublishRecord(this.prisma.scoped, record, autoRetestConfig);
  }

  async updateSchedulesForPublishRecord(
    publishRecordId: string,
    input: RetestScheduleConfigInput,
  ): Promise<GeoRetestScheduleDto[]> {
    const record = await this.prisma.scoped.geoPublishRecord.findFirst({
      where: { id: publishRecordId },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        brandMarketId: true,
        publishedAt: true,
      },
    });
    if (!record) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '发布记录不存在');
    }

    const existing = await this.prisma.scoped.geoRetestSchedule.findMany({
      where: { publishRecordId: record.id },
      orderBy: [{ milestoneDay: 'asc' }, { id: 'asc' }],
    });

    const activePending = existing.find((s) => s.status === 'PENDING');
    const cancelSet = new Set(input.cancelMilestoneDays ?? []);
    const requestedMilestonesSet =
      input.milestones !== undefined
        ? new Set(normalizeMilestoneDays(input.milestones).filter((day) => !cancelSet.has(day)))
        : null;
    const fallbackSchedule =
      activePending ??
      (requestedMilestonesSet
        ? existing.find(
            (s) => s.status === 'CANCELLED' && requestedMilestonesSet.has(s.milestoneDay),
          )
        : undefined) ??
      existing.find((s) => s.status === 'CANCELLED') ??
      existing[0];
    const effectiveSampleCount: RetestSampleCount =
      input.sampleCount ?? (fallbackSchedule?.sampleCount === 3 ? 3 : 1);
    const effectiveIncludeControlPrompts: boolean =
      input.includeControlPrompts ??
      Boolean(
        (fallbackSchedule as { includeControlPrompts?: boolean } | undefined)
          ?.includeControlPrompts,
      );

    if (input.enabled === false) {
      await this.prisma.scoped.geoRetestSchedule.updateMany({
        where: { publishRecordId: record.id, status: 'PENDING' },
        data: { status: 'CANCELLED', skipReason: '用户已暂停自动复测' },
      });
    } else {
      if (cancelSet.size > 0) {
        await this.prisma.scoped.geoRetestSchedule.updateMany({
          where: {
            publishRecordId: record.id,
            milestoneDay: { in: [...cancelSet] },
            status: 'PENDING',
          },
          data: { status: 'CANCELLED', skipReason: '用户已取消该节点复测' },
        });
      }

      if (input.milestones !== undefined || input.enabled === true) {
        const baseMilestones =
          input.milestones !== undefined
            ? normalizeMilestoneDays(input.milestones)
            : existing.length > 0
              ? normalizeMilestoneDays(existing.map((s) => s.milestoneDay))
              : [...DEFAULT_RETEST_MILESTONE_DAYS];

        const targetMilestones = baseMilestones.filter((day) => !cancelSet.has(day));
        const targetSet = new Set(targetMilestones);

        if (input.milestones !== undefined) {
          const toCancel = existing
            .filter((s) => s.status === 'PENDING' && !targetSet.has(s.milestoneDay))
            .map((s) => s.milestoneDay);
          if (toCancel.length > 0) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: {
                publishRecordId: record.id,
                milestoneDay: { in: toCancel },
                status: 'PENDING',
              },
              data: { status: 'CANCELLED', skipReason: '用户已调整复测节点' },
            });
          }
        }

        const existingByDay = new Map(existing.map((s) => [s.milestoneDay, s]));
        const toReactivate = targetMilestones.filter(
          (day) => existingByDay.get(day)?.status === 'CANCELLED',
        );
        if (toReactivate.length > 0) {
          await this.prisma.scoped.geoRetestSchedule.updateMany({
            where: {
              publishRecordId: record.id,
              milestoneDay: { in: toReactivate },
              status: 'CANCELLED',
            },
            data: {
              status: 'PENDING',
              skipReason: null,
              ...(input.sampleCount !== undefined || activePending
                ? { sampleCount: effectiveSampleCount }
                : {}),
              ...(input.includeControlPrompts !== undefined || activePending
                ? { includeControlPrompts: effectiveIncludeControlPrompts }
                : {}),
            },
          });
        }

        const missingDays = targetMilestones.filter((day) => !existingByDay.has(day));
        if (missingDays.length > 0) {
          await this.prisma.scoped.geoRetestSchedule.createMany({
            data: missingDays.map((milestoneDay) => ({
              tenantId: record.tenantId,
              brandId: record.brandId,
              brandMarketId: record.brandMarketId,
              publishRecordId: record.id,
              milestoneDay,
              sampleCount: effectiveSampleCount,
              includeControlPrompts: effectiveIncludeControlPrompts,
              dueAt: new Date(record.publishedAt.getTime() + milestoneDay * DAY_MS),
              status: 'PENDING' as const,
            })),
            skipDuplicates: true,
          });
        }
      }

      if (input.sampleCount !== undefined) {
        await this.prisma.scoped.geoRetestSchedule.updateMany({
          where: { publishRecordId: record.id, status: 'PENDING' },
          data: { sampleCount: input.sampleCount },
        });
      }

      if (input.includeControlPrompts !== undefined) {
        await this.prisma.scoped.geoRetestSchedule.updateMany({
          where: { publishRecordId: record.id, status: 'PENDING' },
          data: { includeControlPrompts: input.includeControlPrompts },
        });
      }
    }

    const updated = await this.prisma.scoped.geoRetestSchedule.findMany({
      where: { publishRecordId: record.id },
      orderBy: [{ milestoneDay: 'asc' }, { id: 'asc' }],
    });

    return updated.map(presentRetestSchedule);
  }

  async estimateBudgetForPublishRecord(
    publishRecordId: string,
    tenantId: string,
    query?: ParsedRetestBudgetEstimateQuery,
  ): Promise<RetestBudgetEstimateDto> {
    const record = await this.prisma.scoped.geoPublishRecord.findFirst({
      where: { id: publishRecordId },
      include: {
        article: {
          select: {
            title: true,
            targetPrompt: true,
          },
        },
        brandMarket: {
          select: {
            market: true,
            localBrandName: true,
            controlPrompts: true,
          },
        },
        retestSchedules: {
          where: { status: 'PENDING' },
          orderBy: [{ milestoneDay: 'asc' }, { id: 'asc' }],
          select: {
            milestoneDay: true,
            sampleCount: true,
            includeControlPrompts: true,
          },
        },
      },
    });
    if (!record) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '发布记录不存在');
    }

    const market: GeoMarket = record.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const pendingSchedules = Array.isArray(record.retestSchedules) ? record.retestSchedules : [];
    const firstPending = pendingSchedules[0];

    const sampleCount: RetestSampleCount =
      query?.sampleCount ?? (firstPending?.sampleCount === 3 ? 3 : 1);
    const includeControlPrompts: boolean =
      query?.includeControlPrompts ?? Boolean(firstPending?.includeControlPrompts);

    const promptCandidate = record.article.targetPrompt.trim();
    const targetPrompt =
      promptCandidate.length >= 2
        ? promptCandidate.slice(0, 300)
        : record.article.title.trim().slice(0, 300) || record.brandMarket.localBrandName;

    const configuredControlPrompts = Array.isArray(record.brandMarket.controlPrompts)
      ? record.brandMarket.controlPrompts
      : [];
    const selectedControlPrompts = selectRetestControlPrompts(
      targetPrompt,
      configuredControlPrompts,
      includeControlPrompts,
    );

    const engineHealth =
      this.engineHealth ?? new VisibilityEngineHealthService(this.visibilityConfig);
    const availability = this.visibilityConfig.featureEnabled
      ? await engineHealth.getAvailability(market)
      : { engines: [] };
    const activeEngineCount = availability.engines.filter((e) => e.available).length;

    const unitPrice = await this.billing.unitPrice('visibility_check');
    const wallet = await this.billing.wallet(tenantId);

    const targetPromptCount = targetPrompt ? 1 : 0;
    const perRunPoints = computeRetestEstimatedPoints({
      targetPromptCount,
      controlPromptCount: selectedControlPrompts.length,
      activeEngineCount,
      sampleCount,
      unitPrice,
    });

    const pendingMilestoneCount =
      query?.milestones !== undefined
        ? normalizeMilestoneDays(query.milestones).length
        : pendingSchedules.length;
    const totalEstimatedPoints = perRunPoints * pendingMilestoneCount;
    const billingMode: 'SHADOW' | 'STRICT' = wallet.billingMode === 'STRICT' ? 'STRICT' : 'SHADOW';

    return {
      publishRecordId: record.id,
      market,
      targetPromptCount,
      configuredControlPromptCount: configuredControlPrompts.length,
      effectiveControlPromptCount: selectedControlPrompts.length,
      selectedControlPrompts,
      totalPromptCount: targetPromptCount + selectedControlPrompts.length,
      activeEngineCount,
      sampleCount,
      includeControlPrompts,
      unitPrice,
      perRunPoints,
      pendingMilestoneCount,
      totalEstimatedPoints,
      billingMode,
      walletAvailable: wallet.available,
      sufficientForNextRun: billingMode === 'SHADOW' || wallet.available >= perRunPoints,
      sufficientForAllPending: billingMode === 'SHADOW' || wallet.available >= totalEstimatedPoints,
    };
  }

  async runDueSweep(opts?: RetestSweepOptions): Promise<RetestSweepReport> {
    const now = opts?.now ?? new Date();
    const batchSize = Math.min(
      MAX_SWEEP_BATCH_SIZE,
      Math.max(1, opts?.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE),
    );

    await this.reconcileStaleRunningSchedules(now, batchSize);

    const due = await this.prisma.base.geoRetestSchedule.findMany({
      where: { status: 'PENDING', dueAt: { lte: now } },
      include: {
        tenant: {
          select: {
            id: true,
            isActive: true,
            expiresAt: true,
          },
        },
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });

    const report: RetestSweepReport = {
      scanned: due.length,
      claimed: 0,
      triggered: 0,
      skippedInsufficientPoints: 0,
      skippedBudgetCap: 0,
      skippedNoEngine: 0,
      skippedInactiveTenant: 0,
      failed: 0,
    };

    const inSweepRunsByMarket = new Map<
      string,
      Array<{ scheduleId: string; runId: string; estimatedPoints: number }>
    >();

    for (const schedule of due) {
      await runInTenant(schedule.tenantId, async () => {
        const expectedRunId = deriveVisibilityRunId(schedule.tenantId, `sched:${schedule.id}`);

        const claimed = await this.prisma.scoped.geoRetestSchedule.updateMany({
          where: { id: schedule.id, status: 'PENDING' },
          data: { status: 'RUNNING', visibilityRunId: expectedRunId, updatedAt: now },
        });
        if (claimed.count !== 1) {
          return;
        }
        report.claimed += 1;

        try {
          const tenant = schedule.tenant;
          if (!tenant || !tenant.isActive || tenant.expiresAt.getTime() <= now.getTime()) {
            const reason = !tenant || !tenant.isActive ? '租户账号已停用' : '租户账号已到期';
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'CANCELLED',
                visibilityRunId: null,
                skipReason: reason,
                executedAt: now,
              },
            });
            report.skippedInactiveTenant += 1;
            return;
          }

          const record = await this.prisma.scoped.geoPublishRecord.findFirst({
            where: {
              id: schedule.publishRecordId,
              brandId: schedule.brandId,
              brandMarketId: schedule.brandMarketId,
            },
            include: {
              article: {
                select: {
                  id: true,
                  title: true,
                  targetPrompt: true,
                  productLineId: true,
                },
              },
              brandMarket: {
                select: {
                  id: true,
                  market: true,
                  localBrandName: true,
                  controlPrompts: true,
                  monthlyRetestPointCap: true,
                },
              },
            },
          });

          if (!record) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'CANCELLED',
                visibilityRunId: null,
                skipReason: '关联发布记录或文章已不存在',
                executedAt: now,
              },
            });
            report.skippedInactiveTenant += 1;
            return;
          }

          const market: GeoMarket = record.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
          const engineHealth =
            this.engineHealth ?? new VisibilityEngineHealthService(this.visibilityConfig);
          const availability = this.visibilityConfig.featureEnabled
            ? await engineHealth.getAvailability(market)
            : { engines: [] };
          const engines = availability.engines.filter((e) => e.available).map((e) => e.key);

          if (!this.visibilityConfig.featureEnabled || engines.length === 0) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'SKIPPED_NO_ENGINE',
                visibilityRunId: null,
                skipReason: this.visibilityConfig.featureEnabled
                  ? `当前市场（${market}）暂无可用的在线监测引擎`
                  : 'AI 可见性监测功能未启用',
                executedAt: now,
              },
            });
            report.skippedNoEngine += 1;
            return;
          }

          const promptCandidate = record.article.targetPrompt.trim();
          const prompt =
            promptCandidate.length >= 2
              ? promptCandidate.slice(0, 300)
              : record.article.title.trim().slice(0, 300) || record.brandMarket.localBrandName;

          if (!prompt) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'FAILED',
                visibilityRunId: null,
                skipReason: '关联文章缺少有效的监测问题',
                executedAt: now,
              },
            });
            report.failed += 1;
            return;
          }

          const selectedControlPrompts = selectRetestControlPrompts(
            prompt,
            record.brandMarket.controlPrompts,
            Boolean((schedule as { includeControlPrompts?: boolean }).includeControlPrompts),
          );
          const prompts = [prompt, ...selectedControlPrompts];

          const sampleCount: RetestSampleCount = schedule.sampleCount === 3 ? 3 : 1;
          const unitPrice = await this.billing.unitPrice('visibility_check');
          const estimatedPoints = computeRetestEstimatedPoints({
            targetPromptCount: 1,
            controlPromptCount: selectedControlPrompts.length,
            activeEngineCount: engines.length,
            sampleCount,
            unitPrice,
          });

          const rawMonthlyCap = (record.brandMarket as { monthlyRetestPointCap?: number | null })
            .monthlyRetestPointCap;
          const monthlyCap =
            typeof rawMonthlyCap === 'number' &&
            Number.isInteger(rawMonthlyCap) &&
            rawMonthlyCap > 0
              ? rawMonthlyCap
              : null;

          const marketSweepKey = `${schedule.tenantId}:${record.brandMarketId}`;
          if (monthlyCap !== null) {
            const monthlyUsage = await computeMonthlyRetestBudgetUsage(this.prisma.scoped, {
              brandId: record.brandId,
              brandMarketId: record.brandMarketId,
              capPoints: monthlyCap,
              now,
              excludeScheduleId: schedule.id,
              inSweepRuns: inSweepRunsByMarket.get(marketSweepKey),
            });
            if (monthlyUsage.usedPoints + estimatedPoints > monthlyCap) {
              await this.prisma.scoped.geoRetestSchedule.updateMany({
                where: { id: schedule.id, status: 'RUNNING' },
                data: {
                  status: 'SKIPPED_BUDGET_CAP',
                  visibilityRunId: null,
                  skipReason: `本月（${monthlyUsage.monthKey}）自动复测预算已用 ${monthlyUsage.usedPoints}/${monthlyCap} 点，本次预计需 ${estimatedPoints} 点，已温和跳过（不影响手动复测与写作）`,
                  executedAt: now,
                  updatedAt: now,
                },
              });
              report.skippedBudgetCap += 1;
              return;
            }
          }

          const wallet = await this.billing.wallet(schedule.tenantId);

          if (wallet.billingMode === 'STRICT' && wallet.available < estimatedPoints) {
            const breakdown =
              selectedControlPrompts.length > 0
                ? `${prompts.length} 问句（含 ${selectedControlPrompts.length} 条对照） × ${engines.length} 引擎 × ${sampleCount} 次采样 × ${unitPrice} 点`
                : `${engines.length} 引擎 × ${sampleCount} 次采样 × ${unitPrice} 点`;
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'SKIPPED_INSUFFICIENT_POINTS',
                visibilityRunId: null,
                skipReason: `预计需要 ${estimatedPoints} 点（${breakdown}），当前可用 ${wallet.available} 点`,
                executedAt: now,
              },
            });
            report.skippedInsufficientPoints += 1;
            return;
          }

          if (!this.runLifecycle) {
            throw new Error('VisibilityRunLifecycleService unavailable');
          }

          const articleProductLineId =
            (record.article as { productLineId?: string | null }).productLineId ?? undefined;

          const run = await this.runLifecycle.createRun(
            record.brandId,
            {
              market,
              ...(articleProductLineId ? { productLineId: articleProductLineId } : {}),
              name: `定时复测 T+${schedule.milestoneDay}：${record.article.title.slice(0, 36)}`.slice(
                0,
                80,
              ),
              engines,
              prompts,
              triggerType: 'RETEST',
              retestArticleId: record.articleId,
              sampleCount,
            },
            `sched:${schedule.id}`,
            'system',
            market,
          );

          if (run.id !== expectedRunId) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id },
              data: { visibilityRunId: run.id, updatedAt: now },
            });
          }

          const committedRuns = inSweepRunsByMarket.get(marketSweepKey) ?? [];
          committedRuns.push({
            scheduleId: schedule.id,
            runId: run.id,
            estimatedPoints,
          });
          inSweepRunsByMarket.set(marketSweepKey, committedRuns);

          try {
            await this.prisma.scoped.geoPublishRecord.updateMany({
              where: {
                id: record.id,
                OR: [{ latestRetestRunId: null }, { latestRetestRunId: { not: run.id } }],
              },
              data: {
                latestRetestRunId: run.id,
                afterMetrics: Prisma.DbNull,
              },
            });
          } catch (pointerErr) {
            this.logger.warn(
              `retest-schedule-sweep failed to sync latestRetestRunId for publishRecord=${record.id} run=${run.id}: ${
                pointerErr instanceof Error ? pointerErr.message : String(pointerErr)
              }`,
            );
          }

          report.triggered += 1;
        } catch (error) {
          let nextStatus: 'SKIPPED_INSUFFICIENT_POINTS' | 'SKIPPED_NO_ENGINE' | 'FAILED' = 'FAILED';
          if (error instanceof ApiError && error.code === API_ERROR.INSUFFICIENT_POINTS) {
            nextStatus = 'SKIPPED_INSUFFICIENT_POINTS';
            report.skippedInsufficientPoints += 1;
          } else if (
            error instanceof ApiError &&
            error.code === API_ERROR.BAD_REQUEST &&
            error.message.includes('暂未上线')
          ) {
            nextStatus = 'SKIPPED_NO_ENGINE';
            report.skippedNoEngine += 1;
          } else {
            report.failed += 1;
          }

          await this.prisma.scoped.geoRetestSchedule
            .updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: nextStatus,
                visibilityRunId: null,
                skipReason: safeSkipReason(error),
                executedAt: now,
              },
            })
            .catch((recoveryErr: unknown) => {
              this.logger.warn(
                `retest-schedule-sweep recovery update failed for schedule=${schedule.id}: ${
                  recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
                }`,
              );
            });
        }
      });
    }

    return report;
  }

  /**
   * 自愈巡检：回收关联 VisibilityRun 已终态（COMPLETED / PARTIAL / FAILED / CANCELLED）
   * 或缺失超时的卡死 RUNNING 日程，防止 Worker 异常退出、瞬时事务失败或历史数据导致日程永久滞留在「复测中」。
   */
  private async reconcileStaleRunningSchedules(now: Date, batchSize: number): Promise<void> {
    const runningSchedules = await this.prisma.base.geoRetestSchedule.findMany({
      where: { status: 'RUNNING' },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });

    for (const schedule of runningSchedules) {
      await runInTenant(schedule.tenantId, async () => {
        try {
          const run = schedule.visibilityRunId
            ? await this.prisma.scoped.visibilityRun.findFirst({
                where: {
                  id: schedule.visibilityRunId,
                  brandId: schedule.brandId,
                  brandMarketId: schedule.brandMarketId,
                },
                select: {
                  id: true,
                  status: true,
                  triggerType: true,
                  retestArticleId: true,
                  lastError: true,
                  finishedAt: true,
                },
              })
            : null;

          if (run && (run.status === 'FAILED' || run.status === 'CANCELLED')) {
            const nextStatus = run.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
            const fallbackReason =
              nextStatus === 'CANCELLED' ? '关联复测任务已取消' : '关联复测任务全部观测失败';
            const reason =
              typeof run.lastError === 'string' && run.lastError.trim()
                ? run.lastError.trim().slice(0, 240)
                : fallbackReason;

            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: nextStatus,
                executedAt: run.finishedAt ?? now,
                skipReason: reason,
              },
            });
            return;
          }

          if (run && (run.status === 'COMPLETED' || run.status === 'PARTIAL')) {
            const completedAt = run.finishedAt ?? schedule.updatedAt;
            if (now.getTime() - completedAt.getTime() < STALE_COMPLETED_RECONCILE_GRACE_MS) {
              return;
            }

            const detailedRun = await this.prisma.scoped.visibilityRun.findFirst({
              where: {
                id: run.id,
                brandId: schedule.brandId,
                brandMarketId: schedule.brandMarketId,
              },
              include: {
                brandMarket: true,
                observations: {
                  where: { status: 'SUCCESS' },
                  include: {
                    citations: {
                      orderBy: { position: 'asc' },
                    },
                  },
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                },
              },
            });

            const successObservations = (detailedRun?.observations ??
              []) as RetestObservationLike[];

            if (this.retestMetricsHook && run.triggerType === 'RETEST') {
              try {
                await this.retestMetricsHook.onVisibilityRunComplete({
                  tenantId: schedule.tenantId,
                  brandId: schedule.brandId,
                  brandMarketId: schedule.brandMarketId,
                  runId: run.id,
                  triggerType: 'RETEST',
                  retestArticleId: run.retestArticleId ?? null,
                  status: run.status,
                  successCount: successObservations.length,
                });
              } catch (hookErr: unknown) {
                this.logger.warn(
                  `retest-schedule-sweep hook replay failed for schedule=${schedule.id}: ${
                    hookErr instanceof Error ? hookErr.message : String(hookErr)
                  }`,
                );
              }

              const afterHook = await this.prisma.scoped.geoRetestSchedule.findFirst({
                where: { id: schedule.id },
                select: { status: true },
              });
              if (afterHook && afterHook.status !== 'RUNNING') {
                return;
              }
            }

            if (successObservations.length > 0 && detailedRun?.brandMarket) {
              const publishRecord = await this.prisma.scoped.geoPublishRecord.findFirst({
                where: { id: schedule.publishRecordId },
                select: {
                  id: true,
                  publishedUrl: true,
                  baselineRunId: true,
                  beforeMetrics: true,
                  publishedAt: true,
                  article: {
                    select: {
                      targetPrompt: true,
                    },
                  },
                },
              });
              const brandMarketLike = detailedRun.brandMarket as RetestBrandMarketLike;
              const publishedUrl = publishRecord?.publishedUrl ?? null;
              const includeControlPrompts = Boolean(
                (schedule as { includeControlPrompts?: boolean }).includeControlPrompts,
              );
              const runPrompts = Array.isArray((detailedRun as { prompts?: unknown }).prompts)
                ? ((detailedRun as { prompts?: string[] }).prompts ?? [])
                : undefined;

              const partitioned = partitionRetestObservations({
                observations: successObservations,
                runPrompts,
                includeControlPrompts,
                targetPrompt: publishRecord?.article?.targetPrompt ?? null,
                brandMarketControlPrompts: brandMarketLike.controlPrompts,
              });

              const scheduleSnapshot = computeScheduleMetricsSnapshot(
                partitioned.targetObservations,
                brandMarketLike,
                publishedUrl,
              );
              const recordSnapshot = computeRetestMetricSnapshot(
                partitioned.targetObservations,
                brandMarketLike,
                publishedUrl,
              );

              let controlMetrics: GeoRetestControlMetricsSnapshot | null = null;
              if (
                includeControlPrompts &&
                scheduleSnapshot &&
                partitioned.controlObservations.length > 0
              ) {
                const obsDelegate = (
                  this.prisma.scoped as unknown as {
                    visibilityObservation?: VisibilityObservationFinder;
                  }
                ).visibilityObservation;
                const baselineControlObservations = await findBaselineControlObservations(
                  obsDelegate,
                  {
                    brandId: schedule.brandId,
                    brandMarketId: schedule.brandMarketId,
                    currentRunId: run.id,
                    baselineRunId: publishRecord?.baselineRunId ?? null,
                    publishedAt: publishRecord?.publishedAt ?? null,
                    controlPrompts: partitioned.controlPrompts,
                  },
                );
                const beforeMetrics = normalizeRetestMetricSnapshot(
                  publishRecord?.beforeMetrics ?? null,
                );
                controlMetrics = computeControlMetricsSnapshot({
                  controlPrompts: partitioned.controlPrompts,
                  controlObservations: partitioned.controlObservations,
                  baselineControlObservations,
                  brandMarket: brandMarketLike,
                  treatmentBaselineMentionRate: beforeMetrics?.mentionRate ?? null,
                  treatmentCurrentMentionRate: scheduleSnapshot.mentionRate,
                });
              }

              if (publishRecord && recordSnapshot) {
                await this.prisma.scoped.geoPublishRecord.updateMany({
                  where: { id: publishRecord.id },
                  data: {
                    latestRetestRunId: run.id,
                    afterMetrics: recordSnapshot as unknown as Prisma.InputJsonValue,
                  },
                });
              }

              if (scheduleSnapshot) {
                await this.prisma.scoped.geoRetestSchedule.updateMany({
                  where: { id: schedule.id, status: 'RUNNING' },
                  data: {
                    status: 'COMPLETED',
                    executedAt: run.finishedAt ?? now,
                    skipReason: null,
                    metricsSnapshotJson: scheduleSnapshot as unknown as Prisma.InputJsonValue,
                    ...(controlMetrics
                      ? {
                          controlMetricsJson: controlMetrics as unknown as Prisma.InputJsonValue,
                        }
                      : {}),
                  },
                });
                return;
              }
            }

            const reason =
              typeof run.lastError === 'string' && run.lastError.trim()
                ? run.lastError.trim().slice(0, 240)
                : '关联复测任务未产生有效观测结果';
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'FAILED',
                executedAt: run.finishedAt ?? now,
                skipReason: reason,
              },
            });
            return;
          }

          const isOrphaned =
            !run &&
            (!schedule.visibilityRunId ||
              now.getTime() - schedule.updatedAt.getTime() >= STALE_RUNNING_ORPHAN_MS);

          if (isOrphaned) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'FAILED',
                executedAt: now,
                skipReason: '关联复测任务缺失或执行中断',
              },
            });
          }
        } catch (err) {
          this.logger.warn(
            `retest-schedule-sweep reconcile failed for schedule=${schedule.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
    }
  }
}
