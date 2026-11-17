import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  escapeLikeLiteral,
  type AiTaskCreateInput,
  type AiTaskDetailRecord,
  type AiTaskItemRecord,
  type AiTaskListQuery,
  type AiTaskListResponse,
  type AiTaskRecord,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS, isUniqueViolation } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { AI_TASK_ENQUEUER, type AiTaskEnqueuer } from './ai-task.runner';
import { ensureBuiltInSystemTemplates } from './system-templates.helper';

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

type LoadedTaskRow = Prisma.AiTaskGetPayload<{
  include: {
    category: { select: { id: true; name: true } };
    keyword: { select: { id: true; main: true } };
    mediaCategory: { select: { id: true; name: true } };
    kb: { select: { id: true; name: true } };
    contentTpl: { select: { id: true; name: true } };
    titleTpl: { select: { id: true; name: true } };
  };
}>;

@Injectable()
export class AiTasksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(AI_TASK_ENQUEUER) private readonly enqueuer: AiTaskEnqueuer,
  ) {}

  async page(query: AiTaskListQuery): Promise<AiTaskListResponse> {
    const tenantId = requireTenant();
    const where = this.buildWhere(tenantId, query);
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.base.aiTask.count({ where }),
      this.prisma.base.aiTask.findMany({
        where,
        orderBy: this.buildOrderBy(query),
        skip,
        take: query.pageSize,
        include: {
          category: { select: { id: true, name: true } },
          keyword: { select: { id: true, main: true } },
          mediaCategory: { select: { id: true, name: true } },
          kb: { select: { id: true, name: true } },
          contentTpl: { select: { id: true, name: true } },
          titleTpl: { select: { id: true, name: true } },
        },
      }),
    ]);

    const items = await this.presentMany(tenantId, rows);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items,
    };
  }

  async exportRows(query: AiTaskListQuery): Promise<AiTaskRecord[]> {
    const tenantId = requireTenant();
    const where = this.buildWhere(tenantId, query);
    const rows = await this.prisma.base.aiTask.findMany({
      where,
      orderBy: this.buildOrderBy(query),
      take: CRUD_EXPORT_LIMIT,
      include: {
        category: { select: { id: true, name: true } },
        keyword: { select: { id: true, main: true } },
        mediaCategory: { select: { id: true, name: true } },
        kb: { select: { id: true, name: true } },
        contentTpl: { select: { id: true, name: true } },
        titleTpl: { select: { id: true, name: true } },
      },
    });
    return this.presentMany(tenantId, rows);
  }

  async detail(id: string): Promise<AiTaskDetailRecord> {
    const tenantId = requireTenant();
    return this.detailForTenant(tenantId, id);
  }

  async detailForTenant(tenantId: string, id: string): Promise<AiTaskDetailRecord> {
    const row = await this.prisma.base.aiTask.findFirst({
      where: { id, tenantId },
      include: {
        category: { select: { id: true, name: true } },
        keyword: { select: { id: true, main: true } },
        mediaCategory: { select: { id: true, name: true } },
        kb: { select: { id: true, name: true } },
        contentTpl: { select: { id: true, name: true } },
        titleTpl: { select: { id: true, name: true } },
        items: {
          orderBy: { seq: 'asc' },
          include: {
            question: { select: { id: true, text: true } },
          },
        },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作任务不存在');
    }
    const [base] = await this.presentMany(tenantId, [row]);
    const items: AiTaskItemRecord[] = row.items.map((item) => ({
      id: item.id,
      seq: item.seq,
      questionId: item.questionId,
      questionText: item.question?.text ?? null,
      templateId: item.templateId,
      direction: item.direction,
      copyType: item.copyType,
      brand: item.brand,
      title: item.title,
      status: item.status,
      attempts: item.attempts,
      model: item.model,
      tokensIn: item.tokensIn,
      tokensOut: item.tokensOut,
      error: item.error,
      articleId: item.articleId,
      startedAt: item.startedAt ? item.startedAt.toISOString() : null,
      finishedAt: item.finishedAt ? item.finishedAt.toISOString() : null,
    }));
    return {
      ...base!,
      items,
    };
  }

  async create(input: AiTaskCreateInput, userId: string): Promise<AiTaskDetailRecord> {
    const tenantId = requireTenant();
    await ensureBuiltInSystemTemplates(this.prisma);

    // 1. Verify keyword & question count
    const keyword = await this.prisma.base.keyword.findFirst({
      where: { id: input.keywordId, tenantId },
      select: { id: true, main: true, brands: true, _count: { select: { questions: true } } },
    });
    if (!keyword) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选训练主词不存在');
    }
    if (keyword._count.questions < 1) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选训练主词下暂无写作问题，请先添加问题后再发起任务',
      );
    }

    // 2. Verify mediaCategory & image assets
    const mediaCat = await this.prisma.base.mediaCategory.findFirst({
      where: { id: input.mediaCategoryId, tenantId },
      select: { id: true, _count: { select: { assets: true } } },
    });
    if (!mediaCat) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选企业画像图库不存在');
    }
    if (input.imageCount > 0 && mediaCat._count.assets < 1) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选图库分类暂无图片，请先上传图片或将配图数设为 0',
      );
    }

    // 3. Verify optional knowledge base
    if (input.kbId) {
      const kb = await this.prisma.base.knowledgeBase.findFirst({
        where: { id: input.kbId, tenantId },
        select: { id: true, indexStatus: true },
      });
      if (!kb) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选企业知识库不存在');
      }
      if (kb.indexStatus === 'INDEXING') {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '所选知识库正在建立向量索引，请变为「可用」后再提交任务',
        );
      }
      if (kb.indexStatus === 'FAILED') {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '所选知识库索引异常，请重新保存知识库后再试',
        );
      }
    }

    // 4. Verify optional contentTpl & titleTpl
    if (input.contentTplId) {
      const tpl = await this.prisma.base.promptTemplate.findFirst({
        where: {
          id: input.contentTplId,
          kind: 'ARTICLE',
          OR: [{ tenantId: null }, { tenantId }],
        },
        select: { id: true },
      });
      if (!tpl) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '所选文章创作指令不存在或类型不匹配');
      }
    }
    if (input.titleTplId) {
      const tpl = await this.prisma.base.promptTemplate.findFirst({
        where: {
          id: input.titleTplId,
          kind: 'TITLE',
          OR: [{ tenantId: null }, { tenantId }],
        },
        select: { id: true },
      });
      if (!tpl) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '所选标题创作指令不存在或类型不匹配');
      }
    }

    // 5. Compliance check on task name & keyword
    await this.compliance.assertAllowed({
      text: `${input.name}\n${keyword.main}\n${keyword.brands.join(' ')}`,
      action: 'ai_task_create',
      tenantId,
      userId,
    });

    // 6. Quota pre-check (AI_WRITE: used + target <= limit; increment only on settle)
    await this.quota.assertAvailable(tenantId, 'AI_WRITE', input.target);

    // 7. Quote price & pre-check STRICT balance for descriptive error message
    const quote = await this.billing.quoteAiWrite({
      count: input.target,
      withKnowledgeBase: Boolean(input.kbId),
      taskName: input.name,
    });
    const walletInfo = await this.billing.wallet(tenantId);
    if (walletInfo.billingMode === 'STRICT' && walletInfo.available < quote.total) {
      throw new ApiError(
        402,
        API_ERROR.INSUFFICIENT_POINTS,
        `本任务需要预扣 ${quote.total} 点，当前可用 ${walletInfo.available} 点`,
      );
    }

    // 8. Resolve or auto-create ArticleCategory
    const categoryId = await this.resolveCategoryId(tenantId, input.categoryId, input.name);

    // 9. Create AiTask + target AiTaskItems
    const seed = randomInt(1, 2_147_483_647);
    const created = await this.prisma.base.aiTask.create({
      data: {
        tenantId,
        name: input.name,
        categoryId,
        keywordId: input.keywordId,
        mediaCategoryId: input.mediaCategoryId,
        imageCount: input.imageCount,
        kbId: input.kbId,
        contentTplId: input.contentTplId,
        titleTplId: input.titleTplId,
        resultStatus: input.resultStatus,
        target: input.target,
        unitPrice: quote.unitTotal,
        seed,
        status: 'QUEUED',
        items: {
          create: Array.from({ length: input.target }, (_, idx) => ({
            seq: idx + 1,
            status: 'PENDING',
          })),
        },
      },
      select: { id: true },
    });

    // 10. Reserve full points & enqueue driver job
    let reservationId: string | null = null;
    try {
      const resv = await this.billing.reserve({
        tenantId,
        refType: 'ai_task',
        refId: created.id,
        amount: quote.total,
      });
      reservationId = resv.id;
      await this.enqueuer.enqueueAiTask({ tenantId, taskId: created.id });
    } catch (error) {
      if (reservationId) {
        await this.billing.close({ tenantId, reservationId }).catch(() => undefined);
      }
      await this.prisma.base.aiTask
        .deleteMany({ where: { id: created.id, tenantId } })
        .catch(() => undefined);
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, '任务队列暂不可用，未扣减点数');
    }

    return this.detailForTenant(tenantId, created.id);
  }

  async pause(id: string): Promise<AiTaskDetailRecord> {
    const tenantId = requireTenant();
    const existing = await this.prisma.base.aiTask.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作任务不存在');
    }
    if (existing.status === 'QUEUED' || existing.status === 'RUNNING') {
      await this.prisma.base.aiTask.updateMany({
        where: { id, tenantId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'PAUSED' },
      });
    }
    return this.detailForTenant(tenantId, id);
  }

  async resume(id: string): Promise<AiTaskDetailRecord> {
    const tenantId = requireTenant();
    const existing = await this.prisma.base.aiTask.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作任务不存在');
    }
    if (existing.status === 'PAUSED' || existing.status === 'QUEUED') {
      await this.prisma.base.aiTask.updateMany({
        where: { id, tenantId, status: { in: ['PAUSED', 'QUEUED'] } },
        data: { status: 'QUEUED', lastError: null },
      });
      await this.enqueuer.enqueueAiTask({ tenantId, taskId: id });
    }
    return this.detailForTenant(tenantId, id);
  }

  async cancel(id: string): Promise<AiTaskDetailRecord> {
    const tenantId = requireTenant();
    const existing = await this.prisma.base.aiTask.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作任务不存在');
    }

    let runningCount = 0;
    await this.prisma.base.$transaction(async (tx) => {
      const taskRows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status
        FROM "AiTask"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const status = taskRows[0]?.status;
      if (status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED') {
        await tx.aiTask.update({
          where: { id },
          data: { status: 'CANCELLED' },
        });
        await tx.aiTaskItem.updateMany({
          where: { taskId: id, status: 'PENDING' },
          data: { status: 'SKIPPED', finishedAt: new Date() },
        });
      }
      runningCount = await tx.aiTaskItem.count({
        where: { taskId: id, status: 'RUNNING' },
      });
    }, TX_OPTIONS);

    if (runningCount === 0) {
      const reservation = await this.prisma.base.pointReservation.findFirst({
        where: {
          tenantId,
          refType: 'ai_task',
          refId: id,
        },
      });
      if (reservation && reservation.status === 'OPEN') {
        await this.billing.close({ tenantId, reservationId: reservation.id });
      }
    }

    return this.detailForTenant(tenantId, id);
  }

  async bulkDelete(ids: readonly string[]): Promise<{ deleted: number }> {
    const tenantId = requireTenant();
    const uniqueIds = Array.from(new Set(ids));
    const activeCount = await this.prisma.base.aiTask.count({
      where: {
        tenantId,
        id: { in: uniqueIds },
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      },
    });
    if (activeCount > 0) {
      throw new ApiError(
        409,
        API_ERROR.BAD_REQUEST,
        '排队中、创作中或已暂停的任务请先点击「终止」释放冻结后再删除',
      );
    }
    const res = await this.prisma.base.aiTask.deleteMany({
      where: {
        tenantId,
        id: { in: uniqueIds },
        status: { in: ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] },
      },
    });
    return { deleted: res.count };
  }

  private async resolveCategoryId(
    tenantId: string,
    explicitCategoryId: string | null,
    taskName: string,
  ): Promise<string> {
    if (explicitCategoryId) {
      const cat = await this.prisma.base.articleCategory.findFirst({
        where: { id: explicitCategoryId, tenantId },
        select: { id: true },
      });
      if (!cat) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选文章分类不存在');
      }
      return cat.id;
    }

    const existing = await this.prisma.base.articleCategory.findUnique({
      where: { tenantId_name: { tenantId, name: taskName } },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const created = await this.prisma.base.articleCategory.create({
        data: { tenantId, name: taskName },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.prisma.base.articleCategory.findUnique({
          where: { tenantId_name: { tenantId, name: taskName } },
          select: { id: true },
        });
        if (raced) return raced.id;
      }
      throw error;
    }
  }

  private buildWhere(tenantId: string, query: AiTaskListQuery): Prisma.AiTaskWhereInput {
    const where: Prisma.AiTaskWhereInput = { tenantId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.keyword) {
      const escaped = escapeLikeLiteral(query.keyword);
      where.OR = [
        { name: { contains: escaped, mode: 'insensitive' } },
        { keyword: { main: { contains: escaped, mode: 'insensitive' } } },
        { category: { name: { contains: escaped, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  private buildOrderBy(query: AiTaskListQuery): Prisma.AiTaskOrderByWithRelationInput[] {
    if (query.sort === 'name') {
      return [{ name: query.order }, { createdAt: 'desc' }];
    }
    if (query.sort === 'lastWrittenAt') {
      return [{ lastWrittenAt: query.order }, { createdAt: 'desc' }];
    }
    return [{ createdAt: query.order }, { id: 'desc' }];
  }

  private async presentMany(
    tenantId: string,
    rows: readonly LoadedTaskRow[],
  ): Promise<AiTaskRecord[]> {
    if (rows.length === 0) return [];
    const taskIds = rows.map((r) => r.id);

    const [reservations, skipCounts] = await Promise.all([
      this.prisma.base.pointReservation.findMany({
        where: {
          tenantId,
          refType: 'ai_task',
          refId: { in: taskIds },
        },
        select: {
          refId: true,
          frozen: true,
          settled: true,
          released: true,
        },
      }),
      this.prisma.base.aiTaskItem.groupBy({
        by: ['taskId'],
        where: { taskId: { in: taskIds }, status: 'SKIPPED' },
        _count: { _all: true },
      }),
    ]);

    const resvMap = new Map(reservations.map((r) => [r.refId, r]));
    const skipMap = new Map(skipCounts.map((s) => [s.taskId, s._count._all]));

    return rows.map((row) => {
      const resv = resvMap.get(row.id);
      return {
        id: row.id,
        name: row.name,
        categoryId: row.categoryId,
        categoryName: row.category.name,
        keywordId: row.keywordId,
        keywordMain: row.keyword.main,
        mediaCategoryId: row.mediaCategoryId,
        mediaCategoryName: row.mediaCategory.name,
        imageCount: row.imageCount,
        kbId: row.kbId,
        kbName: row.kb?.name ?? null,
        contentTplId: row.contentTplId,
        contentTplName: row.contentTpl?.name ?? null,
        titleTplId: row.titleTplId,
        titleTplName: row.titleTpl?.name ?? null,
        resultStatus: row.resultStatus,
        target: row.target,
        doneCount: row.doneCount,
        failCount: row.failCount,
        skipCount: skipMap.get(row.id) ?? 0,
        unitPrice: row.unitPrice,
        frozenPoints: resv?.frozen ?? row.target * row.unitPrice,
        settledPoints: resv?.settled ?? 0,
        releasedPoints: resv?.released ?? 0,
        status: row.status,
        lastError: row.lastError,
        lastWrittenAt: row.lastWrittenAt ? row.lastWrittenAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
