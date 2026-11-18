import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  PRICING_DEFAULTS,
  REWRITE_BATCH_DEFAULT_UNIT_POINTS,
  REWRITE_BATCH_LINK_LIST_MAX,
  buildDefaultBatchCategoryName,
  escapeLikeLiteral,
  parseBatchLinkList,
  resolveRewriteSimMax,
  rewriteBatchCreateSchema,
  type ArticleStatusName,
  type ItemStatusName,
  type RewriteBatchCreateInput,
  type RewriteBatchDetailResponse,
  type RewriteBatchItem,
  type RewriteBatchListQuery,
  type RewriteBatchListResponse,
  type RewriteBatchSourceType,
  type RewriteRecordItem,
  type TaskStatusName,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { isUniqueViolation } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { SearchService } from '../infra/search';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { ensureBuiltInSystemTemplates } from '../writing/system-templates.helper';
import { REWRITE_BATCH_ENQUEUER, type RewriteBatchEnqueuer } from './rewrite-batch.runner';

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

type LoadedBatchRow = Prisma.RewriteBatchGetPayload<{
  include: {
    category: { select: { id: true; name: true } };
    mediaCategory: { select: { id: true; name: true } };
    template: { select: { id: true; name: true } };
    _count: { select: { records: true } };
  };
}>;

const BATCH_INCLUDE = {
  category: { select: { id: true, name: true } },
  mediaCategory: { select: { id: true, name: true } },
  template: { select: { id: true, name: true } },
  _count: { select: { records: true } },
} as const;

type LoadedRecordRow = Prisma.RewriteRecordGetPayload<{
  include: {
    category: { select: { id: true; name: true } };
    mediaCategory: { select: { id: true; name: true } };
    template: { select: { id: true; name: true } };
    article: { select: { id: true; status: true; complianceFlags: true } };
  };
}>;

const RECORD_INCLUDE = {
  category: { select: { id: true, name: true } },
  mediaCategory: { select: { id: true, name: true } },
  template: { select: { id: true, name: true } },
  article: { select: { id: true, status: true, complianceFlags: true } },
} as const;

function readHighSimilarity(
  rawFlags: Prisma.JsonValue | null | undefined,
  similarity: number | null,
  simMax: number,
): boolean {
  if (rawFlags && typeof rawFlags === 'object' && !Array.isArray(rawFlags)) {
    const val = (rawFlags as Record<string, unknown>).highSimilarity;
    if (typeof val === 'boolean') return val;
  }
  return typeof similarity === 'number' && similarity > simMax;
}

