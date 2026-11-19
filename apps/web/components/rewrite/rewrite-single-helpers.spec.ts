import {
  REWRITE_IMAGE_DEFAULT,
  REWRITE_MIN_SOURCE_CHARS,
  type RewriteRecordItem,
} from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import type { RewriteFormOptions } from '../../lib/rewrites';
import * as BatchHelpers from './rewrite-batch-helpers';
import {
  NO_IMAGE_GALLERY_VALUE,
  articleStatusTagColor,
  buildInitialDraft,
  buildRetrySeed,
  formatCreatedBanner,
  formatTime,
  getArticlesHref,
  isCheckableUrl,
  itemStatusTagColor,
  toCreateSingleInput,
  validateCreateDraft,
  type CreateDraft,
} from './rewrite-single-helpers';

function makeOptions(assetCounts: number[]): RewriteFormOptions {
  return {
    unitPoints: 5,
    categories: [],
    mediaCategories: assetCounts.map((assetCount, idx) => ({
      id: `mcat_${idx}`,
      name: `图库${idx}`,
      type: 1,
      assetCount,
      previewAssets: [],
      createdAt: '2026-11-17T08:00:00.000Z',
    })),
    rewriteTemplates: [],
  };
}

function makeRecord(overrides: Partial<RewriteRecordItem> = {}): RewriteRecordItem {
  return {
    id: 'rw_rec_001',
    batchId: null,
    url: 'https://mp.weixin.qq.com/s/sensor-guide',
    urlHash: 'hash_001',
    pastedText: false,
    sourceTitle: '工业传感器选型实务',
    newTitle: '新标题',
    categoryId: 'cat_rw_001',
    categoryName: '爆文复刻-20261117-0900',
    mediaCategoryId: 'mcat_001',
    mediaCategoryName: '产线实拍图库',
    templateId: 'sys_rewrite_01',
    templateName: '系统·参考重写',
    status: 'FAILED',
    error: null,
    similarity: 0.1,
    highSimilarity: false,
    articleId: null,
    articleStatus: null,
    rewrittenAt: null,
    createdAt: '2026-11-17T08:59:55.000Z',
    ...overrides,
  };
}

function validDraft(overrides: Partial<CreateDraft> = {}): CreateDraft {
  return {
    ...buildInitialDraft(makeOptions([3])),
    url: 'https://example.com/a',
    mediaCategoryId: 'mcat_0',
    templateId: 'tpl_1',
    ...overrides,
  };
}

