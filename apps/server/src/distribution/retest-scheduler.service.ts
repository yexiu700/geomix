import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  DEFAULT_RETEST_MILESTONE_DAYS,
  type GeoMarket,
  type GeoRetestScheduleDto,
  type RetestSampleCount,
  type RetestScheduleConfigInput,
  type VisibilityRunDetailRecord,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  RetestMetricsHookService,
  computeRetestMetricSnapshot,
  computeScheduleMetricsSnapshot,
  type RetestBrandMarketLike,
  type RetestObservationLike,
} from '../studio/retest-metrics-hook.service';
import { presentRetestSchedule, type GeoRetestScheduleRow } from '../studio/studio.mapper';
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
  skippedNoEngine: number;
  skippedInactiveTenant: number;
  failed: number;
};

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

/**
 * 幂等创建指定发布记录的定时复测计划（默认 T+7/14/30，sampleCount=1）。
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

  await delegate.createMany({
    data: milestones.map((milestoneDay) => ({
      tenantId: record.tenantId,
      brandId: record.brandId,
      brandMarketId: record.brandMarketId,
      publishRecordId: record.id,
      milestoneDay,
      sampleCount,
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

    const effectiveSampleCount: RetestSampleCount =
      input.sampleCount ??
      (existing.find((s) => s.status === 'PENDING')?.sampleCount === 3 ? 3 : 1);

    if (input.enabled === false) {
      await this.prisma.scoped.geoRetestSchedule.updateMany({
        where: { publishRecordId: record.id, status: 'PENDING' },
        data: { status: 'CANCELLED', skipReason: '用户已暂停自动复测' },
      });
    } else {
      const cancelSet = new Set(input.cancelMilestoneDays ?? []);
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
              sampleCount: effectiveSampleCount,
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
    }

    const updated = await this.prisma.scoped.geoRetestSchedule.findMany({
      where: { publishRecordId: record.id },
      orderBy: [{ milestoneDay: 'asc' }, { id: 'asc' }],
    });

    return updated.map(presentRetestSchedule);
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
      skippedNoEngine: 0,
      skippedInactiveTenant: 0,
      failed: 0,
    };

    for (const schedule of due) {
      await runInTenant(schedule.tenantId, async () => {
        const expectedRunId = deriveVisibilityRunId(schedule.tenantId, `sched:${schedule.id}`);

        const claimed = await this.prisma.scoped.geoRetestSchedule.updateMany({
          where: { id: schedule.id, status: 'PENDING' },
          data: { status: 'RUNNING', visibilityRunId: expectedRunId },
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
                },
              },
              brandMarket: {
                select: {
                  id: true,
                  market: true,
                  localBrandName: true,
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

          const sampleCount: RetestSampleCount = schedule.sampleCount === 3 ? 3 : 1;
          const unitPrice = await this.billing.unitPrice('visibility_check');
          const estimatedPoints = engines.length * sampleCount * unitPrice;
          const wallet = await this.billing.wallet(schedule.tenantId);

          if (wallet.billingMode === 'STRICT' && wallet.available < estimatedPoints) {
            await this.prisma.scoped.geoRetestSchedule.updateMany({
              where: { id: schedule.id, status: 'RUNNING' },
              data: {
                status: 'SKIPPED_INSUFFICIENT_POINTS',
                visibilityRunId: null,
                skipReason: `预计需要 ${estimatedPoints} 点（${engines.length} 引擎 × ${sampleCount} 次采样 × ${unitPrice} 点），当前可用 ${wallet.available} 点`,
                executedAt: now,
              },
            });
            report.skippedInsufficientPoints += 1;
            return;
          }

          if (!this.runLifecycle) {
            throw new Error('VisibilityRunLifecycleService unavailable');
          }

          const run = await this.runLifecycle.createRun(
            record.brandId,
            {
              market,
              name: `定时复测 T+${schedule.milestoneDay}：${record.article.title.slice(0, 36)}`.slice(
                0,
                80,
              ),
              engines,
              prompts: [prompt],
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
              data: { visibilityRunId: run.id },
            });
          }

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
                select: { id: true, publishedUrl: true },
              });
              const brandMarketLike = detailedRun.brandMarket as RetestBrandMarketLike;
              const publishedUrl = publishRecord?.publishedUrl ?? null;
              const scheduleSnapshot = computeScheduleMetricsSnapshot(
                successObservations,
                brandMarketLike,
                publishedUrl,
              );
              const recordSnapshot = computeRetestMetricSnapshot(
                successObservations,
                brandMarketLike,
                publishedUrl,
              );

              if (publishRecord && recordSnapshot) {
                await this.prisma.scoped.geoPublishRecord.updateMany({
                  where: { id: publishRecord.id },
                  data: {
                    latestRetestRunId: run.id,
                    afterMetrics: recordSnapshot as unknown as Prisma.InputJsonValue,
                  },
                });
              }

              await this.prisma.scoped.geoRetestSchedule.updateMany({
                where: { id: schedule.id, status: 'RUNNING' },
                data: {
                  status: 'COMPLETED',
                  executedAt: run.finishedAt ?? now,
                  skipReason: null,
                  ...(scheduleSnapshot
                    ? {
                        metricsSnapshotJson: scheduleSnapshot as unknown as Prisma.InputJsonValue,
                      }
                    : {}),
                },
              });
              return;
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
