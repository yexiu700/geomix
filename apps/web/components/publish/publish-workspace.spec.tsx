// @vitest-environment jsdom
import {
  type BrandFactRecord,
  type BrandRecord,
  type ChannelConnectionDto,
  type GeoArticleRecord,
  type GeoBriefRecord,
  type GeoPublishRecordDto,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandsApi from '../../lib/brands';
import * as briefsApi from '../../lib/briefs';
import * as distributionApi from '../../lib/distribution';
import * as studioApi from '../../lib/studio';
import { invalidateFreshness } from '../../lib/tab-freshness';
import * as uxFoundation from '../../lib/ux-foundation';
import * as visibilityApi from '../../lib/visibility';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider, type ConsoleContextValue } from '../shell/console-context';
import { PublishWorkspace } from './publish-workspace';

const mockConfirm = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockNotifyWarning = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: mockNotifySuccess,
    notifyWarning: mockNotifyWarning,
    notifyError: mockNotifyError,
  }),
}));

const DUAL_BRAND: BrandRecord = {
  id: 'brand_pub_1',
  name: '星辰存储',
  category: '家用 NAS',
  truthAgreementSignedAt: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  markets: [
    {
      id: 'bm_cn_1',
      brandId: 'brand_pub_1',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '星辰存储',
      localCategory: '家用 NAS',
      aliases: ['DXP4800'],
      ownedDomains: ['star.example.com'],
      competitors: [{ name: '群晖', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['2026 四盘位家用静音 NAS 推荐'],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
    {
      id: 'bm_gl_1',
      brandId: 'brand_pub_1',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AstraVault',
      localCategory: 'Home NAS',
      aliases: ['DXP4800'],
      ownedDomains: ['astravault.example.com'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['Best quiet 4-bay NAS 2026'],
      supportedLocales: ['en-US', 'de-DE'],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  ],
};

const DRAFT_ARTICLE: GeoArticleRecord = {
  id: 'art_pub_draft_1',
  brandId: DUAL_BRAND.id,
  brandMarketId: 'bm_cn_1',
  market: 'CN',
  briefId: 'brief_pub_1',
  batchJobId: null,
  recipe: 'AUTHORITY_GUIDE',
  targetFormat: 'CN_DEEP_REVIEW',
  targetLocale: 'zh-CN',
  title: '星辰存储 DXP4800 静音实测报告',
  targetPrompt: '四盘位家用静音 NAS 推荐',
  outlineJson: [{ heading: '实测数据', intent: '对比噪声与功耗' }],
  contentMarkdown: '# 星辰存储 DXP4800 静音实测报告\n\n实测满载噪音 18.5dB。',
  contentHtml: '<h1>星辰存储 DXP4800 静音实测报告</h1><p>实测满载噪音 18.5dB。</p>',
  schemaJsonLd: { '@context': 'https://schema.org', '@graph': [{ '@type': 'Article' }] },
  llmsTxtSnippet: null,
  geoScore: 88,
  geoScoreDetail: {},
  tags: ['NAS'],
  status: 'DRAFT',
  model: 'fake',
  tokensIn: 100,
  tokensOut: 200,
  complianceFlags: [],
  publishRecordCount: 0,
  hasCrawlAlert: false,
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
};

const PUBLISHED_ALERT_ARTICLE: GeoArticleRecord = {
  ...DRAFT_ARTICLE,
  id: 'art_pub_alert_1',
  title: '四盘位 NAS 爬虫抓取异常复盘',
  status: 'PUBLISHED',
  geoScore: 91,
  publishRecordCount: 1,
  hasCrawlAlert: true,
  updatedAt: '2026-11-22T00:00:00.000Z',
};

const GLOBAL_ARTICLE: GeoArticleRecord = {
  ...DRAFT_ARTICLE,
  id: 'art_pub_gl_1',
  brandMarketId: 'bm_gl_1',
  market: 'GLOBAL',
  briefId: null,
  targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
  targetLocale: 'en-US',
  title: 'Best 4-Bay Quiet NAS 2026 Guide',
  targetPrompt: 'Best quiet 4-bay NAS 2026',
  contentMarkdown: 'AstraVault DXP4800 is a Top pick with 100% aluminum chassis.',
  contentHtml: '<p>AstraVault DXP4800 is a Top pick with 100% aluminum chassis.</p>',
  schemaJsonLd: {
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'Article', headline: 'Best 4-Bay Quiet NAS 2026 Guide' }],
  },
  llmsTxtSnippet:
    '# AstraVault\n\n## Featured GEO Guides\n- [Guide](https://astravault.example.com/guides/nas): 18.5dB',
  geoScore: 92,
  status: 'READY',
};

const SAMPLE_BRIEF: GeoBriefRecord = {
  id: 'brief_pub_1',
  brandId: DUAL_BRAND.id,
  brandMarketId: 'bm_cn_1',
  market: 'CN',
  sourceType: 'AUTO_GAP',
  sourceRunId: null,
  sourceObservationIds: [],
  sourceCitationUrl: null,
  targetPrompt: '四盘位家用静音 NAS 推荐',
  priorityScore: 92,
  diagnosisSummary: '知乎权威问答缺口',
  recommendedRecipe: 'AUTHORITY_GUIDE',
  targetFormat: 'CN_DEEP_REVIEW',
  suggestedTitle: '星辰存储 DXP4800 静音实测报告',
  outlineJson: undefined,
  outlineH2: [{ heading: '实测数据', intent: '提供对比表格' }],
  targetFanOuts: ['18.5dB'],
  competitorFocus: ['群晖'],
  matchedFactIds: ['fact_1'],
  missingFactHints: [],
  recommendedChannels: [{ channel: '知乎', reason: '国内权重高', priority: 'HIGH' }],
  status: 'OPEN',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
} as GeoBriefRecord;

const SAMPLE_FACT: BrandFactRecord = {
  id: 'fact_1',
  brandId: DUAL_BRAND.id,
  slot: 'PRODUCT_SPECS',
  title: '核心产品与参数',
  content: '- 满载噪音：18.5dB',
  sourceType: 'MANUAL',
  sourceUrl: null,
  indexStatus: 'NONE',
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
};

const SAMPLE_ACCOUNT: ConsoleContextValue['account'] = {
  id: 'u-pub-1',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-pub-1',
    name: '演示租户',
    expiresAt: '2027-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

function makeConsoleContext(overrides?: Partial<ConsoleContextValue>): ConsoleContextValue {
  return {
    account: SAMPLE_ACCOUNT,
    readOnly: false,
    wallet: {
      points: 200,
      pointsReserved: 0,
      available: 200,
      money: '0.00',
      billingMode: 'SHADOW',
      billingModeSource: 'global',
      tenantBillingMode: null,
    },
    walletLoading: false,
    openCreateBrandModal: vi.fn(),
    openEnableMarketModal: vi.fn(),
    refreshWallet: vi.fn(async () => undefined),
    navigateWorkspace: vi.fn(),
    ...overrides,
  };
}

describe('PublishWorkspace (/publish)', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
    mockConfirm.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockNotifyWarning.mockReset();
    window.history.replaceState(null, '', '/publish');

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [DRAFT_ARTICLE, PUBLISHED_ALERT_ARTICLE],
      total: 2,
    });
    vi.spyOn(studioApi, 'fetchPublishRecords').mockImplementation(async (articleId) => {
      if (articleId === PUBLISHED_ALERT_ARTICLE.id) {
        return {
          items: [
            {
              id: 'pub_blocked_1',
              brandId: DUAL_BRAND.id,
              brandMarketId: 'bm_cn_1',
              articleId: PUBLISHED_ALERT_ARTICLE.id,
              channel: '官网博客',
              publishedUrl: 'https://star.example.com/blocked-guide',
              publishedAt: '2026-11-22T08:00:00.000Z',
              baselineRunId: null,
              latestRetestRunId: null,
              beforeMetrics: null,
              afterMetrics: null,
              crawlStatus: 'BLOCKED',
              crawlCheckedAt: '2026-11-22T09:00:00.000Z',
              crawlReportJson: {
                checkedUrl: 'https://star.example.com/blocked-guide',
                httpStatus: 200,
                robotsTxtFound: true,
                robotsMatrix: [{ bot: 'GPTBot', allowed: false, matchedRule: 'Disallow: /' }],
                metaNoindex: false,
                jsonLdTypes: [],
                jsonLdParseErrors: [],
                canonicalUrl: 'https://star.example.com/blocked-guide',
                canonicalMatches: true,
                issues: ['robots.txt 拦截了 GPTBot'],
              },
              indexNowSubmitted: false,
              retestSchedules: [],
            },
          ],
        };
      }
      return { items: [] };
    });
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValue({
      brandId: DUAL_BRAND.id,
      truthAgreementSignedAt: null,
      totalChars: 20,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [SAMPLE_FACT],
    });
    vi.spyOn(briefsApi, 'getBrief').mockResolvedValue(SAMPLE_BRIEF);
    vi.spyOn(distributionApi, 'runArticlePreflight').mockResolvedValue({
      ok: true,
      blockers: [],
      warnings: [],
    });
    vi.spyOn(distributionApi, 'listArticleDistributions').mockResolvedValue({ items: [] });
    vi.spyOn(distributionApi, 'listDistributionVariantJobs').mockResolvedValue({ items: [] });
    vi.spyOn(distributionApi, 'listChannelConnections').mockResolvedValue({
      items: [] as ChannelConnectionDto[],
    });
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockImplementation(
      async (_brandId, market) => ({
        collector: 'remote_scraper',
        market: market ?? 'CN',
        checkedAt: '2026-11-22T00:00:00.000Z',
        refreshIntervalMs: 300_000,
        engines:
          market === 'GLOBAL'
            ? [
                {
                  key: 'chatgpt',
                  label: 'ChatGPT',
                  market: 'GLOBAL',
                  domestic: false,
                  available: true,
                  status: 'online',
                  defaultChecked: true,
                  unavailableReason: null,
                },
              ]
            : [
                {
                  key: 'deepseek',
                  label: 'DeepSeek',
                  market: 'CN',
                  domestic: true,
                  available: true,
                  status: 'online',
                  defaultChecked: true,
                  unavailableReason: null,
                },
              ],
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('auto-selects first article, shows crawl alert filter badge, switches tabs cleanly, and navigates back to /studio with fix locator', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(distributionApi, 'runArticlePreflight').mockResolvedValueOnce({
      ok: false,
      blockers: [
        {
          code: 'MISSING_FACT_SLOTS',
          severity: 'blocker',
          message: '检测到 1 处未补全的待补充事实占位符',
          details: ['[待补充：满载功耗 W]'],
        },
      ],
      warnings: [],
    });

    const navigateWorkspace = vi.fn();
    render(
      <ConsoleProvider value={makeConsoleContext({ navigateWorkspace })}>
        <PublishWorkspace />
      </ConsoleProvider>,
    );

    // Auto-selects first draft article and defaults to inline 多渠道分发
    expect(await screen.findByTestId('publish-article-header')).toBeTruthy();
    expect(screen.getByTestId('publish-filter-crawl-count').textContent).toBe('1');
    expect(await screen.findByTestId('publish-distribution-workbench')).toBeTruthy();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    expect(await screen.findByTestId('distribution-preflight-blockers')).toBeTruthy();

    // Return to editor -> passes fixCode query param to /studio
    fireEvent.click(screen.getByTestId('distribution-back-to-editor-btn'));
    expect(navigateWorkspace).toHaveBeenCalledWith(
      `/studio?articleId=${DRAFT_ARTICLE.id}&fixCode=MISSING_FACT_SLOTS`,
    );

    // Switch to 发布追踪与复测 tab and verify StudioPublishRetest mounts inline
    fireEvent.click(screen.getByTestId('publish-tab-tracking'));
    expect(await screen.findByTestId('studio-publish-retest')).toBeTruthy();

    // Switch to 手动交付包 tab and verify StudioDeliveryPack mounts inline
    fireEvent.click(screen.getByTestId('publish-tab-delivery'));
    expect(await screen.findByTestId('delivery-copy-jsonld')).toBeTruthy();

    // Header "返回写作台编辑" navigates to /studio?articleId=...
    fireEvent.click(screen.getByTestId('publish-back-to-studio-btn'));
    expect(navigateWorkspace).toHaveBeenCalledWith(`/studio?articleId=${DRAFT_ARTICLE.id}`);
  });

  it('auto-activates 发布追踪与复测 when selecting published/alert article and triggers queue publishFilter queries', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const fetchArticlesSpy = vi.mocked(studioApi.fetchArticles);
    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <PublishWorkspace />
      </ConsoleProvider>,
    );

    await screen.findByTestId(`publish-article-item-${PUBLISHED_ALERT_ARTICLE.id}`);
    fireEvent.click(screen.getByTestId(`publish-article-item-${PUBLISHED_ALERT_ARTICLE.id}`));

    await waitFor(() => {
      expect(screen.getByTestId('publish-tracking-crawl-alert-dot')).toBeTruthy();
      expect(screen.getByTestId('publish-crawl-badges-pub_blocked_1').textContent).toContain(
        '抓取受阻',
      );
    });

    fireEvent.click(screen.getByTestId('publish-filter-CRAWL_ALERT'));
    await waitFor(() => {
      expect(fetchArticlesSpy).toHaveBeenLastCalledWith(
        DUAL_BRAND.id,
        'CN',
        expect.objectContaining({ publishFilter: 'CRAWL_ALERT' }),
        expect.anything(),
      );
    });
  });

  it('supports GLOBAL Delivery Pack, Publish URL registration, CrawlProbe, 3x sampling, and Retest polling termination cleanly', async () => {
    window.history.replaceState(
      null,
      '',
      `/publish?brandId=${DUAL_BRAND.id}&market=GLOBAL&articleId=${GLOBAL_ARTICLE.id}&tab=delivery`,
    );
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [GLOBAL_ARTICLE],
      total: 1,
    });
    const fetchPubSpy = vi.spyOn(studioApi, 'fetchPublishRecords').mockResolvedValue({ items: [] });

    const createdPubRecord: GeoPublishRecordDto = {
      id: 'pub_gl_new_1',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_gl_1',
      articleId: GLOBAL_ARTICLE.id,
      publishedUrl: 'https://astravault.example.com/guides/nas-2026',
      channel: 'Official Blog / Docs',
      publishedAt: '2026-11-23T08:00:00.000Z',
      baselineRunId: 'run_base_1',
      latestRetestRunId: null,
      beforeMetrics: { mentionRate: 0, avgPosition: null, sentiment: null, citationHit: false },
      afterMetrics: null,
      crawlStatus: 'PENDING',
      crawlCheckedAt: null,
      crawlReportJson: null,
      indexNowSubmitted: false,
      retestSchedules: [
        {
          id: 'sched_t7',
          publishRecordId: 'pub_gl_new_1',
          milestoneDay: 7,
          sampleCount: 1,
          dueAt: '2026-11-30T08:00:00.000Z',
          status: 'PENDING',
          visibilityRunId: null,
          metricsSnapshot: null,
          skipReason: null,
          executedAt: null,
          createdAt: '2026-11-23T08:00:00.000Z',
          updatedAt: '2026-11-23T08:00:00.000Z',
        },
      ],
    };
    const createPubSpy = vi
      .spyOn(studioApi, 'createPublishRecord')
      .mockResolvedValueOnce(createdPubRecord);
    const probeSpy = vi.spyOn(distributionApi, 'triggerCrawlProbe').mockResolvedValueOnce({
      ...createdPubRecord,
      crawlStatus: 'OK',
      crawlCheckedAt: '2026-11-23T09:00:00.000Z',
      crawlReportJson: {
        checkedUrl: createdPubRecord.publishedUrl,
        httpStatus: 200,
        robotsTxtFound: true,
        robotsMatrix: [{ bot: 'GPTBot', allowed: true }],
        metaNoindex: false,
        jsonLdTypes: ['Article'],
        jsonLdParseErrors: [],
        canonicalUrl: createdPubRecord.publishedUrl,
        canonicalMatches: true,
        issues: [],
      },
    });
    const exportSpy = vi.spyOn(studioApi, 'exportArticleFile').mockResolvedValueOnce({
      blob: new Blob(['docx']),
      filename: 'astravault.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const downloadSpy = vi.spyOn(uxFoundation, 'triggerBlobDownload').mockReturnValue(true);
    const retestSpy = vi.spyOn(studioApi, 'triggerPublishRetest').mockResolvedValueOnce({
      id: 'run_retest_gl_1',
      triggerType: 'RETEST',
      status: 'QUEUED',
    } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <PublishWorkspace />
      </ConsoleProvider>,
    );

    // 1. Hydrates directly to GLOBAL 手动交付包 tab
    expect(await screen.findByTestId('delivery-copy-jsonld')).toBeTruthy();
    expect(screen.getByTestId('delivery-copy-llmstxt')).toBeTruthy();
    expect(screen.getByTestId('delivery-crawler-checklist').textContent).toContain('GPTBot');

    fireEvent.click(screen.getByTestId('delivery-download-docx'));
    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledWith(GLOBAL_ARTICLE.id, 'docx', expect.anything());
      expect(downloadSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'astravault.docx' }),
      );
    });

    // 2. Switch to tracking tab, register publish URL, run CrawlProbe, and trigger retest modal
    fireEvent.click(screen.getByTestId('publish-tab-tracking'));
    const urlInput = await screen.findByLabelText('已发布文章 URL');
    fireEvent.change(urlInput, {
      target: { value: 'https://astravault.example.com/guides/nas-2026' },
    });
    fireEvent.submit(screen.getByTestId('publish-record-form'));

    await waitFor(() => {
      expect(createPubSpy).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(await screen.findByTestId('publish-crawl-recheck-btn-pub_gl_new_1'));
    await waitFor(() => {
      expect(probeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('publish-crawl-badges-pub_gl_new_1').textContent).toContain(
        '可抓取',
      );
    });

    fireEvent.click(screen.getByTestId('publish-retest-btn'));
    const confirmBtn = (await screen.findByTestId(
      'publish-retest-confirm-btn',
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirmBtn.disabled).toBe(false);
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(retestSpy).toHaveBeenCalledWith(
        'pub_gl_new_1',
        { engines: ['chatgpt'] },
        undefined,
        expect.anything(),
      );
    });

    // External publish-records freshness invalidation reloads records
    const callsBeforeExternal = fetchPubSpy.mock.calls.length;
    act(() => {
      invalidateFreshness('publish-records');
    });
    await waitFor(() => {
      expect(fetchPubSpy.mock.calls.length).toBeGreaterThan(callsBeforeExternal);
    });
  });

  it('auto-switches bare /publish?articleId=... and recovers cleanly on invalid/missing articleId', async () => {
    window.history.replaceState(null, '', `/publish?articleId=${GLOBAL_ARTICLE.id}`);
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
      hydrated: true,
    });
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(studioApi, 'getArticle').mockResolvedValueOnce(GLOBAL_ARTICLE);

    const { unmount } = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <PublishWorkspace />
      </ConsoleProvider>,
    );

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');
    });
    unmount();

    window.history.replaceState(
      null,
      '',
      `/publish?brandId=${DUAL_BRAND.id}&market=CN&articleId=art_missing_pub_1`,
    );
    useWorkspaceStore.setState({
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });
    vi.spyOn(studioApi, 'getArticle').mockRejectedValueOnce(new Error('404 not found'));

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <PublishWorkspace />
      </ConsoleProvider>,
    );

    await waitFor(() => {
      expect(mockNotifyWarning).toHaveBeenCalledWith(
        '未找到链接指定的文章（可能已删除或无权访问），已清除失效参数',
      );
      expect(window.location.search).not.toContain('art_missing_pub_1');
    });
  });
});
