// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VisibilityTrendChart } from './visibility-trend-chart';

afterEach(cleanup);

describe('VisibilityTrendChart', () => {
  it('renders loading skeleton when loading=true', () => {
    const { container } = render(<VisibilityTrendChart points={[]} loading />);
    expect(container.querySelector('.gm-skeleton')).not.toBeNull();
  });

  it('renders empty state when all points have completedChecks === 0', () => {
    render(
      <VisibilityTrendChart
        points={[
          {
            date: '2026-11-18',
            engine: 'all',
            completedChecks: 0,
            mentionedChecks: 0,
            visibilityPct: 0,
          },
          {
            date: '2026-11-19',
            engine: 'all',
            completedChecks: 0,
            mentionedChecks: 0,
            visibilityPct: 0,
          },
        ]}
      />,
    );
    expect(screen.getByText('所选时间窗口暂无趋势数据')).toBeTruthy();
  });

  it('renders SVG line chart, accessible sr-only table, and hover tooltip for populated data', () => {
    render(
      <VisibilityTrendChart
        selectedEngine="deepseek"
        points={[
          {
            date: '2026-11-18',
            engine: 'deepseek',
            completedChecks: 4,
            mentionedChecks: 2,
            visibilityPct: 50,
          },
          {
            date: '2026-11-19',
            engine: 'deepseek',
            completedChecks: 4,
            mentionedChecks: 3,
            visibilityPct: 75,
          },
        ]}
      />,
    );

    const svg = screen.getByRole('img', { name: '品牌提及率趋势图（DeepSeek）' });
    expect(svg).toBeTruthy();
    expect(document.querySelectorAll('table.gm-sr-only tbody tr')).toHaveLength(2);

    const nodeBtn = screen.getByRole('button', { name: '2026-11-19 提及率 75.0%' });
    fireEvent.mouseEnter(nodeBtn);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('2026-11-19');
    expect(tooltip.textContent).toContain('75.0%');

    fireEvent.mouseLeave(nodeBtn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('filters multi-engine server trend to the active engine series without duplicate dates or React key collisions', () => {
    const multiSeriesPoints = [
      {
        date: '2026-11-18',
        engine: 'all' as const,
        completedChecks: 4,
        mentionedChecks: 2,
        visibilityPct: 50,
      },
      {
        date: '2026-11-19',
        engine: 'all' as const,
        completedChecks: 4,
        mentionedChecks: 3,
        visibilityPct: 75,
      },
      {
        date: '2026-11-18',
        engine: 'deepseek' as const,
        completedChecks: 2,
        mentionedChecks: 2,
        visibilityPct: 100,
      },
      {
        date: '2026-11-19',
        engine: 'deepseek' as const,
        completedChecks: 2,
        mentionedChecks: 1,
        visibilityPct: 50,
      },
      {
        date: '2026-11-18',
        engine: 'doubao' as const,
        completedChecks: 2,
        mentionedChecks: 0,
        visibilityPct: 0,
      },
      {
        date: '2026-11-19',
        engine: 'doubao' as const,
        completedChecks: 2,
        mentionedChecks: 2,
        visibilityPct: 100,
      },
    ];

    const { rerender } = render(<VisibilityTrendChart points={multiSeriesPoints} />);

    // Default (no selectedEngine) plots ONLY the 'all' series (2 unique dates, not 6)
    expect(document.querySelectorAll('.gm-trend-node')).toHaveLength(2);
    expect(document.querySelectorAll('table.gm-sr-only tbody tr')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '2026-11-18 提及率 50.0%' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '2026-11-19 提及率 75.0%' })).toBeTruthy();

    // Hover a node, then switch selectedEngine -> tooltip resets and plots ONLY deepseek series
    fireEvent.mouseEnter(screen.getByRole('button', { name: '2026-11-19 提及率 75.0%' }));
    expect(screen.getByRole('tooltip')).toBeTruthy();

    rerender(<VisibilityTrendChart points={multiSeriesPoints} selectedEngine="deepseek" />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.querySelectorAll('.gm-trend-node')).toHaveLength(2);
    expect(document.querySelectorAll('table.gm-sr-only tbody tr')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '2026-11-18 提及率 100.0%' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '2026-11-19 提及率 50.0%' })).toBeTruthy();

    // #410: rightmost X-axis date label uses text-anchor="end" to prevent SVG edge clipping
    const lastDateLabel = screen.getByText('11-19');
    expect(lastDateLabel.getAttribute('text-anchor')).toBe('end');

    // Engine absent from trend points shows clean empty state
    rerender(<VisibilityTrendChart points={multiSeriesPoints} selectedEngine="kimi" />);
    expect(screen.getByText('所选时间窗口暂无趋势数据')).toBeTruthy();
  });

  it('omits penultimate X-axis tick when 14-day step lands directly next to the last date (#430)', () => {
    const fourteenDays = Array.from({ length: 14 }, (_, idx) => ({
      date: `2026-11-${String(14 + idx).padStart(2, '0')}`,
      engine: 'all' as const,
      completedChecks: 4,
      mentionedChecks: idx % 2 === 0 ? 3 : 4,
      visibilityPct: idx % 2 === 0 ? 75 : 100,
    }));

    const { container } = render(<VisibilityTrendChart points={fourteenDays} />);
    const dateLabels = [...container.querySelectorAll('svg text')]
      .map((el) => el.textContent ?? '')
      .filter((text) => /^\d{2}-\d{2}$/.test(text));

    expect(dateLabels).toContain('11-14');
    expect(dateLabels).toContain('11-27');
    expect(dateLabels).not.toContain('11-26');
  });
});