describe('rewrite-single-helpers', () => {
  describe('buildInitialDraft', () => {
    it('defaults to URL mode with default image count when a usable gallery exists', () => {
      expect(buildInitialDraft(makeOptions([0, 4]))).toEqual({
        pastedText: false,
        url: '',
        pastedTitle: '',
        pastedContent: '',
        mediaCategoryId: '',
        imageCount: REWRITE_IMAGE_DEFAULT,
        templateId: '',
        categoryId: '',
        autoCategoryName: '爆文复刻',
        resultStatus: 'PENDING',
        brand: '',
      });
    });

    it('degrades to 0 images when no gallery has assets or options are missing', () => {
      expect(buildInitialDraft(makeOptions([0, 0])).imageCount).toBe(0);
      expect(buildInitialDraft(makeOptions([])).imageCount).toBe(0);
      expect(buildInitialDraft(null).imageCount).toBe(0);
    });

    it('prefers seed values over defaults (pasted-text retry prefill)', () => {
      const draft = buildInitialDraft(makeOptions([4]), {
        pastedText: true,
        url: 'https://example.com/x',
        pastedTitle: '源标题',
        mediaCategoryId: 'mcat_0',
        imageCount: 0,
        templateId: 'tpl_1',
        categoryId: 'cat_1',
        resultStatus: 'NORMAL',
        brand: '品牌',
      });
      expect(draft).toMatchObject({
        pastedText: true,
        url: 'https://example.com/x',
        pastedTitle: '源标题',
        mediaCategoryId: 'mcat_0',
        imageCount: 0,
        templateId: 'tpl_1',
        categoryId: 'cat_1',
        resultStatus: 'NORMAL',
        brand: '品牌',
        autoCategoryName: '爆文复刻',
      });
    });
  });

  describe('status tag colors and shared helpers', () => {
    it('maps item statuses to tag colors', () => {
      expect(itemStatusTagColor('SUCCESS')).toBe('success');
      expect(itemStatusTagColor('RUNNING')).toBe('processing');
      expect(itemStatusTagColor('FAILED')).toBe('error');
      expect(itemStatusTagColor('SKIPPED')).toBe('default');
      expect(itemStatusTagColor('PENDING')).toBe('blue');
    });

    it('maps article statuses to tag colors', () => {
      expect(articleStatusTagColor('NORMAL')).toBe('green');
      expect(articleStatusTagColor('PENDING')).toBe('gold');
      expect(articleStatusTagColor('DISABLED')).toBe('default');
    });

    it('reuses semantically identical batch helpers instead of duplicating them', () => {
      expect(itemStatusTagColor).toBe(BatchHelpers.itemStatusTagColor);
      expect(articleStatusTagColor).toBe(BatchHelpers.articleStatusTagColor);
      expect(formatTime).toBe(BatchHelpers.formatTime);
      expect(NO_IMAGE_GALLERY_VALUE).toBe('__NONE__');
      expect(formatTime(null)).toBe('—');
      expect(formatTime(undefined)).toBe('—');
    });
  });

  describe('validateCreateDraft', () => {
    it('requires an http(s) URL in URL mode', () => {
      expect(validateCreateDraft(validDraft({ url: '  ' }))).toBe(
        '请输入公开文章链接（http/https）',
      );
      expect(validateCreateDraft(validDraft({ url: 'ftp://x' }))).toBe(
        '仅支持 http:// 或 https:// 开头的公开文章链接',
      );
    });

    it('enforces minimum pasted content length in pasted mode', () => {
      expect(
        validateCreateDraft(validDraft({ pastedText: true, url: '', pastedContent: '短文' })),
      ).toBe(`粘贴原文有效正文不足 ${REWRITE_MIN_SOURCE_CHARS} 字（当前 2 字），请补充完整正文`);
      expect(
        validateCreateDraft(
          validDraft({
            pastedText: true,
            url: '',
            pastedContent: '字'.repeat(REWRITE_MIN_SOURCE_CHARS),
          }),
        ),
      ).toBeNull();
    });

    it('requires gallery when images > 0 and requires a template', () => {
      expect(validateCreateDraft(validDraft({ mediaCategoryId: '' }))).toContain('分类');
      expect(validateCreateDraft(validDraft({ mediaCategoryId: '', imageCount: 0 }))).toBeNull();
      expect(validateCreateDraft(validDraft({ templateId: '' }))).toBe('请选择爆文改写指令');
      expect(validateCreateDraft(validDraft())).toBeNull();
    });
  });

  describe('toCreateSingleInput', () => {
    it('trims fields, nulls gallery for 0 images and clears auto category when picking one', () => {
      expect(
        toCreateSingleInput(
          validDraft({
            url: ' https://example.com/a ',
            pastedTitle: ' 标题 ',
            imageCount: 0,
            categoryId: 'cat_1',
            brand: ' 品牌 ',
          }),
        ),
      ).toMatchObject({
        url: 'https://example.com/a',
        pastedTitle: '标题',
        mediaCategoryId: null,
        imageCount: 0,
        categoryId: 'cat_1',
        autoCategoryName: '',
        brand: '品牌',
      });
      expect(
        toCreateSingleInput(validDraft({ autoCategoryName: ' 自动分类 ', imageCount: 2 })),
      ).toMatchObject({
        mediaCategoryId: 'mcat_0',
        categoryId: null,
        autoCategoryName: '自动分类',
      });
    });
  });

  describe('misc helpers', () => {
    it('checks URL eligibility for duplicate detection', () => {
      expect(isCheckableUrl(' https://a.com ')).toBe(true);
      expect(isCheckableUrl('http://a.com')).toBe(true);
      expect(isCheckableUrl('a.com')).toBe(false);
      expect(isCheckableUrl('   ')).toBe(false);
    });

    it('builds pasted-text retry seed and degrades to 0 images without gallery', () => {
      expect(buildRetrySeed(makeRecord())).toEqual({
        pastedText: true,
        url: 'https://mp.weixin.qq.com/s/sensor-guide',
        pastedTitle: '工业传感器选型实务',
        mediaCategoryId: 'mcat_001',
        templateId: 'sys_rewrite_01',
        categoryId: 'cat_rw_001',
      });
      expect(
        buildRetrySeed(
          makeRecord({
            url: 'paste://manual',
            sourceTitle: null,
            mediaCategoryId: null,
            categoryId: null,
          }),
        ),
      ).toEqual({
        pastedText: true,
        url: '',
        pastedTitle: '',
        mediaCategoryId: '',
        imageCount: 0,
        templateId: 'sys_rewrite_01',
        categoryId: '',
      });
    });

    it('formats created banner with similarity / duplicate warnings', () => {
      const ok = formatCreatedBanner({
        record: makeRecord({ newTitle: 'T', categoryName: 'C', status: 'SUCCESS' }),
        duplicateRecentWarning: null,
        settledPoints: 5,
      });
      expect(ok.type).toBe('success');
      expect(ok.text).toBe(
        '复刻完成：《T》已生成至分类「C」（消耗 5 点数，不占用 AI 写作数量配额）。',
      );

      const warn = formatCreatedBanner({
        record: makeRecord({ newTitle: null, categoryName: null, highSimilarity: true }),
        duplicateRecentWarning: '24h 内重复',
        settledPoints: 5,
      });
      expect(warn.type).toBe('warning');
      expect(warn.text).toContain('《未命名》');
      expect(warn.text).toContain('「默认分类」');
      expect(warn.text).toContain('5-gram');
      expect(warn.text.endsWith('24h 内重复')).toBe(true);
    });

    it('builds article list href by category', () => {
      expect(getArticlesHref(null)).toBe('/writing/articles');
      expect(getArticlesHref('cat 1')).toBe('/writing/articles?categoryId=cat%201');
    });
  });
});
