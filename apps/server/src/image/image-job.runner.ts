import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_DEFAULT_UNIT_POINTS,
  API_ERROR,
  GALLERY_CATEGORY_TYPE_IMAGE,
  GALLERY_THUMB_MAX_EDGE,
  PRICING_DEFAULTS,
  buildImageLedgerTitle,
  isAiImageRatio,
  parseEnv,
  resolveAiImageRatioDimensions,
  resolveImageSettings,
  type AiImageCount,
  type AiImageRatio,
} from '@geomix/shared';
import sharp from 'sharp';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { compressImage } from '../infra/compress';
import { ImageService } from '../infra/image';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { StorageService } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';

export function isProductionPlaceholderImageBlocked(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === 'production' && resolveImageSettings(env).provider === 'fake';
}

export function resolveImageProviderReadiness(
  env: Record<string, string | undefined> = process.env,
): { ready: boolean; reason: string | null } {
  let settings: ReturnType<typeof resolveImageSettings>;
  try {
    settings = resolveImageSettings(env);
  } catch {
    return {
      ready: false,
      reason: '当前环境尚未配置 AI 生图服务端点，暂不可发起生图任务。请联系管理员配置后再试。',
    };
  }
  if (settings.provider === 'fake') {
    if (env.NODE_ENV === 'production') {
      return {
        ready: false,
        reason: '当前环境尚未配置真实 AI 生图服务，已禁用演示占位图生成。请联系管理员配置后再试。',
      };
    }
    return { ready: true, reason: null };
  }
  if (!settings.baseUrl?.trim()) {
    return {
      ready: false,
      reason: '当前环境尚未配置 AI 生图服务端点，暂不可发起生图任务。请联系管理员配置后再试。',
    };
  }
  if (!env[settings.apiKeyEnv]?.trim()) {
    return {
      ready: false,
      reason: '当前环境尚未配置 AI 生图服务密钥，暂不可发起生图任务。请联系管理员配置后再试。',
    };
  }
  return { ready: true, reason: null };
}

export const IMAGE_JOB_HANDLER = Symbol('IMAGE_JOB_HANDLER');
export const IMAGE_JOB_ENQUEUER = Symbol('IMAGE_JOB_ENQUEUER');

export interface ImageJobHandler {
  process(payload: { tenantId: string; jobId: string }): Promise<void>;
}

export interface ImageJobEnqueuer {
  enqueueImageJob(job: { tenantId: string; jobId: string }): Promise<void>;
}

export function signMediaAssetVariant(
  tenantId: string,
  assetId: string,
  variant: 'file' | 'thumb',
): string {
  const secret = parseEnv(process.env).JWT_ACCESS_SECRET;
  return createHmac('sha256', secret)
    .update(`${tenantId}:${assetId}:${variant}`)
    .digest('hex')
    .slice(0, 32);
}

export function buildSignedMediaAssetUrl(
  tenantId: string,
  assetId: string,
  variant: 'file' | 'thumb',
): string {
  const sig = signMediaAssetVariant(tenantId, assetId, variant);
  return `/api/v1/media-assets/${assetId}/${variant}?tid=${encodeURIComponent(tenantId)}&sig=${sig}`;
}

function deterministicAssetId(jobId: string, index: number): string {
  const safeSuffix = jobId.replace(/[^A-Za-z0-9]/g, '').slice(-18) || 'job';
  return `med_ai_${safeSuffix}_${index}`;
}

function readableImageError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === API_ERROR.QUOTA_EXCEEDED) {
      return '存储空间配额不足，未入库图片已自动退点';
    }
    if (error.code === API_ERROR.FORBIDDEN_INDUSTRY) {
      return '提示词包含平台禁做或敏感内容（已退还预冻点数）';
    }
    return error.message;
  }
  if (error instanceof ProviderError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 180);
  }
  return '图片生成失败（已退还预冻点数）';
}

