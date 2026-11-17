import { describe, expect, it } from 'vitest';
import {
  CATEGORY_REMAINING_EXPR,
  articleCategoryBulkSchema,
  articleCategoryInputSchema,
  articleCountsAsRemaining,
  categoryListQueryString,
  categoryNameLikePattern,
  parseArticleListQuery,
  parseCategoryListQuery,
  CategoryQueryError,
} from './writing-categories';

const CATEGORY = 'c'.repeat(25);

describe('article category contracts', () => {
  it('counts a normal unsent article as remaining and ignores source', () => {
    expect(articleCountsAsRemaining('NORMAL', 0)).toBe(true);
    expect(articleCountsAsRemaining('NORMAL', 1)).toBe(false);
    expect(articleCountsAsRemaining('PENDING', 0)).toBe(false);
    expect(articleCountsAsRemaining('DISABLED', 0)).toBe(false);
    expect(CATEGORY_REMAINING_EXPR).toBe(
      `COUNT(a.id) FILTER (WHERE a.status = 'NORMAL' AND a."sendCount" = 0)`,
    );
  });

  it('escapes like wildcards before the name search wraps them', () => {
    expect(categoryNameLikePattern('')).toBeNull();
    expect(categoryNameLikePattern('%')).toBe('%\\%%');
    expect(categoryNameLikePattern('_')).toBe('%\\_%');
    expect(categoryNameLikePattern('\\')).toBe('%\\\\%');
    expect(categoryNameLikePattern('50%_\\甲')).toBe('%50\\%\\_\\\\甲%');
    expect(categoryNameLikePattern('中文')).toBe('%中文%');
  });

  it('accepts only the category name and rejects a repeated or foreign field', () => {
    expect(articleCategoryInputSchema.parse({ name: '  测试分类  ' })).toEqual({
      name: '测试分类',
    });
    expect(articleCategoryInputSchema.safeParse({ name: '' }).success).toBe(false);
    expect(articleCategoryInputSchema.safeParse({ name: '甲', tenantId: 'other' }).success).toBe(
      false,
    );
    expect(articleCategoryInputSchema.safeParse({ name: '甲', total: 3 }).success).toBe(false);
    expect(articleCategoryBulkSchema.parse({ action: 'delete', ids: [CATEGORY] })).toEqual({
      action: 'delete',
      ids: [CATEGORY],
    });
    expect(articleCategoryBulkSchema.safeParse({ action: 'enable', ids: [CATEGORY] }).success).toBe(
      false,
    );
  });

  it('parses list filters without accepting a tenant or an enabled flag', () => {
    expect(
      parseCategoryListQuery({
        page: '2',
        pageSize: '25',
        sort: 'remaining',
        order: 'asc',
        filter: JSON.stringify({ keyword: ' 甲 ' }),
      }),
    ).toEqual({
      page: 2,
      pageSize: 25,
      sort: 'remaining',
      order: 'asc',
      keyword: '甲',
      export: undefined,
    });
    expect(categoryListQueryString(parseCategoryListQuery({}))).toBe(
      'page=1&pageSize=10&sort=createdAt&order=desc',
    );
    expect(() => parseCategoryListQuery({ pageSize: '20' })).toThrow(CategoryQueryError);
    expect(() =>
      parseCategoryListQuery({ filter: JSON.stringify({ keyword: '%', tenantId: 'other' }) }),
    ).toThrow('筛选不正确');
    expect(() => parseCategoryListQuery({ filter: JSON.stringify({ enabled: true }) })).toThrow(
      '筛选不正确',
    );
    expect(parseArticleListQuery({ categoryId: CATEGORY, taskId: 't2' })).toEqual({
      categoryId: CATEGORY,
      page: 1,
      pageSize: 10,
    });
    expect(() => parseArticleListQuery({ categoryId: '../secret' })).toThrow('分类编号不正确');
    expect(() => parseArticleListQuery({ categoryId: CATEGORY, tenantId: 'other' })).toThrow(
      '参数不正确',
    );
  });
});
