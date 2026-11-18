// @vitest-environment jsdom

import type { VisibilityEngineBreakdownItem } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SonarDial } from './sonar-dial';

afterEach(() => {
  cleanup();
});

const SAMPLE_BY_ENGINE: VisibilityEngineBreakdownItem[] = [
  {
    engine: 'deepseek',
    completedChecks: 10,
    mentionedChecks: 5,
    visibilityPct: 50,
    avgPosition: 1.8,
  },
  {
    engine: 'google_aio',
    completedChecks: 8,
    mentionedChecks: 2,
    visibilityPct: 25,
    avgPosition: null,
  },
];

describe('SonarDial', () => {
  it('renders 13 engine filter buttons and handles click selection / toggle-off', () => {
    const onSelectEngine = vi.fn();
    const { rerender } = render(
      <SonarDial byEngine={SAMPLE_BY_ENGINE} overallPct={38.9} onSelectEngine={onSelectEngine} />,
    );

    const buttons = document.querySelectorAll('[aria-label^="筛选引擎-"]');
    expect(buttons).toHaveLength(13);
    expect(screen.getByText('38.9%')).toBeTruthy();

    const deepseekBtn = screen.getByRole('button', { name: '筛选引擎-DeepSeek' });
    fireEvent.click(deepseekBtn);
    expect(onSelectEngine).toHaveBeenCalledWith('deepseek');

    rerender(
      <SonarDial
        byEngine={SAMPLE_BY_ENGINE}
        overallPct={38.9}
        selectedEngine="deepseek"
        onSelectEngine={onSelectEngine}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '筛选引擎-DeepSeek' }));
    expect(onSelectEngine).toHaveBeenLastCalledWith(undefined);
  });

  it('supports keyboard Enter/Space selection and Escape to clear', () => {
    const onSelectEngine = vi.fn();
    render(
      <SonarDial
        byEngine={SAMPLE_BY_ENGINE}
        overallPct={38.9}
        selectedEngine="deepseek"
        onSelectEngine={onSelectEngine}
      />,
    );

    const chatgptBtn = screen.getByRole('button', { name: '筛选引擎-ChatGPT' });
    fireEvent.keyDown(chatgptBtn, { key: 'Enter' });
    expect(onSelectEngine).toHaveBeenCalledWith('chatgpt');

    fireEvent.keyDown(chatgptBtn, { key: ' ' });
    expect(onSelectEngine).toHaveBeenCalledWith('chatgpt');

    fireEvent.keyDown(chatgptBtn, { key: 'Escape' });
    expect(onSelectEngine).toHaveBeenLastCalledWith(undefined);
  });

  it('renders accessible 13-row gm-sr-only table with "—" for unobserved avgPosition', () => {
    render(<SonarDial byEngine={SAMPLE_BY_ENGINE} overallPct={38.9} onSelectEngine={vi.fn()} />);

    const table = document.querySelector('table.gm-sr-only');
    expect(table).toBeTruthy();
    const rows = table!.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(13);

    expect(rows[0]!.textContent).toContain('DeepSeek');
    expect(rows[0]!.textContent).toContain('50.0%');
    expect(rows[0]!.textContent).toContain('#1.8');

    // Unobserved engine (e.g. doubao at index 1) shows "—" for visibilityPct and avgPosition
    expect(rows[1]!.textContent).toContain('豆包');
    expect(rows[1]!.textContent).toContain('—');
  });

  it('abbreviates long engine label on dial and shows full name in HTML tooltip on hover', () => {
    render(<SonarDial byEngine={SAMPLE_BY_ENGINE} overallPct={38.9} onSelectEngine={vi.fn()} />);

    expect(screen.getByText('Google AIO')).toBeTruthy();

    const googleBtn = screen.getByRole('button', { name: '筛选引擎-Google AI Overviews' });
    fireEvent.mouseEnter(googleBtn);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Google AI Overviews');
    expect(tooltip.textContent).toContain('25.0%');
    expect(tooltip.textContent).toContain('提及 2 / 观测 8');
    expect(tooltip.textContent).toContain('—');
  });

  it('renders loading, empty, and error states properly', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <SonarDial byEngine={undefined} overallPct={0} loading onSelectEngine={vi.fn()} />,
    );

    expect(document.querySelector('.gm-skeleton.gm-sonar-skeleton')).toBeTruthy();
    expect(document.querySelector('.gm-sonar-sweep')).toBeNull();

    rerender(<SonarDial byEngine={[]} overallPct={0} onSelectEngine={vi.fn()} />);
    expect(document.querySelector('polygon')).toBeNull();
    expect(document.querySelector('.gm-sonar-sweep')).toBeNull();
    expect(screen.getByText('暂无引擎覆盖数据')).toBeTruthy();

    rerender(
      <SonarDial
        byEngine={undefined}
        overallPct={0}
        error="引擎数据加载失败"
        onRetry={onRetry}
        onSelectEngine={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('引擎数据加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重 试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
