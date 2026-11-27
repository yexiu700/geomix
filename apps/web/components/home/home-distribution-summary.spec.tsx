// @vitest-environment jsdom
import type { ActionHomeResponse, DistributionSummaryDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
        issues: ['robots.txt 拦截了 GPTBot'],
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
    ],
    ...overrides,
  };
}

describe('HomeDistributionSummary (Y33 compact strip)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('returns null when no distribution activity, budget usage, or DiD signal exists', () => {
    const { container, rerender } = render(<HomeDistributionSummary />);
    expect(container.querySelector('[data-testid="home-distribution-summary"]')).toBeNull();

    rerender(
      <HomeDistributionSummary
        summary={{ crawlAlerts: [], upcomingRetests: [], channelAttribution: [] }}
      />,
    );
    expect(container.querySelector('[data-testid="home-distribution-summary"]')).toBeNull();
  });

  it('renders single-row summary with published/upcoming/alert/budget/DiD pills and navigates to /publish', () => {
    const onOpenStudio = vi.fn();
    const recentArticles: ActionHomeResponse['recentArticles'] = [
      {
        id: 'art_1',
        title: 'NAS Benchmark',
        recipe: 'AUTHORITY_GUIDE',
        geoScore: 88,
        status: 'PUBLISHED',
        updatedAt: '2026-11-23T00:00:00.000Z',
        publishRecord: {
          id: 'pub_1',
          brandId: 'brand_1',
          brandMarketId: 'bm_1',
          articleId: 'art_1',
          channel: 'WordPress',
          publishedUrl: 'https://example.com/1',
          baselineRunId: null,
          beforeMetrics: null,
          afterMetrics: null,
          latestRetestRunId: null,
          crawlStatus: 'OK',
          crawlCheckedAt: null,
          crawlReportJson: null,
          indexNowSubmitted: false,
          publishedAt: '2026-11-20T00:00:00.000Z',
          retestSchedules: [
            {
              id: 'sched_done',
              publishRecordId: 'pub_1',
              milestoneDay: 7,
              dueAt: '2026-11-27T08:00:00.000Z',
              status: 'COMPLETED',
              sampleCount: 3,
              includeControlPrompts: true,
              visibilityRunId: 'run_1',
              metricsSnapshot: null,
              controlMetricsJson: {
                controlPrompts: ['c1'],
                baselineMentionRate: 20,
                currentMentionRate: 25,
                sampleCount: 3,
                hitCount: 1,
                did: {
                  treatmentDelta: 0.35,
                  controlDelta: 0.05,
                  netLift: 0.3,
                  direction: 'POSITIVE',
                },
              },
              skipReason: null,
              executedAt: '2026-11-27T08:00:00.000Z',
              createdAt: '2026-11-20T08:00:00.000Z',
              updatedAt: '2026-11-27T08:00:00.000Z',
            },
          ],
        },
      },
    ];

    render(
      <HomeDistributionSummary
        summary={makeSummary()}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 60,
          usedPoints: 60,
          remainingPoints: 0,
          skippedCount: 2,
        }}
        recentArticles={recentArticles}
        onOpenStudio={onOpenStudio}
      />,
    );

    const box = screen.getByTestId('home-distribution-summary');
    const text = box.textContent ?? '';
    expect(text).toContain('已发 4 篇');
    expect(text).toContain('待复测 1 项');
    expect(text).toContain('异常 1');
    expect(screen.getByTestId('home-retest-budget-summary').textContent).toContain('预算 60/60 点');
    expect(text).toContain('达上限 (2)');
    expect(screen.getByTestId('home-did-compact').textContent).toContain('DiD +30.0pp');
    expect(text).not.toContain('NaN');
    expect(screen.queryByTestId('home-upcoming-retests')).toBeNull();
    expect(screen.queryByTestId('home-channel-attribution')).toBeNull();
    expect(screen.queryByTestId('home-summary-roi-report-btn')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '去发布' }));
    expect(onOpenStudio).toHaveBeenCalledTimes(1);
  });

  it('guards non-finite numbers without rendering NaN', () => {
    render(
      <HomeDistributionSummary
        summary={makeSummary()}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: Number.NaN as unknown as number,
          usedPoints: Number.NaN as unknown as number,
          remainingPoints: null,
          skippedCount: Number.NaN as unknown as number,
        }}
      />,
    );

    const text = screen.getByTestId('home-distribution-summary').textContent ?? '';
    expect(text).not.toContain('NaN');
  });
});
