import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_MEDIA_FILE_FORMAT_MSG,
  BRAND_MEDIA_FILE_TOO_LARGE_MSG,
  BRAND_MEDIA_THUMB_MAX_EDGE,
  BRAND_MEDIA_UPLOAD_MAX_FILES,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_OUTPUT_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_WARN_WIDTH,
  QUOTA_DEFAULTS,
  buildStorageSummary,
  checkImageWidthWarning,
  parseEnv,
  sanitizeMediaOriginalName,
  type BrandMediaAssetRecord,
  type BrandMediaDeleteResponse,
  type BrandMediaListResponse,
  type BrandMediaOrigin,
  type BrandMediaUploadResponse,
  type MediaStorageSummary,
  type UpdateBrandMediaInput,
} from '@geomix/shared';
import sharp from 'sharp';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { compressImage, placeholderPng } from '../infra/compress';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { StorageService } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import {
  GALLERY_MAX_INPUT_BYTES_TOKEN,
  objectNameFromKey,
  type UploadedFileLike,
} from './brands.http-utils';

const ALLOWED_DECLARED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/octet-stream',
]);

type BrandMediaRow = {
  id: string;
  brandId: string;
  origin: string;
  title: string;
  objectKey: string;
  thumbKey: string | null;
  url: string;
  thumbUrl: string | null;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  aiPrompt: string | null;
  aiModel: string | null;
  usedCount: number;
  createdAt: Date;
};

export const MEDIA_URL_TTL_SECONDS = 86_400;