function presentRecord(row: LoadedRecordRow, simMax: number): RewriteRecordItem {
  return {
    id: row.id,
    batchId: row.batchId,
    url: row.url,
    urlHash: row.urlHash,
    pastedText: row.pastedText,
    sourceTitle: row.sourceTitle,
    newTitle: row.newTitle,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    mediaCategoryId: row.mediaCategoryId,
    mediaCategoryName: row.mediaCategory?.name ?? null,
    templateId: row.templateId,
    templateName: row.template?.name ?? null,
    status: row.status as ItemStatusName,
    error: row.error,
    similarity: row.similarity,
    highSimilarity: readHighSimilarity(row.article?.complianceFlags, row.similarity, simMax),
    articleId: row.article?.id ?? row.articleId,
    articleStatus: (row.article?.status as ArticleStatusName | undefined) ?? null,
    rewrittenAt: row.rewrittenAt ? row.rewrittenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class RewriteBatchesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(REWRITE_BATCH_ENQUEUER) private readonly enqueuer: RewriteBatchEnqueuer,
  ) {}

  private async resolveUnitPoints(): Promise<number> {
    const item = await this.prisma.base.pricingItem.findUnique({
      where: { action: 'rewrite_batch' },
    });
    if (!item) {
      const fallback = PRICING_DEFAULTS.find((p) => p.action === 'rewrite_batch');
      return fallback?.unitPoints ?? REWRITE_BATCH_DEFAULT_UNIT_POINTS;
    }
    if (!item.enabled) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '批量复刻计费项当前未启用');
    }
    return item.unitPoints;
  }

  private buildWhere(
    tenantId: string,
    query: RewriteBatchListQuery,
  ): Prisma.RewriteBatchWhereInput {
    const where: Prisma.RewriteBatchWhereInput = { tenantId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.sourceType) {
      where.sourceType = query.sourceType;
    }
    if (query.keyword) {
      const escaped = escapeLikeLiteral(query.keyword);
      where.OR = [
        { name: { contains: escaped, mode: 'insensitive' } },
        { keyword: { contains: escaped, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  private async hydrateBatches(
    tenantId: string,
    rows: LoadedBatchRow[],
    unitPoints: number,
  ): Promise<RewriteBatchItem[]> {
    if (rows.length === 0) return [];
    const batchIds = rows.map((r) => r.id);

    const [reservations, failedCounts] = await Promise.all([
      this.prisma.base.pointReservation.findMany({
        where: {
          tenantId,
          refType: 'rewrite_batch',
          refId: { in: batchIds },
        },
        select: {
          refId: true,
          frozen: true,
          settled: true,
          released: true,
        },
      }),
      this.prisma.base.rewriteRecord.groupBy({
        by: ['batchId'],
        where: {
          tenantId,
          batchId: { in: batchIds },
          status: { in: ['FAILED', 'SKIPPED'] },
        },
        _count: { _all: true },
      }),
    ]);

    const resvMap = new Map(reservations.map((r) => [r.refId, r]));
    const failMap = new Map(failedCounts.map((f) => [f.batchId ?? '', f._count._all]));

    return rows.map((row) => {
      const resv = resvMap.get(row.id);
      const sourceType: RewriteBatchSourceType =
        row.sourceType === 'remote' ? 'remote' : 'link_list';
      return {
        id: row.id,
        name: row.name,
        keyword: row.keyword,
        sourceType,
        maxCount: row.maxCount,
        doneCount: row.doneCount,
        candidateCount: row._count.records || row.linkList.length,
        failedOrSkippedCount: failMap.get(row.id) ?? 0,
        categoryId: row.categoryId,
        categoryName: row.category?.name ?? null,
        mediaCategoryId: row.mediaCategoryId,
        mediaCategoryName: row.mediaCategory?.name ?? null,
        templateId: row.templateId,
        templateName: row.template?.name ?? null,
        status: row.status as TaskStatusName,
        note: row.note,
        unitPoints,
        reservedPoints: resv?.frozen ?? row.maxCount * unitPoints,
        settledPoints: resv?.settled ?? row.doneCount * unitPoints,
        releasedPoints: resv?.released ?? 0,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async list(query: RewriteBatchListQuery): Promise<RewriteBatchListResponse> {
    const tenantId = requireTenant();
    const where = this.buildWhere(tenantId, query);
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows, unitPoints] = await Promise.all([
      this.prisma.base.rewriteBatch.count({ where }),
      this.prisma.base.rewriteBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
        include: BATCH_INCLUDE,
      }),
      this.resolveUnitPoints().catch(() => REWRITE_BATCH_DEFAULT_UNIT_POINTS),
    ]);

    const items = await this.hydrateBatches(tenantId, rows, unitPoints);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      unitPoints,
      remoteSearchEnabled: this.search.isRemoteReady(),
      items,
    };
  }

  async collectForExport(query: RewriteBatchListQuery): Promise<RewriteBatchItem[]> {
    const tenantId = requireTenant();
    const where = this.buildWhere(tenantId, query);
    const [rows, unitPoints] = await Promise.all([
      this.prisma.base.rewriteBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CRUD_EXPORT_LIMIT,
        include: BATCH_INCLUDE,
      }),
      this.resolveUnitPoints().catch(() => REWRITE_BATCH_DEFAULT_UNIT_POINTS),
    ]);
    return this.hydrateBatches(tenantId, rows, unitPoints);
  }

  async detail(id: string): Promise<RewriteBatchDetailResponse> {
    const tenantId = requireTenant();
    return this.detailForTenant(tenantId, id);
  }

  private async detailForTenant(tenantId: string, id: string): Promise<RewriteBatchDetailResponse> {
    const [row, recordRows, unitPoints] = await Promise.all([
      this.prisma.base.rewriteBatch.findFirst({
        where: { id, tenantId },
        include: BATCH_INCLUDE,
      }),
      this.prisma.base.rewriteRecord.findMany({
        where: { batchId: id, tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: RECORD_INCLUDE,
      }),
      this.resolveUnitPoints().catch(() => REWRITE_BATCH_DEFAULT_UNIT_POINTS),
    ]);

    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '批量复刻任务不存在');
    }

    const [batchItem] = await this.hydrateBatches(tenantId, [row], unitPoints);
    const simMax = resolveRewriteSimMax(process.env);

    return {
      batch: batchItem!,
      records: recordRows.map((rec) => presentRecord(rec, simMax)),
    };
  }

  private async resolveOrCreateCategory(
    tenantId: string,
    categoryId: string | undefined,
    batchName: string,
  ): Promise<string> {
    if (categoryId) {
      const existing = await this.prisma.base.articleCategory.findFirst({
        where: { id: categoryId, tenantId },
        select: { id: true },
      });
      if (!existing) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选文章分类不存在');
      }
      return existing.id;
    }

    const autoName = buildDefaultBatchCategoryName(batchName);
    const found = await this.prisma.base.articleCategory.findFirst({
      where: { tenantId, name: autoName },
      select: { id: true },
    });
    if (found) return found.id;

    try {
      const created = await this.prisma.base.articleCategory.create({
        data: { tenantId, name: autoName },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.prisma.base.articleCategory.findFirstOrThrow({
        where: { tenantId, name: autoName },
        select: { id: true },
      });
      return raced.id;
    }
  }

  async create(
    rawInput: RewriteBatchCreateInput,
    userId?: string,
  ): Promise<RewriteBatchDetailResponse> {
    const tenantId = requireTenant();
    await ensureBuiltInSystemTemplates(this.prisma);

    const parsed = rewriteBatchCreateSchema.parse(rawInput);

    if (parsed.sourceType === 'remote' && !this.search.isRemoteReady()) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '当前未配置自动搜索服务密钥，请使用默认的「粘贴链接清单」模式',
      );
    }

    // 1. Validate optional gallery category & available images (null = 0 images, no source-site images)
    let mediaCat: { id: string } | null = null;
    if (parsed.mediaCategoryId) {
      mediaCat = await this.prisma.base.mediaCategory.findFirst({
        where: { id: parsed.mediaCategoryId, tenantId },
        select: { id: true },
      });
      if (!mediaCat) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选配图分类不存在');
      }
      const assetCount = await this.prisma.base.mediaAsset.count({
        where: { tenantId, categoryId: mediaCat.id },
      });
      if (assetCount < 1) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '所选配图分类下暂无可用图片，请先上传至少 1 张企业图库配图，或选择「不配图（0 张）」',
        );
      }
    }

    // 2. Validate REWRITE prompt template
    const template = await this.prisma.base.promptTemplate.findFirst({
      where: {
        id: parsed.templateId,
        OR: [{ tenantId }, { tenantId: null }],
      },
      select: { id: true, kind: true },
    });
    if (!template) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选改写指令不存在');
    }
    if (template.kind !== 'REWRITE') {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '爆文改写指令仅允许选择「流量复刻」类型的模板',
      );
    }

    // 3. Compliance check on batch name, keyword, and optional brand
    const effectiveKeyword =
      parsed.sourceType === 'remote'
        ? parsed.keyword.trim()
        : (parsed.brand?.trim() || parsed.keyword.trim() || parsed.name.trim()).slice(0, 80);

    await this.compliance.assertAllowed({
      text: `${parsed.name}\n${effectiveKeyword}\n${parsed.brand ?? ''}`,
      action: 'rewrite_batch_create',
      tenantId,
      userId,
    });

    // 4. Canonicalize link list when sourceType === 'link_list'
    const canonicalLinks =
      parsed.sourceType === 'link_list'
        ? parseBatchLinkList(
            parsed.linksText !== undefined && parsed.linksText.trim().length > 0
              ? parsed.linksText
              : parsed.linkList,
            REWRITE_BATCH_LINK_LIST_MAX,
          ).candidates.map((c) => c.url)
        : [];

    // 5. Quote total reserve points & pre-check STRICT available balance
    const unitPoints = await this.resolveUnitPoints();
    const totalReserve = parsed.maxCount * unitPoints;
    const walletInfo = await this.billing.wallet(tenantId);
    if (walletInfo.billingMode === 'STRICT' && walletInfo.available < totalReserve) {
      throw new ApiError(
        402,
        API_ERROR.INSUFFICIENT_POINTS,
        `本批量复刻任务需预冻 ${totalReserve} 点（${parsed.maxCount} 篇 × ${unitPoints} 点），当前可用 ${walletInfo.available} 点`,
      );
    }

    // 6. Resolve or auto-create category "{name}（复刻）"
    const categoryId = await this.resolveOrCreateCategory(tenantId, parsed.categoryId, parsed.name);

    // 7. Create RewriteBatch + reserve points + enqueue job
    const batch = await this.prisma.base.rewriteBatch.create({
      data: {
        tenantId,
        name: parsed.name,
        keyword: effectiveKeyword,
        maxCount: parsed.maxCount,
        doneCount: 0,
        sourceType: parsed.sourceType,
        linkList: canonicalLinks,
        categoryId,
        mediaCategoryId: mediaCat?.id ?? null,
        templateId: template.id,
        status: 'QUEUED',
      },
      select: { id: true },
    });

    let reservationId: string | null = null;
    try {
      const resv = await this.billing.reserve({
        tenantId,
        refType: 'rewrite_batch',
        refId: batch.id,
        amount: totalReserve,
      });
      reservationId = resv.id;
      await this.enqueuer.enqueueRewriteBatch({ tenantId, batchId: batch.id });
    } catch (err) {
      if (reservationId) {
        await this.billing.close({ tenantId, reservationId }).catch(() => undefined);
      }
      await this.prisma.base.rewriteBatch
        .deleteMany({ where: { id: batch.id, tenantId } })
        .catch(() => undefined);
      if (err instanceof ApiError) throw err;
      throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, '任务队列暂不可用，未扣减点数');
    }

    return this.detailForTenant(tenantId, batch.id);
  }

  async pause(id: string): Promise<RewriteBatchDetailResponse> {
    const tenantId = requireTenant();
    const batch = await this.prisma.base.rewriteBatch.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '批量复刻任务不存在');
    }
    if (batch.status === 'QUEUED' || batch.status === 'RUNNING') {
      await this.prisma.base.rewriteBatch.updateMany({
        where: { id, tenantId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'PAUSED', note: '任务已暂停，可随时继续或终止退还剩余点数' },
      });
    }
    return this.detailForTenant(tenantId, id);
  }

  async resume(id: string): Promise<RewriteBatchDetailResponse> {
    const tenantId = requireTenant();
    const batch = await this.prisma.base.rewriteBatch.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '批量复刻任务不存在');
    }
    if (batch.status === 'PAUSED' || batch.status === 'QUEUED') {
      await this.prisma.base.rewriteBatch.updateMany({
        where: { id, tenantId, status: { in: ['PAUSED', 'QUEUED'] } },
        data: { status: 'QUEUED', note: null },
      });
      await this.enqueuer.enqueueRewriteBatch({ tenantId, batchId: id });
    }
    return this.detailForTenant(tenantId, id);
  }

  async cancel(id: string): Promise<RewriteBatchDetailResponse> {
    const tenantId = requireTenant();
    const batch = await this.prisma.base.rewriteBatch.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, doneCount: true, maxCount: true },
    });
    if (!batch) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '批量复刻任务不存在');
    }

    if (batch.status === 'QUEUED' || batch.status === 'RUNNING' || batch.status === 'PAUSED') {
      await this.prisma.base.$transaction(async (tx) => {
        await tx.rewriteRecord.updateMany({
          where: { batchId: id, tenantId, status: 'PENDING' },
          data: { status: 'SKIPPED', error: '任务已手动终止（未扣点）' },
        });
        await tx.rewriteBatch.updateMany({
          where: { id, tenantId },
          data: {
            status: 'CANCELLED',
            note: `任务已手动终止（已完成 ${batch.doneCount}/${batch.maxCount} 篇），未消耗预冻点数已退还`,
          },
        });
      });

      const resv = await this.prisma.base.pointReservation.findUnique({
        where: { refType_refId: { refType: 'rewrite_batch', refId: id } },
        select: { id: true, tenantId: true, status: true },
      });
      if (resv && resv.tenantId === tenantId && resv.status === 'OPEN') {
        await this.billing.close({ tenantId, reservationId: resv.id });
      }
    }

    return this.detailForTenant(tenantId, id);
  }

  async bulkDelete(ids: readonly string[]): Promise<{ affected: number }> {
    const tenantId = requireTenant();
    const uniqueIds = Array.from(new Set(ids));

    const activeCount = await this.prisma.base.rewriteBatch.count({
      where: {
        id: { in: uniqueIds },
        tenantId,
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      },
    });
    if (activeCount > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '进行中或已暂停的批量复刻任务请先执行「终止」释放冻结点数后再删除',
      );
    }

    const res = await this.prisma.base.rewriteBatch.deleteMany({
      where: { id: { in: uniqueIds }, tenantId },
    });
    return { affected: res.count };
  }
}
