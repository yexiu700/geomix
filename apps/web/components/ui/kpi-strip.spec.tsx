// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KpiStrip, formatKpiDisplayValue, normalizeKpiProgressPct } from './index';

describe('KpiStrip', () => {
  afterEach(() => {
    cleanup();
  });

  it('formats KPI display values and sanitizes null/undefined/NaN/Infinity to em-dash', () => {
    expect(formatKpiDisplayValue(null)).toBe('—');
    expect(formatKpiDisplayValue(undefined)).toBe('—');
    expect(formatKpiDisplayValue(Number.NaN)).toBe('—');
    expect(formatKpiDisplayValue(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatKpiDisplayValue(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(formatKpiDisplayValue('')).toBe('—');
    expect(formatKpiDisplayValue('   ')).toBe('—');
    expect(formatKpiDisplayValue('NaN')).toBe('—');
    expect(formatKpiDisplayValue('Infinity')).toBe('—');
    expect(formatKpiDisplayValue('-Infinity')).toBe('—');
    expect(formatKpiDisplayValue(0)).toBe('0');
    expect(formatKpiDisplayValue('42.5%')).toBe('42.5%');
  });

  it('normalizes progress percentages honestly without fabricating width for <= 0 or non-finite values', () => {
    expect(normalizeKpiProgressPct(undefined)).toBeNull();
    expect(normalizeKpiProgressPct(null)).toBe(0);
    expect(normalizeKpiProgressPct(0)).toBe(0);
    expect(normalizeKpiProgressPct(-12)).toBe(0);
    expect(normalizeKpiProgressPct(Number.NaN)).toBe(0);
    expect(normalizeKpiProgressPct(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeKpiProgressPct(42.5)).toBe(42.5);
    expect(normalizeKpiProgressPct(135)).toBe(100);
  });

  it('renders honest empty 0% SVG track (no <rect>), clamps >100%, and omits track when undefined', () => {
    render(
      <KpiStrip
        aria-label="品牌健康度指标"
        data-testid="home-health-strip"
        items={[
          {
            key: 'mention',
            label: '提及率',
            value: '0.0%',
            progressPct: 0,
            caption: '暂无提及',
            testId: 'home-kpi-mention',
          },
          {
            key: 'sov',
            label: '声量份额',
            value: '42.5%',
            progressPct: 42.5,
            tone: 'accent',
            subtext: '领先 2 位竞品',
            testId: 'home-kpi-sov',
          },
          {
            key: 'owned',
            label: '官网引用率',
            value: '100.0%',
            progressPct: 135,
            tone: 'success',
            testId: 'home-kpi-owned',
          },
          {
            key: 'position',
            label: '平均顺位',
            value: '#1.4',
            caption: '多数回答将品牌排在第 1 位',
            testId: 'home-kpi-position',
          },
          {
            key: 'invalid',
            label: '待计算',
            value: Number.NaN,
            progressPct: null,
            testId: 'home-kpi-invalid',
          },
        ]}
      />,
    );

    const strip = screen.getByTestId('home-health-strip');
    expect(strip.getAttribute('role')).toBe('region');
    expect(strip.getAttribute('aria-label')).toBe('品牌健康度指标');

    // 0% item: genuinely empty track (data-empty="true", aria-valuenow="0", ZERO <rect> rendered)
    const mentionItem = screen.getByTestId('home-kpi-mention');
    const mentionBar = mentionItem.querySelector('[role="progressbar"]');
    expect(mentionBar).toBeTruthy();
    expect(mentionBar?.getAttribute('data-empty')).toBe('true');
    expect(mentionBar?.getAttribute('aria-valuenow')).toBe('0');
    expect(mentionBar?.querySelector('rect')).toBeNull();
    expect(mentionItem.querySelector('.gm-ui-kpi-value')?.className).toContain('gm-num');

    // 42.5% item: SVG rect width="42.5"
    const sovItem = screen.getByTestId('home-kpi-sov');
    const sovBar = sovItem.querySelector('[role="progressbar"]');
    expect(sovBar?.getAttribute('data-empty')).toBe('false');
    expect(sovBar?.getAttribute('aria-valuenow')).toBe('42.5');
    expect(sovBar?.querySelector('rect')?.getAttribute('width')).toBe('42.5');
    expect(sovItem.textContent).toContain('领先 2 位竞品');

    // 135% item: clamped to 100
    const ownedItem = screen.getByTestId('home-kpi-owned');
    const ownedBar = ownedItem.querySelector('[role="progressbar"]');
    expect(ownedBar?.getAttribute('aria-valuenow')).toBe('100');
    expect(ownedBar?.querySelector('rect')?.getAttribute('width')).toBe('100');

    // Undefined progressPct & >8 char caption: collapses caption into ⓘ while preserving inline <=8 char captions
    const positionItem = screen.getByTestId('home-kpi-position');
    expect(positionItem.querySelector('[role="progressbar"]')).toBeNull();
    expect(positionItem.querySelector('.gm-ui-kpi-caption')).toBeNull();
    expect(positionItem.querySelector('.gm-explain-trigger')).toBeTruthy();
    expect(positionItem.textContent).toContain('多数回答将品牌排在第 1 位');
    expect(mentionItem.querySelector('.gm-ui-kpi-caption')?.textContent).toBe('暂无提及');

    // NaN value + null progressPct -> '—' + empty 0% track
    const invalidItem = screen.getByTestId('home-kpi-invalid');
    expect(invalidItem.querySelector('.gm-ui-kpi-value')?.textContent).toBe('—');
    expect(invalidItem.querySelector('[role="progressbar"]')?.getAttribute('data-empty')).toBe(
      'true',
    );
    expect(invalidItem.querySelector('rect')).toBeNull();
  });

  it('supports loading skeleton state and keyboard activation on clickable items', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <KpiStrip items={[]} loading skeletonCount={3} data-testid="loading-strip" />,
    );

    const loadingStrip = screen.getByTestId('loading-strip');
    expect(loadingStrip.getAttribute('aria-busy')).toBe('true');
    expect(loadingStrip.querySelectorAll('.gm-ui-kpi-item--loading').length).toBe(3);

    rerender(
      <KpiStrip
        data-testid="interactive-strip"
        items={[
          {
            key: 'clickable',
            label: '待复测文章',
            value: 3,
            testId: 'kpi-clickable',
            onClick: onSelect,
          },
        ]}
      />,
    );

    const clickable = screen.getByTestId('kpi-clickable');
    expect(clickable.getAttribute('role')).toBe('button');
    expect(clickable.getAttribute('tabindex')).toBe('0');

    fireEvent.click(clickable);
    fireEvent.keyDown(clickable, { key: 'Enter' });
    fireEvent.keyDown(clickable, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});
