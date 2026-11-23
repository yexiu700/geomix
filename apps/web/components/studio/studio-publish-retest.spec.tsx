// @vitest-environment jsdom
import type { GeoArticleRecord, GeoPublishRecordDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as distributionApi from '../../lib/distribution';
import * as freshnessApi from '../../lib/tab-freshness';
import * as visibilityApi from '../../lib/visibility';
import { StudioPublishRetest } from './studio-publish-retest';

const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockNotifyWarning = vi.fn();
const mockConfirm = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: mockNotifySuccess,
    notifyWarning: mockNotifyWarning,
    notifyError: mockNotifyError,
  }),
}));

const SAMPLE_ARTICLE: GeoArticleRecord = {
  id: 'art_1',
  brandId: 'brand_1',
  brandMarketId: 'bm_gl_1',
  market: 'GLOBAL',
  briefId: null,
  recipe: 'AUTHORITY_GUIDE',
  title: 'AstraVault X4 Quiet NAS Guide',
  markdown: '# Guide',
  html: '<h1>Guide</h1>',
  geoScore: 88,
  evaluationJson: null,
  status: 'PUBLISHED',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
} as unknown as GeoArticleRecord;

function makeRecord(overrides?: Partial<GeoPublishRecordDto>): GeoPublishRecordDto {
  return {
    id: 'pub_1',
    brandId: 'brand_1',
    brandMarketId: 'bm_gl_1',
    articleId: 'art_1',
    publishedUrl: 'https://astravault.example.com/guides/nas-2026',
    channel: 'Official Blog / Docs',
    publishedAt: '2026-11-20T08:00:00.000Z',
    baselineRunId: 'run_base_1',
    latestRetestRunId: 'run_ret_1',
    beforeMetrics: {
      mentionRate: 20,
      avgPosition: 4.0,
      sentiment: 'neutral',
      citationHit: false,
    },
    afterMetrics: {
      mentionRate: 60,
      avgPosition: 1.5,
      sentiment: 'positive',
      citationHit: true,
    },
    crawlStatus: 'OK',
    crawlCheckedAt: '2026-11-21T08:00:00.000Z',
    indexNowSubmitted: true,
    crawlReportJson: {
      checkedUrl: 'https://astravault.example.com/guides/nas-2026',
      httpStatus: 200,
      robotsTxtFound: true,
      robotsMatrix: [
        { bot: '*', allowed: true },
        { bot: 'GPTBot', allowed: true },
        { bot: 'OAI-SearchBot', allowed: true },
        { bot: 'PerplexityBot', allowed: true },
        { bot: 'Googlebot', allowed: true },
      ],
      metaNoindex: false,
      jsonLdTypes: ['Article', 'FAQPage'],
      jsonLdParseErrors: [],
      canonicalUrl: 'https://astravault.example.com/guides/nas-2026',
      canonicalMatches: true,
      issues: [],
    },
    retestSchedules: [
      {
        id: 'sched_7',
        publishRecordId: 'pub_1',
        milestoneDay: 7,
        sampleCount: 1,
        dueAt: '2026-11-27T08:00:00.000Z',
        status: 'COMPLETED',
        visibilityRunId: 'run_t7',
        metricsSnapshot: {
          mentionRate: 60,
          avgPosition: 1.5,
          sentiment: 'positive',
          citationHit: true,
          sampleCount: 1,
          hitCount: 1,
        },
        skipReason: null,
        executedAt: '2026-11-27T08:10:00.000Z',
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-27T08:10:00.000Z',
      },
      {
        id: 'sched_14',
        publishRecordId: 'pub_1',
        milestoneDay: 14,
        sampleCount: 1,
        dueAt: '2026-12-04T08:00:00.000Z',
        status: 'PENDING',
        visibilityRunId: null,
        metricsSnapshot: null,
        skipReason: null,
        executedAt: null,
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-20T08:00:00.000Z',
      },
      {
        id: 'sched_30',
        publishRecordId: 'pub_1',
        milestoneDay: 30,
        sampleCount: 1,
        dueAt: '2026-12-20T08:00:00.000Z',
        status: 'SKIPPED_INSUFFICIENT_POINTS',
        visibilityRunId: null,
        metricsSnapshot: null,
        skipReason: '点数不足（预计 4 点，当前余额 0 点）',
        executedAt: null,
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-12-20T08:05:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('StudioPublishRetest (M6B #355)', () => {
  beforeEach(() => {
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockNotifyWarning.mockReset();
    mockConfirm.mockReset();

    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue({
      brandId: 'brand_1',
      market: 'GLOBAL',
      engines: [
        { key: 'chatgpt', label: 'ChatGPT', market: 'GLOBAL', available: true },
        { key: 'perplexity', label: 'Perplexity', market: 'GLOBAL', available: true },
        { key: 'gemini', label: 'Gemini', market: 'GLOBAL', available: false },
      ],
    } as unknown as Awaited<ReturnType<typeof visibilityApi.fetchVisibilityEngines>>);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps URL input first, omits autoRetest on default submit, discloses PRD D3 budget ceiling, and supports opt-out & 3-sample mode', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onTriggerRetest = vi.fn().mockResolvedValue(undefined);

    render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={onCreate}
        onTriggerRetest={onTriggerRetest}
      />,
    );

    const form = screen.getByTestId('publish-record-form');
    const firstInput = form.querySelector('input');
    expect(firstInput?.getAttribute('aria-label')).toBe('已发布文章 URL');

    // Wait for live online engine count (2 available GLOBAL engines) -> 3 * 2 * 1 * 2 = 12 pts
    await waitFor(() => {
      expect(screen.getByTestId('publish-form-budget-ceiling').textContent).toContain(
        '3 节点 × 2 活跃引擎 × 1 次采样 × 2 点 = 上限 12 点',
      );
    });

    // Default submit omits autoRetest for backward compatibility
    fireEvent.change(screen.getByLabelText('已发布文章 URL'), {
      target: { value: 'https://astravault.example.com/blog/post-1' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        publishedUrl: 'https://astravault.example.com/blog/post-1',
        channel: 'Official Blog / Docs',
      });
    });

    // Switch to 3x high-confidence -> budget updates to 36 pts and sends autoRetest payload
    fireEvent.click(within(form).getByRole('button', { name: '3 次高置信' }));
    expect(screen.getByTestId('publish-form-budget-ceiling').textContent).toContain('上限 36 点');
    fireEvent.change(screen.getByLabelText('已发布文章 URL'), {
      target: { value: 'https://astravault.example.com/blog/post-2' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        publishedUrl: 'https://astravault.example.com/blog/post-2',
        channel: 'Official Blog / Docs',
        autoRetest: {
          enabled: true,
          milestones: [7, 14, 30],
          sampleCount: 3,
        },
      });
    });

    // Uncheck auto-retest -> sends { enabled: false }
    const checkbox = screen.getByTestId('publish-auto-retest-checkbox');
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText('已发布文章 URL'), {
      target: { value: 'https://astravault.example.com/blog/post-3' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        publishedUrl: 'https://astravault.example.com/blog/post-3',
        channel: 'Official Blog / Docs',
        autoRetest: { enabled: false },
      });
    });
  });

  it('never renders literal "0 点" when 0 online engines are available', async () => {
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValueOnce({
      brandId: 'brand_1',
      market: 'GLOBAL',
      engines: [{ key: 'chatgpt', label: 'ChatGPT', market: 'GLOBAL', available: false }],
    } as unknown as Awaited<ReturnType<typeof visibilityApi.fetchVisibilityEngines>>);

    render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    await waitFor(() => {
      const budgetText = screen.getByTestId('publish-form-budget-ceiling').textContent ?? '';
      expect(budgetText).toContain('当前市场暂无在线引擎');
      expect(budgetText).not.toMatch(/(?:^|[^\d])0\s*点/);
    });
  });

  it('renders crawl probe badges, triggers manual recheck, and expands red diagnostic alerts', async () => {
    const rec = makeRecord();
    const probeSpy = vi.spyOn(distributionApi, 'triggerCrawlProbe').mockResolvedValueOnce(
      makeRecord({
        crawlStatus: 'BLOCKED',
        crawlCheckedAt: '2026-11-23T10:00:00.000Z',
        crawlReportJson: {
          checkedUrl: rec.publishedUrl,
          httpStatus: 200,
          robotsTxtFound: true,
          robotsMatrix: [
            { bot: 'GPTBot', allowed: false, matchedRule: 'Disallow: /guides/' },
            { bot: 'PerplexityBot', allowed: true },
          ],
          metaNoindex: true,
          jsonLdTypes: [],
          jsonLdParseErrors: ['Unexpected token }'],
          canonicalUrl: 'https://other.example.com/',
          canonicalMatches: false,
          issues: ['robots.txt 拦截了 GPTBot', '页面声明了 meta noindex'],
        },
      }),
    );
    const freshnessSpy = vi.spyOn(freshnessApi, 'invalidateFreshness');

    render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[rec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    const badgeBox = screen.getByTestId('publish-crawl-badges-pub_1');
    expect(badgeBox.textContent).toContain('可抓取');
    expect(badgeBox.textContent).toContain('HTTP 200');
    expect(badgeBox.textContent).toContain('GPTBot 允许');
    expect(badgeBox.textContent).toContain('PerplexityBot 允许');
    expect(badgeBox.textContent).toContain('JSON-LD: Article');
    expect(badgeBox.textContent).toContain('IndexNow 已提交');

    fireEvent.click(screen.getByTestId('publish-crawl-recheck-btn-pub_1'));

    await waitFor(() => {
      expect(probeSpy).toHaveBeenCalledWith(
        'pub_1',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(freshnessSpy).toHaveBeenCalledWith('publish-records');
    });

    await waitFor(() => {
      expect(badgeBox.textContent).toContain('抓取受阻');
      expect(badgeBox.textContent).toContain('GPTBot 拦截');
      expect(badgeBox.textContent).toContain('meta noindex');
      expect(badgeBox.textContent).toContain('JSON-LD 解析异常');
    });

    const diag = screen.getByTestId('publish-crawl-diagnostics-pub_1');
    expect(diag.textContent).toContain('robots.txt 拦截了 GPTBot');
    expect(diag.textContent).toContain('Unexpected token }');
    expect(diag.textContent).toContain('Canonical 不一致');
  });

  it('renders stepped T+0/T+7/T+14/T+30 timeline, switches sampling count, cancels/re-enables milestones, and demotes instant retest button', async () => {
    const rec = makeRecord();
    const onTriggerRetest = vi.fn().mockResolvedValue(undefined);
    const updateSchedSpy = vi
      .spyOn(distributionApi, 'updateRetestSchedules')
      .mockResolvedValueOnce({
        publishRecordId: 'pub_1',
        items: rec.retestSchedules!.map((s) =>
          s.status === 'PENDING' ? { ...s, sampleCount: 3 } : s,
        ),
      })
      .mockResolvedValueOnce({
        publishRecordId: 'pub_1',
        items: rec.retestSchedules!.map((s) =>
          s.milestoneDay === 14 ? { ...s, status: 'CANCELLED', sampleCount: 3 } : s,
        ),
      });

    render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[rec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={onTriggerRetest}
      />,
    );

    const timeline = screen.getByTestId('publish-retest-timeline-pub_1');
    expect(timeline.textContent).toContain('T+0 基准');
    expect(timeline.textContent).toContain('提及率 20%');

    // T+7 COMPLETED snapshot
    const t7 = screen.getByTestId('publish-retest-node-pub_1-T7');
    expect(t7.textContent).toContain('已完成');
    expect(t7.textContent).toContain('提及率 60% (+40%)');
    expect(t7.textContent).toContain('引文命中');
    expect(t7.textContent).toContain('#1.5');

    // T+30 SKIPPED_INSUFFICIENT_POINTS
    const t30 = screen.getByTestId('publish-retest-node-pub_1-T30');
    expect(t30.textContent).toContain('点数不足已跳过');
    expect(t30.textContent).toContain('点数不足');

    // Switch sample count to 3x
    const toggle = screen.getByTestId('publish-retest-sample-toggle-pub_1');
    fireEvent.click(within(toggle).getByRole('button', { name: '3 次高置信' }));
    await waitFor(() => {
      expect(updateSchedSpy).toHaveBeenCalledWith(
        'pub_1',
        { sampleCount: 3 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    // Cancel T+14 PENDING milestone
    const t14 = screen.getByTestId('publish-retest-node-pub_1-T14');
    fireEvent.click(within(t14).getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(updateSchedSpy).toHaveBeenCalledWith(
        'pub_1',
        { cancelMilestoneDays: [14] },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(t14.textContent).toContain('已取消');
    });

    // Demoted instant retest button still works & shows gentle hint
    const instantBtn = screen.getByTestId('publish-retest-btn');
    expect(instantBtn.textContent).toContain('一键立刻复测');
    expect(screen.getByText(/新发内容通常需 7–14 天进入 AI 检索/)).toBeTruthy();
    fireEvent.click(instantBtn);
    expect(onTriggerRetest).toHaveBeenCalledWith(expect.objectContaining({ id: 'pub_1' }));
  });

  it('preserves live onlineEngineCount on same-brand article switch both while fetch is in flight and after settle (Fix 1)', async () => {
    let resolveEngines!: (
      val: Awaited<ReturnType<typeof visibilityApi.fetchVisibilityEngines>>,
    ) => void;
    const deferredEngines = new Promise<
      Awaited<ReturnType<typeof visibilityApi.fetchVisibilityEngines>>
    >((resolve) => {
      resolveEngines = resolve;
    });

    const enginesSpy = vi
      .spyOn(visibilityApi, 'fetchVisibilityEngines')
      .mockReturnValueOnce(deferredEngines);

    const article2: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_2',
      title: 'AstraVault X4 RAID5 Benchmarks',
    };
    const article3: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_3',
      title: 'AstraVault X4 Power Draw Guide',
    };

    const { rerender } = render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    // Case A: Switch art_1 -> art_2 (same brand_1 & GLOBAL) WHILE fetchVisibilityEngines is still in flight
    rerender(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={article2}
        publishRecords={[]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    resolveEngines({
      brandId: 'brand_1',
      market: 'GLOBAL',
      engines: [
        { key: 'chatgpt', label: 'ChatGPT', market: 'GLOBAL', available: true },
        { key: 'perplexity', label: 'Perplexity', market: 'GLOBAL', available: false },
      ],
    } as unknown as Awaited<ReturnType<typeof visibilityApi.fetchVisibilityEngines>>);

    await waitFor(() => {
      expect(screen.getByTestId('publish-form-budget-ceiling').textContent).toContain(
        '3 节点 × 1 活跃引擎 × 1 次采样 × 2 点 = 上限 6 点',
      );
    });
    expect(enginesSpy).toHaveBeenCalledTimes(1);

    // Case B: Switch art_2 -> art_3 AFTER live engines settled -> must preserve 1 online engine instead of reverting to static fallback 5
    rerender(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={article3}
        publishRecords={[]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    expect(screen.getByTestId('publish-form-budget-ceiling').textContent).toContain(
      '3 节点 × 1 活跃引擎 × 1 次采样 × 2 点 = 上限 6 点',
    );
    expect(screen.getByTestId('publish-form-budget-ceiling').textContent).not.toContain(
      '5 活跃引擎',
    );
  });

  it('yields stale local crawlOverrides & scheduleOverrides to fresher server publishRecords props while preserving overrides on prepend (Fix 4)', async () => {
    const initialRec = makeRecord({ crawlStatus: 'PENDING' });
    vi.spyOn(distributionApi, 'triggerCrawlProbe').mockResolvedValueOnce(
      makeRecord({
        crawlStatus: 'BLOCKED',
        crawlCheckedAt: '2026-11-23T10:00:00.000Z',
        crawlReportJson: {
          ...initialRec.crawlReportJson!,
          robotsMatrix: [
            { bot: 'GPTBot', allowed: false, matchedRule: 'Disallow: /en/articles/2026/' },
          ],
          issues: ['robots.txt 拦截了 GPTBot'],
        },
      }),
    );
    vi.spyOn(distributionApi, 'updateRetestSchedules').mockResolvedValueOnce({
      publishRecordId: 'pub_1',
      items: initialRec.retestSchedules!.map((s) =>
        s.milestoneDay === 14 ? { ...s, status: 'CANCELLED' } : s,
      ),
    });

    const { rerender } = render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[initialRec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    // Trigger local crawl override (PENDING -> BLOCKED) and local schedule override (T+14 -> CANCELLED)
    fireEvent.click(screen.getByTestId('publish-crawl-recheck-btn-pub_1'));
    await waitFor(() => {
      expect(screen.getByTestId('publish-crawl-badges-pub_1').textContent).toContain('抓取受阻');
    });

    // Verify robotsMatrix diagnostic pill allows wrapping (Fix 3)
    const diagBox = screen.getByTestId('publish-crawl-diagnostics-pub_1');
    const blockedPill = within(diagBox).getByText(
      /GPTBot: 拦截 \(Disallow: \/en\/articles\/2026\/\)/,
    );
    expect(blockedPill.style.whiteSpace).toBe('normal');
    expect(blockedPill.style.maxWidth).toBe('100%');
    expect(blockedPill.style.overflowWrap).toBe('anywhere');

    const t14Before = screen.getByTestId('publish-retest-node-pub_1-T14');
    fireEvent.click(within(t14Before).getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(screen.getByTestId('publish-retest-node-pub_1-T14').textContent).toContain('已取消');
    });

    // Prepending a new record while keeping initialRec reference preserves local overrides
    const prependedRec = makeRecord({ id: 'pub_2', publishedUrl: 'https://example.com/post-2' });
    rerender(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[prependedRec, initialRec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );
    expect(screen.getByTestId('publish-crawl-badges-pub_1').textContent).toContain('抓取受阻');
    expect(screen.getByTestId('publish-retest-node-pub_1-T14').textContent).toContain('已取消');

    // Rerender with a FRESH server publishRecords array (new object reference for pub_1)
    const freshServerRec = makeRecord({
      crawlStatus: 'OK',
      retestSchedules: initialRec.retestSchedules!.map((s) =>
        s.milestoneDay === 14
          ? {
              ...s,
              status: 'COMPLETED',
              metricsSnapshot: {
                mentionRate: 75,
                avgPosition: 1.2,
                sentiment: 'positive',
                citationHit: true,
                sampleCount: 1,
                hitCount: 1,
              },
              executedAt: '2026-12-04T08:15:00.000Z',
            }
          : s,
      ),
    });
    rerender(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[freshServerRec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    expect(screen.getByTestId('publish-crawl-badges-pub_1').textContent).toContain('可抓取');
    expect(screen.getByTestId('publish-crawl-badges-pub_1').textContent).not.toContain('抓取受阻');
    expect(screen.getByTestId('publish-retest-node-pub_1-T14').textContent).toContain('已完成');
    expect(screen.getByTestId('publish-retest-node-pub_1-T14').textContent).not.toContain('已取消');
  });

  it('disables record-level sampling switcher when 0 PENDING schedules exist and fires 0 API calls (Fix 5)', () => {
    const updateSchedSpy = vi.spyOn(distributionApi, 'updateRetestSchedules');
    const noPendingRec = makeRecord({
      retestSchedules: makeRecord().retestSchedules!.map((s) =>
        s.status === 'PENDING' ? { ...s, status: 'CANCELLED' } : s,
      ),
    });

    render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[noPendingRec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    const toggle = screen.getByTestId('publish-retest-sample-toggle-pub_1');
    const btn1 = within(toggle).getByRole('button', { name: '1 次' }) as HTMLButtonElement;
    const btn3 = within(toggle).getByRole('button', { name: '3 次高置信' }) as HTMLButtonElement;
    expect(btn1.disabled).toBe(true);
    expect(btn3.disabled).toBe(true);
    expect(btn1.title).toBe('当前无待执行复测节点，请先开启至少一个节点后再切换采样模式');
    expect(btn3.title).toBe('当前无待执行复测节点，请先开启至少一个节点后再切换采样模式');

    fireEvent.click(btn1);
    fireEvent.click(btn3);
    expect(updateSchedSpy).not.toHaveBeenCalled();
  });

  it('prevents duplicate API requests on same-tick double-click for crawl probe and schedule updates (Fix 6)', async () => {
    const rec = makeRecord();
    let resolveProbe!: (val: GeoPublishRecordDto) => void;
    const probeSpy = vi.spyOn(distributionApi, 'triggerCrawlProbe').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    let resolveSchedule!: (val: {
      publishRecordId: string;
      items: NonNullable<GeoPublishRecordDto['retestSchedules']>;
    }) => void;
    const scheduleSpy = vi.spyOn(distributionApi, 'updateRetestSchedules').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSchedule = resolve;
        }),
    );

    render(
      <StudioPublishRetest
        activeMarket="GLOBAL"
        article={SAMPLE_ARTICLE}
        publishRecords={[rec]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={vi.fn()}
        onTriggerRetest={vi.fn()}
      />,
    );

    // Two synchronous clicks in the same tick on crawl recheck button
    const probeBtn = screen.getByTestId('publish-crawl-recheck-btn-pub_1');
    fireEvent.click(probeBtn);
    fireEvent.click(probeBtn);
    expect(probeSpy).toHaveBeenCalledTimes(1);

    // Two synchronous clicks in the same tick on schedule cancel button
    const t14CancelBtn = within(screen.getByTestId('publish-retest-node-pub_1-T14')).getByRole(
      'button',
      { name: '取消' },
    );
    fireEvent.click(t14CancelBtn);
    fireEvent.click(t14CancelBtn);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    // Settle promises cleanly
    resolveProbe(rec);
    resolveSchedule({ publishRecordId: 'pub_1', items: rec.retestSchedules! });
    await waitFor(() => {
      expect((probeBtn as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
