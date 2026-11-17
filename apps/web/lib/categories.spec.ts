import { CATEGORY_ID } from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import { categoryIdFromHref } from './categories';

const CATEGORY = 'c'.repeat(25);

describe('category href', () => {
  it('reads only a category id that can be stored', () => {
    expect(categoryIdFromHref(`/writing/articles?categoryId=${CATEGORY}&taskId=t2`)).toBe(CATEGORY);
    expect(categoryIdFromHref('/writing/articles')).toBe('');
    expect(categoryIdFromHref('/writing/articles?categoryId=../secret')).toBe('');
    expect(categoryIdFromHref('/writing/articles?categoryId=short')).toBe('');
    expect(CATEGORY_ID.test(CATEGORY)).toBe(true);
  });
});
