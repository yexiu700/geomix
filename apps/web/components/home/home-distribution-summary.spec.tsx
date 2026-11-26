// @vitest-environment jsdom
import type { ActionHomeResponse, DistributionSummaryDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeDistributionSummary } from './home-distribution-summary';

function makeSummary(overrides?: Partial<DistributionSummaryDto>): DistributionSummaryDto {
  return {
    crawlAlerts: [
      {
        publishRecordId: 'pub_blocked_1',
        articleId: 'art_blocked_1',
        articleTitle: 'AstraVault X4 Quiet NAS Review',
        channel: 'Official Blog / Docs',
        publishedUrl: 'https://astravault.example.com/blocked',
        crawlStatus: 'BLOCKED',
        crawlCheckedAt: '2026-11-23T06:30:00.000Z',
        issues: ['robots.txt 拦截了 GPTBot', '缺少 JSON-LD 结构化数据'],
      },
    ],
    upcomingRetests: [
      {
        scheduleId: 'sched_pending_1',
        publishRecordId: 'pub_ok_1',
        articleId: 'art_ok_1',
        articleTitle: 'AstraVault 2.5GbE Throughput Guide',
        channel: 'WordPress',
        milestoneDay: 7,
        sampleCount: 1,
        dueAt: '2026-11-27T08:00:00.000Z',
        status: 'PENDING',
        skipReason: null,
      },
      {
        scheduleId: 'sched_skip_1',
        publishRecordId: 'pub_ok_2',
        articleId: 'art_ok_2',
        articleTitle: 'Home NAS Backup Comparison',
        channel: 'PR / KOL Media Kit',
        milestoneDay: 14,
        sampleCount: 3,
        dueAt: '2026-11-25T08:00:00.000Z',
        status: 'SKIPPED_INSUFFICIENT_POINTS',
        skipReason: '余额不足，已温和跳过本次复测',
      },
    ],
    channelAttribution: [
      {
        channel: 'Official Blog / Docs',
        publishedCount: 4,
        crawlOkCount: 3,
        completedRetestCount: 4,
        citationHitCount: 2,
        citationHitRate: 0.5,
        avgMentionRateDelta: 25.5,
        avgPosition: 2.1,
        avgPositionDelta: -1.5,
        positiveSentimentRate: 0.75,
        sentimentSummary: 'positive',
      },
      {
        channel: 'Reddit',
        publishedCount: 3,
        crawlOkCount: 3,
        completedRetestCount: 3,
        citationHitCount: 0,
        citationHitRate: null,
        avgMentionRateDelta: 18.0,
        avgPosition: 3.2,
        avgPositionDelta: -0.8,
        positiveSentimentRate: 0.5,
        sentimentSummary: 'neutral',
      },
      {
        channel: 'PR / KOL Media Kit',
        publishedCount: 1,
        crawlOkCount: 1,
        completedRetestCount: 0,
        citationHitCount: 0,
        citationHitRate: null,
        avgMentionRateDelta: null,
        avgPosition: null,
        avgPositionDelta: null,
        positiveSentimentRate: null,
        sentimentSummary: null,
      },
    ],
    ...overrides,
  };
}

