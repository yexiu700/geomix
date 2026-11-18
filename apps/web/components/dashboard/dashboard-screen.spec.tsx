// @vitest-environment jsdom

import {
  DASHBOARD_RECHARGE_NOTICE,
  type DashboardSummary,
  type VisibilityOverviewResponse,
} from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmptyDashboardSummary, type DashboardGateway } from '../../lib/dashboard';
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

const BANNED_HOME_JARGON = [
  '影子计费',
  '账面',
  '冻结中',
  '整单预冻',
  '多篇并发异步创作',
  '零拷贝',
  '长文本向量知识库',
  'AI 蒸馏拓展',
  '批量组合词包',
];

function buildVisibilityOverview(completedChecks: number): VisibilityOverviewResponse {
  return {
    profileId: null,
    metrics: {
      completedChecks,
      mentionedChecks: completedChecks > 0 ? completedChecks : 0,
      visibilityPct: completedChecks > 0 ? 100 : 0,
      shareOfVoice: {
        brandMentions: completedChecks,
        totalMentions: completedChecks > 0 ? completedChecks + 4 : 0,
        brandSharePct: completedChecks > 0 ? 66.7 : 0,
        entries: [],
      },
      avgPosition: completedChecks > 0 ? 1.0 : null,
      sentimentSummary: {
        positive: completedChecks,
        neutral: 0,
        mixed: 0,
        negative: 0,
        total: completedChecks,
        positivePct: completedChecks > 0 ? 100 : 0,
        negativePct: 0,
      },
      totalCitations: completedChecks > 0 ? 18 : 0,
      ownedCitations: completedChecks > 0 ? 7 : 0,
      ownedCitationChecks: completedChecks > 0 ? 5 : 0,
      ownedCitationRatePct: completedChecks > 0 ? 38.9 : 0,
      ownedCitationCheckRatePct: completedChecks > 0 ? 62.5 : 0,
      topDomains: [],
    },
    trend: [],
  };
}

function assertAppearsBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

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

