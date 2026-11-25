import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  computeDifferenceInDifferences,
  computeWilsonInterval,
  normalizeVisibilityDomain,
  recomputeRunMetrics,
  type GeoRetestControlMetricsSnapshot,
  type GeoRetestMetricsSnapshot,
  type ProfileForMetrics,
  type RetestMetricSnapshot,
} from '@geomix/shared';
import { TX_OPTIONS } from '../billing/billing.sql';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseProfileCompetitors,
  type OnVisibilityRunCompleteHook,
  type VisibilityRunCompleteEvent,
} from '../visibility/visibility-run.runner';
import { normalizeRetestMetricSnapshot } from './studio.mapper';

export type RetestObservationLike = {
  id: string;
  runId?: string;
  status: string;
  promptText: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: unknown;
  citations: ReadonlyArray<{ url: string; domain: string; sourceKind: string }>;
  createdAt?: Date;
};

export type RetestBrandMarketLike = {
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  controlPrompts?: string[];
};

export type VisibilityObservationFinder = {
  findMany?: (args: {
    where: Record<string, unknown>;
    include?: Record<string, unknown>;
    orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    take?: number;
  }) => Promise<RetestObservationLike[]>;
};

export function normalizeRetestPromptKey(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalizeUrlForMatch(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${protocol}//${host}${pathname}`;
  } catch {
    return null;
  }
}

function extractPublishedHost(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    return normalizeVisibilityDomain(new URL(raw.trim()).hostname);
  } catch {
    return null;
  }
}

function pickDominantSentiment(summary: {
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
}): string | null {
  const ordered: ReadonlyArray<['positive' | 'neutral' | 'mixed' | 'negative', number]> = [
    ['positive', summary.positive],
    ['neutral', summary.neutral],
    ['mixed', summary.mixed],
    ['negative', summary.negative],
  ];
  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [key, count] of ordered) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestCount > 0 ? bestKey : null;
}

function computeRetestSnapshotDetail(
  observations: readonly RetestObservationLike[],
  brandMarket: RetestBrandMarketLike,
  publishedUrl?: string | null,
): GeoRetestMetricsSnapshot | null {
  const completed = observations.filter((obs) => obs.status === 'SUCCESS');
  if (completed.length === 0) return null;

  const ownedDomains = (brandMarket.ownedDomains ?? [])
    .map((d) => normalizeVisibilityDomain(d))
    .filter(Boolean);
  const profile: ProfileForMetrics = {
    brandName: brandMarket.localBrandName,
    brandAliases: brandMarket.aliases ?? [],
    ownedDomains,
    competitors: parseProfileCompetitors(brandMarket.competitors),
  };

  const metrics = recomputeRunMetrics(completed, profile);
  const publishedCanonical = publishedUrl ? canonicalizeUrlForMatch(publishedUrl) : null;
  const publishedHost = extractPublishedHost(publishedUrl);
  const publishedIsOwnedDomain = Boolean(
    publishedHost &&
    ownedDomains.some((owned) => publishedHost === owned || publishedHost.endsWith(`.${owned}`)),
  );

  let citationHit = metrics.ownedCitations > 0;
  if (!citationHit && (publishedCanonical || publishedIsOwnedDomain)) {
    for (const obs of completed) {
      for (const cite of obs.citations ?? []) {
        if (cite.sourceKind === 'OWNED') {
          citationHit = true;
          break;
        }
        if (publishedCanonical) {
          const citedCanonical = canonicalizeUrlForMatch(cite.url);
          if (citedCanonical && citedCanonical === publishedCanonical) {
            citationHit = true;
            break;
          }
        }
        if (publishedIsOwnedDomain && publishedHost) {
          const citedDomain = normalizeVisibilityDomain(cite.domain || cite.url);
          if (
            citedDomain &&
            (citedDomain === publishedHost || citedDomain.endsWith(`.${publishedHost}`))
          ) {
            citationHit = true;
            break;
          }
        }
      }
      if (citationHit) break;
    }
  }

  const wilson = computeWilsonInterval(metrics.mentionedChecks, completed.length);

  return {
    mentionRate: Number.isFinite(metrics.visibilityPct) ? metrics.visibilityPct : 0,
    avgPosition:
      typeof metrics.avgPosition === 'number' && Number.isFinite(metrics.avgPosition)
        ? metrics.avgPosition
        : null,
    sentiment: pickDominantSentiment(metrics.sentimentSummary),
    citationHit,
    sampleCount: completed.length,
    hitCount: metrics.mentionedChecks,
    wilson,
    confidenceLevel: wilson.confidenceLevel,
  };
}

