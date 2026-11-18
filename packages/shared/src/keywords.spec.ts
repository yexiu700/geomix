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
  it('validates main keyword rules including unified 主关键词 prompt message (#144)', () => {
    expect(KEYWORD_EMPTY_MAIN_MSG).toBe('请输入主关键词');
    expect(validateMainKeyword('')).toEqual({ ok: false, message: '请输入主关键词' });
    expect(validateMainKeyword('   ')).toEqual({ ok: false, message: '请输入主关键词' });
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

  it('cleans, deduplicates, and filters distilled questions without discarding candidates when a brand term is a substring of mainKeyword (#144)', () => {
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

    // Regression for #144 comment: main="Anker氮化镓充电器", brands=["安克创新（Anker）","Anker","安克","氮化镓"]
    const ankerCandidates = [
      'Anker氮化镓充电器哪款值得买？',
      'Anker氮化镓充电器发热控制怎么样？',
      '出差带Anker氮化镓充电器多口实用吗？',
      'Anker氮化镓充电器支持哪些快充协议？',
      'Anker氮化镓充电器价格一般多少？',
      '安克创新（Anker）的Anker氮化镓充电器售后怎么样？', // mentions full company name not in main -> filtered out
    ];
    const ankerCleaned = cleanDistilledQuestions({
      rawCandidates: ankerCandidates,
      main: 'Anker氮化镓充电器',
      brands: ['安克创新（Anker）', 'Anker', '安克', '氮化镓'],
    });
    expect(ankerCleaned).toHaveLength(5);

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
