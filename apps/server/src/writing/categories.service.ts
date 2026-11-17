import { Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  articleCountsAsRemaining,
  isArticleStatus,
  type ArticleCategoryInput,
  type ArticleCategoryRecord,
  type ArticleListItem,
  type ArticleListQuery,
  type CategoryListQuery,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { categoryCountSql, categoryPageSql } from './categories.sql';

type StatsRow = {
  id: string;
  name: string;
  createdAt: Date | string;
  total: number | bigint | string;
  remaining: number | bigint | string;
};

/**
 * 文章分类只读写当前登录租户。
 * 文章数量、剩余量每次用 SQL 聚合，不写回分类表。
 * 这里不调用计费，也不创建写作任务。
 */
@Injectable()
export class CategoriesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async page(query: CategoryListQuery): Promise<{
    items: ArticleCategoryRecord[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const tenantId = this.tenantId();
    const [countRows, rows] = await Promise.all([
      this.prisma.base.$queryRaw<Array<{ total: number | bigint | string }>>(
        categoryCountSql(tenantId, query.keyword),
      ),
      this.prisma.base.$queryRaw<StatsRow[]>(
        categoryPageSql({
          tenantId,
          keyword: query.keyword,
          sort: query.sort,
          order: query.order,
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        }),
      ),
    ]);
    return {
      items: rows.map(presentCategory),
      total: readCount(countRows[0]?.total),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async collect(query: CategoryListQuery): Promise<ArticleCategoryRecord[]> {
    const rows = await this.prisma.base.$queryRaw<StatsRow[]>(
      categoryPageSql({
        tenantId: this.tenantId(),
        keyword: query.keyword,
        sort: query.sort,
        order: query.order,
        limit: CRUD_EXPORT_LIMIT + 1,
        offset: 0,
      }),
    );
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多');
    }
    return rows.map(presentCategory);
  }

  async one(id: string): Promise<ArticleCategoryRecord> {
    const row = await this.stats(id);
    if (!row) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    return row;
  }

  async create(input: ArticleCategoryInput): Promise<ArticleCategoryRecord> {
    try {
      const row = await this.prisma.scoped.articleCategory.create({
        data: { tenantId: this.tenantId(), name: input.name },
      });
      return await this.one(row.id);
    } catch (error) {
      if (isUnique(error)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '文章分类已存在');
      throw error;
    }
  }

  async update(id: string, input: ArticleCategoryInput): Promise<ArticleCategoryRecord> {
    const tenantId = this.tenantId();
    const existing = await this.prisma.scoped.articleCategory.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    try {
      await this.prisma.scoped.articleCategory.update({
        where: { id },
        data: { name: input.name },
      });
    } catch (error) {
      if (isUnique(error)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '文章分类已存在');
      throw error;
    }
    return this.one(id);
  }

  async remove(ids: string[]): Promise<{ affected: number }> {
    const tenantId = this.tenantId();
    const unique = [...new Set(ids)];
    const found = await this.prisma.scoped.articleCategory.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    try {
      const result = await this.prisma.scoped.articleCategory.deleteMany({
        where: { tenantId, id: { in: unique } },
      });
      return { affected: result.count };
    } catch (error) {
      if (isForeignKey(error)) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '该分类正在被写作任务或复刻任务使用，不能删除',
        );
      }
      throw error;
    }
  }

  async articles(query: ArticleListQuery): Promise<{
    category: ArticleCategoryRecord;
    items: ArticleListItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const category = await this.stats(query.categoryId);
    if (!category) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    const where = { tenantId: this.tenantId(), categoryId: query.categoryId };
    const [total, rows] = await Promise.all([
      this.prisma.scoped.article.count({ where }),
      this.prisma.scoped.article.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          title: true,
          status: true,
          sendCount: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      category,
      items: rows.map(presentArticle),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async stats(id: string): Promise<ArticleCategoryRecord | null> {
    const rows = await this.prisma.base.$queryRaw<StatsRow[]>(
      categoryPageSql({
        tenantId: this.tenantId(),
        keyword: '',
        sort: 'createdAt',
        order: 'desc',
        limit: 1,
        offset: 0,
        categoryId: id,
      }),
    );
    const row = rows[0];
    return row ? presentCategory(row) : null;
  }

  private tenantId(): string {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return tenantId;
  }
}

function presentCategory(row: StatsRow): ArticleCategoryRecord {
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  return {
    id: row.id,
    name: row.name,
    total: readCount(row.total),
    remaining: readCount(row.remaining),
    createdAt: createdAt.toISOString(),
  };
}

function presentArticle(row: {
  id: string;
  title: string;
  status: string;
  sendCount: number;
  createdAt: Date;
}): ArticleListItem {
  if (!isArticleStatus(row.status)) {
    throw new ApiError(500, 50000, '文章状态不正确');
  }
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    sendCount: row.sendCount,
    countsAsRemaining: articleCountsAsRemaining(row.status, row.sendCount),
    createdAt: row.createdAt.toISOString(),
  };
}

function readCount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new ApiError(500, 50000, '文章数量不正确');
}

function isUnique(error: unknown): boolean {
  return prismaCode(error) === 'P2002';
}

function isForeignKey(error: unknown): boolean {
  return prismaCode(error) === 'P2003';
}

function prismaCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