@Injectable()
export class ImageJobRunner implements ImageJobHandler {
  private readonly logger = new Logger(ImageJobRunner.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ImageService) private readonly imageService: ImageService,
  ) {}

  private async fallbackUnitPoints(): Promise<number> {
    const item = await this.prisma.base.pricingItem.findUnique({
      where: { action: 'image_gen' },
    });
    if (item) return item.unitPoints;
    const def = PRICING_DEFAULTS.find((row) => row.action === 'image_gen');
    return def?.unitPoints ?? AI_IMAGE_DEFAULT_UNIT_POINTS;
  }

  async process(payload: { tenantId: string; jobId: string }): Promise<void> {
    const { tenantId, jobId } = payload;
    const job = await this.prisma.base.aiImageJob.findFirst({
      where: { id: jobId, tenantId },
    });
    if (!job) return;
    if (
      job.status === 'COMPLETED' ||
      job.status === 'PARTIAL' ||
      job.status === 'FAILED' ||
      job.status === 'CANCELLED'
    ) {
      return;
    }

    await this.prisma.base.aiImageJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', error: null },
    });

    const reservation = await this.prisma.base.pointReservation.findUnique({
      where: { refType_refId: { refType: 'image_job', refId: job.id } },
      select: { id: true, tenantId: true, frozen: true, status: true },
    });
    const reservationId = reservation && reservation.tenantId === tenantId ? reservation.id : null;

    const safeCount: AiImageCount = job.count === 4 ? 4 : job.count === 2 ? 2 : 1;
    const unitPoints =
      reservation && reservation.frozen > 0
        ? Math.max(1, Math.floor(reservation.frozen / safeCount))
        : await this.fallbackUnitPoints();

    let targetCategoryId: string | null = null;
    if (job.saveCategoryId) {
      const cat = await this.prisma.base.mediaCategory.findFirst({
        where: {
          id: job.saveCategoryId,
          tenantId,
          type: GALLERY_CATEGORY_TYPE_IMAGE,
        },
        select: { id: true },
      });
      targetCategoryId = cat?.id ?? null;
    }

    const ratio: AiImageRatio = isAiImageRatio(job.ratio) ? job.ratio : AI_IMAGE_DEFAULT_RATIO;

    let rawResult;
    try {
      if (isProductionPlaceholderImageBlocked()) {
        throw new ProviderError(
          PROVIDER_KIND.UPSTREAM,
          '当前未配置真实 AI 生图服务，已拒绝生成演示占位图并退还预冻点数',
          'placeholder_blocked',
        );
      }
      rawResult = await this.imageService.generateRaw({
        tenantId,
        prompt: job.prompt,
        style: job.style ?? undefined,
        ratio,
        count: safeCount,
      });
      if (process.env.NODE_ENV === 'production' && rawResult.fake) {
        throw new ProviderError(
          PROVIDER_KIND.UPSTREAM,
          '当前未配置真实 AI 生图服务，已拒绝生成演示占位图并退还预冻点数',
          'placeholder_blocked',
        );
      }
    } catch (error) {
      const reason = readableImageError(error);
      if (reservationId) {
        await this.billing.close({ tenantId, reservationId }).catch((closeErr) => {
          this.logger.warn(`failed to close reservation ${reservationId}: ${String(closeErr)}`);
        });
      }
      await this.prisma.base.aiImageJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          successCount: 0,
          error: reason,
        },
      });
      return;
    }

    let successCount = 0;
    let resolvedModel: string | null = null;
    const errors: string[] = [];
    const ledgerSubject = buildImageLedgerTitle(job.prompt);

    for (let idx = 0; idx < rawResult.items.length; idx += 1) {
      const rawItem = rawResult.items[idx];
      if (!rawItem) continue;
      resolvedModel = rawItem.model || resolvedModel;

      const seq = idx + 1;
      const assetId = deterministicAssetId(job.id, seq);
      const mainName = `media-${assetId}.jpg`;
      const thumbName = `media-${assetId}-thumb.jpg`;
      const unitKey = `image_job_item:${job.id}:${seq}`;

      const existingAsset = await this.prisma.base.mediaAsset.findFirst({
        where: { id: assetId, tenantId },
        select: { id: true },
      });

      if (existingAsset) {
        if (reservationId) {
          await this.billing.settle({
            tenantId,
            reservationId,
            unitKey,
            action: 'image_gen',
            amount: unitPoints,
            title: ledgerSubject,
            detail: { jobId: job.id, seq, ratio },
          });
        }
        successCount += 1;
        continue;
      }

      try {
        let compressed = await compressImage(rawItem.body);
        const targetDims = resolveAiImageRatioDimensions(ratio);
        const targetAspect = targetDims.width / targetDims.height;
        const actualAspect = compressed.width / Math.max(1, compressed.height);
        if (Math.abs(actualAspect - targetAspect) / targetAspect > 0.12) {
          const croppedWidth =
            actualAspect > targetAspect
              ? Math.max(1, Math.round(compressed.height * targetAspect))
              : compressed.width;
          const croppedHeight =
            actualAspect > targetAspect
              ? compressed.height
              : Math.max(1, Math.round(compressed.width / targetAspect));
          const croppedBuf = await sharp(rawItem.body)
            .resize({
              width: croppedWidth,
              height: croppedHeight,
              fit: 'cover',
              position: 'centre',
            })
            .toBuffer();
          compressed = await compressImage(croppedBuf);
        }
        const thumbBuffer = await sharp(compressed.body)
          .resize({
            width: GALLERY_THUMB_MAX_EDGE,
            height: GALLERY_THUMB_MAX_EDGE,
            fit: 'cover',
          })
          .jpeg({ quality: 75 })
          .toBuffer();

        const storedMain = await this.storage.put({
          tenantId,
          name: mainName,
          body: compressed.body,
          contentType: compressed.contentType,
          idempotencyKey: `ai_img:${assetId}:main`,
        });
        await this.storage.put({
          tenantId,
          name: thumbName,
          body: thumbBuffer,
          contentType: 'image/jpeg',
          idempotencyKey: `ai_img:${assetId}:thumb`,
        });

        try {
          await this.prisma.base.$transaction(async (tx) => {
            await this.quota.consume(tenantId, 'STORAGE_BYTES', compressed.bytes, tx);
            await tx.mediaAsset.create({
              data: {
                id: assetId,
                tenantId,
                categoryId: targetCategoryId,
                origin: 'AI_IMAGE',
                aiImageId: job.id,
                objectKey: storedMain.key,
                url: buildSignedMediaAssetUrl(tenantId, assetId, 'file'),
                thumbUrl: buildSignedMediaAssetUrl(tenantId, assetId, 'thumb'),
                width: compressed.width,
                height: compressed.height,
                bytes: compressed.bytes,
                mime: compressed.contentType,
              },
            });
          }, TX_OPTIONS);
        } catch (dbErr) {
          await Promise.allSettled([
            this.storage.delete(tenantId, mainName),
            this.storage.delete(tenantId, thumbName),
          ]);
          throw dbErr;
        }

        if (reservationId) {
          await this.billing.settle({
            tenantId,
            reservationId,
            unitKey,
            action: 'image_gen',
            amount: unitPoints,
            title: ledgerSubject,
            detail: { jobId: job.id, seq, assetId, ratio },
          });
        }
        successCount += 1;
      } catch (itemErr) {
        errors.push(readableImageError(itemErr));
      }
    }

    if (reservationId) {
      await this.billing.close({ tenantId, reservationId }).catch((closeErr) => {
        this.logger.warn(`failed to close reservation ${reservationId}: ${String(closeErr)}`);
      });
    }

    const terminalStatus =
      successCount >= safeCount ? 'COMPLETED' : successCount > 0 ? 'PARTIAL' : 'FAILED';

    const finalError =
      errors.length > 0
        ? successCount > 0
          ? `成功 ${successCount}/${safeCount} 张；${errors[0]}`
          : (errors[0] ?? '图片生成失败（已退还预冻点数）')
        : null;

    await this.prisma.base.aiImageJob.update({
      where: { id: job.id },
      data: {
        status: terminalStatus,
        successCount,
        model: resolvedModel,
        error: finalError,
      },
    });
  }
}
