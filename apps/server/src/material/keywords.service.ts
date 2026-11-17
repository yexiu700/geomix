import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  DISTILL_MIN_VALID_DEFAULT,
  buildFakeDistillCandidates,
  cleanDistilledQuestions,
  escapeLikeLiteral,
  extractJsonStringArray,
  normalizeQuestionKey,
  parseBrandsInput,
  parseQuestionsLines,
  validateMainKeyword,
  type KeywordDetailRecord,
  type KeywordListQuery,
  type KeywordOptStatusName,
  type KeywordRecord,
  type QuestionSourceName,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService, scanCompliance } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

export const KEYWORDS_MIN_VALID_TOKEN = 'KEYWORDS_MIN_VALID_TOKEN';

@Injectable()
export class KeywordsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(KEYWORDS_MIN_VALID_TOKEN) private readonly minValidFn: () => number,
  ) {}

  async page(query: KeywordListQuery): Promise<{
    items: KeywordRecord[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = this.where(query);
    const [total, rows] = await Promise.all([
      this.prisma.scoped.keyword.count({ where }),
      this.prisma.scoped.keyword.findMany({
        where,
        orderBy: this.orderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { questions: true } } },
      }),
    ]);
    return {
      items: rows.map(presentKeyword),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async collect(query: KeywordListQuery): Promise<KeywordRecord[]> {
    const rows = await this.prisma.scoped.keyword.findMany({
      where: this.where(query),
      orderBy: this.orderBy(query),
      take: CRUD_EXPORT_LIMIT + 1,
      include: { _count: { select: { questions: true } } },
    });
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多');
    }
    return rows.map(presentKeyword);
  }

  async one(id: string): Promise<KeywordDetailRecord> {
    const tenantId = this.tenantId();
    const row = await this.prisma.scoped.keyword.findFirst({
      where: { id, tenantId },
      include: {
        _count: { select: { questions: true } },
        questions: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            text: true,
            source: true,
            included: true,
            usedCount: true,
            createdAt: true,
          },
        },
      },
    });
    if (!row) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '关键词不存在');
    return {
      ...presentKeyword(row),
      questions: row.questions.map((q) => ({
        id: q.id,
        text: q.text,
        source: q.source as QuestionSourceName,
        included: q.included,
        usedCount: q.usedCount,
        createdAt: q.createdAt.toISOString(),
      })),
    };
  }

  async distill(input: {
    main: string;
    brands?: string | string[];
    region?: string;
    idempotencyKey?: string;
    userId?: string;
  }): Promise<{ questions: string[]; charged: number; shadow: boolean }> {
    const tenantId = this.tenantId();
    const checked = validateMainKeyword(input.main);
    if (!checked.ok) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, checked.message);
    }
    const main = checked.value;
    const brands = parseBrandsInput(input.brands);
    const region = (input.region ?? '').trim().slice(0, 40);

    await this.compliance.assertAllowed({
      text: [main, ...brands, region].filter(Boolean).join(' '),
      action: 'distill',
      tenantId,
      userId: input.userId,
    });

    const prices = await this.billing.listPrices();
    const distillPrice = prices.find((item) => item.action === 'distill');
    if (!distillPrice?.enabled) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'AI蒸馏价格未启用');
    }
    const unitPoints = distillPrice.unitPoints;
    const rawIdem = (input.idempotencyKey ?? '').trim() || randomUUID();
    const safeIdem = rawIdem.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 96) || randomUUID();
    const unitKey = `distill:${safeIdem.length >= 8 ? safeIdem : `${safeIdem}-00000000`}`;

    const existingKeyword = await this.prisma.scoped.keyword.findFirst({
      where: { tenantId, main },
      select: { questions: { select: { text: true } } },
    });
    const existingQuestions = existingKeyword?.questions.map((q) => q.text) ?? [];

    const reservation = await this.billing.reserveSync({
      tenantId,
      refType: 'distill',
      unitKey,
      amount: unitPoints,
    });

    let rawCandidates: string[] = [];
    try {
      const completion = await this.llm.complete({
        tenantId,
        scene: 'distill',
        temperature: 0.8,
        maxTokens: 1500,
        idempotencyKey: unitKey,
        messages: [
          {
            role: 'system',
            content:
              '你是中文AI搜索用户行为分析师。请围绕用户给出的主关键词，生成30条潜在客户会向AI提出的咨询类问题，覆盖推荐类、价格类、对比类、地域类、厂家与服务商类。要求：每条必须包含主关键词，长度8到30字，不使用极限词，不出现任何品牌名称，仅输出JSON字符串数组。',
          },
          {
            role: 'user',
            content: [
              `主关键词：${main}`,
              brands.length > 0 ? `业务背景品牌（切勿出现在问题里）：${brands.join('、')}` : '',
              region ? `目标地域参考：${region}` : '',
              '请直接返回 JSON 字符串数组。',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });
      rawCandidates = completion.fake
        ? buildFakeDistillCandidates(main)
        : extractJsonStringArray(completion.text);
    } catch (error) {
      await this.refundDistill(tenantId, reservation.id, unitKey, unitPoints, 'AI蒸馏调用失败退还');
      throw new ApiError(
        502,
        API_ERROR.BAD_REQUEST,
        error instanceof Error && error.message
          ? `AI蒸馏失败：${error.message}`
          : 'AI蒸馏服务暂时不可用',
      );
    }

    const valid = cleanDistilledQuestions({
      rawCandidates,
      main,
      brands,
      existingQuestions,
      isBlockedOrExtreme: (text) => {
        const scanned = scanCompliance(text);
        return scanned.blocked || scanned.hits.length > 0 || scanned.flags.length > 0;
      },
    });

    const minValid = Math.max(1, this.minValidFn());
    if (valid.length < minValid) {
      await this.refundDistill(
        tenantId,
        reservation.id,
        unitKey,
        unitPoints,
        'AI蒸馏有效问题不足退还',
      );
      throw new ApiError(
        422,
        API_ERROR.BAD_REQUEST,
        `有效蒸馏问题不足 ${minValid} 条（实际 ${valid.length} 条），未扣除点数`,
      );
    }

    await this.billing.settle({
      tenantId,
      reservationId: reservation.id,
      unitKey,
      action: 'distill',
      amount: unitPoints,
      title: `AI蒸馏拓展-${main}`,
    });
    await this.billing.close({ tenantId, reservationId: reservation.id });

    return {
      questions: valid,
      charged: unitPoints,
      shadow: reservation.shadow,
    };
  }

  async create(input: {
    main: string;
    brands?: string | string[];
    questionsText: string;
    questionItems?: Array<{ text: string; source?: QuestionSourceName }>;
    userId?: string;
  }): Promise<{
    keyword: KeywordRecord;
    addedQuestions: number;
    skippedDuplicates: number;
  }> {
    const tenantId = this.tenantId();
    const checked = validateMainKeyword(input.main);
    if (!checked.ok) throw new ApiError(400, API_ERROR.BAD_REQUEST, checked.message);
    const main = checked.value;
    const brands = parseBrandsInput(input.brands);

    const sourceMap = new Map<string, QuestionSourceName>();
    for (const item of input.questionItems ?? []) {
      if (item.source) {
        sourceMap.set(normalizeQuestionKey(item.text), item.source);
        sourceMap.set(item.text.trim(), item.source);
      }
    }
    const parsedQuestions = parseQuestionsLines(input.questionsText, sourceMap);

    await this.compliance.assertAllowed({
      text: [main, ...brands, ...parsedQuestions.unique.map((q) => q.text)].join('\n'),
      action: 'keyword_create',
      tenantId,
      userId: input.userId,
    });

    try {
      const created = await this.prisma.base.$transaction(async (tx) => {
        await this.quota.consume(tenantId, 'MAIN_KEYWORD', 1, tx);
        if (parsedQuestions.unique.length > 0) {
          await this.ensureAndConsumeQuestions(tx, tenantId, parsedQuestions.unique.length);
        }
        const keywordRow = await tx.keyword.create({
          data: {
            tenantId,
            main,
            brands,
          },
        });
        if (parsedQuestions.unique.length > 0) {
          await tx.question.createMany({
            data: parsedQuestions.unique.map((q) => ({
              tenantId,
              keywordId: keywordRow.id,
              text: q.text,
              source: q.source,
              included: false,
            })),
          });
        }
        return keywordRow;
      }, TX_OPTIONS);

      return {
        keyword: {
          id: created.id,
          main: created.main,
          brands: created.brands,
          optStatus: created.optStatus as KeywordOptStatusName,
          questionCount: parsedQuestions.unique.length,
          createdAt: created.createdAt.toISOString(),
        },
        addedQuestions: parsedQuestions.unique.length,
        skippedDuplicates: parsedQuestions.skippedDuplicates,
      };
    } catch (error) {
      if (isUnique(error)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '该主训练词已存在');
      }
      throw error;
    }
  }

  async update(
    id: string,
    input: {
      main: string;
      brands?: string | string[];
      questionsText: string;
      questionItems?: Array<{ text: string; source?: QuestionSourceName }>;
      userId?: string;
    },
  ): Promise<{
    keyword: KeywordRecord;
    addedQuestions: number;
    removedQuestions: number;
    skippedDuplicates: number;
  }> {
    const tenantId = this.tenantId();
    const existing = await this.prisma.scoped.keyword.findFirst({
      where: { id, tenantId },
      include: { questions: true },
    });
    if (!existing) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '关键词不存在');

    const checked = validateMainKeyword(input.main);
    if (!checked.ok) throw new ApiError(400, API_ERROR.BAD_REQUEST, checked.message);
    const main = checked.value;
    const brands = parseBrandsInput(input.brands);

    const sourceMap = new Map<string, QuestionSourceName>();
    for (const item of input.questionItems ?? []) {
      if (item.source) {
        sourceMap.set(normalizeQuestionKey(item.text), item.source);
        sourceMap.set(item.text.trim(), item.source);
      }
    }
    const parsedQuestions = parseQuestionsLines(input.questionsText, sourceMap);

    await this.compliance.assertAllowed({
      text: [main, ...brands, ...parsedQuestions.unique.map((q) => q.text)].join('\n'),
      action: 'keyword_update',
      tenantId,
      userId: input.userId,
    });

    const existingByKey = new Map(existing.questions.map((q) => [normalizeQuestionKey(q.text), q]));
    const desiredKeys = new Set<string>();
    const toAdd: Array<{ text: string; source: QuestionSourceName }> = [];
    for (const item of parsedQuestions.unique) {
      const key = normalizeQuestionKey(item.text);
      desiredKeys.add(key);
      if (!existingByKey.has(key)) {
        toAdd.push(item);
      }
    }
    const toRemoveIds = existing.questions
      .filter((q) => !desiredKeys.has(normalizeQuestionKey(q.text)))
      .map((q) => q.id);

    try {
      const updated = await this.prisma.base.$transaction(async (tx) => {
        if (toRemoveIds.length > 0) {
          const deleted = await tx.question.deleteMany({
            where: { tenantId, keywordId: id, id: { in: toRemoveIds } },
          });
          if (deleted.count > 0) {
            await this.quota.release(tenantId, 'QUESTION', deleted.count, tx);
          }
        }
        if (toAdd.length > 0) {
          await this.ensureAndConsumeQuestions(tx, tenantId, toAdd.length);
          await tx.question.createMany({
            data: toAdd.map((q) => ({
              tenantId,
              keywordId: id,
              text: q.text,
              source: q.source,
              included: false,
            })),
          });
        }
        const row = await tx.keyword.update({
          where: { id },
          data: { main, brands },
          include: { _count: { select: { questions: true } } },
        });
        return row;
      }, TX_OPTIONS);

      return {
        keyword: presentKeyword(updated),
        addedQuestions: toAdd.length,
        removedQuestions: toRemoveIds.length,
        skippedDuplicates: parsedQuestions.skippedDuplicates,
      };
    } catch (error) {
      if (isUnique(error)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '该主训练词已存在');
      }
      throw error;
    }
  }

  async removeMany(ids: string[]): Promise<{ affected: number }> {
    const tenantId = this.tenantId();
    const uniqueIds = [...new Set(ids)];
    const found = await this.prisma.scoped.keyword.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '关键词不存在');
    }
    const taskRefs = await this.prisma.scoped.aiTask.count({
      where: { tenantId, keywordId: { in: uniqueIds } },
    });
    if (taskRefs > 0) {
      throw new ApiError(409, API_ERROR.BAD_REQUEST, '所选关键词已被写作任务引用，不能删除');
    }

    return this.prisma.base.$transaction(async (tx) => {
      const questionCount = await tx.question.count({
        where: { tenantId, keywordId: { in: uniqueIds } },
      });
      const deleted = await tx.keyword.deleteMany({
        where: { tenantId, id: { in: uniqueIds } },
      });
      if (deleted.count > 0) {
        await this.quota.release(tenantId, 'MAIN_KEYWORD', deleted.count, tx);
      }
      if (questionCount > 0) {
        await this.quota.release(tenantId, 'QUESTION', questionCount, tx);
      }
      return { affected: deleted.count };
    }, TX_OPTIONS);
  }

  private async ensureAndConsumeQuestions(
    tx: Prisma.TransactionClient,
    tenantId: string,
    count: number,
  ): Promise<void> {
    const quotaRow = await tx.quota.findUnique({
      where: { tenantId_key: { tenantId, key: 'QUESTION' } },
    });
    if (quotaRow && quotaRow.used + BigInt(count) > quotaRow.limit) {
      const remaining = Math.max(0, Number(quotaRow.limit - quotaRow.used));
      throw new ApiError(
        409,
        API_ERROR.QUOTA_EXCEEDED,
        `写作问题配额不足，当前还可添加 ${remaining} 条`,
      );
    }
    await this.quota.consume(tenantId, 'QUESTION', count, tx);
  }

  private async refundDistill(
    tenantId: string,
    reservationId: string,
    unitKey: string,
    amount: number,
    title: string,
  ): Promise<void> {
    await this.billing.releaseUnit({
      tenantId,
      reservationId,
      unitKey,
      amount,
      title,
    });
    await this.billing.close({ tenantId, reservationId });
  }

  private where(query: KeywordListQuery): Prisma.KeywordWhereInput {
    const where: Prisma.KeywordWhereInput = { tenantId: this.tenantId() };
    if (query.keyword) {
      where.main = { contains: escapeLikeLiteral(query.keyword), mode: 'insensitive' };
    }
    if (query.optStatus) {
      where.optStatus = query.optStatus;
    }
    return where;
  }

  private orderBy(query: KeywordListQuery): Prisma.KeywordOrderByWithRelationInput {
    if (query.sort === 'main') return { main: query.order };
    return { createdAt: query.order };
  }

  private tenantId(): string {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return tenantId;
  }
}

export function readDistillMinValid(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DISTILL_MIN_VALID?.trim();
  if (!raw) return DISTILL_MIN_VALID_DEFAULT;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 50
    ? parsed
    : DISTILL_MIN_VALID_DEFAULT;
}

function presentKeyword(row: {
  id: string;
  main: string;
  brands: string[];
  optStatus: string;
  createdAt: Date;
  _count: { questions: number };
}): KeywordRecord {
  return {
    id: row.id,
    main: row.main,
    brands: row.brands,
    optStatus: row.optStatus as KeywordOptStatusName,
    questionCount: row._count.questions,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