describe('HomeDistributionSummary (M6B #355)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders compact empty state without literal "0 点" when summary is missing or empty', () => {
    const { rerender } = render(<HomeDistributionSummary onOpenArticle={vi.fn()} />);
    const box = screen.getByTestId('home-distribution-summary');
    expect(box.textContent).toContain('暂无分发追踪与渠道归因数据');
    expect(box.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);
    expect(screen.queryByTestId('home-crawl-alerts')).toBeNull();
    expect(screen.queryByTestId('home-upcoming-retests')).toBeNull();
    expect(screen.queryByTestId('home-channel-attribution')).toBeNull();

    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        onOpenArticle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('home-distribution-summary').textContent).toContain(
      '暂无分发追踪与渠道归因数据',
    );
  });

  it('renders crawl alerts, upcoming/skipped retests, and navigates via callbacks', () => {
    const onOpenArticle = vi.fn();
    const onOpenPoints = vi.fn();
    render(
      <HomeDistributionSummary
        summary={makeSummary()}
        onOpenArticle={onOpenArticle}
        onOpenPoints={onOpenPoints}
      />,
    );

    const crawlBox = screen.getByTestId('home-crawl-alerts');
    expect(crawlBox.textContent).toContain('抓取受阻');
    expect(crawlBox.textContent).toContain('AstraVault X4 Quiet NAS Review');
    expect(crawlBox.textContent).toContain('robots.txt 拦截了 GPTBot');
    fireEvent.click(within(crawlBox).getByRole('button', { name: '立即排查' }));
    expect(onOpenArticle).toHaveBeenCalledWith('art_blocked_1');

    const retestBox = screen.getByTestId('home-upcoming-retests');
    expect(retestBox.textContent).toContain('T+7');
    expect(retestBox.textContent).toContain('2026-11-27');
    expect(retestBox.textContent).toContain('点数不足已跳过');
    expect(retestBox.textContent).toContain('余额不足，已温和跳过本次复测');

    fireEvent.click(within(retestBox).getByRole('button', { name: '查看点数' }));
    expect(onOpenPoints).toHaveBeenCalledTimes(1);

    const viewBtns = within(retestBox).getAllByRole('button', { name: '查看追踪' });
    fireEvent.click(viewBtns[0]!);
    expect(onOpenArticle).toHaveBeenCalledWith('art_ok_1');
  });

  it('formats channel attribution scales accurately and degrades zero-citation channels gracefully per PRD D5 (zero NaN)', () => {
    render(<HomeDistributionSummary summary={makeSummary()} onOpenArticle={vi.fn()} />);

    const tableBox = screen.getByTestId('home-channel-attribution');
    const text = tableBox.textContent ?? '';

    // Exact numeric units
    expect(text).toContain('50.0%(2/4)'); // 0.5 ratio * 100
    expect(text).toContain('+25.5%'); // already percentage points, NOT +2550%
    expect(text).not.toContain('2550');
    expect(text).toContain('#2.1(↑1.5)'); // negative avgPositionDelta = improved rank
    expect(text).toContain('75% 正向'); // 0.75 ratio * 100

    // PRD D5 zero-citation graceful degradation for Reddit (completedRetestCount=3, citationHitRate=null)
    expect(text).toContain('待引文就绪');
    expect(text).toContain('+18.0%');
    expect(text).toContain('#3.2(↑0.8)');
    expect(text).toContain('50% 正向');
    expect(screen.getByTestId('home-citation-degraded-note')).toBeTruthy();

    // Zero NaN or Infinity anywhere
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });

  it('guards against non-finite numbers so NaN or Infinity never appear', () => {
    render(
      <HomeDistributionSummary
        summary={makeSummary({
          crawlAlerts: [],
          upcomingRetests: [],
          channelAttribution: [
            {
              channel: 'Webhook',
              publishedCount: 2,
              crawlOkCount: 1,
              completedRetestCount: 1,
              citationHitCount: 0,
              citationHitRate: Number.NaN,
              avgMentionRateDelta: Number.POSITIVE_INFINITY,
              avgPosition: Number.NaN,
              avgPositionDelta: Number.NEGATIVE_INFINITY,
              positiveSentimentRate: Number.NaN,
              sentimentSummary: null,
            },
          ],
        })}
        onOpenArticle={vi.fn()}
      />,
    );

    const text = screen.getByTestId('home-channel-attribution').textContent ?? '';
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
    expect(text).toContain('待引文就绪');
  });

  it('renders Wilson 95% CI badge, low-sample n<5 3x hint, DiD net lift strip, keeps 50.0%(2/4) contiguous, and opens ROI modal (#372)', () => {
    const onOpenRoiReportModal = vi.fn();
    const recentArticles: ActionHomeResponse['recentArticles'] = [
      {
        id: 'art_did_1',
        title: 'Quiet NAS Comparison',
        recipe: 'AUTHORITY_GUIDE',
        geoScore: 86,
        status: 'PUBLISHED',
        updatedAt: '2026-11-18T00:00:00.000Z',
        publishRecord: {
          id: 'pub_did_1',
          articleId: 'art_did_1',
          brandId: 'brand_1',
          brandMarketId: 'bm_1',
          channel: 'Official Blog / Docs',
          publishedUrl: 'https://astravault.example.com/guide',
          publishedAt: '2026-11-10T00:00:00.000Z',
          baselineRunId: 'vrun_base_1',
          latestRetestRunId: 'vrun_1',
          beforeMetrics: {
            mentionRate: 40,
            avgPosition: 3.0,
            sentiment: 'neutral',
            citationHit: false,
          },
          afterMetrics: {
            mentionRate: 70,
            avgPosition: 1.8,
            sentiment: 'positive',
            citationHit: true,
          },
          crawlStatus: 'OK',
          crawlCheckedAt: '2026-11-11T00:00:00.000Z',
          crawlReportJson: null,
          retestSchedules: [
            {
              id: 'sched_did_1',
              publishRecordId: 'pub_did_1',
              milestoneDay: 7,
              sampleCount: 1,
              includeControlPrompts: true,
              dueAt: '2026-11-17T00:00:00.000Z',
              status: 'COMPLETED',
              visibilityRunId: 'vrun_1',
              metricsSnapshot: {
                mentionRate: 70,
                avgPosition: 1.8,
                sentiment: 'positive',
                citationHit: true,
                sampleCount: 4,
                hitCount: 3,
                wilson: {
                  hits: 3,
                  trials: 4,
                  rate: 0.75,
                  lower: 0.3006,
                  upper: 0.9544,
                  halfWidth: 0.3269,
                  z: 1.96,
                  confidenceLevel: 'LOW',
                },
                confidenceLevel: 'LOW',
              },
              controlMetricsJson: {
                controlPrompts: ['backup nas'],
                baselineMentionRate: 40,
                currentMentionRate: 45,
                sampleCount: 4,
                hitCount: 2,
                did: {
                  treatmentDelta: 0.3,
                  controlDelta: 0.05,
                  netLift: 0.25,
                  direction: 'POSITIVE',
                },
              },
              skipReason: null,
              executedAt: '2026-11-17T01:00:00.000Z',
              createdAt: '2026-11-10T00:00:00.000Z',
              updatedAt: '2026-11-17T01:00:00.000Z',
            },
          ],
        },
      },
    ];

    const summaryWithWilson = makeSummary({
      channelAttribution: [
        {
          ...makeSummary().channelAttribution[0]!,
          citationHitWilson: {
            hits: 2,
            trials: 4,
            rate: 0.5,
            lower: 0.15,
            upper: 0.85,
            halfWidth: 0.35,
            z: 1.96,
            confidenceLevel: 'LOW',
          },
        },
      ],
    });

    render(
      <HomeDistributionSummary
        summary={summaryWithWilson}
        recentArticles={recentArticles}
        onOpenArticle={vi.fn()}
        onOpenRoiReportModal={onOpenRoiReportModal}
      />,
    );

    const box = screen.getByTestId('home-distribution-summary');
    expect(box.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);
    expect(box.textContent).toContain('50.0%(2/4)');

    // Channel-level Wilson 95% CI & low-sample hint
    const channelCi = screen.getByTestId('channel-wilson-ci-Official Blog / Docs');
    expect(channelCi.textContent).toContain('95% CI [15.0%, 85.0%]');
    expect(channelCi.textContent).toContain('低置信');
    expect(
      screen.getByTestId('channel-low-sample-hint-Official Blog / Docs').textContent,
    ).toContain('3× 采样');

    // DiD net lift indicator strip
    const strip = screen.getByTestId('home-did-confidence-strip');
    expect(screen.getByTestId('home-did-net-lift').textContent).toContain('+25.0pp');
    expect(strip.textContent).toContain('正向净增益');
    expect(strip.textContent).toContain('处理组 Δ +30.0pp');
    expect(strip.textContent).toContain('对照组 Δ +5.0pp');
    expect(screen.getByTestId('home-wilson-summary').textContent).toContain(
      'Wilson 95% CI [30.1%, 95.4%]',
    );
    expect(screen.getByTestId('home-low-sample-hint').textContent).toContain('3× 采样');

    // Trigger ROI report modal button
    fireEvent.click(screen.getByTestId('home-summary-roi-report-btn'));
    expect(onOpenRoiReportModal).toHaveBeenCalledTimes(1);
  });

  it('suppresses duplicate home-crawl-alerts and respects isEmpty when hideCrawlAlerts is true (#392)', () => {
    render(
      <HomeDistributionSummary
        summary={makeSummary({
          upcomingRetests: [],
          channelAttribution: [],
        })}
        hideCrawlAlerts
        onOpenArticle={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('home-crawl-alerts')).toBeNull();
    expect(screen.getByTestId('home-distribution-summary').textContent).toContain(
      '暂无分发追踪与渠道归因数据',
    );
  });

  it('renders Monthly Retest Budget Progress Board honoring 0% empty track rule, >100% clamp, null cap, and SKIPPED_BUDGET_CAP (#387)', () => {
    const onOpenBudgetSettings = vi.fn();

    // 1. 0% used with cap=100 -> empty track (NO <rect> fill) AND prevents EmptyState
    const { rerender } = render(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 100,
          usedPoints: 0,
          remainingPoints: 100,
          skippedCount: 0,
        }}
        onOpenArticle={vi.fn()}
        onOpenBudgetSettings={onOpenBudgetSettings}
      />,
    );

    const board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).toContain('月度自动复测预算');
    expect(board.textContent).toContain('2026-11');
    expect(board.textContent).toContain('已消耗 0 点 / 上限 100 点');
    const barZero = screen.getByTestId('home-retest-budget-bar');
    expect(barZero.getAttribute('aria-valuenow')).toBe('0');
    expect(barZero.getAttribute('data-empty')).toBe('true');
    expect(barZero.querySelector('rect')).toBeNull();

    // 2. Over-cap usage (150/100) + skippedCount=2 + SKIPPED_BUDGET_CAP row -> clamped to 100 & warning badge
    rerender(
      <HomeDistributionSummary
        summary={{
          crawlAlerts: [],
          channelAttribution: [],
          upcomingRetests: [
            {
              scheduleId: 'sched_cap_1',
              publishRecordId: 'pub_cap_1',
              articleId: 'art_cap_1',
              articleTitle: 'Portable Power Station Benchmark',
              channel: 'Official Blog',
              milestoneDay: 7,
              sampleCount: 1,
              dueAt: '2026-11-25T08:00:00.000Z',
              status: 'SKIPPED_BUDGET_CAP',
              skipReason: '本月自动复测预算已达上限，已温和跳过',
            },
          ],
        }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 100,
          usedPoints: 150,
          remainingPoints: 0,
          skippedCount: 2,
        }}
        onOpenArticle={vi.fn()}
        onOpenBudgetSettings={onOpenBudgetSettings}
      />,
    );

    const barOver = screen.getByTestId('home-retest-budget-bar');
    expect(barOver.getAttribute('aria-valuenow')).toBe('100');
    expect(barOver.getAttribute('data-empty')).toBe('false');
    const fillRect = barOver.querySelector('rect');
    expect(fillRect).not.toBeNull();
    expect(fillRect?.getAttribute('width')).toBe('100');

    expect(screen.getByTestId('home-retest-budget-skipped-alert').textContent).toContain(
      '已达月度预算上限，已跳过 2 次自动复测',
    );
    const retestRow = screen.getByTestId('home-upcoming-retest-sched_cap_1');
    expect(retestRow.textContent).toContain('超出月度预算上限已跳过');

    fireEvent.click(within(retestRow).getByRole('button', { name: '调整上限' }));
    expect(onOpenBudgetSettings).toHaveBeenCalledTimes(1);

    // 3. null cap with usedPoints > 0 -> shows 未设上限 and no filled rect
    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: null,
          usedPoints: 30,
          remainingPoints: null,
          skippedCount: 0,
        }}
        onOpenArticle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('home-retest-budget-board').textContent).toContain('未设上限');
    expect(screen.getByTestId('home-retest-budget-bar').querySelector('rect')).toBeNull();
  });

  it('clamps malformed negative remainingPoints to 0 so negative remaining points never render (#387)', () => {
    render(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 100,
          usedPoints: 250,
          remainingPoints: -150,
          skippedCount: 1,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    const board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).toContain('剩余 0 点');
    expect(board.textContent).not.toContain('-150');
  });

  it('Tier 5 #9: sanitizes NaN, Infinity, and non-positive capPoints=0 without leaking NaN/Infinity/上限 0 点 into DOM or aria-valuenow', () => {
    const { rerender } = render(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 100,
          usedPoints: Number.NaN,
          remainingPoints: Number.NaN,
          skippedCount: Number.NaN,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    let board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).not.toContain('NaN');
    expect(board.textContent).toContain('已消耗 0 点 / 上限 100 点');
    expect(board.textContent).toContain('剩余 100 点（0%）');
    expect(screen.getByTestId('home-retest-budget-bar').getAttribute('aria-valuenow')).toBe('0');

    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 100,
          usedPoints: Number.POSITIVE_INFINITY,
          remainingPoints: -50,
          skippedCount: Number.POSITIVE_INFINITY,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).not.toContain('Infinity');
    expect(board.textContent).toContain('已消耗 0 点 / 上限 100 点');
    expect(screen.getByTestId('home-retest-budget-bar').getAttribute('aria-valuenow')).toBe('0');

    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 0,
          usedPoints: 25,
          remainingPoints: 0,
          skippedCount: 1,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).not.toContain('上限 0 点');
    expect(board.textContent).toContain('本月已消耗 25 点');
    expect(board.textContent).toContain('未设上限');
    const bar = screen.getByTestId('home-retest-budget-bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('data-empty')).toBe('true');
    expect(bar.querySelector('rect')).toBeNull();
  });

  it('Tier 5 R2: handles sub-1 fractional capPoints (0.5) and float-overflow usedPoints (1e308) without NaN%, Infinity%, or 上限 0 点', () => {
    // 1. capPoints: 0.5, usedPoints: 0, skippedCount: 0 -> truncated cap becomes null, hides empty budget board cleanly
    const { rerender } = render(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 0.5,
          usedPoints: 0,
          remainingPoints: 0.5,
          skippedCount: 0,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    const containerText = screen.getByTestId('home-distribution-summary').textContent ?? '';
    expect(screen.queryByTestId('home-retest-budget-board')).toBeNull();
    expect(containerText).not.toContain('NaN');
    expect(containerText).not.toContain('Infinity');
    expect(containerText).not.toContain('上限 0 点');

    // 2. capPoints: 0.5, usedPoints: 0, skippedCount: 1 -> renders 未设上限, zero NaN%, zero 上限 0 点, aria-valuenow="0"
    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 0.5,
          usedPoints: 0,
          remainingPoints: 0.5,
          skippedCount: 1,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    let board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).toContain('未设上限');
    expect(board.textContent).not.toContain('NaN%');
    expect(board.textContent).not.toContain('NaN');
    expect(board.textContent).not.toContain('上限 0 点');
    let bar = screen.getByTestId('home-retest-budget-bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('data-empty')).toBe('true');
    expect(bar.querySelector('rect')).toBeNull();

    // 3. capPoints: 0.5, usedPoints: 10 -> renders 未设上限, zero Infinity%, zero 上限 0 点
    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 0.5,
          usedPoints: 10,
          remainingPoints: 0,
          skippedCount: 0,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).toContain('本月已消耗 10 点');
    expect(board.textContent).toContain('未设上限');
    expect(board.textContent).not.toContain('Infinity%');
    expect(board.textContent).not.toContain('Infinity');
    expect(board.textContent).not.toContain('上限 0 点');
    bar = screen.getByTestId('home-retest-budget-bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('data-empty')).toBe('true');
    expect(bar.querySelector('rect')).toBeNull();

    // 4. capPoints: 1, usedPoints: 1e308 -> renders finite 100%, zero Infinity%
    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 1,
          usedPoints: 1e308,
          remainingPoints: 0,
          skippedCount: 0,
        }}
        onOpenArticle={vi.fn()}
      />,
    );

    board = screen.getByTestId('home-retest-budget-board');
    expect(board.textContent).toContain('（100%）');
    expect(board.textContent).not.toContain('Infinity%');
    expect(board.textContent).not.toContain('Infinity');
    bar = screen.getByTestId('home-retest-budget-bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('data-empty')).toBe('false');
    expect(bar.querySelector('rect')?.getAttribute('width')).toBe('100');
  });
});
