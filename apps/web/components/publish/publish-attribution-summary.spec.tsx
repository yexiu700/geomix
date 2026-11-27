// @vitest-environment jsdom
import type { ActionHomeResponse, DistributionSummaryDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishAttributionSummary } from './publish-attribution-summary';

function makeSummary(overrides?: Partial<DistributionSummaryDto>): DistributionSummaryDto {
  return {
    crawlAlerts: [],
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
    ],
    ...overrides,
  };
}

describe('PublishAttributionSummary (Y33 migrated from /home)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('returns null when summary, DiD/Wilson, and retestBudget are all empty', () => {
    const { container } = render(<PublishAttributionSummary onSelectArticle={vi.fn()} />);
    expect(container.querySelector('[data-testid="publish-brand-attribution-summary"]')).toBeNull();
  });

  it('renders DiD, Wilson CI, upcoming retests, channel attribution, and monthly budget progress bar with 0 NaN', () => {
    const onSelectArticle = vi.fn();
    const onOpenPoints = vi.fn();
    const onOpenBudgetSettings = vi.fn();

    const recentArticles: ActionHomeResponse['recentArticles'] = [
      {
        id: 'art_1',
        title: 'NAS Benchmark',
        recipe: 'AUTHORITY_GUIDE',
        geoScore: 88,
        status: 'PUBLISHED',
        updatedAt: '2026-11-23T00:00:00.000Z',
        publishRecord: {
          id: 'pub_ok_1',
          brandId: 'brand_1',
          brandMarketId: 'bm_1',
          articleId: 'art_1',
          channel: 'Official Blog / Docs',
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
              publishRecordId: 'pub_ok_1',
              milestoneDay: 7,
              dueAt: '2026-11-27T08:00:00.000Z',
              status: 'COMPLETED',
              sampleCount: 3,
              includeControlPrompts: true,
              visibilityRunId: 'run_1',
              metricsSnapshot: {
                mentionRate: 70,
                avgPosition: 1.5,
                sentiment: 'positive',
                citationHit: true,
                sampleCount: 3,
                hitCount: 2,
                wilson: {
                  hits: 7,
                  trials: 10,
                  rate: 0.7,
                  lower: 0.397,
                  upper: 0.892,
                  halfWidth: 0.247,
                  z: 1.96,
                  confidenceLevel: 'MEDIUM',
                },
              },
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
      <PublishAttributionSummary
        summary={makeSummary()}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 60,
          usedPoints: 60,
          remainingPoints: 0,
          skippedCount: 1,
        }}
        recentArticles={recentArticles}
        onSelectArticle={onSelectArticle}
        onOpenPoints={onOpenPoints}
        onOpenBudgetSettings={onOpenBudgetSettings}
      />,
    );

    expect(screen.getByTestId('publish-did-net-lift').textContent).toContain('DiD 净增益 +30.0pp');
    expect(screen.getByTestId('publish-wilson-summary').textContent).toContain(
      'Wilson 95% CI [39.7%, 89.2%]',
    );

    const budgetBoard = screen.getByTestId('publish-retest-budget-board');
    expect(budgetBoard.textContent).toContain('已消耗 60 点 / 上限 60 点');
    expect(screen.getByTestId('publish-retest-budget-bar').getAttribute('aria-valuenow')).toBe(
      '100',
    );
    expect(screen.getByTestId('publish-retest-budget-skipped-alert').textContent).toContain(
      '预算达上限 · 已跳过 1 次',
    );
    fireEvent.click(screen.getByTestId('publish-retest-budget-settings-btn'));
    expect(onOpenBudgetSettings).toHaveBeenCalledTimes(1);

    const retestBox = screen.getByTestId('publish-upcoming-retests');
    fireEvent.click(within(retestBox).getByRole('button', { name: '查看点数' }));
    expect(onOpenPoints).toHaveBeenCalledTimes(1);
    fireEvent.click(within(retestBox).getAllByRole('button', { name: '查看' })[0]!);
    expect(onSelectArticle).toHaveBeenCalledWith('art_ok_1');

    const attrText = screen.getByTestId('publish-channel-attribution').textContent ?? '';
    expect(attrText).toContain('50.0%(2/4)');
    expect(attrText).toContain('+25.5%');
    expect(attrText).toContain('待引文就绪');
    expect(attrText).not.toContain('NaN');
  });
});
