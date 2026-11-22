import {
  CITATION_SOURCE_KINDS,
  ITEM_STATUSES,
  TASK_STATUSES,
  VISIBILITY_SENTIMENTS,
} from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import { GM, GM_ANTD_THEME, formatCompact, formatPct, truncateMiddle } from './design-tokens';

describe('design-tokens', () => {
  it('formats percentages with one decimal or em-dash for null/NaN', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(undefined)).toBe('—');
    expect(formatPct(Number.NaN)).toBe('—');
    expect(formatPct(42)).toBe('42.0%');
    expect(formatPct(0)).toBe('0.0%');
    expect(formatPct(66.66)).toBe('66.7%');
  });

  it('formats compact numbers for >= 10000 and keeps smaller numbers plain', () => {
    expect(formatCompact(9999)).toBe('9999');
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(10000)).toBe('1万');
    expect(formatCompact(12500)).toBe('1.3万');
    expect(formatCompact(Number.NaN)).toBe('—');
  });

  it('truncates middle of long strings to exact max length', () => {
    expect(truncateMiddle('short')).toBe('short');
    expect(truncateMiddle('a'.repeat(56))).toBe('a'.repeat(56));
    const truncated = truncateMiddle('a'.repeat(100));
    expect(truncated.length).toBe(56);
    expect(truncated).toBe(`${'a'.repeat(35)}…${'a'.repeat(20)}`);
  });

  it('maps all shared enum keys cleanly', () => {
    expect(Object.keys(GM.sourceKind).sort()).toEqual([...CITATION_SOURCE_KINDS].sort());
    expect(GM.sourceKind.ECOMMERCE).toBe('#B692F6');
    expect(Object.keys(GM.taskStatus).sort()).toEqual([...TASK_STATUSES].sort());
    expect(Object.keys(GM.itemStatus).sort()).toEqual([...ITEM_STATUSES].sort());
    expect(Object.keys(GM.sentiment).sort()).toEqual([...VISIBILITY_SENTIMENTS].sort());
  });

  it('configures AntD dark theme with Sonar Ink contrast tokens', () => {
    expect(GM_ANTD_THEME.token.colorPrimary).toBe('#C5F04A');
    expect(GM_ANTD_THEME.components.Button.primaryColor).toBe('#0A0C0B');
    expect(GM_ANTD_THEME.components.Checkbox.colorWhite).toBe('#0A0C0B');
    expect(GM_ANTD_THEME.components.Tooltip.colorBgSpotlight).toBe('#1D2220');
    expect(GM_ANTD_THEME.components.Tooltip.colorTextLightSolid).toBe('#E8ECEA');
  });
});
