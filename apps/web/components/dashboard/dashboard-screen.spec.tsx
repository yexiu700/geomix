// @vitest-environment jsdom

import { DASHBOARD_RECHARGE_NOTICE, type DashboardSummary } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DashboardGateway } from '../../lib/dashboard';
import type { ShellAction } from '../../lib/tab-stack';
import { DashboardScreen } from './dashboard-screen';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
});

function buildSampleSummary(): DashboardSummary {
  return {
    generatedAt: '2026-11-17T08:00:00.000Z',
    monthKey: '2026-11',
    tenant: {
      id: 't_demo',
      name: 'GeoMix 演示企业',
      expiresAt: '2029-12-31T00:00:00.000Z',
      isActive: true,
      readOnly: false,
    },
    features: {
      aiImage: true,
    },
    balanceCard: {
      balance: '1280.50',
      monthConsumed: '219.50',
      monthRecharged: '1500.00',
      rechargeNotice: DASHBOARD_RECHARGE_NOTICE.money,
    },
    pointsCard: {
      billingMode: 'SHADOW',
      billingModeSource: 'global',
      points: 1000,
      pointsReserved: 20,
      available: 980,
      monthConsumedPoints: 0,
      monthListPricePoints: 45,
      monthRechargedPoints: 500,
      rechargeNotice: DASHBOARD_RECHARGE_NOTICE.points,
    },
    announcements: [
      {
        id: 'ann_1',
        content: 'GeoMix 自写播报一：请使用自有授权品牌资料与实景图库开展创作。',
        sort: 1,
      },
      {
        id: 'ann_2',
        content: 'GeoMix 自写播报二：影子计费期间消耗仅记录原价核算流水，不实扣可用点数。',
        sort: 2,
      },
    ],
    trend5d: [
      { date: '2026-11-13', label: '11-13', writingCount: 2, rewriteCount: 1, totalCount: 3 },
      { date: '2026-11-14', label: '11-14', writingCount: 0, rewriteCount: 2, totalCount: 2 },
      { date: '2026-11-15', label: '11-15', writingCount: 4, rewriteCount: 1, totalCount: 5 },
      { date: '2026-11-16', label: '11-16', writingCount: 1, rewriteCount: 0, totalCount: 1 },
      { date: '2026-11-17', label: '11-17', writingCount: 3, rewriteCount: 2, totalCount: 5 },
    ],
    stats: {
      keywords: 6,
      questions: 48,
      mediaAssets: 12,
      knowledgeBases: 2,
      prompts: 3,
      articleCategories: 4,
      aiTasks: 5,
      articles: 18,
      rewriteSingle: 4,
      rewriteBatches: 2,
      aiImages: 3,
    },
  };
}

