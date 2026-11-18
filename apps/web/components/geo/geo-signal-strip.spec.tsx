// @vitest-environment jsdom

import type { VisibilityOverviewResponse } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoSignalStrip } from './geo-signal-strip';

afterEach(() => {
  cleanup();
});

function buildOverview(
  overrides: Partial<VisibilityOverviewResponse['metrics']> = {},
): VisibilityOverviewResponse {
  return {
    profileId: null,
    metrics: {
      completedChecks: 40,
      mentionedChecks: 18,
      visibilityPct: 45,
      shareOfVoice: {
        brandMentions: 18,
        totalMentions: 50,
        brandSharePct: 36,
        entries: [],
      },
      avgPosition: 2.34,
      sentimentSummary: {
        positive: 12,
        neutral: 5,
        mixed: 1,
        negative: 0,
        total: 18,
        positivePct: 66.7,
        negativePct: 0,
      },
      totalCitations: 25,
      ownedCitations: 10,
      ownedCitationChecks: 8,
      ownedCitationRatePct: 40,
      ownedCitationCheckRatePct: 20,
      topDomains: [],
      ...overrides,
    },
    trend: [],
  };
}

describe('GeoSignalStrip', () => {
  it('renders 4 skeleton cards while loading', () => {
    const load = vi.fn(() => new Promise<VisibilityOverviewResponse>(() => {}));
    render(<GeoSignalStrip load={load} onOpenOverview={vi.fn()} />);

    const loadingGrid = screen.getByTestId('geo-signal-strip-loading');
    expect(loadingGrid.querySelectorAll('.gm-skeleton-kpi')).toHaveLength(4);
    expect(screen.getByText('AI 可见度信号 · 近 14 日')).toBeTruthy();
  });

  it('renders empty state when completedChecks is 0 and triggers onOpenMonitors', async () => {
    const load = vi.fn().mockResolvedValue(buildOverview({ completedChecks: 0 }));
    const onOpenMonitors = vi.fn();

    render(<GeoSignalStrip load={load} onOpenOverview={vi.fn()} onOpenMonitors={onOpenMonitors} />);

    await screen.findByText('还没有 AI 可见度数据');
    fireEvent.click(screen.getByRole('button', { name: '去发起诊断' }));
    expect(onOpenMonitors).toHaveBeenCalledTimes(1);
  });

  it('renders error state and retries load when clicking retry', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(buildOverview());

    render(<GeoSignalStrip load={load} onOpenOverview={vi.fn()} />);

    await screen.findByText('AI 可见度信号加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重 试' }));

    await screen.findByText('45.0%');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renders 4 KPI cards with gm-num, handles avgPosition=null, and triggers onOpenOverview on click', async () => {
    const load = vi.fn().mockResolvedValue(buildOverview({ avgPosition: null }));
    const onOpenOverview = vi.fn();

    render(<GeoSignalStrip load={load} onOpenOverview={onOpenOverview} />);

    await screen.findByTestId('geo-signal-visibility');

    const visCard = screen.getByTestId('geo-signal-visibility');
    const sovCard = screen.getByTestId('geo-signal-sov');
    const posCard = screen.getByTestId('geo-signal-position');
    const ownCard = screen.getByTestId('geo-signal-owned-citation');

    expect(visCard.textContent).toContain('45.0%');
    expect(visCard.textContent).toContain('18 / 40');
    expect(sovCard.textContent).toContain('36.0%');
    expect(sovCard.textContent).toContain('18 / 50');
    expect(posCard.textContent).toContain('—');
    expect(posCard.textContent).toContain('越靠前越好');
    expect(ownCard.textContent).toContain('40.0%');
    expect(ownCard.textContent).toContain('10 / 25');

    for (const card of [visCard, sovCard, posCard, ownCard]) {
      const valNode = card.querySelector('.gm-kpi-value');
      expect(valNode?.classList.contains('gm-num')).toBe(true);
    }

    fireEvent.click(visCard);
    fireEvent.click(screen.getByText('进入 AI 数据看板 →'));
    await waitFor(() => {
      expect(onOpenOverview).toHaveBeenCalledTimes(2);
    });
  });
});