@Injectable()
export class BrandMediaService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(GALLERY_MAX_INPUT_BYTES_TOKEN) private readonly maxInputBytes: () => number,
  ) {}

  computeMediaExpiry(
    nowMs: number = Date.now(),
    ttlSeconds: number = MEDIA_URL_TTL_SECONDS,
  ): number {
    const safeTtl = Math.max(1, Math.floor(ttlSeconds));
    return Math.floor(nowMs / 1000) + safeTtl;
  }

  signMediaVariant(
    tenantId: string,
    brandId: string,
    mediaId: string,
    variant: 'file' | 'thumb',
    exp: number,
  ): string {
    const secret = parseEnv(process.env).JWT_ACCESS_SECRET;
    return createHmac('sha256', secret)
      .update(`${tenantId}:${brandId}:${mediaId}:${variant}:${exp}`)
      .digest('hex')
      .slice(0, 32);
  }

  verifyMediaVariant(
    tenantId: string,
    brandId: string,
    mediaId: string,
    variant: 'file' | 'thumb',
    sig: unknown,
    rawExp: unknown,
    nowMs: number = Date.now(),
  ): boolean {
    if (typeof tenantId !== 'string' || !tenantId.trim()) return false;
    if (typeof sig !== 'string' || !/^[0-9a-f]{32}$/i.test(sig)) return false;
    const expStr =
      typeof rawExp === 'number' ? String(rawExp) : typeof rawExp === 'string' ? rawExp.trim() : '';
    if (!/^\d{1,12}$/.test(expStr)) return false;
    const exp = Number(expStr);
    if (!Number.isSafeInteger(exp) || exp <= 0) return false;
    const nowSec = Math.floor(nowMs / 1000);
    if (exp <= nowSec) return false;

    const expected = this.signMediaVariant(tenantId, brandId, mediaId, variant, exp);
    const actualBuf = Buffer.from(sig.toLowerCase(), 'utf8');
    const expectedBuf = Buffer.from(expected.toLowerCase(), 'utf8');
    if (actualBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(actualBuf, expectedBuf);
  }

  async listMedia(tenantId: string, brandId: string): Promise<BrandMediaListResponse> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: { id: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    const rows = await this.prisma.scoped.brandMediaAsset.findMany({
      where: { brandId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const storage = await this.readStorageSummary(tenantId);
    return {
      items: rows.map((row) => this.presentAsset(tenantId, row)),
      storage,
    };
  }

  async uploadMedia(
    tenantId: string,
    userId: string,
    brandId: string,
    files: readonly UploadedFileLike[],
    defaultTitle?: string,
  ): Promise<BrandMediaUploadResponse> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: { id: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    if (!Array.isArray(files) || files.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请选择至少一张产品图片');
    }
    if (files.length > BRAND_MEDIA_UPLOAD_MAX_FILES) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `单次最多上传 ${BRAND_MEDIA_UPLOAD_MAX_FILES} 张图片`,
      );
    }

    const maxBytes = this.maxInputBytes();
    const uploadedItems: BrandMediaAssetRecord[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '图片文件为空');
      }
      if (file.buffer.length > maxBytes) {
        throw new ApiError(413, API_ERROR.BAD_REQUEST, BRAND_MEDIA_FILE_TOO_LARGE_MSG);
      }

      const declaredMime = (file.mimetype ?? '').trim().toLowerCase();
      if (declaredMime && !ALLOWED_DECLARED_MIMES.has(declaredMime)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, BRAND_MEDIA_FILE_FORMAT_MSG);
      }

      let compressed;
      try {
        compressed = await compressImage(file.buffer, {
          maxInputBytes: maxBytes,
          maxOutputBytes: IMAGE_MAX_OUTPUT_BYTES,
          maxEdge: IMAGE_MAX_EDGE,
          maxPixels: IMAGE_MAX_PIXELS,
          warnWidth: IMAGE_WARN_WIDTH,
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          if (error.kind === PROVIDER_KIND.TOO_LARGE) {
            throw new ApiError(413, API_ERROR.BAD_REQUEST, error.message);
          }
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            error.message || BRAND_MEDIA_FILE_FORMAT_MSG,
          );
        }
        throw new ApiError(400, API_ERROR.BAD_REQUEST, BRAND_MEDIA_FILE_FORMAT_MSG);
      }

      const widthWarning = checkImageWidthWarning(compressed.width);
      if (widthWarning) {
        warnings.push(widthWarning);
      }

      const thumbBuffer = await sharp(compressed.body)
        .resize({
          width: BRAND_MEDIA_THUMB_MAX_EDGE,
          height: BRAND_MEDIA_THUMB_MAX_EDGE,
          fit: 'cover',
        })
        .jpeg({ quality: 75 })
        .toBuffer();

      const explicitTitle = files.length === 1 ? defaultTitle?.trim() : '';
      const cleanName = sanitizeMediaOriginalName(file.originalname);
      const fallbackTitle = cleanName ? cleanName.replace(/\.[^.]+$/, '').trim() : '';
      const title = (explicitTitle || fallbackTitle || '产品实拍图').slice(0, 120);

      await this.compliance.assertAllowed({
        text: title,
        action: 'brand_media_upload',
        tenantId,
        userId,
      });

      const assetId = `bma_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
      const mainName = `brand-media-${assetId}.jpg`;
      const thumbName = `brand-media-${assetId}-thumb.jpg`;

      const storedMain = await this.storage.put({
        tenantId,
        name: mainName,
        body: compressed.body,
        contentType: compressed.contentType,
        idempotencyKey: `brand-media-main-${assetId}`,
      });

      let storedThumb;
      try {
        storedThumb = await this.storage.put({
          tenantId,
          name: thumbName,
          body: thumbBuffer,
          contentType: 'image/jpeg',
          idempotencyKey: `brand-media-thumb-${assetId}`,
        });
      } catch (error) {
        await this.storage.delete(tenantId, mainName).catch(() => undefined);
        throw error;
      }

      const url = `/api/v2/brands/${brandId}/media/${assetId}/file`;
      const thumbUrl = `/api/v2/brands/${brandId}/media/${assetId}/thumb`;

      try {
        const created = await this.prisma.base.$transaction(async (tx) => {
          await this.quota.consume(tenantId, 'STORAGE_BYTES', compressed.bytes, tx);
          return tx.brandMediaAsset.create({
            data: {
              id: assetId,
              tenantId,
              brandId,
              origin: 'PRODUCT_UPLOAD',
              title,
              objectKey: storedMain.key,
              thumbKey: storedThumb.key,
              url,
              thumbUrl,
              mime: compressed.contentType,
              bytes: compressed.bytes,
              width: compressed.width,
              height: compressed.height,
            },
          });
        }, TX_OPTIONS);

        uploadedItems.push(this.presentAsset(tenantId, created));
      } catch (error) {
        await Promise.allSettled([
          this.storage.delete(tenantId, mainName),
          this.storage.delete(tenantId, thumbName),
        ]);
        throw error;
      }
    }

    const storage = await this.readStorageSummary(tenantId);
    return {
      items: uploadedItems,
      item: uploadedItems[0]!,
      warnings,
      storage,
    };
  }

  async updateMedia(
    tenantId: string,
    userId: string,
    brandId: string,
    mediaId: string,
    input: UpdateBrandMediaInput,
  ): Promise<BrandMediaAssetRecord> {
    const title = input.title.trim();
    await this.compliance.assertAllowed({
      text: title,
      action: 'brand_media_update',
      tenantId,
      userId,
    });

    const existing = await this.prisma.scoped.brandMediaAsset.findFirst({
      where: { id: mediaId, brandId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '图片不存在');
    }

    const updated = await this.prisma.scoped.brandMediaAsset.update({
      where: { id: mediaId },
      data: { title },
    });
    return this.presentAsset(tenantId, updated);
  }

  async removeMedia(
    tenantId: string,
    brandId: string,
    mediaId: string,
  ): Promise<BrandMediaDeleteResponse> {
    const existing = await this.prisma.scoped.brandMediaAsset.findFirst({
      where: { id: mediaId, brandId },
      select: { id: true, bytes: true, objectKey: true, thumbKey: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '图片不存在');
    }

    const releasedBytes = Math.max(0, existing.bytes);

    await this.prisma.base.$transaction(async (tx) => {
      const deleted = await tx.brandMediaAsset.deleteMany({
        where: { id: mediaId, brandId, tenantId },
      });
      if (deleted.count !== 1) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '图片不存在');
      }
      if (releasedBytes > 0) {
        await this.quota.release(tenantId, 'STORAGE_BYTES', releasedBytes, tx);
      }
    }, TX_OPTIONS);

    await this.cleanupForBrand(tenantId, [existing]);

    const storage = await this.readStorageSummary(tenantId);
    return {
      deleted: 1,
      id: mediaId,
      releasedBytes,
      storage,
    };
  }

  async readAssetBytes(
    tenantId: string,
    brandId: string,
    mediaId: string,
    variant: 'file' | 'thumb',
  ): Promise<{ body: Buffer; contentType: string }> {
    const asset = await runInTenant(tenantId, () =>
      this.prisma.scoped.brandMediaAsset.findFirst({
        where: { id: mediaId, brandId },
        select: { id: true, objectKey: true, thumbKey: true, mime: true },
      }),
    );
    if (!asset) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '图片不存在');
    }

    const mainName = objectNameFromKey(tenantId, asset.objectKey);
    const thumbName = objectNameFromKey(tenantId, asset.thumbKey);

    if (variant === 'thumb' && thumbName) {
      const thumbObj = await this.storage.get(tenantId, thumbName);
      if (thumbObj) return thumbObj;
    }
    if (mainName) {
      const mainObj = await this.storage.get(tenantId, mainName);
      if (mainObj) return mainObj;
    }

    const fallback = await placeholderPng(`${tenantId}:${brandId}:${mediaId}:${variant}`);
    return { body: fallback, contentType: 'image/png' };
  }

  async cleanupForBrand(
    tenantId: string,
    assets: ReadonlyArray<{ objectKey: string; thumbKey: string | null }>,
  ): Promise<void> {
    const names = new Set<string>();
    for (const asset of assets) {
      const mainName = objectNameFromKey(tenantId, asset.objectKey);
      if (mainName) names.add(mainName);
      const thumbName = objectNameFromKey(tenantId, asset.thumbKey);
      if (thumbName) names.add(thumbName);
    }
    if (names.size > 0) {
      await Promise.allSettled(
        Array.from(names).map((name) => this.storage.delete(tenantId, name)),
      );
    }
  }

  private async readStorageSummary(tenantId: string): Promise<MediaStorageSummary> {
    const rows = await this.quota.read(tenantId);
    const storageRow = rows.find((row) => row.key === 'STORAGE_BYTES');
    const defaultLimit =
      QUOTA_DEFAULTS.find((item) => item.key === 'STORAGE_BYTES')?.limit ?? 100 * 1024 * 1024;
    return buildStorageSummary(storageRow?.used ?? 0n, storageRow?.limit ?? BigInt(defaultLimit));
  }

  private presentAsset(
    tenantId: string,
    row: BrandMediaRow,
    nowMs: number = Date.now(),
    ttlSeconds: number = MEDIA_URL_TTL_SECONDS,
  ): BrandMediaAssetRecord {
    const origin: BrandMediaOrigin =
      row.origin === 'AI_INLINE_GEN' ? 'AI_INLINE_GEN' : 'PRODUCT_UPLOAD';
    const exp = this.computeMediaExpiry(nowMs, ttlSeconds);
    const fileSig = this.signMediaVariant(tenantId, row.brandId, row.id, 'file', exp);
    const thumbSig = this.signMediaVariant(tenantId, row.brandId, row.id, 'thumb', exp);
    const tidParam = encodeURIComponent(tenantId);

    return {
      id: row.id,
      brandId: row.brandId,
      origin,
      title: row.title,
      objectKey: row.objectKey,
      thumbKey: row.thumbKey,
      url: `${row.url}?tid=${tidParam}&exp=${exp}&sig=${fileSig}`,
      thumbUrl: row.thumbUrl ? `${row.thumbUrl}?tid=${tidParam}&exp=${exp}&sig=${thumbSig}` : null,
      mime: row.mime,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      aiPrompt: row.aiPrompt,
      aiModel: row.aiModel,
      usedCount: row.usedCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
