import { describe, expect, it } from 'vitest';
import {
  parseShanghaiDateTimeLocal,
  shanghaiCurrentMonthWindowUtc,
  shanghaiFiveDayWindowUtc,
  toShanghaiDateKey,
} from './shanghai-time';

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

  it('computes Shanghai date keys, 5-day windows, and current-month windows in UTC+8', () => {
    expect(toShanghaiDateKey('2026-11-17T16:00:00.000Z')).toBe('2026-11-18');
    expect(toShanghaiDateKey('2026-11-17T15:59:59.000Z')).toBe('2026-11-17');

    const fiveDay = shanghaiFiveDayWindowUtc(new Date('2026-11-18T01:00:00.000Z'));
    expect(fiveDay.keys).toEqual([
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ]);
    expect(fiveDay.startUtc.toISOString()).toBe('2026-11-13T16:00:00.000Z');
    expect(fiveDay.endUtc.toISOString()).toBe('2026-11-18T15:59:59.999Z');

    const monthWin = shanghaiCurrentMonthWindowUtc(new Date('2026-11-18T01:00:00.000Z'));
    expect(monthWin.monthKey).toBe('2026-11');
    expect(monthWin.startUtc.toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(monthWin.endUtc.toISOString()).toBe('2026-11-30T16:00:00.000Z');
  });
});
