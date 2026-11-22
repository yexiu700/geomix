import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  defaultTargetFormatForMarket,
  finishStatus,
  targetFormatsForMarket,
  type GeoMarket,
  type GeoRecipe,
  type GeoTargetFormat,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { QuotaService } from '../billing/quota.service';
import { ComplianceService } from '../infra/compliance';
import { ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { StudioGenerationService } from './studio-generation.service';
import { deriveGeoArticleId, extractCompetitorNames, normalizeOutlineJson } from './studio.mapper';

export const GEO_BATCH_HANDLER = Symbol('GEO_BATCH_HANDLER');
export const GEO_BATCH_ENQUEUER = Symbol('GEO_BATCH_ENQUEUER');

export type GeoBatchJobData = {
  tenantId: string;
  jobId: string;
  recipe?: GeoRecipe;
  targetFormat?: GeoTargetFormat;
};

export interface GeoBatchHandler {
  process(payload: GeoBatchJobData): Promise<void>;
}

export interface GeoBatchEnqueuer {
  enqueueGeoBatch(job: GeoBatchJobData): Promise<void>;
}

/**
 * Worker 侧消费 `geo-batch` 队列（2–20 篇轻量批量 GEO 写作）。
 * 严格遵循每篇独立结算/失败原子退费（#321 零假文案降级）与任务结束统一关单释放余量。
 */
@Injectable()
export class GeoBatchRunner implements GeoBatchHandler {
  private readonly logger = new Logger(GeoBatchRunner.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(StudioGenerationService) private readonly generation: StudioGenerationService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  async process(payload: GeoBatchJobData): Promise<void> {
    const { tenantId, jobId } = payload;

    const loaded = await this.prisma.base.$transaction(async (tx) => {
      const job = await tx.geoBatchJob.findFirst({
        where: { id: jobId, tenantId },
        include: { brand: true, brandMarket: true },
      });
      if (!job) return null;
      if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(job.status)) {
        return { job, terminal: true as const };
      }
      if (job.status === 'QUEUED') {
        await tx.geoBatchJob.updateMany({
          where: { id: jobId, tenantId, status: 'QUEUED' },
          data: { status: 'RUNNING' },
        });
      }
      const pref = await tx.promptPreference.findUnique({ where: { tenantId } });
      const existingArticles = await tx.geoArticle.findMany({
        where: { tenantId, batchJobId: jobId },
        select: { id: true, briefId: true },
      });
      const reservation = job.reservationId
        ? await tx.pointReservation.findFirst({
            where: { id: job.reservationId, tenantId },
            select: { id: true, shadow: true, status: true },
          })
        : null;
      const releasedLogs =
        job.reservationId && typeof tx.pointLog?.findMany === 'function'
          ? await tx.pointLog.findMany({
              where: {
                tenantId,
                reservationId: job.reservationId,
                status: 'RELEASED',
              },
              select: { unitKey: true },
            })
          : [];
      return {
        job,
        terminal: false as const,
        pref,
        existingArticles,
        reservation,
        releasedLogs,
      };
    });

    if (!loaded || loaded.terminal) return;

    const { job, pref, existingArticles, reservation, releasedLogs } = loaded;
    const market = job.brandMarket.market as GeoMarket;
    const reservationId = job.reservationId;
    const reservationShadow = reservation?.shadow ?? true;
    const existingBriefIds = new Set(
      existingArticles.map((a) => a.briefId).filter((id): id is string => Boolean(id)),
    );
    const releasedUnitKeys = new Set(releasedLogs.map((row) => row.unitKey));
    const competitors = extractCompetitorNames(job.brandMarket.competitors);
    const recipeOverrides =
      pref?.recipeOverrides &&
      typeof pref.recipeOverrides === 'object' &&
      !Array.isArray(pref.recipeOverrides)
        ? (pref.recipeOverrides as Record<string, unknown>)
        : null;

    let doneCount = existingBriefIds.size;
    let failCount = 0;
    let lastError: string | null = job.lastError;

    for (const briefId of job.briefIds) {
      if (existingBriefIds.has(briefId)) continue;

      const unitKey = `geo_batch:${jobId}:${briefId}`;
      if (releasedUnitKeys.has(unitKey)) {
        failCount += 1;
        continue;
      }
      const articleId = deriveGeoArticleId(tenantId, `batch:${jobId}:${briefId}`);

      const brief = await this.prisma.base.$transaction(async (tx) => {
        const row = await tx.geoBrief.findFirst({
          where: {
            id: briefId,
            tenantId,
            brandId: job.brandId,
            brandMarketId: job.brandMarketId,
          },
        });
        if (row && row.status === 'OPEN') {
          await tx.geoBrief.updateMany({
            where: { id: row.id, tenantId, status: 'OPEN' },
            data: { status: 'WRITING' },
          });
        }
        return row;
      });

      if (!brief) {
        failCount += 1;
        lastError = '部分写作意见不存在或已被移除';
        if (reservationId) {
          await this.billing
            .releaseUnit({
              tenantId,
              reservationId,
              unitKey,
              amount: job.unitPrice,
              title: '批量GEO写作失败退还',
            })
            .catch(() => undefined);
        }
        continue;
      }

      try {
        await this.compliance.assertAllowed({
          text: `${brief.targetPrompt}\n${brief.suggestedTitle}`,
          action: 'geo_batch_write',
          market,
          customForbiddenWords: pref?.customForbiddenWords,
          tenantId,
        });

        const recipe = payload.recipe ?? (brief.recommendedRecipe as GeoRecipe);
        const rawTargetFormat = payload.targetFormat ?? (brief.targetFormat as GeoTargetFormat);
        const targetFormat = targetFormatsForMarket(market).includes(rawTargetFormat)
          ? rawTargetFormat
          : defaultTargetFormatForMarket(market);
        const outlineH2 = normalizeOutlineJson(brief.outlineH2);
        const queryText = [brief.targetPrompt, ...brief.targetFanOuts].join(' ');
        const factSnippets = await this.generation.retrieveFacts(tenantId, job.brandId, queryText);
        const matchedFactIds = [...new Set(factSnippets.map((f) => f.factId))];

        const overrideRaw = recipeOverrides?.[recipe];
        const generated = await this.generation.generateArticle({
          tenantId,
          articleId,
          brand: {
            id: job.brand.id,
            name: job.brand.name,
            category: job.brand.category,
          },
          market: {
            id: job.brandMarket.id,
            market,
            locale: job.brandMarket.locale,
            region: job.brandMarket.region,
            localBrandName: job.brandMarket.localBrandName,
            localCategory: job.brandMarket.localCategory,
            aliases: job.brandMarket.aliases,
            ownedDomains: job.brandMarket.ownedDomains,
            competitors,
          },
          recipe,
          targetFormat,
          targetPrompt: brief.targetPrompt,
          title: brief.suggestedTitle,
          outlineH2,
          targetFanOuts: brief.targetFanOuts,
          factSnippets,
          matchedFactIds,
          customToneNote: pref?.customToneNote ?? null,
          customForbiddenWords: pref?.customForbiddenWords ?? [],
          recipeOverride: typeof overrideRaw === 'string' ? overrideRaw : null,
          sourceCitationUrl: brief.sourceCitationUrl ?? undefined,
          reservationShadow,
        });

        await this.prisma.base.$transaction(async (tx) => {
          await tx.geoArticle.create({
            data: {
              id: articleId,
              tenantId,
              brandId: job.brandId,
              brandMarketId: job.brandMarketId,
              briefId: brief.id,
              batchJobId: job.id,
              recipe,
              targetFormat,
              title: generated.title,
              targetPrompt: brief.targetPrompt,
              outlineJson: outlineH2 as unknown as Prisma.InputJsonValue,
              contentMarkdown: generated.contentMarkdown,
              contentHtml: generated.contentHtml,
              schemaJsonLd: generated.evaluation.schemaJsonLd as unknown as Prisma.InputJsonValue,
              llmsTxtSnippet: generated.evaluation.llmsTxtSnippet,
              geoScore: generated.evaluation.geoScore,
              geoScoreDetail: generated.evaluation
                .geoScoreDetail as unknown as Prisma.InputJsonValue,
              tags: [],
              status: 'DRAFT',
              model: generated.model,
              tokensIn: generated.tokensIn,
              tokensOut: generated.tokensOut,
              complianceFlags: generated.complianceFlags as unknown as Prisma.InputJsonValue,
            },
          });
          await tx.geoBrief.updateMany({
            where: { id: brief.id, tenantId },
            data: { status: 'DONE' },
          });
          await tx.geoBatchJob.updateMany({
            where: { id: job.id, tenantId },
            data: { doneCount: doneCount + 1 },
          });
        });

        if (reservationId) {
          try {
            await this.billing.settleGeoWriteUnit({
              tenantId,
              reservationId,
              unitKey,
              subject: generated.title,
              geoWritePoints: job.unitPrice,
            });
          } catch (settleErr) {
            await this.prisma.base.$transaction(async (tx) => {
              await tx.geoArticle.deleteMany({ where: { id: articleId, tenantId } });
              await tx.geoBrief.updateMany({
                where: { id: brief.id, tenantId },
                data: { status: 'OPEN' },
              });
              await tx.geoBatchJob.updateMany({
                where: { id: job.id, tenantId },
                data: { doneCount },
              });
            });
            throw settleErr;
          }
        }

        await this.quota.applyArticleEvent(tenantId, 'GEO_BATCH', 'create').catch(() => undefined);
        doneCount += 1;
      } catch (err) {
        failCount += 1;
        lastError = safeBatchError(err);
        this.logger.warn(`geo-batch item failed job=${jobId} brief=${briefId}: ${lastError}`);
        if (reservationId) {
          await this.billing
            .releaseUnit({
              tenantId,
              reservationId,
              unitKey,
              amount: job.unitPrice,
              title: '批量GEO写作失败退还',
            })
            .catch(() => undefined);
        }
        await this.prisma.base.$transaction(async (tx) => {
          await tx.geoBrief.updateMany({
            where: { id: brief.id, tenantId, status: 'WRITING' },
            data: { status: 'OPEN' },
          });
          await tx.geoBatchJob.updateMany({
            where: { id: job.id, tenantId },
            data: { failCount, lastError },
          });
        });
      }
    }

    const finalStatus = finishStatus({
      done: doneCount,
      fail: failCount,
      skip: 0,
      cancelled: false,
    });

    await this.prisma.base.$transaction(async (tx) => {
      await tx.geoBatchJob.updateMany({
        where: { id: jobId, tenantId },
        data: {
          status: finalStatus,
          doneCount,
          failCount,
          lastError,
          finishedAt: new Date(),
        },
      });
    });

    if (reservationId) {
      await this.billing.close({ tenantId, reservationId }).catch((err: unknown) => {
        this.logger.warn(
          `geo-batch close reservation failed job=${jobId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });
    }
  }
}

function safeBatchError(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Error && err.message.trim()) return err.message.slice(0, 240);
  return '批量文章生成失败，已退还该篇点数';
}
