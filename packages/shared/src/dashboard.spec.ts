import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_ENTRY_CARDS,
  DASHBOARD_TREND_DAYS,
  aggregateCreationTrend5Days,
  shanghaiCurrentMonthWindowUtc,
  shanghaiFiveDayWindowUtc,
  summarizeMonthMoney,
  summarizeMonthPoints,
  toShanghaiDateKey,
  visibleDashboardEntryCards,
} from './dashboard';

describe('dashboard shared helpers', () => {
  it('computes strict 5-day Asia/Shanghai window across UTC midnight boundary', () => {
    // 2026-11-17T02:00:00+08:00 === 2026-11-16T18:00:00Z
    const now = new Date('2026-11-16T18:00:00.000Z');
    expect(toShanghaiDateKey(now)).toBe('2026-11-17');

    const win = shanghaiFiveDayWindowUtc(now);
    expect(win.keys).toHaveLength(DASHBOARD_TREND_DAYS);
    expect(win.keys).toEqual([
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
    // 2026-11-13 00:00:00+08:00 === 2026-11-12T16:00:00.000Z
    expect(win.startUtc.toISOString()).toBe('2026-11-12T16:00:00.000Z');
    // 2026-11-17 23:59:59.999+08:00 === 2026-11-17T15:59:59.999Z
    expect(win.endUtc.toISOString()).toBe('2026-11-17T15:59:59.999Z');
  });

  it('aggregates writing vs rewrite counts per Shanghai day and ignores MANUAL or out-of-window articles', () => {
    const now = new Date('2026-11-17T04:00:00.000Z'); // 2026-11-17 12:00 CST
    const trend = aggregateCreationTrend5Days(
      [
        // Out of window (6 days ago in CST: 2026-11-12)
        { source: 'AI_TASK', createdAt: '2026-11-12T05:00:00.000Z' },
        // 2026-11-13 00:30 CST (2026-11-12T16:30Z)
        { source: 'AI_TASK', createdAt: '2026-11-12T16:30:00.000Z' },
        { source: 'REWRITE_SINGLE', createdAt: '2026-11-13T03:00:00.000Z' },
        // 2026-11-15 CST
        { source: 'AI_TASK', createdAt: '2026-11-15T01:00:00.000Z' },
        { source: 'AI_TASK', createdAt: '2026-11-15T02:00:00.000Z' },
        { source: 'REWRITE_BATCH', createdAt: '2026-11-15T08:00:00.000Z' },
        // Manual article should not pollute AI creation trend
        { source: 'MANUAL', createdAt: '2026-11-17T01:00:00.000Z' },
        // 2026-11-17 CST
        { source: 'REWRITE_SINGLE', createdAt: '2026-11-17T02:00:00.000Z' },
      ],
      now,
    );

    expect(trend).toEqual([
      { date: '2026-11-13', label: '11-13', writingCount: 1, rewriteCount: 1, totalCount: 2 },
      { date: '2026-11-14', label: '11-14', writingCount: 0, rewriteCount: 0, totalCount: 0 },
      { date: '2026-11-15', label: '11-15', writingCount: 2, rewriteCount: 1, totalCount: 3 },
      { date: '2026-11-16', label: '11-16', writingCount: 0, rewriteCount: 0, totalCount: 0 },
      { date: '2026-11-17', label: '11-17', writingCount: 0, rewriteCount: 1, totalCount: 1 },
    ]);
  });

  it('reconciles monthly points and money ledgers accurately in both SHADOW and STRICT modes', () => {
    const monthWin = shanghaiCurrentMonthWindowUtc(new Date('2026-11-30T17:00:00.000Z'));
    // 2026-11-30T17:00Z is 2026-12-01 01:00 CST -> December!
    expect(monthWin.monthKey).toBe('2026-12');
    expect(monthWin.startUtc.toISOString()).toBe('2026-11-30T16:00:00.000Z');

    const pointSummary = summarizeMonthPoints([
      { delta: 500, listPrice: 0, status: 'SETTLED', action: 'admin_topup' },
      // Shadow-mode settled consumption (delta=0, listPrice=15)
      { delta: 0, listPrice: 15, status: 'SETTLED', action: 'ai_write' },
      // Strict-mode settled consumption (delta=-10, listPrice=10)
      { delta: -10, listPrice: 10, status: 'SETTLED', action: 'distill' },
      // Released / non-settled should not count
      { delta: -5, listPrice: 5, status: 'RELEASED', action: 'rewrite_single' },
    ]);
    expect(pointSummary).toEqual({
      actualConsumed: 10,
      listPriceConsumed: 25,
      recharged: 500,
    });

    const moneySummary = summarizeMonthMoney([
      { amount: '1200.50' },
      { amount: '-199.90' },
      { amount: '-0.10' },
    ]);
    expect(moneySummary).toEqual({
      consumed: '200.00',
      recharged: '1200.50',
    });
  });

  it('marks phase-2 entries with 即将上线 and hides AI生图 card when aiImageEnabled is false', () => {
    const comingSoon = DASHBOARD_ENTRY_CARDS.filter((c) => c.comingSoon);
    expect(comingSoon.map((c) => c.title)).toEqual([
      '文章发布',
      'AI数据',
      'AI可见度诊断',
      'AI工具',
    ]);
    for (const card of comingSoon) {
      expect(card.badge).toBe('即将上线');
      expect(card.href).toBeNull();
    }

    const withAiImage = visibleDashboardEntryCards({ aiImageEnabled: true });
    const withoutAiImage = visibleDashboardEntryCards({ aiImageEnabled: false });
    expect(withAiImage.some((c) => c.key === 'image')).toBe(true);
    expect(withoutAiImage.some((c) => c.key === 'image')).toBe(false);
  });
});