/**
 * 计算发布前（基线）或发布后（RETEST 复测）的单篇指标快照。
 * 纯函数，供 RetestMetricsHookService 与 GeoDeliveryService 复用。
 */
export function computeRetestMetricSnapshot(
  observations: readonly RetestObservationLike[],
  brandMarket: RetestBrandMarketLike,
  publishedUrl?: string | null,
): RetestMetricSnapshot | null {
  const detail = computeRetestSnapshotDetail(observations, brandMarket, publishedUrl);
  if (!detail) return null;
  return {
    mentionRate: detail.mentionRate,
    avgPosition: detail.avgPosition,
    sentiment: detail.sentiment,
    citationHit: detail.citationHit,
  };
}

/**
 * 计算定时复测节点（支持 sampleCount=1|3 多次采样聚合 + Wilson 95% 置信区间）的扩展指标快照。
 */
export function computeScheduleMetricsSnapshot(
  observations: readonly RetestObservationLike[],
  brandMarket: RetestBrandMarketLike,
  publishedUrl?: string | null,
): GeoRetestMetricsSnapshot | null {
  return computeRetestSnapshotDetail(observations, brandMarket, publishedUrl);
}

/**
 * 将一次包含对照组问句的复测观测拆分为「目标问句观测」与「对照组问句观测」，
 * 确保目标文章 afterMetrics 与 metricsSnapshotJson 不被对照组问句污染。
 */
export function partitionRetestObservations(params: {
  observations: readonly RetestObservationLike[];
  runPrompts?: readonly string[] | null;
  includeControlPrompts?: boolean;
  targetPrompt?: string | null;
  brandMarketControlPrompts?: readonly string[] | null;
}): {
  targetObservations: RetestObservationLike[];
  controlObservations: RetestObservationLike[];
  controlPrompts: string[];
} {
  const completed = params.observations.filter((obs) => obs.status === 'SUCCESS');
  if (!params.includeControlPrompts) {
    return {
      targetObservations: completed,
      controlObservations: [],
      controlPrompts: [],
    };
  }

  const targetKey = normalizeRetestPromptKey(params.targetPrompt ?? params.runPrompts?.[0] ?? null);
  const rawControlCandidates: readonly string[] =
    Array.isArray(params.runPrompts) && params.runPrompts.length > 1
      ? params.runPrompts.slice(1)
      : (params.brandMarketControlPrompts ?? []);

  const seen = new Set<string>(targetKey ? [targetKey] : []);
  const controlPrompts: string[] = [];
  for (const raw of rawControlCandidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeRetestPromptKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    controlPrompts.push(trimmed);
  }

  if (controlPrompts.length === 0) {
    return {
      targetObservations: completed,
      controlObservations: [],
      controlPrompts: [],
    };
  }

  const controlKeySet = new Set(controlPrompts.map((p) => normalizeRetestPromptKey(p)));
  const targetObservations: RetestObservationLike[] = [];
  const controlObservations: RetestObservationLike[] = [];

  for (const obs of completed) {
    const key = normalizeRetestPromptKey(obs.promptText);
    if (controlKeySet.has(key)) {
      controlObservations.push(obs);
    } else {
      targetObservations.push(obs);
    }
  }

  return {
    targetObservations,
    controlObservations,
    controlPrompts,
  };
}

/**
 * 计算对照组指标快照及 Difference-in-Differences（DiD）净增益。
 * 重要标度约定：mentionRate 均为 0..100 百分比，调用 computeDifferenceInDifferences 前
 * 严格转换为 [0, 1] 比例（pct / 100），避免 clamp01 误截断。
 */
