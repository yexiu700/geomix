import { describe, expect, it } from 'vitest';
import {
  PROMPT_MANUAL_SLOT_WARN,
  PROMPT_MISSING_CONVERSION_WARN,
  PROMPT_PLACEHOLDERS,
  PROMPT_REWRITE_BRAND_SWAP_WARN,
  PROMPT_TITLE_LOOKS_LIKE_BODY_WARN,
  analyzePromptWarnings,
  computePromptRandomPool,
  hasManualBrandSlot,
  insertPlaceholderAtCursor,
  parsePromptListQuery,
  promptWriteSchema,
} from './prompts';

describe('prompts shared rules', () => {
  it('exposes the 5 standard placeholders and inserts at cursor selection', () => {
    expect(PROMPT_PLACEHOLDERS.map((p) => p.token)).toEqual([
      '{训练词占位符}',
      '{转化词占位符}',
      '{问题}',
      '{标题}',
      '{公司名称}',
    ]);

    const inserted = insertPlaceholderAtCursor('围绕撰写说明', '{训练词占位符}', 2, 2);
    expect(inserted.nextValue).toBe('围绕{训练词占位符}撰写说明');
    expect(inserted.nextCursor).toBe(2 + '{训练词占位符}'.length);
  });

  it('marks templates containing 【品牌N】 as randomPool = false', () => {
    expect(hasManualBrandSlot('请客观对比【品牌1】与【品牌2】的适用场景')).toBe(true);
    expect(computePromptRandomPool('请客观对比【品牌1】与【品牌2】的适用场景')).toBe(false);
    expect(computePromptRandomPool('围绕{问题}介绍{训练词占位符}与{转化词占位符}')).toBe(true);
  });

  it('generates non-blocking yellow warnings for missing conversion token, body-in-title, rewrite brand swap, and manual slots', () => {
    const missingConv = analyzePromptWarnings('ARTICLE', '围绕{问题}介绍{训练词占位符}选购建议');
    expect(missingConv).toContain(PROMPT_MISSING_CONVERSION_WARN);

    const cleanArticle = analyzePromptWarnings(
      'ARTICLE',
      '围绕{问题}介绍{训练词占位符}，并在结尾自然提及{转化词占位符}',
    );
    expect(cleanArticle).toEqual([]);

    const bodyInTitle = analyzePromptWarnings(
      'TITLE',
      '请围绕{问题}写一篇 1200 字的文章，分成三个小标题展开论述',
    );
    expect(bodyInTitle).toContain(PROMPT_TITLE_LOOKS_LIKE_BODY_WARN);

    const cleanTitle = analyzePromptWarnings(
      'TITLE',
      '围绕{问题}与{训练词占位符}输出一行 20 字左右的标题',
    );
    expect(cleanTitle).toEqual([]);

    const badRewrite = analyzePromptWarnings(
      'REWRITE',
      '请把原文推荐的第一个品牌换成{转化词占位符}',
    );
    expect(badRewrite).toContain(PROMPT_REWRITE_BRAND_SWAP_WARN);

    const slotArticle = analyzePromptWarnings(
      'ARTICLE',
      '对照【品牌1】与{转化词占位符}的公开参数条件',
    );
    expect(slotArticle).toContain(PROMPT_MANUAL_SLOT_WARN);
  });

  it('validates promptWriteSchema and parses list query kind filters', () => {
    const parsed = promptWriteSchema.parse({
      name: '  工程机械深度选购指令  ',
      content: '  围绕{问题}介绍{训练词占位符}与{转化词占位符}  ',
    });
    expect(parsed.kind).toBe('ARTICLE');
    expect(parsed.name).toBe('工程机械深度选购指令');

    expect(parsePromptListQuery({ kind: 'REWRITE', page: '2', pageSize: '10' })).toEqual({
      page: 2,
      pageSize: 10,
      kind: 'REWRITE',
      q: undefined,
    });
    expect(parsePromptListQuery({ kind: 'INVALID' }).kind).toBeUndefined();
  });

  it('formats promptExportTable createdAt in Asia/Shanghai (UTC+8) (#203)', async () => {
    const { promptExportTable } = await import('./prompts');
    const table = promptExportTable([
      {
        id: 'prm_1',
        tenantId: 't_1',
        isSystem: false,
        kind: 'ARTICLE',
        name: '测试指令',
        content: '内容',
        randomPool: true,
        hasManualSlot: false,
        sort: 1,
        clonedFrom: null,
        warnings: [],
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
    ]);
    expect(table.rows[0]?.[2]).toBe('2026-11-18 08:00:00');
  });
});
