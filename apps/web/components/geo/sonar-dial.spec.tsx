// @vitest-environment jsdom

import type { VisibilityEngineBreakdownItem } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('gives left/right engine labels ample SVG viewBox padding and keeps ring scale labels clear of center KPI text (#187)', () => {
    render(
      <SonarDial
        byEngine={[
          {
            engine: 'claude',
            completedChecks: 5,
            mentionedChecks: 5,
            visibilityPct: 100,
            avgPosition: 1,
          },
          {
            engine: 'tongyi',
            completedChecks: 5,
            mentionedChecks: 5,
            visibilityPct: 100,
            avgPosition: 1,
          },
        ]}
        overallPct={100}
        onSelectEngine={vi.fn()}
      />,
    );

    const svg = screen.getByRole('img', { name: 'AI 引擎覆盖率声呐盘' });
    const viewBoxParts = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
    expect(viewBoxParts).toHaveLength(4);
    const [vbX, vbY, vbW, vbH] = viewBoxParts as [number, number, number, number];
    const vbRight = vbX + vbW;
    const vbBottom = vbY + vbH;

    const svgScope = within(svg as unknown as HTMLElement);

    // Left-edge and right-edge labels must have >= 65 SVG units of clearance inside viewBox
    for (const label of ['Claude', 'Perplexity']) {
      const textEl = svgScope.getByText(label);
      const x = Number(textEl.getAttribute('x'));
      expect(x - vbX).toBeGreaterThanOrEqual(65);
    }
    for (const label of ['通义千问', '文心一言']) {
      const textEl = svgScope.getByText(label);
      const x = Number(textEl.getAttribute('x'));
      expect(vbRight - x).toBeGreaterThanOrEqual(65);
    }
    const topLabel = svgScope.getByText('DeepSeek');
    expect(Number(topLabel.getAttribute('y')) - vbY).toBeGreaterThanOrEqual(50);
    const bottomLabel = svgScope.getByText('Kimi');
    expect(vbBottom - Number(bottomLabel.getAttribute('y'))).toBeGreaterThanOrEqual(50);

    // Ring scale labels (25%, 50%, 75%) must sit clearly above the center value (100.0%)
    const centerVal = svgScope.getByText('100.0%');
    const centerY = Number(centerVal.getAttribute('y'));
    // With 24px font centered near baseline centerY, top of glyphs is around centerY - 20
    const centerTopEdge = centerY - 20;
    const ring25 = svgScope.getByText('25%');
    const ring25Y = Number(ring25.getAttribute('y'));
    expect(ring25Y).toBeLessThanOrEqual(centerTopEdge - 8);
  });

  it('hides sonar sweep wedge and coverage polygon when completedChecks > 0 but effective mentions are 0 (#303)', () => {
    render(
      <SonarDial
        byEngine={[
          {
            engine: 'tongyi',
            completedChecks: 22,
            mentionedChecks: 0,
            visibilityPct: 0,
            avgPosition: null,
          },
        ]}
        overallPct={0}
        onSelectEngine={vi.fn()}
      />,
    );

    expect(document.querySelector('.gm-sonar-sweep')).toBeNull();
    expect(document.querySelector('polygon')).toBeNull();
    expect(screen.getAllByText('0.0%').length).toBeGreaterThan(0);
  });

  it('renders exactly 8 CN spokes with valid viewBox clearance and zero GLOBAL engines when market="CN"', () => {
    render(
      <SonarDial
        market="CN"
        byEngine={[
          {
            engine: 'deepseek',
            completedChecks: 4,
            mentionedChecks: 3,
            visibilityPct: 75,
            avgPosition: 1.5,
          },
          {
            engine: 'chatgpt',
            completedChecks: 5,
            mentionedChecks: 5,
            visibilityPct: 100,
            avgPosition: 1,
          },
        ]}
        overallPct={75}
        onSelectEngine={vi.fn()}
      />,
    );

    const buttons = document.querySelectorAll('[aria-label^="筛选引擎-"]');
    expect(buttons).toHaveLength(8);
    const srRows = document.querySelectorAll('table.gm-sr-only tbody tr');
    expect(srRows).toHaveLength(8);
    expect(screen.queryByLabelText('筛选引擎-ChatGPT')).toBeNull();
    expect(screen.queryByLabelText('筛选引擎-Perplexity')).toBeNull();
    expect(screen.getByLabelText('筛选引擎-通义千问')).toBeTruthy();

    const svg = screen.getByRole('img', { name: 'AI 引擎覆盖率声呐盘' });
    const [vbX, vbY, vbW, vbH] = (svg.getAttribute('viewBox') ?? '')
      .trim()
      .split(/\s+/)
      .map(Number) as [number, number, number, number];
    const svgScope = within(svg as unknown as HTMLElement);
    expect(Number(svgScope.getByText('DeepSeek').getAttribute('y')) - vbY).toBeGreaterThanOrEqual(
      50,
    );
    expect(
      vbY + vbH - Number(svgScope.getByText('文心一言').getAttribute('y')),
    ).toBeGreaterThanOrEqual(50);
    expect(
      vbX + vbW - Number(svgScope.getByText('腾讯元宝').getAttribute('x')),
    ).toBeGreaterThanOrEqual(65);
    expect(Number(svgScope.getByText('Kimi').getAttribute('x')) - vbX).toBeGreaterThanOrEqual(65);
  });

  it('renders exactly 5 GLOBAL spokes with Google AIO short label and resets hover safely on CN -> GLOBAL switch', () => {
    const byEngine = [
      {
        engine: 'zhipu' as const,
        completedChecks: 4,
        mentionedChecks: 2,
        visibilityPct: 50,
        avgPosition: 2,
      },
      {
        engine: 'chatgpt' as const,
        completedChecks: 6,
        mentionedChecks: 4,
        visibilityPct: 66.7,
        avgPosition: 1.5,
      },
      {
        engine: 'google_aio' as const,
        completedChecks: 6,
        mentionedChecks: 3,
        visibilityPct: 50,
        avgPosition: 2,
      },
    ];

    const { rerender } = render(
      <SonarDial market="CN" byEngine={byEngine} overallPct={50} onSelectEngine={vi.fn()} />,
    );

    const zhipuHit = screen.getByLabelText('筛选引擎-智谱');
    fireEvent.mouseEnter(zhipuHit);
    expect(screen.getByRole('tooltip').textContent).toContain('智谱');

    // Switch to GLOBAL (5 spokes) while index 7 was hovered: must not throw and must clear tooltip
    rerender(
      <SonarDial market="GLOBAL" byEngine={byEngine} overallPct={58.3} onSelectEngine={vi.fn()} />,
    );

    expect(screen.queryByRole('tooltip')).toBeNull();
    const buttons = document.querySelectorAll('[aria-label^="筛选引擎-"]');
    expect(buttons).toHaveLength(5);
    expect(document.querySelectorAll('table.gm-sr-only tbody tr')).toHaveLength(5);
    expect(screen.queryByLabelText('筛选引擎-豆包')).toBeNull();
    expect(screen.queryByLabelText('筛选引擎-DeepSeek')).toBeNull();
    expect(screen.getByLabelText('筛选引擎-Google AI Overviews')).toBeTruthy();

    const svg = screen.getByRole('img', { name: 'AI 引擎覆盖率声呐盘' });
    const [vbX, vbY, vbW] = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const svgScope = within(svg as unknown as HTMLElement);
    expect(Number(svgScope.getByText('ChatGPT').getAttribute('y')) - vbY).toBeGreaterThanOrEqual(
      50,
    );
    expect(
      vbX + vbW - Number(svgScope.getByText('Perplexity').getAttribute('x')),
    ).toBeGreaterThanOrEqual(65);
    expect(Number(svgScope.getByText('Google AIO').getAttribute('x')) - vbX).toBeGreaterThanOrEqual(
      65,
    );
  });
});
