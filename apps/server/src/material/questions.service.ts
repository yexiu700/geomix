import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  QUESTION_EMPTY_LINES_MSG,
  QUESTION_TEXT_MAX,
  cleanQuestionDisplay,
  escapeLikeLiteral,
  normalizeQuestionKey,
  parseBatchQuestionLines,
  type QuestionBatchCreateInput,
  type QuestionBatchResult,
  type QuestionListQuery,
  type QuestionRecord,
  type QuestionSourceName,
  type QuestionUpdateInput,
} from '@geomix/shared';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

type QuestionRowWithKeyword = {
  id: string;
  keywordId: string;
  text: string;
  source: QuestionSourceName;
  usedCount: number;
  included: boolean;
  createdAt: Date;
  keyword: {
    id: string;
    main: string;
  };
};

function presentQuestion(row: QuestionRowWithKeyword): QuestionRecord {
  return {
    id: row.id,
    keywordId: row.keywordId,
    keywordMain: row.keyword.main,
    text: row.text,
    source: row.source,
    usedCount: row.usedCount,
    included: row.included,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class QuestionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  async page(query: QuestionListQuery): Promise<{
    items: QuestionRecord[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = this.where(query);
    const [total, rows] = await Promise.all([
      this.prisma.scoped.question.count({ where }),
      this.prisma.scoped.question.findMany({
        where,
        orderBy: this.orderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { keyword: { select: { id: true, main: true } } },
      }),
    ]);

    return {
      items: rows.map(presentQuestion),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async collect(query: QuestionListQuery): Promise<QuestionRecord[]> {
    const rows = await this.prisma.scoped.question.findMany({
      where: this.where(query),
      orderBy: this.orderBy(query),
      take: CRUD_EXPORT_LIMIT + 1,
      include: { keyword: { select: { id: true, main: true } } },
    });
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多');
    }
    return rows.map(presentQuestion);
  }

  async batchCreate(
    input: QuestionBatchCreateInput & { userId?: string },
  ): Promise<QuestionBatchResult> {
    const tenantId = this.tenantId();
    const keywordRow = await this.prisma.scoped.keyword.findFirst({
      where: { id: input.keywordId, tenantId },
      select: { id: true, main: true },
    });
    if (!keywordRow) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '蒸馏主词不存在');
    }

    const parsed = parseBatchQuestionLines(input.questionsText);
    if (parsed.items.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, QUESTION_EMPTY_LINES_MSG);
    }

    for (const [idx, line] of parsed.items.entries()) {
      if (line.length > QUESTION_TEXT_MAX) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          `第 ${idx + 1} 条问题长度超过 ${QUESTION_TEXT_MAX} 个字符`,
        );
      }
    }

    await this.compliance.assertAllowed({
      text: parsed.items.join('\n'),
      action: 'question_create',
      tenantId,
      userId: input.userId,
    });

    return this.prisma.base.$transaction(async (tx) => {
      const existing = await tx.question.findMany({
        where: { tenantId, keywordId: keywordRow.id },
        select: { text: true },
      });
      const existingKeys = new Set(existing.map((q) => normalizeQuestionKey(q.text)));

      const toInsert: string[] = [];
      let existingDupCount = 0;
      for (const candidate of parsed.items) {
        const key = normalizeQuestionKey(candidate);
        if (existingKeys.has(key)) {
          existingDupCount += 1;
          continue;
        }
        existingKeys.add(key);
        toInsert.push(candidate);
      }

      const skippedCount = parsed.duplicateInInputCount + existingDupCount;
      if (toInsert.length === 0) {
        return {
          createdCount: 0,
          skippedCount,
          items: [],
        };
      }

      const quotaRow = await tx.quota.findUnique({
        where: { tenantId_key: { tenantId, key: 'QUESTION' } },
      });
      if (quotaRow && quotaRow.used + BigInt(toInsert.length) > quotaRow.limit) {
        const remaining = Math.max(0, Number(quotaRow.limit - quotaRow.used));
        throw new ApiError(
          409,
          API_ERROR.QUOTA_EXCEEDED,
          `写作问题配额不足，当前还可添加 ${remaining} 条`,
        );
      }

      await this.quota.consume(tenantId, 'QUESTION', toInsert.length, tx);

      const createdItems: QuestionRecord[] = [];
      for (const text of toInsert) {
        const row = await tx.question.create({
          data: {
            tenantId,
            keywordId: keywordRow.id,
            text,
            source: 'MANUAL',
            included: false,
          },
          include: { keyword: { select: { id: true, main: true } } },
        });
        createdItems.push(presentQuestion(row));
      }

      return {
        createdCount: createdItems.length,
        skippedCount,
        items: createdItems,
      };
    }, TX_OPTIONS);
  }

  async update(
    id: string,
    input: QuestionUpdateInput & { userId?: string },
  ): Promise<QuestionRecord> {
    const tenantId = this.tenantId();
    const current = await this.prisma.scoped.question.findFirst({
      where: { id, tenantId },
      include: { keyword: { select: { id: true, main: true } } },
    });
    if (!current) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作标题不存在');
    }

    const cleaned = cleanQuestionDisplay(input.text);
    if (!cleaned) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请输入问题内容');
    }
    if (cleaned.length > QUESTION_TEXT_MAX) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, `单条问题不超过 ${QUESTION_TEXT_MAX} 个字符`);
    }

    await this.compliance.assertAllowed({
      text: cleaned,
      action: 'question_update',
      tenantId,
      userId: input.userId,
    });

    const siblings = await this.prisma.scoped.question.findMany({
      where: { tenantId, keywordId: current.keywordId, id: { not: current.id } },
      select: { text: true },
    });
    const targetKey = normalizeQuestionKey(cleaned);
    if (siblings.some((s) => normalizeQuestionKey(s.text) === targetKey)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '该主词下已存在相同问题');
    }

    try {
      const updated = await this.prisma.scoped.question.update({
        where: { id: current.id },
        data: { text: cleaned },
        include: { keyword: { select: { id: true, main: true } } },
      });
      return presentQuestion(updated);
    } catch (error) {
      if (isUniqueError(error)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '该主词下已存在相同问题');
      }
      throw error;
    }
  }

  async removeMany(ids: string[]): Promise<{ affected: number }> {
    const tenantId = this.tenantId();
    const uniqueIds = [...new Set(ids)];
    const found = await this.prisma.scoped.question.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作标题不存在');
    }

    return this.prisma.base.$transaction(async (tx) => {
      const deleted = await tx.question.deleteMany({
        where: { tenantId, id: { in: uniqueIds } },
      });
      if (deleted.count > 0) {
        await this.quota.release(tenantId, 'QUESTION', deleted.count, tx);
      }
      return { affected: deleted.count };
    }, TX_OPTIONS);
  }

  private where(query: QuestionListQuery): Prisma.QuestionWhereInput {
    const where: Prisma.QuestionWhereInput = { tenantId: this.tenantId() };
    if (query.keywordId) {
      where.keywordId = query.keywordId;
    }
    if (query.included !== undefined) {
      where.included = query.included;
    }
    if (query.createdAtFrom || query.createdAtTo) {
      where.createdAt = {
        ...(query.createdAtFrom ? { gte: new Date(query.createdAtFrom) } : {}),
        ...(query.createdAtTo ? { lte: new Date(query.createdAtTo) } : {}),
      };
    }
    if (query.keyword) {
      const needle = escapeLikeLiteral(query.keyword);
      where.OR = [
        { text: { contains: needle, mode: 'insensitive' } },
        { keyword: { main: { contains: needle, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  private orderBy(query: QuestionListQuery): Prisma.QuestionOrderByWithRelationInput[] {
    if (query.sort === 'usedCount') {
      return [{ usedCount: query.order }, { createdAt: 'desc' }];
    }
    if (query.sort === 'text') {
      return [{ text: query.order }, { createdAt: 'desc' }];
    }
    return [{ createdAt: query.order }, { id: query.order }];
  }

  private tenantId(): string {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return tenantId;
  }
}
