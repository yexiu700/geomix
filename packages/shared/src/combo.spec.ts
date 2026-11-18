import { describe, expect, it } from 'vitest';
import {
  COMBO_MAX,
  EMPTY_MAIN_KEYWORD_MSG,
  EXPANDER_WORD_PACKS,
  buildKeywordCombos,
} from './combo';

describe('buildKeywordCombos', () => {
  it('generates 24 combinations for 3 × 2 × 4', () => {
    const result = buildKeywordCombos({
      mainKeyword: '工业机器人',
      prefixesText: '深圳\n苏州\n定制化',
      mainsText: '工业机器人\n六轴工业机器人',
      suffixesText: '哪家好\n厂家推荐\n一般多少钱\n怎么选',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prefixCount).toBe(3);
    expect(result.mainCount).toBe(2);
    expect(result.suffixCount).toBe(4);
    expect(result.items).toHaveLength(24);
    expect(result.truncated).toBe(false);
  });

  it('treats empty prefix or suffix as a valid combinable option, including (2+1)×1×(2+1)=9', () => {
    const emptyPrefixOnly = buildKeywordCombos({
      mainKeyword: '激光切割机',
      prefixesText: '',
      mainsText: '激光切割机',
      suffixesText: '哪家好\n报价',
    });
    expect(emptyPrefixOnly.ok).toBe(true);
    if (emptyPrefixOnly.ok) {
      expect(emptyPrefixOnly.prefixCount).toBe(1);
      expect(emptyPrefixOnly.items).toEqual(['激光切割机哪家好', '激光切割机报价']);
    }

    const withEmptyOption = buildKeywordCombos({
      mainKeyword: '激光切割机',
      prefixesText: '华东\n深圳',
      mainsText: '激光切割机',
      suffixesText: '哪家好\n厂家',
      includeEmptyPrefix: true,
      includeEmptySuffix: true,
    });
    expect(withEmptyOption.ok).toBe(true);
    if (withEmptyOption.ok) {
      expect(withEmptyOption.prefixCount).toBe(3);
      expect(withEmptyOption.mainCount).toBe(1);
      expect(withEmptyOption.suffixCount).toBe(3);
      expect(withEmptyOption.items).toHaveLength(9);
      expect(withEmptyOption.items).toContain('激光切割机');
      expect(withEmptyOption.items).toContain('华东激光切割机');
      expect(withEmptyOption.items).toContain('激光切割机哪家好');
    }
  });

  it('reports exact 1-based line numbers when a main line lacks mainKeyword', () => {
    const result = buildKeywordCombos({
      mainKeyword: '工业相机',
      prefixesText: '国产',
      mainsText: '工业相机\n视觉检测镜头\n高速工业相机\n光源控制器',
      suffixesText: '哪家好',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidMainLines).toEqual([2, 4]);
    expect(result.error).toContain('2');
    expect(result.error).toContain('4');
  });

  it('prompts 请输入主关键词 when mainKeyword is blank, uses 主关键词 in errors, truncates at COMBO_MAX, and exposes consumer packs (#144)', () => {
    expect(EMPTY_MAIN_KEYWORD_MSG).toBe('请输入主关键词');

    const empty = buildKeywordCombos({
      mainKeyword: '   ',
      prefixesText: '上海',
      mainsText: '测试',
      suffixesText: '哪家好',
    });
    expect(empty).toEqual({
      ok: false,
      error: '请输入主关键词',
      invalidMainLines: [],
    });

    const invalid = buildKeywordCombos({
      mainKeyword: '氮化镓充电器',
      prefixesText: '家用',
      mainsText: '普通电源',
      suffixesText: '值得买吗',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain('主关键词');
      expect(invalid.error).not.toContain('主训练词');
    }

    const prefixes = Array.from({ length: 40 }, (_, i) => `前缀${i}`).join('\n');
    const suffixes = Array.from({ length: 30 }, (_, i) => `后缀${i}`).join('\n');
    const capped = buildKeywordCombos({
      mainKeyword: '智能仓储',
      prefixesText: prefixes,
      mainsText: '智能仓储',
      suffixesText: suffixes,
    });
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.rawCount).toBe(1200);
      expect(capped.items).toHaveLength(COMBO_MAX);
      expect(capped.truncated).toBe(true);
    }
    expect(EXPANDER_WORD_PACKS.map((p) => p.key)).toEqual([
      'region',
      'service',
      'consumerScene',
      'question',
      'recommend',
      'consumerReview',
    ]);
  });
});