describe('DashboardScreen (Issue #22, #135, #136, #219)', () => {
  it('renders balance & points cards with monthly consumption & recharge prompts, strict 5-day trend, and avoids duplicate announcement bar (#135)', async () => {
    const actions: ShellAction[] = [];
    const gateway: DashboardGateway = {
      async getSummary() {
        return buildSampleSummary();
      },
    };

    const { container } = render(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        gateway={gateway}
        loadVisibilityOverview={async () => buildVisibilityOverview(8)}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('¥1280.50');

    // #135: Header appears before visibility signal, and no duplicate announcement bar in body
    const header = screen.getByTestId('dashboard-header');
    const signalStrip = screen.getByTestId('geo-signal-strip');
    assertAppearsBefore(header, signalStrip);
    expect(screen.queryByTestId('dashboard-announcement-bar')).toBeNull();

    // Balance card
    const balanceCard = screen.getByTestId('dashboard-balance-card');
    expect(balanceCard.textContent).toContain('¥219.50');
    expect(balanceCard.textContent).toContain('¥1500.00');
    expect(balanceCard.textContent).toContain(DASHBOARD_RECHARGE_NOTICE.money);
    expect(balanceCard.textContent).not.toContain('（充值请联系客服）');

    // Points card (SHADOW mode shows plain free-trial label + listPrice 45 without accounting jargon)
    const pointsCard = screen.getByTestId('dashboard-points-card');
    expect(pointsCard.textContent).toContain('980 点');
    expect(pointsCard.textContent).toContain('免费体验期（暂不扣点）');
    expect(pointsCard.textContent).toContain('免费期原价核算 45 点');
    expect(pointsCard.textContent).toContain('任务占用中 20 点');
    expect(pointsCard.textContent).toContain(DASHBOARD_RECHARGE_NOTICE.points);

    // Zero R&D jargon across rendered home content
    for (const term of BANNED_HOME_JARGON) {
      expect(container.textContent).not.toContain(term);
    }

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
        loadVisibilityOverview={async () => buildVisibilityOverview(8)}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('18 篇文章');
    const imageCard = screen.getByTestId('dashboard-card-image');
    expect(imageCard).toBeTruthy();
    expect(imageCard.textContent).toContain('企业画像图库');
    expect(screen.queryByText(/\/视频/)).toBeNull();

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
        loadVisibilityOverview={async () => buildVisibilityOverview(8)}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );
    expect(screen.queryByTestId('dashboard-card-image')).toBeNull();
    expect(screen.queryByTestId('dashboard-card-aidata')).toBeNull();
    expect(screen.queryByTestId('dashboard-card-visibility')).toBeNull();
  });

  it('places main heading first, renders 3-step beginner guidance above empty signals, and removes R&D jargon on empty accounts (#135, #136)', async () => {
    const actions: ShellAction[] = [];
    const emptySummary = createEmptyDashboardSummary(true, new Date('2026-11-18T04:00:00.000Z'));
    const gateway: DashboardGateway = {
      async getSummary() {
        return emptySummary;
      },
    };

    const { container } = render(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        gateway={gateway}
        loadVisibilityOverview={async () => buildVisibilityOverview(0)}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('还没有 AI 可见度数据');

    const header = screen.getByTestId('dashboard-header');
    const onboarding = screen.getByTestId('dashboard-onboarding-guide');
    const entryCards = screen.getByTestId('dashboard-entry-cards');
    const signalStrip = screen.getByTestId('geo-signal-strip');
    const trendCard = screen.getByTestId('dashboard-trend-card');

    // #135: Main heading & refresh button at top; no duplicate announcement bar
    expect(header.textContent).toContain('首页');
    expect(screen.getByRole('button', { name: '刷新首页' })).toBeTruthy();
    expect(screen.queryByTestId('dashboard-announcement-bar')).toBeNull();

    // #135 & #136: Beginner 3-step guide & quick entries appear above empty visibility signal & trend
    assertAppearsBefore(header, onboarding);
    assertAppearsBefore(onboarding, entryCards);
    assertAppearsBefore(entryCards, signalStrip);
    assertAppearsBefore(signalStrip, trendCard);

    // #136: Clear 3-step workflow actions
    expect(onboarding.textContent).toContain('第 1 步');
    expect(onboarding.textContent).toContain('第 2 步');
    expect(onboarding.textContent).toContain('第 3 步');

    fireEvent.click(screen.getByRole('button', { name: '添加关键词' }));
    fireEvent.click(screen.getByRole('button', { name: '生成写作标题' }));
    fireEvent.click(screen.getByRole('button', { name: '发起 AI 写作' }));
    expect(actions).toEqual([
      { type: 'open', href: '/material/keywords', sourceId: '/dashboard' },
      { type: 'open', href: '/material/questions', sourceId: '/dashboard' },
      { type: 'open', href: '/writing/tasks', sourceId: '/dashboard' },
    ]);

    // #136: Zero R&D jargon
    for (const term of BANNED_HOME_JARGON) {
      expect(container.textContent).not.toContain(term);
    }
  });

  it('surfaces module quick-entry cards above 5-day trend and provides zero-points next-step guidance for historical-data accounts (#219)', async () => {
    const actions: ShellAction[] = [];
    const base = buildSampleSummary();
    const zeroPointsHistorySummary: DashboardSummary = {
      ...base,
      balanceCard: {
        ...base.balanceCard,
        balance: '0.00',
        monthConsumed: '0.00',
        monthRecharged: '0.00',
      },
      pointsCard: {
        ...base.pointsCard,
        points: 0,
        pointsReserved: 0,
        available: 0,
        monthRechargedPoints: 0,
      },
    };
    const gateway: DashboardGateway = {
      async getSummary() {
        return zeroPointsHistorySummary;
      },
    };

    const { container } = render(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        gateway={gateway}
        loadVisibilityOverview={async () => buildVisibilityOverview(8)}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('100.0%');
    await screen.findByTestId('dashboard-zero-points-guide');

    const header = screen.getByTestId('dashboard-header');
    const zeroPointsGuide = screen.getByTestId('dashboard-zero-points-guide');
    const signalStrip = screen.getByTestId('geo-signal-strip');
    const entryCards = screen.getByTestId('dashboard-entry-cards');
    const trendCard = screen.getByTestId('dashboard-trend-card');

    // Empty-state onboarding is kept separate from historical-data accounts
    expect(screen.queryByTestId('dashboard-onboarding-guide')).toBeNull();

    // #219: Module quick-entries appear BEFORE the tall 5-day trend chart so they stay above the fold
    assertAppearsBefore(header, zeroPointsGuide);
    assertAppearsBefore(zeroPointsGuide, signalStrip);
    assertAppearsBefore(signalStrip, entryCards);
    assertAppearsBefore(entryCards, trendCard);

    // #219: Zero-points next-step guidance explains unavailable online recharge & offers direct actions
    expect(zeroPointsGuide.textContent).toContain('可用点数为 0');
    expect(zeroPointsGuide.textContent).toContain('联系平台管理员');

    fireEvent.click(screen.getByRole('button', { name: '查看 AI 数据看板' }));
    fireEvent.click(screen.getByRole('button', { name: '查看账号权益' }));
    expect(actions).toEqual([
      { type: 'open', href: '/visibility/overview', sourceId: '/dashboard' },
      { type: 'open', href: '/me/rights', sourceId: '/dashboard' },
    ]);

    for (const term of BANNED_HOME_JARGON) {
      expect(container.textContent).not.toContain(term);
    }
  });

  it('handles STRICT billing with zero points and visibility-only history without showing empty onboarding (#219)', async () => {
    const actions: ShellAction[] = [];
    const emptyBase = createEmptyDashboardSummary(true, new Date('2026-11-18T04:00:00.000Z'));
    const strictZeroSummary: DashboardSummary = {
      ...emptyBase,
      pointsCard: {
        ...emptyBase.pointsCard,
        billingMode: 'STRICT',
        points: 0,
        pointsReserved: 0,
        available: 0,
      },
    };
    const gateway: DashboardGateway = {
      async getSummary() {
        return strictZeroSummary;
      },
    };

    render(
      <DashboardScreen
        title="首页"
        tabId="/dashboard"
        gateway={gateway}
        loadVisibilityOverview={async () => buildVisibilityOverview(4)}
        autoRotateAnnouncements={false}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await screen.findByText('100.0%');
    const zeroPointsGuide = await screen.findByTestId('dashboard-zero-points-guide');
    expect(screen.queryByTestId('dashboard-onboarding-guide')).toBeNull();
    expect(zeroPointsGuide.textContent).toContain('按次计费任务需补充点数后发起');
    expect(screen.getByTestId('dashboard-points-card').textContent).toContain('正式计费');

    assertAppearsBefore(
      screen.getByTestId('dashboard-entry-cards'),
      screen.getByTestId('dashboard-trend-card'),
    );

    fireEvent.click(screen.getByRole('button', { name: '管理关键词与知识库' }));
    expect(actions).toEqual([{ type: 'open', href: '/material/keywords', sourceId: '/dashboard' }]);
  });
});
