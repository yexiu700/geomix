import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  GALLERY_CATEGORY_TYPE_IMAGE,
  GALLERY_FILE_TOO_LARGE_MSG,
  GALLERY_PREVIEW_LIMIT,
  GALLERY_THUMB_MAX_EDGE,
  GALLERY_UPLOAD_MAX_FILES,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_INPUT_BYTES,
  IMAGE_MAX_OUTPUT_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_WARN_WIDTH,
  buildStorageSummary,
  escapeLikeLiteral,
  parseEnv,
  type MediaAssetListQuery,
  type MediaAssetListResponse,
  type MediaAssetPreview,
  type MediaAssetRecord,
  type MediaCategoryListQuery,
  type MediaCategoryListResponse,
  type MediaCategoryRecord,
  type MediaCategoryWriteInput,
  type MediaOriginName,
  type MediaStorageSummary,
  type MediaUploadJsonInput,
  type MediaUploadResponse,
  type MediaUploadResultItem,
} from '@geomix/shared';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { compressImage, placeholderPng } from '../infra/compress';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { StorageService } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

export const GALLERY_MAX_INPUT_BYTES_TOKEN = Symbol('GALLERY_MAX_INPUT_BYTES_TOKEN');

export type RawUploadFile = {
  filename?: string;
  buffer: Buffer;
};

type CategoryRow = {
  id: string;
  name: string;
  type: number;
  createdAt: Date;
  _count: { assets: number };
  assets: Array<{
    id: string;
    url: string;
    thumbUrl: string | null;
    width: number;
    height: number;
  }>;
};

type AssetRow = {
  id: string;
  categoryId: string | null;
  origin: MediaOriginName;
  objectKey: string;
  url: string;
  thumbUrl: string | null;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  usedCount: number;
  createdAt: Date;
  category: { id: string; name: string } | null;
};

