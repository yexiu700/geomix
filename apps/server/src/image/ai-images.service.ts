import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_DEFAULT_UNIT_POINTS,
  AI_IMAGE_PROMPT_MIN,
  AI_IMAGE_REF_MAX_BYTES,
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  FAKE_MARK,
  GALLERY_CATEGORY_TYPE_IMAGE,
  GALLERY_THUMB_MAX_EDGE,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_OUTPUT_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_WARN_WIDTH,
  PRICING_DEFAULTS,
  escapeLikeLiteral,
  isAiImageRatio,
  parseEnv,
  quoteAiImagePoints,
  type AiImageGeneratedAsset,
  type AiImageJobItem,
  type AiImageJobListQuery,
  type AiImageJobListResponse,
  type AiImageOptimizePromptResponse,
  type AiImageRatio,
  type AiImageSaveToGalleryInput,
  type TaskStatusName,
} from '@geomix/shared';
import sharp from 'sharp';
import type { z } from 'zod';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { compressImage } from '../infra/compress';
import { LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { StorageService } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import {
  IMAGE_JOB_ENQUEUER,
  buildSignedMediaAssetUrl,
  type ImageJobEnqueuer,
} from './image-job.runner';
import {
  buildFallbackVisualPrompt,
  buildImagePromptMessages,
  extractAndValidateOptimizedPrompt,
  trimPromptToMaxLength,
} from './prompt-optimizer';
import type { aiImageCreateSchema, aiImageOptimizePromptSchema } from '@geomix/shared';

type JobRow = {
  id: string;
  tenantId: string;
  prompt: string;
  style: string | null;
  ratio: string;
  count: number;
  refAssetId: string | null;
  saveCategoryId: string | null;
  status: TaskStatusName;
  successCount: number;
  error: string | null;
  model: string | null;
  createdAt: Date;
  assets: Array<{
    id: string;
    categoryId: string | null;
    width: number;
    height: number;
    bytes: number;
    usedCount: number;
    createdAt: Date;
    category: { id: string; name: string } | null;
  }>;
};

type ReservationSnapshot = {
  refId: string;
  frozen: number;
  settled: number;
  released: number;
};

function generateJobId(): string {
  return `img_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

function generateRefAssetId(): string {
  return `med_ref_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

export function formatAiImageOrderNo(createdAt: Date, id: string): string {
  const y = createdAt.getUTCFullYear();
  const m = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(createdAt.getUTCDate()).padStart(2, '0');
  const suffix = id
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-6)
    .toUpperCase()
    .padStart(6, '0');
  return `IMG${y}${m}${d}-${suffix}`;
}

function extractKbContext(kb: {
  mode: 'DETAIL' | 'SUMMARY';
  companyName: string | null;
  brandShort: string | null;
  fields: Prisma.JsonValue | null;
  summaryText: string | null;
}): string {
  if (kb.mode === 'SUMMARY') {
    const raw = (kb.summaryText ?? '').replace(/\s+/g, ' ').trim();
    return raw.slice(0, 140);
  }
  const parts: string[] = [];
  if (kb.fields && typeof kb.fields === 'object' && !Array.isArray(kb.fields)) {
    const record = kb.fields as Record<string, unknown>;
    if (typeof record.productService === 'string' && record.productService.trim()) {
      parts.push(record.productService.trim().slice(0, 80));
    }
    if (typeof record.productFeature === 'string' && record.productFeature.trim()) {
      parts.push(record.productFeature.trim().slice(0, 80));
    }
  }
  return parts.join('，').slice(0, 140);
}

@Injectable()
export class AiImagesService {
  private readonly logger = new Logger(AiImagesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(IMAGE_JOB_ENQUEUER) private readonly enqueuer: ImageJobEnqueuer,
  ) {}

  private requireTenant(): string {
    const tenantId = currentTenantId();
    if (!tenantId) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    }
    return tenantId;
  }

  async resolveUnitPoints(requireEnabled = false): Promise<number> {
    const row = await this.prisma.base.pricingItem.findUnique({
      where: { action: 'image_gen' },
    });
    if (!row) {
      const def = PRICING_DEFAULTS.find((item) => item.action === 'image_gen');
      return def?.unitPoints ?? AI_IMAGE_DEFAULT_UNIT_POINTS;
    }
    if (requireEnabled && !row.enabled) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'AI 生图计费项目当前未启用');
    }
    return row.unitPoints;
  }

  private buildWhere(query: AiImageJobListQuery): Prisma.AiImageJobWhereInput {
    const where: Prisma.AiImageJobWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.keyword) {
      const trimmed = query.keyword.trim();
      const escaped = escapeLikeLiteral(trimmed);
      const orConditions: Prisma.AiImageJobWhereInput[] = [
        { prompt: { contains: escaped, mode: 'insensitive' } },
        { id: { contains: escaped, mode: 'insensitive' } },
      ];
      const orderNoMatch = /^IMG\d{8}-([A-Za-z0-9]{1,6})$/i.exec(trimmed);
      if (orderNoMatch?.[1]) {
        orConditions.push({
          id: { endsWith: escapeLikeLiteral(orderNoMatch[1]), mode: 'insensitive' },
        });
      }
      where.OR = orConditions;
    }
    return where;
  }

  private async presentJobs(
    tenantId: string,
    rows: JobRow[],
    defaultUnitPoints: number,
  ): Promise<AiImageJobItem[]> {
    if (rows.length === 0) return [];

    const jobIds = rows.map((row) => row.id);
    const saveCatIds = Array.from(
      new Set(
        rows
          .map((row) => row.saveCategoryId)
          .filter((val): val is string => typeof val === 'string' && val.length > 0),
      ),
    );

    const [reservations, categories] = await Promise.all([
      this.prisma.base.pointReservation.findMany({
        where: {
          tenantId,
          refType: 'image_job',
          refId: { in: jobIds },
        },
        select: {
          refId: true,
          frozen: true,
          settled: true,
          released: true,
        },
      }),
      saveCatIds.length > 0
        ? this.prisma.base.mediaCategory.findMany({
            where: {
              tenantId,
              id: { in: saveCatIds },
              type: GALLERY_CATEGORY_TYPE_IMAGE,
            },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const resMap = new Map<string, ReservationSnapshot>(
      reservations.map((item) => [item.refId, item]),
    );
    const catMap = new Map<string, string>(categories.map((cat) => [cat.id, cat.name]));

    return rows.map((row) => {
      const resv = resMap.get(row.id);
      const count = Math.max(1, row.count);
      const unitPoints =
        resv && resv.frozen > 0 ? Math.max(1, Math.floor(resv.frozen / count)) : defaultUnitPoints;
      const reservedPoints = resv?.frozen ?? count * unitPoints;
      const settledPoints = resv?.settled ?? 0;
      const releasedPoints = resv?.released ?? 0;
      const ratio: AiImageRatio = isAiImageRatio(row.ratio) ? row.ratio : AI_IMAGE_DEFAULT_RATIO;

      const assets: AiImageGeneratedAsset[] = row.assets.map((asset) => ({
        id: asset.id,
        categoryId: asset.categoryId,
        categoryName: asset.category?.name ?? null,
        url: buildSignedMediaAssetUrl(tenantId, asset.id, 'file'),
        thumbUrl: buildSignedMediaAssetUrl(tenantId, asset.id, 'thumb'),
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        usedCount: asset.usedCount,
        createdAt: asset.createdAt.toISOString(),
      }));

      const saveCategoryName =
        (row.saveCategoryId ? catMap.get(row.saveCategoryId) : undefined) ??
        assets.find((item) => item.categoryName)?.categoryName ??
        null;

      return {
        id: row.id,
        orderNo: formatAiImageOrderNo(row.createdAt, row.id),
        prompt: row.prompt,
        style: row.style,
        ratio,
        count: row.count,
        successCount: row.successCount,
        refAssetId: row.refAssetId,
        saveCategoryId: row.saveCategoryId,
        saveCategoryName,
        status: row.status,
        error: row.error,
        model: row.model,
        unitPoints,
        reservedPoints,
        settledPoints,
        releasedPoints,
        createdAt: row.createdAt.toISOString(),
        assets,
      };
    });
  }

  async list(query: AiImageJobListQuery): Promise<AiImageJobListResponse> {
    const tenantId = this.requireTenant();
    const where = this.buildWhere(query);
    const [total, rows, unitPoints] = await Promise.all([
      this.prisma.scoped.aiImageJob.count({ where }),
      this.prisma.scoped.aiImageJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          assets: {
            orderBy: { createdAt: 'asc' },
            include: { category: { select: { id: true, name: true } } },
          },
        },
      }),
      this.resolveUnitPoints(false),
    ]);

    const items = await this.presentJobs(tenantId, rows as JobRow[], unitPoints);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      unitPoints,
      featureEnabled: parseEnv(process.env).FEATURE_AI_IMAGE,
      items,
    };
  }

  async collectForExport(query: AiImageJobListQuery): Promise<AiImageJobItem[]> {
    const tenantId = this.requireTenant();
    const where = this.buildWhere(query);
    const [rows, unitPoints] = await Promise.all([
      this.prisma.scoped.aiImageJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: CRUD_EXPORT_LIMIT + 1,
        include: {
          assets: {
            orderBy: { createdAt: 'asc' },
            include: { category: { select: { id: true, name: true } } },
          },
        },
      }),
      this.resolveUnitPoints(false),
    ]);
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多，请先缩小筛选范围');
    }
    return this.presentJobs(tenantId, rows as JobRow[], unitPoints);
  }

  async detail(id: string): Promise<AiImageJobItem> {
    const tenantId = this.requireTenant();
    const [row, unitPoints] = await Promise.all([
      this.prisma.scoped.aiImageJob.findFirst({
        where: { id },
        include: {
          assets: {
            orderBy: { createdAt: 'asc' },
            include: { category: { select: { id: true, name: true } } },
          },
        },
      }),
      this.resolveUnitPoints(false),
    ]);
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '生图任务记录不存在');
    }
    const [item] = await this.presentJobs(tenantId, [row as JobRow], unitPoints);
    if (!item) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '生图任务记录不存在');
    }
    return item;
  }

  async optimizePrompt(
    input: z.infer<typeof aiImageOptimizePromptSchema>,
    userId?: string,
  ): Promise<AiImageOptimizePromptResponse> {
    const tenantId = this.requireTenant();
    await this.compliance.assertAllowed({
      text: input.prompt,
      action: 'image_prompt_optimize',
      tenantId,
      userId,
    });

    let keywordText = '';
    if (input.keywordId) {
      const kw = await this.prisma.scoped.keyword.findFirst({
        where: { id: input.keywordId },
        select: { main: true },
      });
      if (!kw) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选训练主词不存在');
      }
      keywordText = kw.main.trim();
    }

    let kbContext = '';
    if (input.kbId) {
      const kb = await this.prisma.scoped.knowledgeBase.findFirst({
        where: { id: input.kbId },
        select: {
          mode: true,
          companyName: true,
          brandShort: true,
          fields: true,
          summaryText: true,
        },
      });
      if (!kb) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选知识库不存在');
      }
      kbContext = extractKbContext(kb);
    }

    const styleLabel = input.style?.trim() || '写实摄影';
    const contextSegments = [
      `基础描述：${input.prompt}`,
      `视觉风格：${styleLabel}`,
      keywordText ? `关联主题词：${keywordText}` : '',
      kbContext ? `产品服务场景参考：${kbContext}` : '',
    ].filter(Boolean);

    const idemHash = createHash('sha256')
      .update(`${tenantId}:${contextSegments.join('|')}`)
      .digest('hex')
      .slice(0, 24);

    const fallbackPrompt = buildFallbackVisualPrompt({
      prompt: input.prompt,
      styleLabel,
      keywordText,
      kbContext,
    });

    let candidate: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const strictRetry = attempt > 0;
      try {
        const completion = await this.llm.complete({
          tenantId,
          scene: 'image_prompt',
          messages: buildImagePromptMessages({ contextSegments, strictRetry }),
          idempotencyKey: strictRetry ? `img_opt_${idemHash}:retry1` : `img_opt_${idemHash}`,
          temperature: strictRetry ? 0.2 : 0.5,
          maxTokens: 800,
          disableThinking: true,
        });

        if (completion.fake && completion.text.startsWith(FAKE_MARK)) {
          candidate = fallbackPrompt;
          break;
        }

        const extracted = extractAndValidateOptimizedPrompt(completion.text);
        if (extracted) {
          candidate = extracted;
          break;
        }
        this.logger.warn(
          `optimizePrompt rejected leaked/invalid output on attempt ${attempt + 1} (tenant=${tenantId})`,
        );
      } catch (err) {
        if (err instanceof ProviderError && err.kind === PROVIDER_KIND.CONTRACT) {
          this.logger.warn(
            `optimizePrompt caught contract error on attempt ${attempt + 1} (tenant=${tenantId}): ${err.reason}`,
          );
          continue;
        }
        throw err;
      }
    }

    const finalCandidate = candidate ?? fallbackPrompt;
    const scanned = this.compliance.scan(finalCandidate);
    if (scanned.blocked) {
      throw new ApiError(
        403,
        API_ERROR.FORBIDDEN_INDUSTRY,
        '提示词扩写结果触发合规限制，请调整基础描述后重试',
      );
    }

    const optimizedPrompt = trimPromptToMaxLength(scanned.text.trim());
    return {
      optimizedPrompt:
        optimizedPrompt.length >= AI_IMAGE_PROMPT_MIN ? optimizedPrompt : fallbackPrompt,
    };
  }

  private async ingestUploadedRefImage(tenantId: string, base64Raw: string): Promise<string> {
    const cleaned = base64Raw.replace(/^data:[^;]+;base64,/i, '').trim();
    if (!cleaned) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '参考图片内容不能为空');
    }
    const estimatedBytes = Math.floor((cleaned.length * 3) / 4);
    if (estimatedBytes > AI_IMAGE_REF_MAX_BYTES) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '参考图片不能超过 10MB');
    }
    const buffer = Buffer.from(cleaned, 'base64');
    if (buffer.length === 0 || buffer.length > AI_IMAGE_REF_MAX_BYTES) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '参考图片格式不正确或超过 10MB');
    }

    let compressed;
    try {
      compressed = await compressImage(buffer, {
        maxInputBytes: AI_IMAGE_REF_MAX_BYTES,
        maxOutputBytes: IMAGE_MAX_OUTPUT_BYTES,
        maxEdge: IMAGE_MAX_EDGE,
        maxPixels: IMAGE_MAX_PIXELS,
        warnWidth: IMAGE_WARN_WIDTH,
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, err.message);
      }
      throw err;
    }

    const thumbBuffer = await sharp(compressed.body)
      .resize({
        width: GALLERY_THUMB_MAX_EDGE,
        height: GALLERY_THUMB_MAX_EDGE,
        fit: 'cover',
      })
      .jpeg({ quality: 75 })
      .toBuffer();

    const assetId = generateRefAssetId();
    const mainName = `media-${assetId}.jpg`;
    const thumbName = `media-${assetId}-thumb.jpg`;

    const storedMain = await this.storage.put({
      tenantId,
      name: mainName,
      body: compressed.body,
      contentType: compressed.contentType,
      idempotencyKey: `img_ref:${assetId}:main`,
    });
    await this.storage.put({
      tenantId,
      name: thumbName,
      body: thumbBuffer,
      contentType: 'image/jpeg',
      idempotencyKey: `img_ref:${assetId}:thumb`,
    });

    try {
      await this.prisma.base.$transaction(async (tx) => {
        await this.quota.consume(tenantId, 'STORAGE_BYTES', compressed.bytes, tx);
        await tx.mediaAsset.create({
          data: {
            id: assetId,
            tenantId,
            categoryId: null,
            origin: 'UPLOAD',
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
    } catch (err) {
      await Promise.allSettled([
        this.storage.delete(tenantId, mainName),
        this.storage.delete(tenantId, thumbName),
      ]);
      throw err;
    }

    return assetId;
  }

  async create(
    input: z.infer<typeof aiImageCreateSchema>,
    userId?: string,
  ): Promise<AiImageJobItem> {
    const tenantId = this.requireTenant();

    await this.compliance.assertAllowed({
      text: input.prompt,
      action: 'image_prompt',
      tenantId,
      userId,
    });
    if (input.style) {
      await this.compliance.assertAllowed({
        text: input.style,
        action: 'image_style',
        tenantId,
        userId,
      });
    }

    let saveCategoryId: string | null = null;
    if (input.saveCategoryId) {
      const category = await this.prisma.scoped.mediaCategory.findFirst({
        where: { id: input.saveCategoryId, type: GALLERY_CATEGORY_TYPE_IMAGE },
        select: { id: true },
      });
      if (!category) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选图库分组不存在');
      }
      saveCategoryId = category.id;
    }

    let refAssetId: string | null = null;
    if (input.refAssetId) {
      const refAsset = await this.prisma.scoped.mediaAsset.findFirst({
        where: { id: input.refAssetId },
        select: { id: true },
      });
      if (!refAsset) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选参考图片不存在');
      }
      refAssetId = refAsset.id;
    } else if (input.refImageBase64) {
      refAssetId = await this.ingestUploadedRefImage(tenantId, input.refImageBase64);
    }

    const unitPoints = await this.resolveUnitPoints(true);
    const quote = quoteAiImagePoints(input.count, unitPoints);
    const jobId = generateJobId();

    let reservationId: string;
    try {
      const resv = await this.billing.reserve({
        tenantId,
        refType: 'image_job',
        refId: jobId,
        amount: quote.totalPoints,
      });
      reservationId = resv.id;
    } catch (err) {
      if (err instanceof ApiError && err.code === API_ERROR.INSUFFICIENT_POINTS) {
        const wallet = await this.billing.wallet(tenantId).catch(() => null);
        const availText = wallet ? `，当前可用 ${wallet.available} 点` : '';
        throw new ApiError(
          402,
          API_ERROR.INSUFFICIENT_POINTS,
          `本次生图需预冻 ${quote.totalPoints} 点${availText}`,
        );
      }
      throw err;
    }

    try {
      await this.prisma.base.aiImageJob.create({
        data: {
          id: jobId,
          tenantId,
          prompt: input.prompt,
          style: input.style ?? null,
          ratio: input.ratio,
          count: input.count,
          refAssetId,
          saveCategoryId,
          status: 'QUEUED',
        },
      });
      await this.enqueuer.enqueueImageJob({ tenantId, jobId });
    } catch (err) {
      await this.billing.close({ tenantId, reservationId }).catch(() => undefined);
      await this.prisma.base.aiImageJob
        .deleteMany({ where: { id: jobId, tenantId } })
        .catch(() => undefined);
      throw err;
    }

    return this.detail(jobId);
  }

  async saveToGallery(
    id: string,
    input: AiImageSaveToGalleryInput,
  ): Promise<{
    savedCount: number;
    categoryId: string;
    categoryName: string;
    job: AiImageJobItem;
  }> {
    const tenantId = this.requireTenant();

    const [job, category] = await Promise.all([
      this.prisma.scoped.aiImageJob.findFirst({
        where: { id },
        select: { id: true },
      }),
      this.prisma.scoped.mediaCategory.findFirst({
        where: { id: input.categoryId, type: GALLERY_CATEGORY_TYPE_IMAGE },
        select: { id: true, name: true },
      }),
    ]);

    if (!job) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '生图任务记录不存在');
    }
    if (!category) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '目标图库分组不存在');
    }

    const assetWhere: Prisma.MediaAssetWhereInput = {
      tenantId,
      aiImageId: id,
    };
    if (input.assetIds && input.assetIds.length > 0) {
      assetWhere.id = { in: input.assetIds };
    }

    const targetAssets = await this.prisma.base.mediaAsset.findMany({
      where: assetWhere,
      select: { id: true },
    });
    if (targetAssets.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '当前记录暂无可存入图库的生成图片');
    }

    const targetIds = targetAssets.map((item) => item.id);
    await this.prisma.base.$transaction(async (tx) => {
      await tx.mediaAsset.updateMany({
        where: { tenantId, id: { in: targetIds } },
        data: { categoryId: category.id },
      });
      await tx.aiImageJob.update({
        where: { id },
        data: { saveCategoryId: category.id },
      });
    }, TX_OPTIONS);

    return {
      savedCount: targetIds.length,
      categoryId: category.id,
      categoryName: category.name,
      job: await this.detail(id),
    };
  }

  async bulkDelete(ids: readonly string[]): Promise<{ deletedCount: number }> {
    const tenantId = this.requireTenant();
    const uniqueIds = Array.from(new Set(ids));
    const jobs = await this.prisma.scoped.aiImageJob.findMany({
      where: { id: { in: uniqueIds } },
      select: {
        id: true,
        status: true,
        assets: {
          select: {
            id: true,
            categoryId: true,
            bytes: true,
            usedCount: true,
            objectKey: true,
          },
        },
      },
    });
    if (jobs.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分生图记录不存在或无权操作');
    }

    for (const job of jobs) {
      if (job.status === 'QUEUED' || job.status === 'RUNNING') {
        throw new ApiError(
          409,
          API_ERROR.BAD_REQUEST,
          '生图任务正在排队或生成中，请等待完成后再删除',
        );
      }
    }

    const unsavedAssets = jobs
      .flatMap((job) => job.assets)
      .filter((asset) => asset.categoryId === null);

    const removableAssets: typeof unsavedAssets = [];
    for (const asset of unsavedAssets) {
      const [articleRef, jobRef] = await Promise.all([
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
          where: {
            tenantId,
            refAssetId: asset.id,
            id: { notIn: uniqueIds },
          },
        }),
      ]);
      if (articleRef === 0 && jobRef === 0) {
        removableAssets.push(asset);
      }
    }

    const removableIds = removableAssets.map((item) => item.id);
    const releasedBytes = removableAssets.reduce((sum, item) => sum + item.bytes, 0);

    await this.prisma.base.$transaction(async (tx) => {
      if (removableIds.length > 0) {
        await tx.mediaAsset.deleteMany({
          where: { tenantId, id: { in: removableIds } },
        });
        if (releasedBytes > 0) {
          await this.quota.release(tenantId, 'STORAGE_BYTES', releasedBytes, tx);
        }
      }
      await tx.aiImageJob.deleteMany({
        where: { tenantId, id: { in: uniqueIds } },
      });
    }, TX_OPTIONS);

    if (removableAssets.length > 0) {
      await Promise.allSettled(
        removableAssets.flatMap((asset) => [
          this.storage.delete(tenantId, `media-${asset.id}.jpg`),
          this.storage.delete(tenantId, `media-${asset.id}-thumb.jpg`),
        ]),
      );
    }

    return { deletedCount: uniqueIds.length };
  }
}
