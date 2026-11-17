import { Prisma } from '@prisma/client';
import {
  CATEGORY_REMAINING_EXPR,
  categoryNameLikePattern,
  type CategorySort,
  type CrudOrder,
} from '@geomix/shared';

/**
 * 文章数量和剩余量只用这一条聚合，不在分类行上保存计数。
 * 文章必须属于同一个租户，避免把别的租户挂到本分类上的行算进来。
 * 剩余量表达式来自共享常量，对应「正常且发送次数为 0」。
 */
const LIKE_ESCAPE = '\\';

export function categoryPageSql(input: {
  tenantId: string;
  keyword: string;
  sort: CategorySort;
  order: CrudOrder;
  limit: number;
  offset: number;
  categoryId?: string;
}): Prisma.Sql {
  const idFilter = input.categoryId ? Prisma.sql`AND c.id = ${input.categoryId}` : Prisma.empty;
  return Prisma.sql`
    SELECT c.id, c.name, c."createdAt",
      CAST(COUNT(a.id) AS int) AS total,
      CAST(${Prisma.raw(CATEGORY_REMAINING_EXPR)} AS int) AS remaining
    FROM "ArticleCategory" c
    LEFT JOIN "Article" a
      ON a."categoryId" = c.id AND a."tenantId" = c."tenantId"
    WHERE c."tenantId" = ${input.tenantId}
      ${idFilter}
      ${categoryNamePredicate(input.keyword)}
    GROUP BY c.id
    ORDER BY ${categoryOrderSql(input.sort, input.order)}
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
}

export function categoryCountSql(tenantId: string, keyword: string): Prisma.Sql {
  return Prisma.sql`
    SELECT CAST(COUNT(*) AS int) AS total
    FROM "ArticleCategory" c
    WHERE c."tenantId" = ${tenantId}
      ${categoryNamePredicate(keyword)}
  `;
}

function categoryNamePredicate(keyword: string): Prisma.Sql {
  const pattern = categoryNameLikePattern(keyword);
  if (!pattern) return Prisma.empty;
  return Prisma.sql`AND c.name ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`;
}

function categoryOrderSql(sort: CategorySort, order: CrudOrder): Prisma.Sql {
  const direction = order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (sort === 'name') return Prisma.sql`c.name ${direction}, c.id ASC`;
  if (sort === 'total') return Prisma.sql`COUNT(a.id) ${direction}, c.id ASC`;
  if (sort === 'remaining') {
    return Prisma.sql`${Prisma.raw(CATEGORY_REMAINING_EXPR)} ${direction}, c.id ASC`;
  }
  return Prisma.sql`c."createdAt" ${direction}, c.id ASC`;
}