export function computeControlMetricsSnapshot(params: {
  controlPrompts: readonly string[];
  controlObservations: readonly RetestObservationLike[];
  baselineControlObservations: readonly RetestObservationLike[];
  brandMarket: RetestBrandMarketLike;
  treatmentBaselineMentionRate: number | null;
  treatmentCurrentMentionRate: number | null;
}): GeoRetestControlMetricsSnapshot | null {
  const controlObs = params.controlObservations.filter((obs) => obs.status === 'SUCCESS');
  if (controlObs.length === 0) {
    return null;
  }

  const currentDetail = computeRetestSnapshotDetail(controlObs, params.brandMarket, null);
  if (!currentDetail) {
    return null;
  }

  const baselineObs = params.baselineControlObservations.filter((obs) => obs.status === 'SUCCESS');
  const baselineDetail =
    baselineObs.length > 0
      ? computeRetestSnapshotDetail(baselineObs, params.brandMarket, null)
      : null;
  const baselineMentionRate = baselineDetail ? baselineDetail.mentionRate : null;

  const did =
    params.treatmentBaselineMentionRate !== null &&
    Number.isFinite(params.treatmentBaselineMentionRate) &&
    params.treatmentCurrentMentionRate !== null &&
    Number.isFinite(params.treatmentCurrentMentionRate) &&
    baselineMentionRate !== null &&
    Number.isFinite(baselineMentionRate)
      ? computeDifferenceInDifferences({
          treatmentBaseline: params.treatmentBaselineMentionRate / 100,
          treatmentCurrent: params.treatmentCurrentMentionRate / 100,
          controlBaseline: baselineMentionRate / 100,
          controlCurrent: currentDetail.mentionRate / 100,
        })
      : null;

  return {
    controlPrompts: [...params.controlPrompts],
    baselineMentionRate,
    currentMentionRate: currentDetail.mentionRate,
    sampleCount: currentDetail.sampleCount ?? controlObs.length,
    hitCount: currentDetail.hitCount ?? 0,
    ...(currentDetail.wilson ? { wilson: currentDetail.wilson } : {}),
    did,
  };
}

/**
 * 查找对照组问句的基线观测：
 * - 优先级 1：publishRecord.baselineRunId 内的对照组问句观测
 * - 优先级 2：同 brandMarket 在 publishedAt 之前最近一次已完成的包含对应对照组问句的 VisibilityRun 观测
 * - 优先级 3：无基线则返回空数组（baselineMentionRate = null, did = null）
 */
