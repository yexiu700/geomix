import { describe, expect, it } from 'vitest';
import {
  REWRITE_BATCH_LINK_LIST_MAX,
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  batchRewriteImageCountForText,
  buildDefaultBatchCategoryName,
  looksLikeUrlNotKeyword,
  parseBatchLinkList,
  resolveRewriteBatchTimeouts,
  rewriteBatchCreateSchema,
} from './rewrite-batches';

describe('rewrite-batches shared validation & candidate parsing', () => {
  it('detects URLs mistakenly entered as search keywords and rejects them with explicit message', () => {
    expect(looksLikeUrlNotKeyword('https://mp.weixin.qq.com/s/abc123')).toBe(true);
    expect(looksLikeUrlNotKeyword('http://zhuanlan.zhihu.com/p/9988')).toBe(true);
    expect(looksLikeUrlNotKeyword('www.example.com/article/1')).toBe(true);
    expect(looksLikeUrlNotKeyword('mp.weixin.qq.com/s/abc')).toBe(true);
    expect(looksLikeUrlNotKeyword('万瓦光纤激光切割机选型')).toBe(false);
    expect(looksLikeUrlNotKeyword('CNC 5轴加工中心保养')).toBe(false);

    const parsed = rewriteBatchCreateSchema.safeParse({
      name: '激光设备批量复刻',
      maxCount: 5,
      sourceType: 'remote',
      keyword: 'https://mp.weixin.qq.com/s/test-article',
      mediaCategoryId: 'gal_01',
      templateId: 'sys_rewrite_01',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
    }
  });

  it('canonicalizes, deduplicates, excludes video/ecommerce/login URLs, and blocks SSRF hosts in link_list', () => {
    const raw = [
      'https://zhuanlan.zhihu.com/p/1001?utm_source=wechat&b=2',
      'https://zhuanlan.zhihu.com/p/1001?b=2&utm_medium=cpc',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'https://item.jd.com/10001234.html',
      'https://portal.example.org/auth/login?next=/post',
      'https://news.example.org/industry/laser-guide',
    ].join('\n');

    const res = parseBatchLinkList(raw);
    expect(res.invalidLines).toHaveLength(0);
    expect(res.duplicateLines).toEqual([2]);
    expect(res.excludedLines).toHaveLength(3);
    expect(res.candidates.map((c) => c.url)).toEqual([
      'https://zhuanlan.zhihu.com/p/1001?b=2',
      'https://news.example.org/industry/laser-guide',
    ]);

    const withInternal = parseBatchLinkList('http://127.0.0.1/secret\nhttp://169.254.169.254/meta');
    expect(withInternal.candidates).toHaveLength(0);
    expect(withInternal.invalidLines.map((i) => i.line)).toEqual([1, 2]);
  });

  it('enforces max 50 unique links on link_list mode and reports exact invalid line number', () => {
    const fiftyOne = Array.from(
      { length: REWRITE_BATCH_LINK_LIST_MAX + 1 },
      (_, idx) => `https://industry.example.org/post-${idx + 1}`,
    );
    const parsedOver = rewriteBatchCreateSchema.safeParse({
      name: '超限测试',
      maxCount: 10,
      sourceType: 'link_list',
      linkList: fiftyOne,
      mediaCategoryId: 'gal_01',
      templateId: 'sys_rewrite_01',
    });
    expect(parsedOver.success).toBe(false);
    if (!parsedOver.success) {
      expect(parsedOver.error.issues[0]?.message).toContain('第 51 行');
    }

    const validFive = rewriteBatchCreateSchema.safeParse({
      name: '钣金加工专题',
      maxCount: 3,
      sourceType: 'link_list',
      linksText: fiftyOne.slice(0, 5).join('\n'),
      mediaCategoryId: 'gal_01',
      templateId: 'sys_rewrite_01',
    });
    expect(validFive.success).toBe(true);
  });

  it('formats auto batch category name, resolves timeouts, and computes image count', () => {
    expect(buildDefaultBatchCategoryName('激光切管专题')).toBe('激光切管专题（复刻）');
    expect(buildDefaultBatchCategoryName('激光切管专题（复刻）')).toBe('激光切管专题（复刻）');
    expect(batchRewriteImageCountForText(450)).toBe(1);
    expect(batchRewriteImageCountForText(820)).toBe(2);

    const custom = resolveRewriteBatchTimeouts({
      REWRITE_BATCH_TIMEOUT_MS: '8000',
      REWRITE_BATCH_ITEM_TIMEOUT_MS: '1500',
    });
    expect(custom).toEqual({ batchTimeoutMs: 8000, itemTimeoutMs: 1500 });
  });
});
