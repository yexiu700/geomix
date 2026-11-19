import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER_DRAFT,
  buildArticlesRouteHref,
  buildDefaultCreateDraft,
  buildInitialFilterDraft,
  clearFilterHandoffs,
  filterDraftToQueryFields,
  parseOptionalIntInput,
  stashFilterHandoff,
  statusTagColor,
  takeFilterHandoff,
  validateFilterDraft,
  type FilterDraft,
} from './article-manage-helpers';
import { buildArticlesRouteHref as reexportedBuildArticlesRouteHref } from './article-manage-screen';

function draft(overrides: Partial<FilterDraft> = {}): FilterDraft {
  return { ...EMPTY_FILTER_DRAFT, ...overrides };
}

describe('article-manage-helpers (#288)', () => {
  describe('filter handoff', () => {
    it('is consumed exactly once per href', () => {
      clearFilterHandoffs();
      const href = '/writing/articles?taskId=task_once';
      stashFilterHandoff(href, draft({ taskId: 'task_once', keyword: '一次性' }));

      expect(takeFilterHandoff(href)).toEqual(draft({ taskId: 'task_once', keyword: '一次性' }));
      expect(takeFilterHandoff(href)).toBeNull();
    });

    it('isolates handoffs by href and overwrites a pending entry for the same href', () => {
      clearFilterHandoffs();
      stashFilterHandoff('/writing/articles?categoryId=a', draft({ keyword: 'A1' }));
      stashFilterHandoff('/writing/articles?categoryId=a', draft({ keyword: 'A2' }));
      stashFilterHandoff('/writing/articles?categoryId=b', draft({ keyword: 'B' }));

      expect(takeFilterHandoff('/writing/articles?categoryId=c')).toBeNull();
      expect(takeFilterHandoff('/writing/articles?categoryId=b')?.keyword).toBe('B');
      expect(takeFilterHandoff('/writing/articles?categoryId=a')?.keyword).toBe('A2');
    });

    it('clearFilterHandoffs drops every pending handoff', () => {
      stashFilterHandoff('/writing/articles?categoryId=x', draft({ keyword: 'X' }));
      stashFilterHandoff('/writing/articles?taskId=y', draft({ keyword: 'Y' }));
      clearFilterHandoffs();

      expect(takeFilterHandoff('/writing/articles?categoryId=x')).toBeNull();
      expect(takeFilterHandoff('/writing/articles?taskId=y')).toBeNull();
    });
  });

  describe('buildArticlesRouteHref', () => {
    it('builds bare route and query combinations', () => {
      expect(buildArticlesRouteHref()).toBe('/writing/articles');
      expect(buildArticlesRouteHref('', '')).toBe('/writing/articles');
      expect(buildArticlesRouteHref('cat_1')).toBe('/writing/articles?categoryId=cat_1');
      expect(buildArticlesRouteHref(undefined, 'task_1')).toBe('/writing/articles?taskId=task_1');
      expect(buildArticlesRouteHref('cat_1', 'task_1')).toBe(
        '/writing/articles?categoryId=cat_1&taskId=task_1',
      );
    });

    it('url-encodes values', () => {
      expect(buildArticlesRouteHref('a b&c')).toBe('/writing/articles?categoryId=a+b%26c');
    });

    it('remains importable from article-manage-screen with identical output', () => {
      expect(reexportedBuildArticlesRouteHref).toBe(buildArticlesRouteHref);
      expect(reexportedBuildArticlesRouteHref('cat_1', 'task_1')).toBe(
        '/writing/articles?categoryId=cat_1&taskId=task_1',
      );
    });
  });

  describe('parseOptionalIntInput', () => {
    it('returns undefined for blank input', () => {
      expect(parseOptionalIntInput('')).toBeUndefined();
      expect(parseOptionalIntInput('   ')).toBeUndefined();
    });

    it('accepts non-negative integers up to 6 digits (trimmed)', () => {
      expect(parseOptionalIntInput('0')).toBe(0);
      expect(parseOptionalIntInput(' 7 ')).toBe(7);
      expect(parseOptionalIntInput('999999')).toBe(999999);
    });

    it('rejects negatives, decimals, leading zeros, overflow and non-digits', () => {
      for (const raw of ['-1', '1.5', '01', '00', '1000000', 'abc', '1e3', '+3', '3 4']) {
        expect(parseOptionalIntInput(raw)).toBeUndefined();
      }
    });
  });

  describe('filter draft mapping', () => {
    it('validateFilterDraft reports the first invalid numeric field', () => {
      expect(validateFilterDraft(draft())).toBeNull();
      expect(validateFilterDraft(draft({ sendCount: '2', videoCount: '0' }))).toBeNull();
      expect(validateFilterDraft(draft({ sendCount: '-1', videoCount: 'x' }))).toBe(
        '发送次数筛选需填写非负整数',
      );
      expect(validateFilterDraft(draft({ videoCount: '1.2' }))).toBe(
        '转视频次数筛选需填写非负整数',
      );
    });

    it('filterDraftToQueryFields trims keyword and drops empty / invalid values', () => {
      expect(
        filterDraftToQueryFields(
          draft({
            categoryId: 'cat_1',
            keyword: '  激光 ',
            sendCount: '3',
            status: 'PENDING',
            createdFrom: '2026-11-01',
            sort: 'createdAt',
            order: 'asc',
          }),
        ),
      ).toEqual({
        categoryId: 'cat_1',
        taskId: undefined,
        keyword: '激光',
        sendCount: 3,
        videoCount: undefined,
        status: 'PENDING',
        createdFrom: '2026-11-01',
        createdTo: undefined,
        sort: 'createdAt',
        order: 'asc',
      });
      expect(filterDraftToQueryFields(draft({ status: 'BOGUS' })).status).toBeUndefined();
    });

    it('buildInitialFilterDraft prefers URL category/task over the handoff', () => {
      expect(buildInitialFilterDraft({}, null)).toEqual(EMPTY_FILTER_DRAFT);
      expect(
        buildInitialFilterDraft(
          { categoryId: 'cat_url' },
          draft({ categoryId: 'cat_handoff', taskId: 'task_handoff', keyword: 'k' }),
        ),
      ).toEqual(draft({ categoryId: 'cat_url', taskId: '', keyword: 'k' }));
    });
  });

  it('statusTagColor and buildDefaultCreateDraft keep their defaults', () => {
    expect(statusTagColor('NORMAL')).toBe('success');
    expect(statusTagColor('PENDING')).toBe('gold');
    expect(statusTagColor('DISABLED')).toBe('default');
    expect(buildDefaultCreateDraft(null)).toEqual({
      title: '',
      categoryId: '',
      mediaCategoryId: '',
      coverUrl: null,
      status: 'NORMAL',
      contentHtml: '<p></p>',
    });
  });
});
