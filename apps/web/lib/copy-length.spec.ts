import { describe, expect, it } from 'vitest';
import {
  CONTROL_LABEL_MAX_CHARS,
  EXPLAIN_INLINE_MAX_CHARS,
  copyLength,
  isControlLabelWithinLimit,
  shouldCollapseToExplain,
} from './copy-length';

describe('copyLength', () => {
  it('counts pure CJK strings at 1 per character and fullwidth punctuation at 1', () => {
    expect(copyLength('')).toBe(0);
    expect(copyLength('   ')).toBe(0);
    expect(copyLength('首页')).toBe(2);
    expect(copyLength('产品参数')).toBe(4);
    expect(copyLength('品牌英文名')).toBe(5);
    expect(copyLength('（免费）')).toBe(4);
    expect(copyLength('AI 提炼（免费）')).toBe(7);
  });

  it('treats recognized abbreviations and T+N markers as 1 unit', () => {
    expect(copyLength('GEO 写作台')).toBe(4);
    expect(copyLength('ROI 报告')).toBe(3);
    expect(copyLength('AI 提炼')).toBe(3);
    expect(copyLength('JSON-LD')).toBe(1);
    expect(copyLength('llms.txt')).toBe(1);
    expect(copyLength('Near-Miss')).toBe(1);
    expect(copyLength('T+0 基准')).toBe(3);
    expect(copyLength('声量（SoV）')).toBe(5);
  });

  it('counts ordinary English letters at 0.5 each and ignores digits/spaces/ASCII symbols', () => {
    expect(copyLength('3次采样')).toBe(3);
    expect(copyLength('+ 新建品牌')).toBe(4);
    expect(copyLength('Webhook')).toBe(3.5);
    expect(copyLength('Prompt List')).toBe(5);
  });

  it('enforces 4-char control limit and >8-char explain collapse threshold', () => {
    expect(CONTROL_LABEL_MAX_CHARS).toBe(4);
    expect(EXPLAIN_INLINE_MAX_CHARS).toBe(8);

    expect(isControlLabelWithinLimit('去写作')).toBe(true);
    expect(isControlLabelWithinLimit('AI 提炼')).toBe(true);
    expect(isControlLabelWithinLimit('一键去写（10 点）')).toBe(false);

    expect(shouldCollapseToExplain('最多 10 个竞品')).toBe(false);
    expect(shouldCollapseToExplain('查找或补充事实')).toBe(false);
    expect(shouldCollapseToExplain('维护品牌中英文名称、品类与主域名')).toBe(true);
  });
});
