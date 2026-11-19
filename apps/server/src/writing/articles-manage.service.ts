import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  ARTICLE_ZIP_EXPORT_LIMIT,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  articleCountsAsRemaining,
  buildArticleExportZip,
  countArticleWords,
  escapeLikeLiteral,
  parseEnv,
  sanitizeRichArticleHtml,
  type ArticleBulkStatusInput,
  type ArticleCreateInput,
  type ArticleDetailRecord,
  type ArticleManageItem,
  type ArticleManageListResponse,
  type ArticleManageQuery,
  type ArticleSourceName,
  type ArticleStatusName,
  type ArticleUpdateInput,
  type ArticleZipExportInput,
  type ExportableArticleDoc,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { CategoriesService } from './categories.service';

type ArticleRowWithRelations = {
  id: string;
  categoryId: string | null;
  aiTaskId: string | null;
  title: string;
  contentHtml: string;
  contentText: string;
  coverUrl: string | null;
  status: ArticleStatusName;
  source: ArticleSourceName;
  sourceUrl: string | null;
  sendCount: number;
  videoCount: number;
  createdAt: Date;
  updatedAt: Date;
  category: { id: string; name: string } | null;
  aiTask: { id: string; name: string } | null;
};

function requireTenantId(): string {
  const tid = currentTenantId();
  if (!tid) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tid;
}

function parseDateFloor(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Date(`${iso}T00:00:00.000Z`);
  }
  return new Date(iso);
}

function parseDateCeil(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Date(`${iso}T23:59:59.999Z`);
  }
  return new Date(iso);
}

export function extractReferencedMediaAssetIds(row: {
  coverUrl: string | null;
  contentHtml: string;
}): string[] {
  const ids = new Set<string>();
  const scan = (raw: string | null | undefined) => {
    if (!raw) return;
    const re = /\/media-assets\/([A-Za-z0-9_-]+)\//g;
    let m: RegExpExecArray | null = re.exec(raw);
    while (m) {
      if (m[1]) ids.add(m[1]);
      m = re.exec(raw);
    }
  };
  scan(row.coverUrl);
  scan(row.contentHtml);
  return Array.from(ids);
}