function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function generateAssetId(): string {
  return `med_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function mainObjectName(assetId: string): string {
  return `media-${assetId}.jpg`;
}

function thumbObjectName(assetId: string): string {
  return `media-${assetId}-thumb.jpg`;
}

function objectNameFromKey(tenantId: string, objectKey: string): string | null {
  const prefix = `tenants/${tenantId}/`;
  if (!objectKey.startsWith(prefix)) return null;
  return objectKey.slice(prefix.length);
}

@Injectable()
export class GalleryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(GALLERY_MAX_INPUT_BYTES_TOKEN)
    private readonly maxInputBytes: () => number,
  ) {}

  private signingSecret(): string {
    return parseEnv(process.env).JWT_ACCESS_SECRET;
  }

  signAssetVariant(tenantId: string, assetId: string, variant: 'file' | 'thumb'): string {
    return createHmac('sha256', this.signingSecret())
      .update(`${tenantId}:${assetId}:${variant}`)
      .digest('hex')
      .slice(0, 32);
  }

  verifyAssetVariant(
    tenantId: string,
    assetId: string,
    variant: 'file' | 'thumb',
    sig: string,
  ): boolean {
    if (!sig || sig.length !== 32 || !/^[0-9a-f]{32}$/.test(sig)) return false;
    const expected = this.signAssetVariant(tenantId, assetId, variant);
    return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  }

  private signedAssetUrl(tenantId: string, assetId: string, variant: 'file' | 'thumb'): string {
    const sig = this.signAssetVariant(tenantId, assetId, variant);
    return `/api/v1/media-assets/${assetId}/${variant}?tid=${encodeURIComponent(tenantId)}&sig=${sig}`;
  }

  private presentCategory(tenantId: string, row: CategoryRow): MediaCategoryRecord {
    const previewAssets: MediaAssetPreview[] = row.assets.map((asset) => ({
      id: asset.id,
      url: this.signedAssetUrl(tenantId, asset.id, 'file'),
      thumbUrl: this.signedAssetUrl(tenantId, asset.id, 'thumb'),
      width: asset.width,
      height: asset.height,
    }));
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      assetCount: row._count.assets,
      previewAssets,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private presentAsset(tenantId: string, row: AssetRow): MediaAssetRecord {
    return {
      id: row.id,
      categoryId: row.categoryId,
      categoryName: row.category?.name ?? null,
      origin: row.origin,
      objectKey: row.objectKey,
      url: this.signedAssetUrl(tenantId, row.id, 'file'),
      thumbUrl: this.signedAssetUrl(tenantId, row.id, 'thumb'),
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      mime: row.mime,
      usedCount: row.usedCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async readStorage(tenantId: string): Promise<MediaStorageSummary> {
    const rows = await this.quota.read(tenantId);
    const storageRow = rows.find((row) => row.key === 'STORAGE_BYTES');
    if (!storageRow) {
      return buildStorageSummary(0n, 100n * 1024n * 1024n);
    }
    return buildStorageSummary(storageRow.used, storageRow.limit);
  }

  private categoryWhere(query: MediaCategoryListQuery): Prisma.MediaCategoryWhereInput {
    const where: Prisma.MediaCategoryWhereInput = {
      type: GALLERY_CATEGORY_TYPE_IMAGE,
    };
    if (query.q) {
      where.name = {
        contains: escapeLikeLiteral(query.q),
        mode: 'insensitive',
      };
    }
    return where;
  }

  async pageCategories(query: MediaCategoryListQuery): Promise<MediaCategoryListResponse> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const where = this.categoryWhere(query);
    const [total, rows, storage] = await Promise.all([
      this.prisma.scoped.mediaCategory.count({ where }),
      this.prisma.scoped.mediaCategory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          _count: { select: { assets: true } },
          assets: {
            orderBy: { createdAt: 'desc' },
            take: GALLERY_PREVIEW_LIMIT,
            select: { id: true, url: true, thumbUrl: true, width: true, height: true },
          },
        },
      }),
      this.readStorage(tenantId),
    ]);
    return {
      items: rows.map((row) => this.presentCategory(tenantId, row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      storage,
    };
  }

  async collectCategories(query: MediaCategoryListQuery): Promise<MediaCategoryRecord[]> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const rows = await this.prisma.scoped.mediaCategory.findMany({
      where: this.categoryWhere(query),
      orderBy: { createdAt: 'desc' },
      take: CRUD_EXPORT_LIMIT + 1,
      include: {
        _count: { select: { assets: true } },
        assets: {
          orderBy: { createdAt: 'desc' },
          take: GALLERY_PREVIEW_LIMIT,
          select: { id: true, url: true, thumbUrl: true, width: true, height: true },
        },
      },
    });
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多');
    }
    return rows.map((row) => this.presentCategory(tenantId, row));
  }

  async createCategory(
    input: MediaCategoryWriteInput & { userId?: string },
  ): Promise<MediaCategoryRecord> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    await this.compliance.assertAllowed({
      text: input.name,
      action: 'media_category',
      tenantId,
      userId: input.userId,
    });
    try {
      const created = await this.prisma.scoped.mediaCategory.create({
        data: {
          tenantId,
          type: GALLERY_CATEGORY_TYPE_IMAGE,
          name: input.name,
        },
        include: {
          _count: { select: { assets: true } },
          assets: {
            orderBy: { createdAt: 'desc' },
            take: GALLERY_PREVIEW_LIMIT,
            select: { id: true, url: true, thumbUrl: true, width: true, height: true },
          },
        },
      });
      return this.presentCategory(tenantId, created);
    } catch (error) {
      if (isUniqueError(error)) {
        throw new ApiError(409, API_ERROR.BAD_REQUEST, '该素材分类已存在');
      }
      throw error;
    }
  }

  async updateCategory(
    id: string,
    input: MediaCategoryWriteInput & { userId?: string },
  ): Promise<MediaCategoryRecord> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const existing = await this.prisma.scoped.mediaCategory.findFirst({
      where: { id, type: GALLERY_CATEGORY_TYPE_IMAGE },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '素材分类不存在');
    await this.compliance.assertAllowed({
      text: input.name,
      action: 'media_category',
      tenantId,
      userId: input.userId,
    });
    try {
      const updated = await this.prisma.scoped.mediaCategory.update({
        where: { id },
        data: { name: input.name },
        include: {
          _count: { select: { assets: true } },
          assets: {
            orderBy: { createdAt: 'desc' },
            take: GALLERY_PREVIEW_LIMIT,
            select: { id: true, url: true, thumbUrl: true, width: true, height: true },
          },
        },
      });
      return this.presentCategory(tenantId, updated);
    } catch (error) {
      if (isUniqueError(error)) {
        throw new ApiError(409, API_ERROR.BAD_REQUEST, '该素材分类已存在');
      }
      throw error;
    }
  }

  async removeCategories(ids: readonly string[]): Promise<{ deleted: number }> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const uniqueIds = Array.from(new Set(ids));
    const rows = await this.prisma.scoped.mediaCategory.findMany({
      where: { id: { in: uniqueIds }, type: GALLERY_CATEGORY_TYPE_IMAGE },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            assets: true,
            aiTasks: true,
            batches: true,
            records: true,
          },
        },
      },
    });
    if (rows.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '素材分类不存在');
    }
    for (const row of rows) {
      if (row._count.assets > 0) {
        throw new ApiError(
          409,
          API_ERROR.BAD_REQUEST,
          `素材分类「${row.name}」下仍有图片，禁止删除`,
        );
      }
      if (row._count.aiTasks > 0 || row._count.batches > 0 || row._count.records > 0) {
        throw new ApiError(
          409,
          API_ERROR.BAD_REQUEST,
          `素材分类「${row.name}」已被写作或复刻任务引用，禁止删除`,
        );
      }
    }
    const result = await this.prisma.scoped.mediaCategory.deleteMany({
      where: { id: { in: uniqueIds }, type: GALLERY_CATEGORY_TYPE_IMAGE },
    });
    return { deleted: result.count };
  }

  private assetWhere(query: MediaAssetListQuery): Prisma.MediaAssetWhereInput {
    const where: Prisma.MediaAssetWhereInput = {};
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.q) {
      where.objectKey = {
        contains: escapeLikeLiteral(query.q),
        mode: 'insensitive',
      };
    }
    return where;
  }

  async pageAssets(query: MediaAssetListQuery): Promise<MediaAssetListResponse> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    let category: { id: string; name: string } | null = null;
    if (query.categoryId) {
      const found = await this.prisma.scoped.mediaCategory.findFirst({
        where: { id: query.categoryId, type: GALLERY_CATEGORY_TYPE_IMAGE },
        select: { id: true, name: true },
      });
      if (!found) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '素材分类不存在');
      category = found;
    }
    const where = this.assetWhere(query);
    const [total, rows, storage] = await Promise.all([
      this.prisma.scoped.mediaAsset.count({ where }),
      this.prisma.scoped.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { category: { select: { id: true, name: true } } },
      }),
      this.readStorage(tenantId),
    ]);
    return {
      category,
      items: rows.map((row) => this.presentAsset(tenantId, row as AssetRow)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      storage,
    };
  }

  async collectAssets(query: MediaAssetListQuery): Promise<MediaAssetRecord[]> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const rows = await this.prisma.scoped.mediaAsset.findMany({
      where: this.assetWhere(query),
      orderBy: { createdAt: 'desc' },
      take: CRUD_EXPORT_LIMIT + 1,
      include: { category: { select: { id: true, name: true } } },
    });
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多');
    }
    return rows.map((row) => this.presentAsset(tenantId, row as AssetRow));
  }

  async uploadJson(input: MediaUploadJsonInput): Promise<MediaUploadResponse> {
    const files: RawUploadFile[] = input.files.map((item) => {
      const cleaned = item.contentBase64.replace(/^data:[^;]+;base64,/i, '').trim();
      if (!cleaned) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '图片内容不能为空');
      }
      const estimatedBytes = Math.floor((cleaned.length * 3) / 4);
      if (estimatedBytes > this.maxInputBytes()) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, GALLERY_FILE_TOO_LARGE_MSG);
      }
      const buffer = Buffer.from(cleaned, 'base64');
      if (buffer.length === 0) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '图片内容无法解码');
      }
      return { filename: item.filename, buffer };
    });
    return this.uploadBuffers(input.categoryId, files);
  }

  async uploadBuffers(categoryId: string, files: RawUploadFile[]): Promise<MediaUploadResponse> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    if (files.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请至少选择一张图片');
    }
    if (files.length > GALLERY_UPLOAD_MAX_FILES) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `单次最多上传 ${GALLERY_UPLOAD_MAX_FILES} 张图片`,
      );
    }

    const category = await this.prisma.scoped.mediaCategory.findFirst({
      where: { id: categoryId, type: GALLERY_CATEGORY_TYPE_IMAGE },
      select: { id: true, name: true },
    });
    if (!category) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '素材分类不存在');
    }

    const limitBytes = this.maxInputBytes();
    for (const file of files) {
      if (file.buffer.length > limitBytes) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, GALLERY_FILE_TOO_LARGE_MSG);
      }
    }

    const items: MediaUploadResultItem[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      let compressed;
      try {
        compressed = await compressImage(file.buffer, {
          maxInputBytes: limitBytes,
          maxOutputBytes: IMAGE_MAX_OUTPUT_BYTES,
          maxEdge: IMAGE_MAX_EDGE,
          maxPixels: IMAGE_MAX_PIXELS,
          warnWidth: IMAGE_WARN_WIDTH,
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          if (error.kind === PROVIDER_KIND.TOO_LARGE && error.reason === 'input') {
            throw new ApiError(400, API_ERROR.BAD_REQUEST, GALLERY_FILE_TOO_LARGE_MSG);
          }
          throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
        }
        throw error;
      }

      const thumbBuffer = await sharp(compressed.body)
        .resize({
          width: GALLERY_THUMB_MAX_EDGE,
          height: GALLERY_THUMB_MAX_EDGE,
          fit: 'cover',
        })
        .jpeg({ quality: 75 })
        .toBuffer();

      const assetId = generateAssetId();
      const mainName = mainObjectName(assetId);
      const thumbName = thumbObjectName(assetId);

      const storedMain = await this.storage.put({
        tenantId,
        name: mainName,
        body: compressed.body,
        contentType: compressed.contentType,
        idempotencyKey: `upload:${assetId}:main`,
      });
      await this.storage.put({
        tenantId,
        name: thumbName,
        body: thumbBuffer,
        contentType: 'image/jpeg',
        idempotencyKey: `upload:${assetId}:thumb`,
      });

      let created: AssetRow;
      try {
        created = await this.prisma.base.$transaction(async (tx) => {
          await this.quota.consume(tenantId, 'STORAGE_BYTES', compressed.bytes, tx);
          return tx.mediaAsset.create({
            data: {
              id: assetId,
              tenantId,
              categoryId: category.id,
              origin: 'UPLOAD',
              objectKey: storedMain.key,
              url: `/api/v1/media-assets/${assetId}/file`,
              thumbUrl: `/api/v1/media-assets/${assetId}/thumb`,
              width: compressed.width,
              height: compressed.height,
              bytes: compressed.bytes,
              mime: compressed.contentType,
            },
            include: { category: { select: { id: true, name: true } } },
          }) as Promise<AssetRow>;
        }, TX_OPTIONS);
      } catch (error) {
        await Promise.allSettled([
          this.storage.delete(tenantId, mainName),
          this.storage.delete(tenantId, thumbName),
        ]);
        throw error;
      }

      const label = file.filename?.trim() || assetId;
      const warningText = compressed.warning
        ? `${label}：图片宽度 ${compressed.width}px 小于建议值 500px（仅提示，已完成上传）`
        : undefined;
      if (warningText) warnings.push(warningText);

      items.push({
        asset: this.presentAsset(tenantId, created),
        warning: warningText,
      });
    }

    const storage = await this.readStorage(tenantId);
    return { items, warnings, storage };
  }

  async removeAssets(ids: readonly string[]): Promise<{
    deleted: number;
    releasedBytes: number;
    storage: MediaStorageSummary;
  }> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const uniqueIds = Array.from(new Set(ids));
    const assets = await this.prisma.scoped.mediaAsset.findMany({
      where: { id: { in: uniqueIds } },
      select: {
        id: true,
        bytes: true,
        usedCount: true,
        objectKey: true,
      },
    });
    if (assets.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '图片素材不存在');
    }

    for (const asset of assets) {
      if (asset.usedCount > 0) {
        throw new ApiError(409, API_ERROR.BAD_REQUEST, '所选图片已被文章使用，禁止删除');
      }
      const [articleRefCount, imageJobRefCount] = await Promise.all([
        this.prisma.base.article.count({
          where: {
            tenantId,
            OR: [
              { coverUrl: { contains: `/media-assets/${asset.id}/` } },
              { contentHtml: { contains: `/media-assets/${asset.id}/` } },
            ],
          },
        }),
        this.prisma.base.aiImageJob.count({
          where: { tenantId, refAssetId: asset.id },
        }),
      ]);
      if (articleRefCount > 0 || imageJobRefCount > 0) {
        throw new ApiError(409, API_ERROR.BAD_REQUEST, '所选图片存在关联引用，禁止删除');
      }
    }

    const totalBytes = assets.reduce((sum, item) => sum + item.bytes, 0);

    await this.prisma.base.$transaction(async (tx) => {
      await tx.mediaAsset.deleteMany({
        where: { tenantId, id: { in: uniqueIds } },
      });
      if (totalBytes > 0) {
        await this.quota.release(tenantId, 'STORAGE_BYTES', totalBytes, tx);
      }
    }, TX_OPTIONS);

    await Promise.allSettled(
      assets.flatMap((asset) => {
        const parsedMain = objectNameFromKey(tenantId, asset.objectKey) ?? mainObjectName(asset.id);
        return [
          this.storage.delete(tenantId, parsedMain),
          this.storage.delete(tenantId, thumbObjectName(asset.id)),
        ];
      }),
    );

    const storage = await this.readStorage(tenantId);
    return { deleted: assets.length, releasedBytes: totalBytes, storage };
  }

  async readAssetBytes(
    tenantId: string,
    assetId: string,
    variant: 'file' | 'thumb',
  ): Promise<{ body: Buffer; contentType: string }> {
    const asset = await this.prisma.base.mediaAsset.findFirst({
      where: { id: assetId, tenantId },
      select: { id: true, objectKey: true, width: true, height: true },
    });
    if (!asset) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '图片素材不存在');
    }
    const targetName =
      variant === 'thumb'
        ? thumbObjectName(asset.id)
        : (objectNameFromKey(tenantId, asset.objectKey) ?? mainObjectName(asset.id));
    const stored = await this.storage.get(tenantId, targetName);
    if (stored) return stored;
    if (variant === 'thumb') {
      const mainFallback = await this.storage.get(
        tenantId,
        objectNameFromKey(tenantId, asset.objectKey) ?? mainObjectName(asset.id),
      );
      if (mainFallback) return mainFallback;
    }
    const w =
      variant === 'thumb'
        ? GALLERY_THUMB_MAX_EDGE
        : Math.max(64, Math.min(IMAGE_MAX_EDGE, asset.width || 640));
    const h =
      variant === 'thumb'
        ? GALLERY_THUMB_MAX_EDGE
        : Math.max(64, Math.min(IMAGE_MAX_EDGE, asset.height || 360));
    const basePng = await placeholderPng(asset.id);
    const fallbackPng = await sharp(basePng)
      .resize({ width: w, height: h, fit: 'fill' })
      .png()
      .toBuffer();
    return { body: fallbackPng, contentType: 'image/png' };
  }
}

export function readGalleryMaxInputBytes(env: Record<string, string | undefined>): number {
  const raw = env.GALLERY_MAX_INPUT_BYTES;
  if (!raw) return IMAGE_MAX_INPUT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return IMAGE_MAX_INPUT_BYTES;
  return parsed;
}
