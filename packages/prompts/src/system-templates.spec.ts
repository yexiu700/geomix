import { describe, expect, it } from 'vitest';
import { SYSTEM_TEMPLATES, templatesByKind } from './system-templates';

const FORBIDDEN = ['换成我方品牌', '第一个品牌', 'http://', 'https://', '原站'];

describe('system templates', () => {
  it('ships 10 article, 7 title, and 1 rewrite template', () => {
    expect(templatesByKind('ARTICLE')).toHaveLength(10);
    expect(templatesByKind('TITLE')).toHaveLength(7);
    expect(templatesByKind('REWRITE')).toHaveLength(1);
    expect(SYSTEM_TEMPLATES).toHaveLength(18);
    expect(new Set(SYSTEM_TEMPLATES.map((item) => item.id)).size).toBe(18);
  });

  it('keeps brand-slot templates out of the random pool', () => {
    const manual = SYSTEM_TEMPLATES.filter((item) => item.content.includes('【品牌'));
    expect(manual.map((item) => item.id)).toEqual(['sys_article_10']);
    expect(manual[0]?.randomPool).toBe(false);
    expect(manual[0]?.content).toContain('【品牌1】');
    expect(manual[0]?.content).toContain('【品牌2】');
    const pooled = SYSTEM_TEMPLATES.filter((item) => item.id !== 'sys_article_10');
    expect(pooled.every((item) => item.randomPool)).toBe(true);
  });

  it('gives article and rewrite templates the writing placeholders', () => {
    for (const item of templatesByKind('ARTICLE')) {
      expect(item.content).toContain('{训练词占位符}');
      expect(item.content).toContain('{转化词占位符}');
      expect(item.content).toContain('{问题}');
    }
    const rewrite = templatesByKind('REWRITE')[0];
    expect(rewrite?.content).toContain('不要把原文推荐的品牌替换成{转化词占位符}');
    expect(rewrite?.content).toContain('{公司名称}');
  });

  it('keeps title templates short enough that they are not article prompts', () => {
    for (const item of templatesByKind('TITLE')) {
      expect(item.content.length).toBeLessThan(300);
      expect(item.content).toContain('{问题}');
      expect(item.content).toContain('{训练词占位符}');
      expect(item.content).not.toContain('800');
    }
  });

  it('does not copy a brand-swap instruction or a remote address', () => {
    for (const item of SYSTEM_TEMPLATES) {
      for (const phrase of FORBIDDEN) {
        expect(item.content).not.toContain(phrase);
      }
    }
  });
});