@Injectable()
export class ArticlesManageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
  ) {}

  private buildWhere(tenantId: string, query: ArticleManageQuery): Prisma.ArticleWhereInput {
    const where: Prisma.ArticleWhereInput = { tenantId };
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.taskId) {
      where.aiTaskId = query.taskId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.sendCount !== undefined) {
      where.sendCount = query.sendCount;
    }
    if (query.videoCount !== undefined) {
      where.videoCount = query.videoCount;
    }
    if (query.keyword) {
      where.title = {
        contains: escapeLikeLiteral(query.keyword),
        mode: 'insensitive',
      };
    }
    if (query.createdFrom || query.createdTo) {
      where.createdAt = {
        ...(query.createdFrom ? { gte: parseDateFloor(query.createdFrom) } : {}),
        ...(query.createdTo ? { lte: parseDateCeil(query.createdTo) } : {}),
      };
    }
    return where;
  }

  private buildOrderBy(query: ArticleManageQuery): Prisma.ArticleOrderByWithRelationInput[] {
    if (query.sort === 'sendCount') {
      return [{ sendCount: query.order }, { createdAt: 'desc' }, { id: 'asc' }];
    }
    if (query.sort === 'videoCount') {
      return [{ videoCount: query.order }, { createdAt: 'desc' }, { id: 'asc' }];
    }
    return [{ createdAt: query.order }, { id: 'asc' }];
  }

  async list(query: ArticleManageQuery): Promise<ArticleManageListResponse> {
    const tenantId = requireTenantId();
    const where = this.buildWhere(tenantId, query);
    const orderBy = this.buildOrderBy(query);

    const [total, rows, categorySummary] = await Promise.all([
      this.prisma.scoped.article.count({ where }),
      this.prisma.scoped.article.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          category: { select: { id: true, name: true } },
          aiTask: { select: { id: true, name: true } },
        },
      }),
      query.categoryId
        ? this.categories.one(query.categoryId).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      categorySummary: categorySummary
        ? {
            id: categorySummary.id,
            name: categorySummary.name,
            total: categorySummary.total,
            remaining: categorySummary.remaining,
          }
        : null,
      items: (rows as unknown as ArticleRowWithRelations[]).map((r) =>
        presentManageItem(tenantId, r),
      ),
    };
  }

  async collectForTableExport(query: ArticleManageQuery): Promise<ArticleManageItem[]> {
    const tenantId = requireTenantId();
    const where = this.buildWhere(tenantId, query);
    const rows = await this.prisma.scoped.article.findMany({
      where,
      orderBy: this.buildOrderBy(query),
      take: CRUD_EXPORT_LIMIT + 1,
      include: {
        category: { select: { id: true, name: true } },
        aiTask: { select: { id: true, name: true } },
      },
    });
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, `单次表格导出不超过 ${CRUD_EXPORT_LIMIT} 篇`);
    }
    return (rows as unknown as ArticleRowWithRelations[]).map((r) =>
      presentManageItem(tenantId, r),
    );
  }

  async detail(id: string): Promise<ArticleDetailRecord> {
    const tenantId = requireTenantId();
    const row = await this.prisma.scoped.article.findFirst({
      where: { id, tenantId },
      include: {
        category: { select: { id: true, name: true } },
        aiTask: { select: { id: true, name: true } },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }
    return presentDetail(tenantId, row as unknown as ArticleRowWithRelations);
  }

  /**
   * 手动添加文章：
   * - 默认状态为 NORMAL（计入分类剩余量）
   * - source 固定为 MANUAL，绝不消耗 AI_WRITE 配额，绝不扣减点数
   * - 若未显式传 coverUrl 但指定了 mediaCategoryId，则按图库分类自动带出首张图片作为封面
   */
  async createManual(input: ArticleCreateInput): Promise<ArticleDetailRecord> {
    const tenantId = requireTenantId();
    const category = await this.prisma.scoped.articleCategory.findFirst({
      where: { id: input.categoryId, tenantId },
      select: { id: true },
    });
    if (!category) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '归属分类不存在');
    }

    let resolvedCoverUrl: string | null = canonicalizeMediaUrl(input.coverUrl ?? null);
    if (!resolvedCoverUrl && input.mediaCategoryId) {
      const mediaCat = await this.prisma.scoped.mediaCategory.findFirst({
        where: { id: input.mediaCategoryId, tenantId },
        select: { id: true },
      });
      if (!mediaCat) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选画像图库分类不存在');
      }
      const autoAsset = await this.prisma.scoped.mediaAsset.findFirst({
        where: { tenantId, categoryId: input.mediaCategoryId },
        orderBy: [{ usedCount: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, url: true },
      });
      if (autoAsset) {
        resolvedCoverUrl = canonicalizeMediaUrl(autoAsset.url);
      }
    }

    const sanitized = sanitizeRichArticleHtml(input.contentHtml);
    if (!sanitized.contentText.trim()) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '文章正文不能为空');
    }

    const created = await this.prisma.scoped.article.create({
      data: {
        tenantId,
        categoryId: input.categoryId,
        title: input.title,
        contentHtml: sanitized.contentHtml,
        contentText: sanitized.contentText,
        coverUrl: resolvedCoverUrl,
        status: input.status,
        source: 'MANUAL',
      },
      include: {
        category: { select: { id: true, name: true } },
        aiTask: { select: { id: true, name: true } },
      },
    });

    return presentDetail(tenantId, created as unknown as ArticleRowWithRelations);
  }

  /**
   * 编辑文章（标题、归属分类、封面更换/移除、状态、富文本正文）。
   * 修改状态实时反映在分类 SQL 聚合的剩余量中，不会改动 AI_WRITE 配额或计费流水。
   */
  async update(id: string, input: ArticleUpdateInput): Promise<ArticleDetailRecord> {
    const tenantId = requireTenantId();
    const existing = await this.prisma.scoped.article.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    if (input.categoryId !== undefined) {
      const cat = await this.prisma.scoped.articleCategory.findFirst({
        where: { id: input.categoryId, tenantId },
        select: { id: true },
      });
      if (!cat) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '归属分类不存在');
      }
    }

    const data: Prisma.ArticleUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.categoryId !== undefined) data.categoryId = input.categoryId;
    if (input.coverUrl !== undefined) data.coverUrl = canonicalizeMediaUrl(input.coverUrl);
    if (input.status !== undefined) data.status = input.status;
    if (input.contentHtml !== undefined) {
      const sanitized = sanitizeRichArticleHtml(input.contentHtml);
      if (!sanitized.contentText.trim()) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '文章正文不能为空');
      }
      data.contentHtml = sanitized.contentHtml;
      data.contentText = sanitized.contentText;
    }

    const updated = await this.prisma.scoped.article.update({
      where: { id },
      data,
      include: {
        category: { select: { id: true, name: true } },
        aiTask: { select: { id: true, name: true } },
      },
    });

    return presentDetail(tenantId, updated as unknown as ArticleRowWithRelations);
  }

  /**
   * 明确的「标记为已审核」动作：将单篇文章状态置为 NORMAL。
   */
  async approveOne(id: string): Promise<ArticleDetailRecord> {
    const tenantId = requireTenantId();
    const existing = await this.prisma.scoped.article.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }
    const updated = await this.prisma.scoped.article.update({
      where: { id },
      data: { status: 'NORMAL' },
      include: {
        category: { select: { id: true, name: true } },
        aiTask: { select: { id: true, name: true } },
      },
    });
    return presentDetail(tenantId, updated as unknown as ArticleRowWithRelations);
  }

  /**
   * 批量状态切换（页面主入口为「批量设为正常」 status='NORMAL'）。
   */
  async bulkStatus(input: ArticleBulkStatusInput): Promise<{ updated: number }> {
    const tenantId = requireTenantId();
    const uniqueIds = Array.from(new Set(input.ids));
    const found = await this.prisma.scoped.article.count({
      where: { tenantId, id: { in: uniqueIds } },
    });
    if (found !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分文章不存在或无权操作');
    }
    const res = await this.prisma.scoped.article.updateMany({
      where: { tenantId, id: { in: uniqueIds } },
      data: { status: input.status },
    });
    return { updated: res.count };
  }

  async bulkDelete(ids: string[]): Promise<{ deleted: number }> {
    const tenantId = requireTenantId();
    const uniqueIds = Array.from(new Set(ids));
    const rows = await this.prisma.scoped.article.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true, coverUrl: true, contentHtml: true },
    });
    if (rows.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分文章不存在或无权删除');
    }

    const decrementByAssetId = new Map<string, number>();
    for (const row of rows) {
      for (const assetId of extractReferencedMediaAssetIds(row)) {
        decrementByAssetId.set(assetId, (decrementByAssetId.get(assetId) ?? 0) + 1);
      }
    }

    const deleted = await this.prisma.base.$transaction(async (tx) => {
      const res = await tx.article.deleteMany({
        where: { tenantId, id: { in: uniqueIds } },
      });
      if (decrementByAssetId.size > 0) {
        const assetIds = Array.from(decrementByAssetId.keys());
        const assets = await tx.mediaAsset.findMany({
          where: { tenantId, id: { in: assetIds } },
          select: { id: true, usedCount: true },
        });
        for (const asset of assets) {
          const dec = decrementByAssetId.get(asset.id) ?? 0;
          if (dec > 0 && asset.usedCount > 0) {
            await tx.mediaAsset.update({
              where: { id: asset.id },
              data: { usedCount: Math.max(0, asset.usedCount - dec) },
            });
          }
        }
      }
      return res.count;
    });

    return { deleted };
  }

  /**
   * 批量导出 Markdown / HTML / Docx 压缩包（.zip）。
   */
  async exportZip(input: ArticleZipExportInput): Promise<{
    filename: string;
    bytes: Buffer;
  }> {
    const tenantId = requireTenantId();
    const where: Prisma.ArticleWhereInput = { tenantId };
    if (input.ids && input.ids.length > 0) {
      where.id = { in: Array.from(new Set(input.ids)) };
    } else {
      if (input.categoryId) where.categoryId = input.categoryId;
      if (input.taskId) where.aiTaskId = input.taskId;
      if (input.status) where.status = input.status;
      if (input.keyword) {
        where.title = {
          contains: escapeLikeLiteral(input.keyword),
          mode: 'insensitive',
        };
      }
    }

    const rows = await this.prisma.scoped.article.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: ARTICLE_ZIP_EXPORT_LIMIT + 1,
      include: {
        category: { select: { id: true, name: true } },
      },
    });
    if (rows.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '没有可导出的文章');
    }
    if (rows.length > ARTICLE_ZIP_EXPORT_LIMIT) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `单次打包导出最多 ${ARTICLE_ZIP_EXPORT_LIMIT} 篇，请先筛选或勾选`,
      );
    }

    const docs: ExportableArticleDoc[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      categoryName: r.category?.name ?? null,
      coverUrl: signMediaUrl(tenantId, r.coverUrl),
      contentHtml: signMediaHtml(tenantId, r.contentHtml),
      contentText: r.contentText,
      createdAt: r.createdAt.toISOString(),
    }));

    const zipBytes = buildArticleExportZip(docs, input.format);
    return {
      filename: `geomix-articles-${input.format}.zip`,
      bytes: Buffer.from(zipBytes),
    };
  }
}