describe('DashboardScreen (Issue #22)', () => {
  it('renders balance & points cards with monthly consumption & recharge prompts, strict 5-day trend, and self-written announcement carousel', async () => {
    const actions: ShellAction[] = [];
    const gateway: DashboardGateway = {
      async getSummary() {
        return buildSampleSummary();
      },
    };

    render(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        gateway={gateway}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('¥1280.50');

    // Balance card
    const balanceCard = screen.getByTestId('dashboard-balance-card');
    expect(balanceCard.textContent).toContain('¥219.50');
    expect(balanceCard.textContent).toContain('¥1500.00');
    expect(balanceCard.textContent).toContain(DASHBOARD_RECHARGE_NOTICE.money);

    // Points card (SHADOW mode shows both actual 0 and listPrice 45)
    const pointsCard = screen.getByTestId('dashboard-points-card');
    expect(pointsCard.textContent).toContain('980 点');
    expect(pointsCard.textContent).toContain('影子计费（免费期）');
    expect(pointsCard.textContent).toContain('免费期原价核算 45 点');
    expect(pointsCard.textContent).toContain(DASHBOARD_RECHARGE_NOTICE.points);

    // Strict 5-day trend (5 days only, writing=10, rewrite=6, total=16)
    const trendCard = screen.getByTestId('dashboard-trend-card');
    expect(trendCard.textContent).toContain('近 5 日 AI 创作趋势');
    expect(trendCard.textContent).toContain('AI 写作：10 篇');
    expect(trendCard.textContent).toContain('爆文复刻：6 篇');
    expect(trendCard.textContent).toContain('5 日合计 16 篇');

    const dayCells = document.querySelectorAll('[data-testid^="dashboard-trend-day-"]');
    expect(dayCells).toHaveLength(5);
    expect(screen.getByTestId('dashboard-trend-day-2026-11-15').textContent).toContain(
      '写作 4 · 复刻 1',
    );

    // Announcement bar switching
    const annBar = screen.getByTestId('dashboard-announcement-bar');
    expect(annBar.textContent).toContain('GeoMix 自写播报一');
    fireEvent.click(screen.getByLabelText('下一条播报'));
    expect(annBar.textContent).toContain('GeoMix 自写播报二');

    // Ledger navigation buttons
    fireEvent.click(screen.getByText('余额明细'));
    fireEvent.click(screen.getByText('点数明细'));
    expect(actions).toEqual([
      { type: 'open', href: '/me/money', sourceId: '/dashboard' },
      { type: 'open', href: '/me/points', sourceId: '/dashboard' },
    ]);
  });

  it('navigates active entry cards including AI数据 & AI可见度诊断, marks remaining Phase-2 cards as 即将上线, and respects feature flags (#92)', async () => {
    const actions: ShellAction[] = [];
    const gateway: DashboardGateway = {
      async getSummary() {
        return buildSampleSummary();
      },
    };

    const { rerender } = render(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        aiImageEnabled
        visibilityEnabled
        gateway={gateway}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('18 篇文章');
    expect(screen.getByTestId('dashboard-card-image')).toBeTruthy();

    // Stale coming-soon visibility cards must be gone
    expect(screen.queryByTestId('dashboard-card-aidata-soon')).toBeNull();
    expect(screen.queryByTestId('dashboard-card-visibility-soon')).toBeNull();

    // Active AI数据 & AI可见度诊断 cards are clickable and not aria-disabled
    const aidataCard = screen.getByTestId('dashboard-card-aidata');
    const visibilityCard = screen.getByTestId('dashboard-card-visibility');
    expect(aidataCard.getAttribute('aria-disabled')).toBeNull();
    expect(visibilityCard.getAttribute('aria-disabled')).toBeNull();
    expect(aidataCard.textContent).not.toContain('即将上线');
    expect(visibilityCard.textContent).not.toContain('即将上线');

    fireEvent.click(screen.getByTestId('dashboard-card-tasks'));
    fireEvent.click(aidataCard);
    fireEvent.click(visibilityCard);
    expect(actions).toEqual([
      { type: 'open', href: '/writing/tasks', sourceId: '/dashboard' },
      { type: 'open', href: '/visibility/overview', sourceId: '/dashboard' },
      { type: 'open', href: '/visibility/monitors', sourceId: '/dashboard' },
    ]);

    // Remaining Phase-2 cards show 即将上线 and are non-navigable
    for (const key of ['publish-soon', 'tools-soon']) {
      const card = screen.getByTestId(`dashboard-card-${key}`);
      expect(card.textContent).toContain('即将上线');
      expect(card.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(card);
    }
    expect(actions).toHaveLength(3);

    // Turning off aiImageEnabled / visibilityEnabled hides respective entry cards
    rerender(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        aiImageEnabled={false}
        visibilityEnabled={false}
        gateway={gateway}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );
    expect(screen.queryByTestId('dashboard-card-image')).toBeNull();
    expect(screen.queryByTestId('dashboard-card-aidata')).toBeNull();
    expect(screen.queryByTestId('dashboard-card-visibility')).toBeNull();
  });
});
