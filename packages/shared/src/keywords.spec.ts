import { describe, expect, it } from 'vitest';
import {
  KEYWORD_EMPTY_MAIN_MSG,
  buildFakeDistillCandidates,
  cleanDistilledQuestions,
  extractJsonStringArray,
  parseBrandsInput,
  parseQuestionsLines,
  validateMainKeyword,
} from './keywords';

describe('keywords shared helpers', () => {
  it('validates main keyword rules including empty prompt message', () => {
    expect(validateMainKeyword('')).toEqual({ ok: false, message: KEYWORD_EMPTY_MAIN_MSG });
    expect(validateMainKeyword('   ')).toEqual({ ok: false, message: KEYWORD_EMPTY_MAIN_MSG });
    expect(validateMainKeyword('机器')).toEqual({ ok: false, message: '主关键词不少于 3 个字' });
    expect(validateMainKeyword('机器人,自动化')).toEqual({
      ok: false,
      message: '主关键词只能填一个，不能包含逗号或换行',
    });
    expect(validateMainKeyword(' 工业机器人 ')).toEqual({ ok: true, value: '工业机器人' });
  });

  it('splits Chinese and English commas for brands and deduplicates', () => {
    expect(parseBrandsInput('智造甲，智造乙, 智造甲 , BrandX')).toEqual([
      '智造甲',
      '智造乙',
      'BrandX',
    ]);
  });

  it('cleans, deduplicates, and filters distilled questions against brands and existing questions', () => {
    const raw = extractJsonStringArray(
      '```json\n["工业机器人哪家靠谱？", "工业机器人哪家靠谱?", "智造甲工业机器人怎么样？", "无关话题推荐", "定制工业机器人收费标准是多少？"]\n```',
    );
    const cleaned = cleanDistilledQuestions({
      rawCandidates: raw,
      main: '工业机器人',
      brands: ['智造甲'],
      existingQuestions: ['定制工业机器人收费标准是多少'],
    });
    expect(cleaned).toEqual(['工业机器人哪家靠谱？']);

    const fakeCleaned = cleanDistilledQuestions({
      rawCandidates: buildFakeDistillCandidates('智能仓储系统'),
      main: '智能仓储系统',
      brands: ['演示品牌A'],
    });
    expect(fakeCleaned.length).toBeGreaterThanOrEqual(10);
  });

  it('parses question lines and counts skipped duplicates', () => {
    const parsed = parseQuestionsLines('工业机器人哪家好？\n工业机器人哪家好?\n工业机器人报价\n');
    expect(parsed.unique).toHaveLength(2);
    expect(parsed.skippedDuplicates).toBe(1);
  });
});
