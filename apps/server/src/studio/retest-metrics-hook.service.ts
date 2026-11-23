import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  normalizeVisibilityDomain,
  recomputeRunMetrics,
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

export type RetestObservationLike = {
  id: string;
  status: string;
  promptText: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: unknown;
  citations: ReadonlyArray<{ url: string; domain: string; sourceKind: string }>;
};

export type RetestBrandMarketLike = {
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
};

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
 * 计算定时复测节点（支持 sampleCount=1|3 多次采样聚合）的扩展指标快照。
 */
export function computeScheduleMetricsSnapshot(
  observations: readonly RetestObservationLike[],
  brandMarket: RetestBrandMarketLike,
  publishedUrl?: string | null,
): GeoRetestMetricsSnapshot | null {
  return computeRetestSnapshotDetail(observations, brandMarket, publishedUrl);
}

/**
 * 复测完成回写钩子（Issue #333 / D10）：
 * 仅依赖 PrismaService，在 ApiModule 与 WorkerModule 中均安全注册，
 * 当 triggerType === 'RETEST' 且有有效 SUCCESS 观测时自动回写 GeoPublishRecord.afterMetrics。
 */
@Injectable()
export class RetestMetricsHookService implements OnVisibilityRunCompleteHook {
  readonly name = 'geo-retest-metrics-writeback';
  private readonly logger = new Logger(RetestMetricsHookService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onVisibilityRunComplete(event: VisibilityRunCompleteEvent): Promise<void> {
    if (event.triggerType !== 'RETEST' || event.successCount <= 0) {
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

        if (
          !run ||
          run.triggerType !== 'RETEST' ||
          !run.brandMarket ||
          run.observations.length === 0
        ) {
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

        const uniqueRecords = new Map<string, { id: string; publishedUrl: string }>();
        for (const record of records) {
          uniqueRecords.set(record.id, { id: record.id, publishedUrl: record.publishedUrl });
        }
        for (const schedule of schedules) {
          if (schedule.publishRecord) {
            uniqueRecords.set(schedule.publishRecord.id, {
              id: schedule.publishRecord.id,
              publishedUrl: schedule.publishRecord.publishedUrl,
            });
          }
        }

        if (uniqueRecords.size === 0 && schedules.length === 0) {
          return;
        }

        for (const record of uniqueRecords.values()) {
          const snapshot = computeRetestMetricSnapshot(
            run.observations,
            run.brandMarket,
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
          const scheduleSnapshot = computeScheduleMetricsSnapshot(
            run.observations,
            run.brandMarket,
            schedule.publishRecord?.publishedUrl ?? null,
          );
          if (!scheduleSnapshot) continue;

          await tx.geoRetestSchedule.update({
            where: { id: schedule.id },
            data: {
              status: 'COMPLETED',
              executedAt,
              skipReason: null,
              metricsSnapshotJson: scheduleSnapshot as unknown as Prisma.InputJsonValue,
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
