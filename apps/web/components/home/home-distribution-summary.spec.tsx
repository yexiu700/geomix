// @vitest-environment jsdom
import type { DistributionSummaryDto } from '@geomix/shared';
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
    fireEvent.click(within(crawlBox).getByRole('button', { name: '前往排查' }));
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
});
