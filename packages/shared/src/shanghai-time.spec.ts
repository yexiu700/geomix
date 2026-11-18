import { describe, expect, it } from 'vitest';
import { parseShanghaiDateTimeLocal } from './shanghai-time';

describe('shanghai-time', () => {
  it('parses datetime-local strings strictly in UTC+8 regardless of host timezone', () => {
    expect(parseShanghaiDateTimeLocal('2026-11-18T08:30')).toBe('2026-11-18T00:30:00.000Z');
    expect(parseShanghaiDateTimeLocal('2026-11-18T00:00:00')).toBe('2026-11-17T16:00:00.000Z');
    expect(parseShanghaiDateTimeLocal('2026-11-18 23:59:59')).toBe('2026-11-18T15:59:59.000Z');
    expect(parseShanghaiDateTimeLocal('2026-11-18')).toBe('2026-11-17T16:00:00.000Z');
  });

  it('preserves explicit timezone offsets and rejects empty or invalid dates', () => {
    expect(parseShanghaiDateTimeLocal('2026-11-18T05:00:00.000Z')).toBe('2026-11-18T05:00:00.000Z');
    expect(parseShanghaiDateTimeLocal('')).toBeNull();
    expect(parseShanghaiDateTimeLocal(null)).toBeNull();
    expect(parseShanghaiDateTimeLocal('2026-02-30T10:00')).toBeNull();
    expect(parseShanghaiDateTimeLocal('not-a-date')).toBeNull();
  });
});