const MEDIA_ASSET_URL_RE = /^\/api\/v1\/media-assets\/([A-Za-z0-9_-]+)\/(file|thumb)(?:\?.*)?$/;

function canonicalizeMediaUrl(url: string | null): string | null {
  if (!url) return null;
  const match = MEDIA_ASSET_URL_RE.exec(url);
  if (!match) return url;
  return `/api/v1/media-assets/${match[1]}/${match[2]}`;
}

function buildSignedMediaAssetPath(
  tenantId: string,
  assetId: string,
  variant: 'file' | 'thumb',
): string {
  const secret = parseEnv(process.env).JWT_ACCESS_SECRET;
  const sig = createHmac('sha256', secret)
    .update(`${tenantId}:${assetId}:${variant}`)
    .digest('hex')
    .slice(0, 32);
  return `/api/v1/media-assets/${assetId}/${variant}?tid=${encodeURIComponent(tenantId)}&sig=${sig}`;
}

function signMediaUrl(tenantId: string, url: string | null): string | null {
  if (!url) return null;
  const match = MEDIA_ASSET_URL_RE.exec(url);
  if (!match) return url;
  return buildSignedMediaAssetPath(tenantId, match[1]!, match[2] as 'file' | 'thumb');
}

function signMediaHtml(tenantId: string, html: string): string {
  return html.replace(
    /\/api\/v1\/media-assets\/([A-Za-z0-9_-]+)\/(file|thumb)(?:\?[^"'\s>]*)?/g,
    (_, assetId: string, variant: 'file' | 'thumb') =>
      buildSignedMediaAssetPath(tenantId, assetId, variant),
  );
}

function presentManageItem(tenantId: string, row: ArticleRowWithRelations): ArticleManageItem {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    aiTaskId: row.aiTaskId,
    aiTaskName: row.aiTask?.name ?? null,
    title: row.title,
    coverUrl: signMediaUrl(tenantId, row.coverUrl),
    status: row.status,
    source: row.source,
    sendCount: row.sendCount,
    videoCount: row.videoCount,
    wordCount: countArticleWords(row.contentText || row.contentHtml),
    countsAsRemaining: articleCountsAsRemaining(row.status, row.sendCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentDetail(tenantId: string, row: ArticleRowWithRelations): ArticleDetailRecord {
  return {
    ...presentManageItem(tenantId, row),
    contentHtml: signMediaHtml(tenantId, row.contentHtml),
    contentText: row.contentText,
    sourceUrl: row.sourceUrl,
  };
}