export async function findBaselineControlObservations(
  obsDelegate: VisibilityObservationFinder | undefined,
  params: {
    tenantId?: string;
    brandId: string;
    brandMarketId: string;
    currentRunId: string;
    baselineRunId: string | null;
    publishedAt: Date | null;
    controlPrompts: readonly string[];
  },
): Promise<RetestObservationLike[]> {
  if (typeof obsDelegate?.findMany !== 'function' || params.controlPrompts.length === 0) {
    return [];
  }

  const controlKeySet = new Set(params.controlPrompts.map((p) => normalizeRetestPromptKey(p)));
  const baseTenantFilter = params.tenantId ? { tenantId: params.tenantId } : {};

  if (params.baselineRunId && params.baselineRunId !== params.currentRunId) {
    const baselineRows = await obsDelegate.findMany({
      where: {
        ...baseTenantFilter,
        brandId: params.brandId,
        brandMarketId: params.brandMarketId,
        runId: params.baselineRunId,
        status: 'SUCCESS',
      },
      include: {
        citations: {
          orderBy: { position: 'asc' },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const matched = baselineRows.filter((row) =>
      controlKeySet.has(normalizeRetestPromptKey(row.promptText)),
    );
    if (matched.length > 0) {
      return matched;
    }
  }

  const priorRows = await obsDelegate.findMany({
    where: {
      ...baseTenantFilter,
      brandId: params.brandId,
      brandMarketId: params.brandMarketId,
      status: 'SUCCESS',
      runId: { not: params.currentRunId },
      ...(params.publishedAt ? { createdAt: { lte: params.publishedAt } } : {}),
    },
    include: {
      citations: {
        orderBy: { position: 'asc' },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });

  const matchingPrior = priorRows.filter((row) =>
    controlKeySet.has(normalizeRetestPromptKey(row.promptText)),
  );
  if (matchingPrior.length === 0) {
    return [];
  }

  const latestRunId = matchingPrior[0]?.runId;
  if (!latestRunId) {
    return matchingPrior;
  }

  return matchingPrior.filter((row) => row.runId === latestRunId);
}

/**
 * 复测完成回写钩子（Issue #333 / D10 / #369）：
 * 仅依赖 PrismaService，在 ApiModule 与 WorkerModule 中均安全注册，
 * 当 triggerType === 'RETEST' 且有有效 SUCCESS 观测时自动回写 GeoPublishRecord.afterMetrics
 * 以及 GeoRetestSchedule.metricsSnapshotJson（含 Wilson 95% CI）与 controlMetricsJson（含 DiD）。
 */
@Injectable()
export class RetestMetricsHookService implements OnVisibilityRunCompleteHook {
  readonly name = 'geo-retest-metrics-writeback';
  private readonly logger = new Logger(RetestMetricsHookService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onVisibilityRunComplete(event: VisibilityRunCompleteEvent): Promise<void> {
    if (event.triggerType !== 'RETEST') {
      return;
    }

    try {
      await this.prisma.base.$transaction(async (tx) => {
        const run = await tx.visibilityRun.findFirst({
          where: { id: event.runId, tenantId: event.tenantId },
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

        if (!run || run.triggerType !== 'RETEST') {
          return;
        }

        const isTerminalNoSuccess =
          event.status === 'FAILED' ||
          event.status === 'CANCELLED' ||
          event.successCount <= 0 ||
          run.observations.length === 0;

        if (isTerminalNoSuccess) {
          const nextStatus =
            event.status === 'CANCELLED' || run.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
          const fallbackReason =
            nextStatus === 'CANCELLED' ? '关联复测任务已取消' : '关联复测任务全部观测失败';
          const reason =
            typeof run.lastError === 'string' && run.lastError.trim()
              ? run.lastError.trim().slice(0, 240)
              : fallbackReason;

          await tx.geoRetestSchedule.updateMany({
            where: {
              tenantId: event.tenantId,
              brandId: run.brandId,
              brandMarketId: run.brandMarketId,
              visibilityRunId: run.id,
              status: { in: ['PENDING', 'RUNNING'] },
            },
            data: {
              status: nextStatus,
              executedAt: new Date(),
              skipReason: reason,
            },
          });
          return;
        }

        if (!run.brandMarket) {
          return;
        }

        const allLinkedSchedules = await tx.geoRetestSchedule.findMany({
          where: {
            tenantId: event.tenantId,
            brandId: run.brandId,
            brandMarketId: run.brandMarketId,
            visibilityRunId: run.id,
          },
          include: {
            publishRecord: {
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
            },
          },
        });

        const schedules = allLinkedSchedules.filter(
          (schedule) => schedule.status === 'PENDING' || schedule.status === 'RUNNING',
        );

        let records = await tx.geoPublishRecord.findMany({
          where: {
            tenantId: event.tenantId,
            brandId: run.brandId,
            brandMarketId: run.brandMarketId,
            latestRetestRunId: run.id,
          },
        });

        // Worker-first race fallback: worker may complete fake RETEST before API links latestRetestRunId.
        // Skip fallback whenever ANY schedule is linked to this run (including CANCELLED or already
        // COMPLETED schedules) so a scheduled retest on an older channel never mutates an unrelated
        // publish record on the same article.
        if (records.length === 0 && allLinkedSchedules.length === 0 && run.retestArticleId) {
          records = await tx.geoPublishRecord.findMany({
            where: {
              tenantId: event.tenantId,
              brandId: run.brandId,
              brandMarketId: run.brandMarketId,
              articleId: run.retestArticleId,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          });
        }

        type TargetRecordEntry = {
          id: string;
          publishedUrl: string;
          includeControlPrompts: boolean;
          targetPrompt: string | null;
        };

        const scheduleMetaByRecordId = new Map<
          string,
          { includeControlPrompts: boolean; targetPrompt: string | null }
        >();
        for (const schedule of allLinkedSchedules) {
          const recId = schedule.publishRecord?.id ?? schedule.publishRecordId;
          if (!recId) continue;
          const prev = scheduleMetaByRecordId.get(recId);
          scheduleMetaByRecordId.set(recId, {
            includeControlPrompts:
              Boolean(prev?.includeControlPrompts) ||
              Boolean((schedule as { includeControlPrompts?: boolean }).includeControlPrompts),
            targetPrompt:
              schedule.publishRecord?.article?.targetPrompt ?? prev?.targetPrompt ?? null,
          });
        }

        const uniqueRecords = new Map<string, TargetRecordEntry>();
        for (const record of records) {
          const meta = scheduleMetaByRecordId.get(record.id);
          uniqueRecords.set(record.id, {
            id: record.id,
            publishedUrl: record.publishedUrl,
            includeControlPrompts: Boolean(meta?.includeControlPrompts),
            targetPrompt: meta?.targetPrompt ?? null,
          });
        }
        for (const schedule of schedules) {
          if (schedule.publishRecord) {
            const existing = uniqueRecords.get(schedule.publishRecord.id);
            const meta = scheduleMetaByRecordId.get(schedule.publishRecord.id);
            uniqueRecords.set(schedule.publishRecord.id, {
              id: schedule.publishRecord.id,
              publishedUrl: schedule.publishRecord.publishedUrl,
              includeControlPrompts:
                Boolean(existing?.includeControlPrompts) ||
                Boolean(meta?.includeControlPrompts) ||
                Boolean((schedule as { includeControlPrompts?: boolean }).includeControlPrompts),
              targetPrompt:
                schedule.publishRecord.article?.targetPrompt ??
                meta?.targetPrompt ??
                existing?.targetPrompt ??
                null,
            });
          }
        }

        if (uniqueRecords.size === 0 && schedules.length === 0) {
          return;
        }

        const runPrompts = Array.isArray((run as { prompts?: unknown }).prompts)
          ? ((run as { prompts?: string[] }).prompts ?? [])
          : undefined;
        const brandMarketLike = run.brandMarket as RetestBrandMarketLike;
        const obsDelegate = (
          tx as unknown as { visibilityObservation?: VisibilityObservationFinder }
        ).visibilityObservation;

        for (const record of uniqueRecords.values()) {
          const partitioned = partitionRetestObservations({
            observations: run.observations,
            runPrompts,
            includeControlPrompts: record.includeControlPrompts,
            targetPrompt: record.targetPrompt,
            brandMarketControlPrompts: brandMarketLike.controlPrompts,
          });
          const snapshot = computeRetestMetricSnapshot(
            partitioned.targetObservations,
            brandMarketLike,
            record.publishedUrl,
          );
          if (!snapshot) continue;

          await tx.geoPublishRecord.update({
            where: { id: record.id },
            data: {
              latestRetestRunId: run.id,
              afterMetrics: snapshot as unknown as Prisma.InputJsonValue,
            },
          });
        }

        const executedAt = new Date();
        for (const schedule of schedules) {
          const includeControlPrompts = Boolean(
            (schedule as { includeControlPrompts?: boolean }).includeControlPrompts,
          );
          const partitioned = partitionRetestObservations({
            observations: run.observations,
            runPrompts,
            includeControlPrompts,
            targetPrompt: schedule.publishRecord?.article?.targetPrompt ?? null,
            brandMarketControlPrompts: brandMarketLike.controlPrompts,
          });

          const scheduleSnapshot = computeScheduleMetricsSnapshot(
            partitioned.targetObservations,
            brandMarketLike,
            schedule.publishRecord?.publishedUrl ?? null,
          );
          if (!scheduleSnapshot) {
            await tx.geoRetestSchedule.update({
              where: { id: schedule.id },
              data: {
                status: 'FAILED',
                executedAt,
                skipReason: '目标问句未产生有效观测结果',
              },
            });
            continue;
          }

          let controlMetrics: GeoRetestControlMetricsSnapshot | null = null;
          if (includeControlPrompts && partitioned.controlObservations.length > 0) {
            const baselineControlObservations = await findBaselineControlObservations(obsDelegate, {
              tenantId: event.tenantId,
              brandId: run.brandId,
              brandMarketId: run.brandMarketId,
              currentRunId: run.id,
              baselineRunId: schedule.publishRecord?.baselineRunId ?? null,
              publishedAt: schedule.publishRecord?.publishedAt ?? null,
              controlPrompts: partitioned.controlPrompts,
            });
            const beforeMetrics = normalizeRetestMetricSnapshot(
              schedule.publishRecord?.beforeMetrics ?? null,
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

          await tx.geoRetestSchedule.update({
            where: { id: schedule.id },
            data: {
              status: 'COMPLETED',
              executedAt,
              skipReason: null,
              metricsSnapshotJson: scheduleSnapshot as unknown as Prisma.InputJsonValue,
              ...(controlMetrics
                ? {
                    controlMetricsJson: controlMetrics as unknown as Prisma.InputJsonValue,
                  }
                : {}),
            },
          });
        }
      }, TX_OPTIONS);
    } catch (err) {
      this.logger.warn(
        `Retest metrics writeback failed for run=${event.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
