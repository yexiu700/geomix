// @vitest-environment jsdom
import {
  API_ERROR,
  type BrandFactRecord,
  type BrandMediaAssetRecord,
  type BrandRecord,
  type GeoArticleRecord,
  type GeoBatchJobRecord,
  type GeoBriefRecord,
  type GeoPublishRecordDto,
  type PromptPreferenceRecord,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandsApi from '../../lib/brands';
import * as briefsApi from '../../lib/briefs';
import * as distributionApi from '../../lib/distribution';
import { GatewayApiError } from '../../lib/envelope';
import * as studioApi from '../../lib/studio';
import { invalidateFreshness } from '../../lib/tab-freshness';
import * as uxFoundation from '../../lib/ux-foundation';
import * as visibilityApi from '../../lib/visibility';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider, type ConsoleContextValue } from '../shell/console-context';
import { StudioDeliveryPack } from './studio-delivery-pack';
import { StudioPublishRetest } from './studio-publish-retest';
import { StudioWorkspace } from './studio-workspace';

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
  id: 'brand_studio_1',
  name: '星辰存储',
  category: '家用NAS',
  truthAgreementSignedAt: null,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  markets: [
    {
      id: 'bm_cn_1',
      brandId: 'brand_studio_1',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '星辰存储',
      aliases: ['DXP4800'],
      ownedDomains: ['star.example.com'],
      competitors: [{ name: '群晖', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['家用静音四盘位NAS推荐'],
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    {
      id: 'bm_gl_1',
      brandId: 'brand_studio_1',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AstraVault',
      aliases: ['DXP4800'],
      ownedDomains: ['astravault.example.com'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['Best quiet 4-bay NAS 2026'],
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
  ],
};

const BRIEF_1: GeoBriefRecord = {
  id: 'brief_st_1',
  brandId: 'brand_studio_1',
  brandMarketId: 'bm_cn_1',
  market: 'CN',
  sourceType: 'AUTO_GAP',
  sourceRunId: null,
  sourceObservationIds: [],
  sourceCitationUrl: null,
  targetPrompt: '四盘位静音家用 NAS 推荐',
  priorityScore: 95,
  diagnosisSummary: '竞品命中 2 个引擎，本品牌未提及',
  recommendedRecipe: 'COMPARISON_MATRIX',
  targetFormat: 'CN_DEEP_REVIEW',
  suggestedTitle: '2026 四盘位静音家用 NAS 横向实测',
  outlineH2: [{ heading: '核心噪音与功耗实测', intent: '对比数据' }],
  targetFanOuts: ['18.5dB', '待机功耗'],
  competitorFocus: ['群晖'],
  matchedFactIds: ['fact_1'],
  missingFactHints: [],
  recommendedChannels: [],
  status: 'OPEN',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

const BRIEF_2: GeoBriefRecord = {
  ...BRIEF_1,
  id: 'brief_st_2',
  targetPrompt: '客厅静音 NAS 功耗对比',
  suggestedTitle: '客厅静音 NAS 待机功耗横评',
  priorityScore: 88,
};

const SAMPLE_ARTICLE: GeoArticleRecord = {
  id: 'art_st_1',
  brandId: 'brand_studio_1',
  brandMarketId: 'bm_cn_1',
  market: 'CN',
  briefId: 'brief_st_1',
  batchJobId: null,
  recipe: 'AUTHORITY_GUIDE',
  targetFormat: 'CN_DEEP_REVIEW',
  title: '星辰存储 DXP4800 静音实测报告',
  targetPrompt: '四盘位静音家用 NAS 推荐',
  outlineJson: [],
  contentMarkdown:
    '星辰存储 DXP4800 实测满载噪音 18.5dB。\n\n## 核心参数\n\n待机功耗实测为 [待补充：如待机功耗 W]。',
  contentHtml: '<p>星辰存储 DXP4800 实测满载噪音 18.5dB。</p>',
  schemaJsonLd: { '@context': 'https://schema.org', '@graph': [] },
  llmsTxtSnippet: null,
  geoScore: 82,
  geoScoreDetail: {
    dimensions: {
      directAnswer: {
        key: 'directAnswer',
        label: '首段直答',
        score: 18,
        maxScore: 20,
        passed: true,
        hints: [],
      },
      structuredExtractable: {
        key: 'structuredExtractable',
        label: '结构化可抽取',
        score: 16,
        maxScore: 20,
        passed: true,
        hints: [],
      },
      factDensity: {
        key: 'factDensity',
        label: '事实与量化密度',
        score: 20,
        maxScore: 25,
        passed: true,
        hints: [],
      },
      fanOutCoverage: {
        key: 'fanOutCoverage',
        label: 'Fan-Out 覆盖率',
        score: 18,
        maxScore: 20,
        passed: true,
        hints: [],
      },
      deAiCompliance: {
        key: 'deAiCompliance',
        label: '去 AI 味与合规',
        score: 10,
        maxScore: 15,
        passed: false,
        hints: [],
      },
    },
    coveredFanOuts: [],
    missingFanOuts: [],
  },
  tags: ['NAS'],
  status: 'DRAFT',
  model: 'fake-quality',
  tokensIn: 120,
  tokensOut: 360,
  complianceFlags: [],
  createdAt: '2026-11-20T01:00:00.000Z',
  updatedAt: '2026-11-20T01:00:00.000Z',
};

const SAMPLE_FACT: BrandFactRecord = {
  id: 'fact_1',
  brandId: 'brand_studio_1',
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
  id: 'u-st-1',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-st-1',
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

describe('StudioWorkspace 3-Pane UI (M4-A #331)', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
    mockConfirm.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockNotifyWarning.mockReset();
    window.history.replaceState(null, '', '/studio');

    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({
      items: [BRIEF_1, BRIEF_2],
      total: 2,
    });
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [SAMPLE_ARTICLE],
      total: 1,
    });
    vi.spyOn(studioApi, 'fetchBatchJobs').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(studioApi, 'fetchPublishRecords').mockResolvedValue({ items: [] });
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
                {
                  key: 'perplexity',
                  label: 'Perplexity',
                  market: 'GLOBAL',
                  domestic: false,
                  available: false,
                  status: 'offline',
                  defaultChecked: false,
                  unavailableReason: '暂未上线',
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
                {
                  key: 'doubao',
                  label: '豆包',
                  market: 'CN',
                  domestic: true,
                  available: false,
                  status: 'offline',
                  defaultChecked: false,
                  unavailableReason: '暂未上线',
                },
              ],
      }),
    );
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValue({
      brandId: 'brand_studio_1',
      truthAgreementSignedAt: null,
      totalChars: 20,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [SAMPLE_FACT],
    });
    vi.spyOn(studioApi, 'getPromptPreferences').mockResolvedValue({
      customToneNote: '保持客观技术评测口吻',
      customForbiddenWords: ['神级方案', '颠覆行业'],
      recipeOverrides: null,
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    vi.spyOn(brandsApi, 'listBrandMedia').mockResolvedValue({
      items: [
        {
          id: 'media_photo_1',
          brandId: 'brand_studio_1',
          origin: 'PRODUCT_UPLOAD',
          title: 'DXP4800 静音风道实拍图',
          objectKey: 'tenants/t1/brand-media-media_photo_1.jpg',
          thumbKey: 'tenants/t1/brand-media-media_photo_1-thumb.jpg',
          url: '/api/v2/brands/brand_studio_1/media/media_photo_1/file?tid=t1&exp=9999999999&sig=abc',
          thumbUrl:
            '/api/v2/brands/brand_studio_1/media/media_photo_1/thumb?tid=t1&exp=9999999999&sig=def',
          mime: 'image/jpeg',
          bytes: 42_000,
          width: 1200,
          height: 800,
          aiPrompt: null,
          aiModel: null,
          usedCount: 0,
          createdAt: '2026-11-20T00:00:00.000Z',
        },
      ],
      storage: {
        used: '42000',
        limit: '104857600',
        usedText: '41 KB',
        limitText: '100 MB',
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders cold-load Skeleton without 0 点 / 免费体验期 / ¥0.00 flash and renders 0-brand empty state', () => {
    useWorkspaceStore.setState({ brandsLoading: true, brandsLoaded: false, brands: [] });
    const { rerender } = render(
      <ConsoleProvider value={makeConsoleContext({ walletLoading: true, wallet: null })}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );
    const loading = screen.getByTestId('studio-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(document.body.textContent).not.toContain('0 点');
    expect(document.body.textContent).not.toContain('免费体验期');
    expect(document.body.textContent).not.toContain('¥0.00');

    const openCreateBrandModal = vi.fn();
    useWorkspaceStore.setState({ brandsLoading: false, brandsLoaded: true, brands: [] });
    rerender(
      <ConsoleProvider value={makeConsoleContext({ openCreateBrandModal })}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );
    expect(screen.getByText('尚未创建品牌资产')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即创建首个品牌' }));
    expect(openCreateBrandModal).toHaveBeenCalledTimes(1);
  });

  it('isolates market-linked targetFormat chips, keeps advanced prefs collapsed by default, and displays historical articles without legacy columns', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // CN formats visible; GLOBAL formats absent from DOM
    expect(await screen.findByTestId('studio-format-CN_DEEP_REVIEW')).toBeTruthy();
    expect(screen.getByTestId('studio-format-CN_COMMUNITY_QA')).toBeTruthy();
    expect(screen.queryByTestId('studio-format-GLOBAL_AUTHORITY_GUIDE')).toBeNull();
    expect(screen.queryByTestId('studio-format-GLOBAL_COMMUNITY_DISCUSSION')).toBeNull();

    // Historical article title visible immediately, zero legacy columns
    expect(await screen.findByText('星辰存储 DXP4800 静音实测报告')).toBeTruthy();
    expect(document.body.textContent).not.toContain('发送次数');
    expect(document.body.textContent).not.toContain('转视频次数');
    expect(document.body.textContent).not.toContain('1000字上限');

    // Advanced prefs collapsed by default -> customToneNote not rendered until expanded
    expect(document.body.textContent).not.toContain('保持客观技术评测口吻');
    fireEvent.click(screen.getByTestId('studio-advanced-prefs'));
    expect(await screen.findByTestId('studio-advanced-prefs-panel')).toBeTruthy();
    expect(document.body.textContent).toContain('保持客观技术评测口吻');
    expect(document.body.textContent).toContain('神级方案');

    // Switch to GLOBAL -> only GLOBAL formats in DOM
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL');
    });
    expect(await screen.findByTestId('studio-format-GLOBAL_AUTHORITY_GUIDE')).toBeTruthy();
    expect(screen.getByTestId('studio-format-GLOBAL_COMMUNITY_DISCUSSION')).toBeTruthy();
    expect(screen.queryByTestId('studio-format-CN_DEEP_REVIEW')).toBeNull();
  });

  it('streams SSE article via studio-stream-btn, displays geo-score-value, and supports missing-fact writeback (checked & unchecked)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const refreshWallet = vi.fn(async () => undefined);
    const streamSpy = vi
      .spyOn(studioApi, 'streamGenerateArticle')
      .mockImplementation(async (_brandId, _input, handlers) => {
        handlers.onMeta?.({
          reservationId: 'res_1',
          unitPrice: 10,
          billingMode: 'SHADOW',
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          matchedFactIds: ['fact_1'],
        });
        handlers.onDelta?.({ text: '星辰存储实测静音 18.5dB。' });
        handlers.onComplete?.({
          article: SAMPLE_ARTICLE,
          geoScore: 82,
          geoScoreDetail: SAMPLE_ARTICLE.geoScoreDetail,
          schemaJsonLd: SAMPLE_ARTICLE.schemaJsonLd,
          llmsTxtSnippet: null,
        });
        return { aborted: false, receivedEvents: 3 };
      });

    const updateSpy = vi.spyOn(studioApi, 'updateArticle').mockResolvedValue({
      ...SAMPLE_ARTICLE,
      contentMarkdown:
        '星辰存储 DXP4800 实测满载噪音 18.5dB。\n\n## 核心参数\n\n待机功耗实测为 12.5W。',
      geoScore: 91,
    });
    const saveFactsSpy = vi.spyOn(brandsApi, 'saveBrandFacts').mockResolvedValue({
      brandId: 'brand_studio_1',
      truthAgreementSignedAt: '2026-11-20T02:00:00.000Z',
      totalChars: 40,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [
        {
          ...SAMPLE_FACT,
          content: '- 满载噪音：18.5dB\n- 待机功耗 W：12.5W',
          sourceType: 'STUDIO_FEEDBACK',
        },
      ],
    });

    render(
      <ConsoleProvider value={makeConsoleContext({ refreshWallet })}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    const promptBox = await screen.findByLabelText('目标问题');
    fireEvent.change(promptBox, { target: { value: '四盘位静音家用 NAS 推荐' } });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    await waitFor(() => {
      expect(streamSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('geo-score-value').textContent).toBe('82');
    });
    expect(refreshWallet).toHaveBeenCalled();

    // Missing-fact pill visible -> click, fill value, keep sync checked, confirm -> saves BOTH article & BrandFact
    const pill = await screen.findByTestId('missing-fact-pill');
    fireEvent.click(pill);
    const input = await screen.findByPlaceholderText('输入真实实测数值或参数');
    fireEvent.change(input, { target: { value: '12.5W' } });
    fireEvent.click(screen.getByRole('button', { name: '确认填入' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'art_st_1',
        expect.objectContaining({
          contentMarkdown: expect.stringContaining('12.5W'),
        }),
      );
      expect(saveFactsSpy).toHaveBeenCalledWith(
        'brand_studio_1',
        expect.objectContaining({
          truthAgreed: true,
          facts: [
            expect.objectContaining({
              slot: 'PRODUCT_SPECS',
              sourceType: 'STUDIO_FEEDBACK',
              content: expect.stringContaining('12.5W'),
            }),
          ],
        }),
      );
    });
  });

  it('supports inline rewrite, left-queue 2-20 batch launch, and delete via useUxFeedback confirm', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const batchJob: GeoBatchJobRecord = {
      id: 'gb_ui_1',
      brandId: 'brand_studio_1',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      briefIds: ['brief_st_1', 'brief_st_2'],
      total: 2,
      doneCount: 0,
      failCount: 0,
      unitPrice: 10,
      reservationId: 'res_b1',
      status: 'QUEUED',
      lastError: null,
      createdAt: '2026-11-20T02:00:00.000Z',
      updatedAt: '2026-11-20T02:00:00.000Z',
      finishedAt: null,
    };
    const createBatchSpy = vi.spyOn(studioApi, 'createBatchJob').mockResolvedValue(batchJob);
    const rewriteSpy = vi.spyOn(studioApi, 'rewriteArticleSection').mockResolvedValue({
      rewrittenText: '| 维度 | 数值 |\n| --- | --- |\n| 噪音 | 18.5dB |',
      action: 'TO_TABLE',
      complianceFlags: [],
      model: 'fake-quality',
      tokensIn: 20,
      tokensOut: 40,
    });
    const deleteSpy = vi
      .spyOn(studioApi, 'deleteArticle')
      .mockResolvedValue({ deleted: true, id: 'art_st_1' });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Pending brief checkboxes are the first checkboxes in default DOM
    await screen.findByTestId('studio-brief-item-brief_st_1');
    const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);

    const batchBtn = screen.getByTestId('studio-batch-btn');
    expect((batchBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(batchBtn);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const batchOnOk = mockConfirm.mock.calls[0]?.[0]?.onOk as (() => Promise<void>) | undefined;
    await act(async () => {
      await batchOnOk?.();
    });
    await waitFor(() => {
      expect(createBatchSpy).toHaveBeenCalledWith(
        'brand_studio_1',
        { market: 'CN', briefIds: ['brief_st_1', 'brief_st_2'] },
        expect.any(String),
      );
    });

    // Select article -> inline rewrite TO_TABLE -> delete via feedback.confirm
    fireEvent.click(screen.getByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(await screen.findByTestId('studio-rewrite-TO_TABLE'));
    await waitFor(() => {
      expect(rewriteSpy).toHaveBeenCalledWith(
        'art_st_1',
        expect.objectContaining({ action: 'TO_TABLE' }),
      );
    });
    expect(await screen.findByTestId('studio-rewrite-preview')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('删除文章-星辰存储 DXP4800 静音实测报告'));
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    const onOk = mockConfirm.mock.calls[1]?.[0]?.onOk as (() => Promise<void>) | undefined;
    await act(async () => {
      await onOk?.();
    });
    expect(deleteSpy).toHaveBeenCalledWith('art_st_1');
  });

  it('disables mutating controls in readOnly expired tenant mode', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    render(
      <ConsoleProvider value={makeConsoleContext({ readOnly: true })}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    const streamBtn = (await screen.findByTestId('studio-stream-btn')) as HTMLButtonElement;
    expect(streamBtn.disabled).toBe(true);
    const batchBtn = (await screen.findByTestId('studio-batch-btn')) as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(true);
  });

  it('skips BrandFact writeback when checkbox is unchecked and displays SSE error refund alert', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const updateSpy = vi.spyOn(studioApi, 'updateArticle').mockResolvedValue({
      ...SAMPLE_ARTICLE,
      contentMarkdown:
        '星辰存储 DXP4800 实测满载噪音 18.5dB。\n\n## 核心参数\n\n待机功耗实测为 11W。',
      geoScore: 89,
    });
    const saveFactsSpy = vi.spyOn(brandsApi, 'saveBrandFacts');
    vi.spyOn(studioApi, 'streamGenerateArticle').mockImplementationOnce(
      async (_brandId, _input, handlers) => {
        handlers.onErrorEvent?.({
          code: 50201,
          msg: '上游模型服务暂不可用',
          refunded: true,
        });
        return { aborted: false, receivedEvents: 1 };
      },
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Trigger SSE error event
    const promptBox = await screen.findByLabelText('目标问题');
    fireEvent.change(promptBox, { target: { value: '[E2E_LLM_FAIL] 测试报错退点' } });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));
    expect(await screen.findByTestId('studio-stream-error')).toBeTruthy();
    expect(screen.getByTestId('studio-stream-error').textContent).toContain('退还');

    // Select article -> open missing-fact pill -> UNCHECK sync -> confirm -> updateArticle ONLY
    fireEvent.click(screen.getByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(await screen.findByTestId('missing-fact-pill'));
    const input = await screen.findByPlaceholderText('输入真实实测数值或参数');
    fireEvent.change(input, { target: { value: '11W' } });
    const syncCheckbox = screen.getByRole('checkbox', { name: '同步存入品牌事实卡' });
    fireEvent.click(syncCheckbox);
    fireEvent.click(screen.getByRole('button', { name: '确认填入' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'art_st_1',
        expect.objectContaining({ contentMarkdown: expect.stringContaining('11W') }),
      );
    });
    expect(saveFactsSpy).not.toHaveBeenCalled();
  });

  it('preserves active article, draftTitle, and active SSE stream when filtering historical articles without refetching briefs/facts/prefs', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const briefsSpy = vi.spyOn(briefsApi, 'fetchBriefs');
    const factsSpy = vi.spyOn(brandsApi, 'getBrandFacts');
    const prefsSpy = vi.spyOn(studioApi, 'getPromptPreferences');
    const articlesSpy = vi.spyOn(studioApi, 'fetchArticles');

    let capturedStreamSignal: AbortSignal | undefined;
    let resolveStream!: (val: { aborted: boolean; receivedEvents: number }) => void;
    vi.spyOn(studioApi, 'streamGenerateArticle').mockImplementationOnce(
      async (_brandId, _input, handlers, opts) => {
        capturedStreamSignal = opts?.signal;
        handlers.onDelta?.({ text: '流式生成中的正文...' });
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Wait for initial load & select historical article
    const articleTitleEl = await screen.findByText('星辰存储 DXP4800 静音实测报告');
    fireEvent.click(articleTitleEl);
    const titleInput = (await screen.findByLabelText('文章标题')) as HTMLInputElement;
    expect(titleInput.value).toBe('星辰存储 DXP4800 静音实测报告');

    // Start an active SSE stream so we can verify filtering does NOT abort it
    const promptBox = screen.getByLabelText('目标问题');
    fireEvent.change(promptBox, { target: { value: '四盘位静音 NAS 深度评测' } });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));
    await waitFor(() => {
      expect(capturedStreamSignal).toBeDefined();
    });

    const briefsCallsBefore = briefsSpy.mock.calls.length;
    const factsCallsBefore = factsSpy.mock.calls.length;
    const prefsCallsBefore = prefsSpy.mock.calls.length;
    const articlesCallsBefore = articlesSpy.mock.calls.length;

    // Filter by tag & status
    fireEvent.change(screen.getByLabelText('按标签筛选历史成稿'), { target: { value: 'NAS' } });
    fireEvent.change(screen.getByLabelText('按状态筛选历史成稿'), { target: { value: 'READY' } });

    await waitFor(() => {
      expect(articlesSpy.mock.calls.length).toBeGreaterThan(articlesCallsBefore);
    });

    // Must NOT abort stream, must NOT wipe active article / draftTitle, must NOT re-fetch briefs/facts/prefs
    expect(capturedStreamSignal?.aborted).toBe(false);
    expect(titleInput.value).toBe('星辰存储 DXP4800 静音实测报告');
    expect(briefsSpy.mock.calls.length).toBe(briefsCallsBefore);
    expect(factsSpy.mock.calls.length).toBe(factsCallsBefore);
    expect(prefsSpy.mock.calls.length).toBe(prefsCallsBefore);

    await act(async () => {
      resolveStream({ aborted: false, receivedEvents: 1 });
    });
  });

  it('renders loaded customToneNote and customForbiddenWords when studio-advanced-prefs is opened before getPromptPreferences() resolves', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    let resolvePrefs!: (value: PromptPreferenceRecord) => void;
    vi.spyOn(studioApi, 'getPromptPreferences').mockImplementationOnce(
      () =>
        new Promise<PromptPreferenceRecord>((resolve) => {
          resolvePrefs = resolve;
        }),
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Click advanced prefs immediately while getPromptPreferences() is still in flight
    fireEvent.click(await screen.findByTestId('studio-advanced-prefs'));
    const toneTextarea = (await screen.findByLabelText('自定义风格指令')) as HTMLTextAreaElement;
    expect(toneTextarea.value).toBe('');

    // Now resolve getPromptPreferences()
    await act(async () => {
      resolvePrefs({
        customToneNote: '工程实验室客观口吻-async',
        customForbiddenWords: ['神级方案', '绝对领先'],
        recipeOverrides: null,
        updatedAt: '2026-11-21T05:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(toneTextarea.value).toBe('工程实验室客观口吻-async');
    });
    expect(await screen.findByText('神级方案')).toBeTruthy();
    expect(await screen.findByText('绝对领先')).toBeTruthy();
  });

  it('executes saveBrandFacts strictly BEFORE updateArticle during missing-fact writeback (T3-07 ordering)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const callOrder: string[] = [];
    vi.spyOn(brandsApi, 'saveBrandFacts').mockImplementationOnce(async () => {
      callOrder.push('saveBrandFacts');
      return {
        brandId: 'brand_studio_1',
        items: [
          {
            id: 'fact_spec_1',
            brandId: 'brand_studio_1',
            slot: 'PRODUCT_SPECS',
            title: '核心产品与参数',
            content: 'Intel N100，满载噪音 18.5dB\n- 如待机功耗 W：12.5W',
            sourceType: 'STUDIO_FEEDBACK',
            sourceUrl: null,
            indexStatus: 'NONE',
            createdAt: '2026-11-21T05:00:00.000Z',
            updatedAt: '2026-11-21T05:05:00.000Z',
          },
        ],
        totalChars: 42,
        vectorIndexRequired: false,
        vectorIndexed: false,
        truthAgreementSignedAt: '2026-11-21T00:00:00.000Z',
      };
    });
    vi.spyOn(studioApi, 'updateArticle').mockImplementationOnce(async () => {
      callOrder.push('updateArticle');
      return {
        ...SAMPLE_ARTICLE,
        contentMarkdown:
          '星辰存储 DXP4800 实测满载噪音 18.5dB。\n\n## 核心参数\n\n待机功耗实测为 12.5W。',
        geoScore: 92,
      };
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(await screen.findByTestId('missing-fact-pill'));
    const input = await screen.findByPlaceholderText('输入真实实测数值或参数');
    fireEvent.change(input, { target: { value: '12.5W' } });
    fireEvent.click(screen.getByRole('button', { name: '确认填入' }));

    await waitFor(() => {
      expect(callOrder).toEqual(['saveBrandFacts', 'updateArticle']);
    });
  });

  it('supports Left Pane Competitor URL Counter modal with automatic 422/42201 pasted-content fallback (M4-B #332)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const counterBrief: GeoBriefRecord = {
      ...BRIEF_1,
      id: 'brief_counter_1',
      sourceType: 'CITATION_COUNTER',
      recommendedRecipe: 'CITATION_COUNTER',
      sourceCitationUrl: 'http://public.e2e.example/anti-scrape/403',
      targetPrompt: '四盘位静音 NAS 噪音功耗实测反制',
      suggestedTitle: '2026 四盘位家用 NAS 实测超越稿：星辰存储 DXP4800',
      outlineH2: [
        { heading: '硬件规格与双 2.5GbE 实测升级', intent: '超越竞品参数' },
        { heading: '18.5dB 满载噪音与功耗横向对比表', intent: '提供对比表格' },
      ],
    };

    let createdCounter = false;
    vi.spyOn(briefsApi, 'fetchBriefs').mockImplementation(async () => ({
      items: createdCounter ? [counterBrief, BRIEF_1, BRIEF_2] : [BRIEF_1, BRIEF_2],
      total: createdCounter ? 3 : 2,
    }));

    const counterSpy = vi
      .spyOn(briefsApi, 'createBriefFromCitationUrl')
      .mockRejectedValueOnce(
        new GatewayApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '目标网页受反爬限制无法直接抓取，请改用「粘贴参考正文」继续反制',
        ),
      )
      .mockImplementationOnce(async () => {
        createdCounter = true;
        return counterBrief;
      });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByTestId('studio-counter-url-btn'));
    const urlInput = await screen.findByTestId('counter-url-input');
    fireEvent.change(urlInput, { target: { value: 'http://public.e2e.example/anti-scrape/403' } });
    fireEvent.click(screen.getByTestId('counter-submit-btn'));

    // 422/42201 automatically reveals 粘贴参考正文 fallback block
    const fallbackBox = await screen.findByTestId('counter-pasted-fallback');
    expect(fallbackBox.textContent).toContain('粘贴参考正文');

    const pasteArea = screen.getByTestId('counter-pasted-content');
    fireEvent.change(pasteArea, {
      target: {
        value:
          '## 硬件参数对比\n主流竞品噪音 32dB、待机功耗 24W，缺少双 2.5GbE 网口与离线相册。\n## 选购结论\n建议关注低噪音与低功耗四盘位机型。',
      },
    });
    fireEvent.click(screen.getByTestId('counter-submit-btn'));

    await waitFor(() => {
      expect(counterSpy).toHaveBeenCalledTimes(2);
      expect(counterSpy).toHaveBeenLastCalledWith(
        'brand_studio_1',
        expect.objectContaining({
          market: 'CN',
          citationUrl: 'http://public.e2e.example/anti-scrape/403',
          pastedContent: expect.stringContaining('硬件参数对比'),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect((screen.getByLabelText('目标问题') as HTMLTextAreaElement).value).toBe(
        '四盘位静音 NAS 噪音功耗实测反制',
      );
    });
    expect(screen.getByTestId('studio-brief-item-brief_counter_1')).toBeTruthy();
  });

  it('supports Inline Media Popover Tab 1 free product photo insert and Tab 2 5-pt AI image gen & error handling (M4-B #332)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const refreshWallet = vi.fn(async () => undefined);
    const updateSpy = vi
      .spyOn(studioApi, 'updateArticle')
      .mockImplementation(async (_id, patch) => ({
        ...SAMPLE_ARTICLE,
        contentMarkdown: patch.contentMarkdown ?? SAMPLE_ARTICLE.contentMarkdown,
      }));

    const aiAsset: BrandMediaAssetRecord = {
      id: 'media_ai_1',
      brandId: 'brand_studio_1',
      origin: 'AI_INLINE_GEN',
      title: '四盘位 NAS 风道散热示意图',
      objectKey: 'tenants/t1/brand-media-media_ai_1.jpg',
      thumbKey: 'tenants/t1/brand-media-media_ai_1-thumb.jpg',
      url: '/api/v2/brands/brand_studio_1/media/media_ai_1/file?tid=t1&exp=9999999999&sig=ai1',
      thumbUrl:
        '/api/v2/brands/brand_studio_1/media/media_ai_1/thumb?tid=t1&exp=9999999999&sig=ai2',
      mime: 'image/jpeg',
      bytes: 51_200,
      width: 1280,
      height: 720,
      aiPrompt: '极简桌面四盘位家用NAS静音散热风道原理示意图',
      aiModel: 'fake-image',
      usedCount: 0,
      createdAt: '2026-11-20T03:00:00.000Z',
    };
    const aiGenSpy = vi
      .spyOn(brandsApi, 'generateBrandAiImage')
      .mockRejectedValueOnce(new GatewayApiError(402, API_ERROR.INSUFFICIENT_POINTS, '点数不足'))
      .mockResolvedValueOnce(aiAsset);

    render(
      <ConsoleProvider value={makeConsoleContext({ refreshWallet })}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Select an article so Insert Media button is enabled
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    expect(screen.queryByTestId('studio-media-popover')).toBeNull();

    // Tab 1: Free real product photo insert
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    const popover = await screen.findByTestId('studio-media-popover');
    expect(popover.textContent).toContain('从品牌实拍图插入');
    fireEvent.click(await screen.findByTestId('studio-media-item-media_photo_1'));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'art_st_1',
        expect.objectContaining({
          contentMarkdown: expect.stringContaining(
            '![DXP4800 静音风道实拍图](/api/v2/brands/brand_studio_1/media/media_photo_1/file?tid=t1&exp=9999999999&sig=abc)',
          ),
          usedMediaIds: ['media_photo_1'],
        }),
      );
    });
    // Preview rewrites relative /api/v2/... img src to full API origin
    const previewImg = screen.getByTestId('studio-preview-body').querySelector('img');
    expect(previewImg?.getAttribute('src')).toMatch(
      /^https?:\/\/.*\/api\/v2\/brands\/brand_studio_1\/media\/media_photo_1\/file/,
    );

    // Tab 2: 5-pt AI image gen error (402) keeps popover open & refreshes wallet, then retry succeeds
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    await screen.findByTestId('studio-media-popover');
    fireEvent.click(screen.getByRole('tab', { name: /AI 一键生成配图/ }));

    const promptInput = await screen.findByTestId('studio-ai-image-prompt');
    fireEvent.change(promptInput, {
      target: { value: '极简桌面四盘位家用NAS静音散热风道原理示意图' },
    });
    fireEvent.click(screen.getByTestId('studio-ai-image-gen-btn'));

    expect(await screen.findByTestId('studio-ai-image-error')).toBeTruthy();
    expect(refreshWallet).toHaveBeenCalled();
    expect(screen.getByTestId('studio-media-popover')).toBeTruthy();

    // Retry succeeds -> inserts AI image and persists usedMediaIds: ['media_ai_1']
    fireEvent.click(screen.getByTestId('studio-ai-image-gen-btn'));
    await waitFor(() => {
      expect(aiGenSpy).toHaveBeenCalledTimes(2);
      expect(aiGenSpy).toHaveBeenLastCalledWith(
        'brand_studio_1',
        expect.objectContaining({
          prompt: '极简桌面四盘位家用NAS静音散热风道原理示意图',
          ratio: '16:9',
        }),
        expect.stringMatching(/^geo_img_/),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(updateSpy).toHaveBeenLastCalledWith(
        'art_st_1',
        expect.objectContaining({
          contentMarkdown: expect.stringContaining(
            '/api/v2/brands/brand_studio_1/media/media_ai_1/file',
          ),
          usedMediaIds: ['media_ai_1'],
        }),
      );
    });
  });

  it('catches backfill errors cleanly in StudioEditorCanvas.handleConfirmSlot without unhandled rejection', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(brandsApi, 'saveBrandFacts').mockRejectedValueOnce(new Error('网络暂时不可用'));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      render(
        <ConsoleProvider value={makeConsoleContext()}>
          <StudioWorkspace />
        </ConsoleProvider>,
      );

      fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
      fireEvent.click(await screen.findByTestId('missing-fact-pill'));
      const input = await screen.findByPlaceholderText('输入真实实测数值或参数');
      fireEvent.change(input, { target: { value: '12.5W' } });
      fireEvent.click(screen.getByRole('button', { name: '确认填入' }));

      await waitFor(() => {
        expect(mockNotifyError).toHaveBeenCalledWith('网络暂时不可用');
      });
      // Popover remains open for retry and zero unhandled rejections occurred
      expect(screen.getByPlaceholderText('输入真实实测数值或参数')).toBeTruthy();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('closes StudioMediaPopover and aborts in-flight AI image gen on same-brand market switch and when clicking studio-free-topic-btn (M4-B iter2)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    let capturedAiSignal: AbortSignal | undefined;
    vi.spyOn(brandsApi, 'generateBrandAiImage').mockImplementation(
      async (_brandId, _input, _idemKey, opts) => {
        capturedAiSignal = opts?.signal;
        return new Promise<BrandMediaAssetRecord>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // 1. Open popover on an active article, click + 自由选题 (!hasArticle) -> popover closes immediately
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    expect(await screen.findByTestId('studio-media-popover')).toBeTruthy();

    fireEvent.click(screen.getByTestId('studio-free-topic-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('studio-media-popover')).toBeNull();
    });

    // 2. Re-select article, start AI image generation, then switch market CN -> GLOBAL on SAME brand
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    await screen.findByTestId('studio-media-popover');
    fireEvent.click(screen.getByRole('tab', { name: /AI 一键生成配图/ }));

    fireEvent.change(await screen.findByTestId('studio-ai-image-prompt'), {
      target: { value: '四盘位 NAS 散热风道结构示意图' },
    });
    fireEvent.click(screen.getByTestId('studio-ai-image-gen-btn'));

    await waitFor(() => {
      expect(capturedAiSignal).toBeDefined();
      expect(capturedAiSignal?.aborted).toBe(false);
    });

    act(() => {
      useWorkspaceStore.setState({ activeMarket: 'GLOBAL', contextEpoch: 2 });
    });

    await waitFor(() => {
      expect(capturedAiSignal?.aborted).toBe(true);
      expect(screen.queryByTestId('studio-media-popover')).toBeNull();
    });
  });

  it('prevents same-tick rapid double-click duplicate mutations in StudioMediaPopover Tab 1/Tab 2 and CitationCounterModal (M4-B iter2)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    let resolveUpdate!: (val: GeoArticleRecord) => void;
    const updateSpy = vi.spyOn(studioApi, 'updateArticle').mockImplementation(
      () =>
        new Promise<GeoArticleRecord>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    let resolveAiGen!: (val: BrandMediaAssetRecord) => void;
    const aiGenSpy = vi.spyOn(brandsApi, 'generateBrandAiImage').mockImplementation(
      () =>
        new Promise<BrandMediaAssetRecord>((resolve) => {
          resolveAiGen = resolve;
        }),
    );

    let resolveCounter!: (val: GeoBriefRecord) => void;
    const counterSpy = vi.spyOn(briefsApi, 'createBriefFromCitationUrl').mockImplementation(
      () =>
        new Promise<GeoBriefRecord>((resolve) => {
          resolveCounter = resolve;
        }),
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Select article & open popover
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    const photoItem = await screen.findByTestId('studio-media-item-media_photo_1');

    // 1. Same-tick rapid double-click on Tab 1 photo item -> strictly 1 updateArticle call
    act(() => {
      photoItem.click();
      photoItem.click();
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpdate({
        ...SAMPLE_ARTICLE,
        contentMarkdown: `${SAMPLE_ARTICLE.contentMarkdown}\n\n![DXP4800 静音风道实拍图](/api/v2/brands/brand_studio_1/media/media_photo_1/file?tid=t1&exp=9999999999&sig=abc)`,
      });
    });

    // 2. Same-tick rapid double-click on Tab 2 AI Generate -> strictly 1 generateBrandAiImage call
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    await screen.findByTestId('studio-media-popover');
    fireEvent.click(screen.getByRole('tab', { name: /AI 一键生成配图/ }));
    fireEvent.change(await screen.findByTestId('studio-ai-image-prompt'), {
      target: { value: '极简四盘位家用NAS内部风道示意' },
    });
    const genBtn = screen.getByTestId('studio-ai-image-gen-btn');
    act(() => {
      genBtn.click();
      genBtn.click();
    });
    expect(aiGenSpy).toHaveBeenCalledTimes(1);

    // Finish AI gen cleanly
    updateSpy.mockResolvedValueOnce(SAMPLE_ARTICLE);
    await act(async () => {
      resolveAiGen({
        id: 'media_ai_guard_1',
        brandId: 'brand_studio_1',
        origin: 'AI_INLINE_GEN',
        title: 'AI 风道示意',
        objectKey: 'tenants/t1/brand-media-media_ai_guard_1.jpg',
        thumbKey: 'tenants/t1/brand-media-media_ai_guard_1-thumb.jpg',
        url: '/api/v2/brands/brand_studio_1/media/media_ai_guard_1/file?tid=t1&exp=9999999999&sig=ai',
        thumbUrl:
          '/api/v2/brands/brand_studio_1/media/media_ai_guard_1/thumb?tid=t1&exp=9999999999&sig=ait',
        mime: 'image/jpeg',
        bytes: 30_000,
        width: 1280,
        height: 720,
        aiPrompt: '极简四盘位家用NAS内部风道示意',
        aiModel: 'fake-image',
        usedCount: 0,
        createdAt: '2026-11-20T03:00:00.000Z',
      });
    });

    // 3. Same-tick rapid double-click on CitationCounterModal submit -> strictly 1 createBriefFromCitationUrl call
    fireEvent.click(screen.getByTestId('studio-counter-url-btn'));
    fireEvent.change(await screen.findByTestId('counter-url-input'), {
      target: { value: 'https://competitor.example/nas-review' },
    });
    const submitBtn = screen.getByTestId('counter-submit-btn');
    act(() => {
      submitBtn.click();
      submitBtn.click();
    });
    expect(counterSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCounter({
        ...BRIEF_1,
        id: 'brief_counter_guard_1',
        sourceType: 'CITATION_COUNTER',
        recommendedRecipe: 'CITATION_COUNTER',
        sourceCitationUrl: 'https://competitor.example/nas-review',
      });
    });
  });

  it('supports M5 Right Pane Evaluator Fan-Out 一键补写小节 (0 pts) & CN vs GLOBAL Delivery Pack (.docx via triggerBlobDownload)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const articleWithMissingFanOut: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      geoScore: 76,
      geoScoreDetail: {
        dimensions: {
          directAnswer: {
            key: 'directAnswer',
            label: '首段直答',
            score: 18,
            maxScore: 20,
            passed: true,
            hints: [],
          },
          structuredExtractable: {
            key: 'structuredExtractable',
            label: '结构化可抽取',
            score: 16,
            maxScore: 20,
            passed: true,
            hints: [],
          },
          factDensity: {
            key: 'factDensity',
            label: '事实与量化密度',
            score: 20,
            maxScore: 25,
            passed: true,
            hints: [],
          },
          fanOutCoverage: {
            key: 'fanOutCoverage',
            label: 'Fan-Out 覆盖率',
            score: 10,
            maxScore: 20,
            passed: false,
            hints: ['尚有 1 个目标拆解词未覆盖'],
          },
          deAiCompliance: {
            key: 'deAiCompliance',
            label: '去 AI 味与合规',
            score: 12,
            maxScore: 15,
            passed: true,
            hints: [],
          },
        },
        coveredFanOuts: ['18.5dB'],
        missingFanOuts: ['待机功耗'],
      },
    };
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [articleWithMissingFanOut],
      total: 1,
    });
    const rewriteSpy = vi.spyOn(studioApi, 'rewriteArticleSection').mockResolvedValueOnce({
      action: 'ADD_EVIDENCE',
      rewrittenText: '实测星辰存储 DXP4800 待机功耗仅 14W，24 小时持续运行省电。',
      model: 'fake-quality',
      tokensIn: 30,
      tokensOut: 50,
      complianceFlags: [],
    });
    const updateSpy = vi.spyOn(studioApi, 'updateArticle').mockResolvedValueOnce({
      ...articleWithMissingFanOut,
      contentMarkdown: `${articleWithMissingFanOut.contentMarkdown}\n\n## 待机功耗 实测解析\n\n实测待机功耗 14W`,
    });
    const evalSpy = vi.spyOn(studioApi, 'evaluateArticleGeo').mockResolvedValueOnce({
      geoScore: 91,
      geoScoreDetail: {
        dimensions: {
          directAnswer: {
            key: 'directAnswer',
            label: '首段直答',
            score: 20,
            maxScore: 20,
            passed: true,
            hints: [],
          },
          structuredExtractable: {
            key: 'structuredExtractable',
            label: '结构化可抽取',
            score: 18,
            maxScore: 20,
            passed: true,
            hints: [],
          },
          factDensity: {
            key: 'factDensity',
            label: '事实与量化密度',
            score: 21,
            maxScore: 25,
            passed: true,
            hints: [],
          },
          fanOutCoverage: {
            key: 'fanOutCoverage',
            label: 'Fan-Out 覆盖率',
            score: 20,
            maxScore: 20,
            passed: true,
            hints: [],
          },
          deAiCompliance: {
            key: 'deAiCompliance',
            label: '去 AI 味与合规',
            score: 12,
            maxScore: 15,
            passed: true,
            hints: [],
          },
        },
        coveredFanOuts: ['18.5dB', '待机功耗'],
        missingFanOuts: [],
      },
      uncoveredFanOuts: [],
      schemaJsonLd: { '@context': 'https://schema.org', '@graph': [{ '@type': 'Article' }] },
      llmsTxtSnippet: null,
      crawlerChecklist: [{ bot: 'Bytespider', purpose: '豆包检索', recommended: true }],
      recommendedChannels: [{ channel: '知乎', reason: '国内权重高' }],
    });
    const exportSpy = vi.spyOn(studioApi, 'exportArticleFile').mockResolvedValueOnce({
      blob: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]),
      filename: 'dxp4800.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const downloadSpy = vi.spyOn(uxFoundation, 'triggerBlobDownload').mockReturnValue(true);

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));

    // CN track: delivery-copy-jsonld is ALWAYS visible, code preview collapsed by default, no llms.txt, no literal "0 点"
    expect(await screen.findByTestId('delivery-copy-jsonld')).toBeTruthy();
    expect(screen.queryByTestId('delivery-jsonld-preview')).toBeNull();
    expect(screen.queryByTestId('delivery-copy-llmstxt')).toBeNull();
    expect(screen.getByTestId('delivery-channel-guidance').textContent).toContain('知乎');
    expect(document.body.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);

    // Click 一键补写小节 -> rewrite -> update -> evaluate -> lifts score 76 -> 91
    fireEvent.click(await screen.findByTestId('fanout-supplement-btn'));
    await waitFor(() => {
      expect(rewriteSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(evalSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('geo-score-value').textContent).toBe('91');
    });

    // Download .docx strictly via triggerBlobDownload with AbortSignal
    fireEvent.click(screen.getByTestId('delivery-download-docx'));
    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledWith(
        'art_st_1',
        'docx',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(downloadSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'dxp4800.docx' }),
      );
    });
  });

  it('supports GLOBAL Delivery Pack (expanded JSON-LD, llms.txt, GPTBot/PerplexityBot) and Publish URL + Retest Before/After loop (M5 #333)', async () => {
    const globalArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_gl_1',
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      title: 'Best 4-Bay Quiet NAS 2026 Guide',
      targetPrompt: 'Best quiet 4-bay NAS 2026',
      contentMarkdown: 'AstraVault DXP4800 is a Top pick with 100% aluminum chassis.',
      schemaJsonLd: {
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'Article', headline: 'Best 4-Bay Quiet NAS 2026 Guide' }],
      },
      llmsTxtSnippet:
        '# AstraVault\n\n## Featured GEO Guides\n- [Guide](https://astravault.example.com/guides/nas): 18.5dB',
      geoScore: 90,
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [globalArticle],
      total: 1,
    });
    const createdPubRecord = {
      id: 'pub_gl_1',
      brandId: 'brand_studio_1',
      brandMarketId: 'bm_gl_1',
      articleId: 'art_gl_1',
      publishedUrl: 'https://astravault.example.com/guides/nas-2026',
      channel: 'Official Blog / Docs',
      publishedAt: '2026-11-21T00:00:00.000Z',
      baselineRunId: 'run_base_1',
      latestRetestRunId: null,
      beforeMetrics: { mentionRate: 0, avgPosition: null, sentiment: null, citationHit: false },
      afterMetrics: null,
    };
    const createPubSpy = vi
      .spyOn(studioApi, 'createPublishRecord')
      .mockResolvedValueOnce(createdPubRecord);
    const retestSpy = vi.spyOn(studioApi, 'triggerPublishRetest').mockResolvedValueOnce({
      id: 'run_retest_gl_1',
      brandId: 'brand_studio_1',
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      triggerType: 'RETEST',
      retestArticleId: 'art_gl_1',
      status: 'QUEUED',
    } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);

    const refreshWallet = vi.fn().mockResolvedValue(undefined);
    render(
      <ConsoleProvider value={makeConsoleContext({ refreshWallet })}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByText('Best 4-Bay Quiet NAS 2026 Guide'));

    // GLOBAL track: expanded JSON-LD preview, llms.txt button, GPTBot & PerplexityBot checklist
    expect(await screen.findByTestId('delivery-copy-jsonld')).toBeTruthy();
    expect(screen.getByTestId('delivery-jsonld-preview')).toBeTruthy();
    expect(screen.getByTestId('delivery-copy-llmstxt')).toBeTruthy();
    const checklistText = screen.getByTestId('delivery-crawler-checklist').textContent ?? '';
    expect(checklistText).toContain('GPTBot');
    expect(checklistText).toContain('PerplexityBot');

    // Register publish URL: rejects javascript: inline, then accepts valid https://
    const form = screen.getByTestId('publish-record-form');
    const urlInput = screen.getByLabelText('已发布文章 URL');
    fireEvent.change(urlInput, { target: { value: 'javascript:alert(1)' } });
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(createPubSpy).not.toHaveBeenCalled();

    fireEvent.change(urlInput, {
      target: { value: 'https://astravault.example.com/guides/nas-2026' },
    });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(createPubSpy).toHaveBeenCalledWith(
        'art_gl_1',
        {
          publishedUrl: 'https://astravault.example.com/guides/nas-2026',
          channel: 'Official Blog / Docs',
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    // Before/After panel visible + open retest engine confirmation modal (#337)
    expect(await screen.findByTestId('publish-before-after')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('publish-retest-btn'));
    expect(await screen.findByTestId('publish-retest-modal')).toBeTruthy();
    const confirmRetestBtn = (await screen.findByTestId(
      'publish-retest-confirm-btn',
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirmRetestBtn.disabled).toBe(false);
    });
    fireEvent.click(confirmRetestBtn);
    await waitFor(() => {
      expect(retestSpy).toHaveBeenCalledWith(
        'pub_gl_1',
        { engines: ['chatgpt'] },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(refreshWallet).toHaveBeenCalled();
    });
  });

  it('guards same-tick double-click on evaluate, docx export, publish submit, and billable retest (D-1) and preserves URL on error (D-5)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const existingRecord = {
      id: 'pub_d1_1',
      brandId: 'brand_studio_1',
      brandMarketId: 'bm_cn_1',
      articleId: 'art_st_1',
      publishedUrl: 'https://star.example.com/guides/nas',
      channel: '官网博客',
      publishedAt: '2026-11-21T00:00:00.000Z',
      baselineRunId: null,
      latestRetestRunId: null,
      beforeMetrics: null,
      afterMetrics: null,
    };
    vi.spyOn(studioApi, 'fetchPublishRecords').mockResolvedValue({ items: [existingRecord] });

    let resolveEval!: (v: Awaited<ReturnType<typeof studioApi.evaluateArticleGeo>>) => void;
    const evalSpy = vi.spyOn(studioApi, 'evaluateArticleGeo').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEval = resolve;
        }),
    );

    let resolveExport!: (v: Awaited<ReturnType<typeof studioApi.exportArticleFile>>) => void;
    const exportSpy = vi.spyOn(studioApi, 'exportArticleFile').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
    );
    vi.spyOn(uxFoundation, 'triggerBlobDownload').mockReturnValue(true);

    let resolveRetest!: (v: Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>) => void;
    const retestSpy = vi.spyOn(studioApi, 'triggerPublishRetest').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetest = resolve;
        }),
    );

    let rejectCreatePub!: (err: Error) => void;
    const createPubSpy = vi.spyOn(studioApi, 'createPublishRecord').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreatePub = reject;
        }),
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    const evalBtn = await screen.findByTestId('geo-evaluate-refresh-btn');
    const docxBtn = screen.getByTestId('delivery-download-docx');
    const retestBtn = await screen.findByTestId('publish-retest-btn');

    // Open retest confirmation modal first and wait for online engines to load
    fireEvent.click(retestBtn);
    const confirmRetestBtn = (await screen.findByTestId(
      'publish-retest-confirm-btn',
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirmRetestBtn.disabled).toBe(false);
    });

    // Same-tick double-clicks must each fire strictly 1 request
    act(() => {
      evalBtn.click();
      evalBtn.click();
      docxBtn.click();
      docxBtn.click();
      confirmRetestBtn.click();
      confirmRetestBtn.click();
    });
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(retestSpy).toHaveBeenCalledTimes(1);

    // Same-tick double-submit on publish form fires strictly 1 request & preserves URL on API error (D-5)
    const urlInput = screen.getByLabelText('已发布文章 URL') as HTMLInputElement;
    const form = screen.getByTestId('publish-record-form');
    fireEvent.change(urlInput, { target: { value: 'https://star.example.com/keep-on-error' } });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(createPubSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectCreatePub(new GatewayApiError(500, API_ERROR.UPSTREAM_UNAVAILABLE, '登记服务繁忙'));
      resolveEval({
        geoScore: 86,
        geoScoreDetail: SAMPLE_ARTICLE.geoScoreDetail as unknown as Awaited<
          ReturnType<typeof studioApi.evaluateArticleGeo>
        >['geoScoreDetail'],
        uncoveredFanOuts: [],
        schemaJsonLd: SAMPLE_ARTICLE.schemaJsonLd,
        llmsTxtSnippet: null,
        crawlerChecklist: [],
        recommendedChannels: [],
      });
      resolveExport({
        blob: new Blob(['ok']),
        filename: 'ok.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      resolveRetest({
        id: 'run_d1_1',
        triggerType: 'RETEST',
        status: 'QUEUED',
      } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);
    });

    expect(urlInput.value).toBe('https://star.example.com/keep-on-error');
    expect(mockNotifyError).toHaveBeenCalledWith('登记服务繁忙');

    // Direct StudioPublishRetest test: rejecting onCreatePublishRecord preserves URL with zero unhandled rejection
    cleanup();
    const rejectingProp = vi.fn().mockRejectedValueOnce(new Error('网络超时'));
    render(
      <StudioPublishRetest
        activeMarket="CN"
        article={SAMPLE_ARTICLE}
        publishRecords={[]}
        recordsLoading={false}
        retestingRecordId={null}
        pollingRetestRecordId={null}
        readOnly={false}
        onCreatePublishRecord={rejectingProp}
        onTriggerRetest={vi.fn()}
      />,
    );
    const directInput = screen.getByLabelText('已发布文章 URL') as HTMLInputElement;
    fireEvent.change(directInput, { target: { value: 'https://star.example.com/direct-keep' } });
    fireEvent.submit(screen.getByTestId('publish-record-form'));
    await waitFor(() => {
      expect(rejectingProp).toHaveBeenCalledTimes(1);
    });
    expect(directInput.value).toBe('https://star.example.com/direct-keep');
  });

  it('aborts evaluate/export on CN->GLOBAL switch and prevents Article A -> Article B stale score clobber (D-2) + avoids duplicate H1 copy', async () => {
    const articleA: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_race_a',
      title: '文章 A 静音实测',
      contentMarkdown: '# 文章 A 静音实测\n\n正文内容',
      geoScore: 81,
    };
    const articleB: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_race_b',
      title: '文章 B 功耗实测',
      geoScore: 76,
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [articleA, articleB],
      total: 2,
    });
    const copySpy = vi.spyOn(studioApi, 'copyTextToClipboard').mockResolvedValue(true);
    const downloadSpy = vi.spyOn(uxFoundation, 'triggerBlobDownload').mockReturnValue(true);

    let evalSignalA: AbortSignal | undefined;
    let resolveEvalA!: (v: Awaited<ReturnType<typeof studioApi.evaluateArticleGeo>>) => void;
    vi.spyOn(studioApi, 'evaluateArticleGeo').mockImplementation((_id, opts) => {
      evalSignalA = opts?.signal;
      return new Promise((resolve) => {
        resolveEvalA = resolve;
      });
    });

    let exportSignal: AbortSignal | undefined;
    let resolveExport!: (v: Awaited<ReturnType<typeof studioApi.exportArticleFile>>) => void;
    vi.spyOn(studioApi, 'exportArticleFile').mockImplementation((_id, _fmt, opts) => {
      exportSignal = opts?.signal;
      return new Promise((resolve) => {
        resolveExport = resolve;
      });
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Select Article A -> verify copy Markdown does NOT prepend duplicate # H1
    fireEvent.click(await screen.findByText('文章 A 静音实测'));
    fireEvent.click(await screen.findByTestId('delivery-copy-md'));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith('# 文章 A 静音实测\n\n正文内容\n');
    });

    // Trigger evaluate on Article A, then switch to Article B before it resolves
    fireEvent.click(screen.getByTestId('geo-evaluate-refresh-btn'));
    expect(evalSignalA).toBeDefined();
    expect(evalSignalA?.aborted).toBe(false);

    fireEvent.click(screen.getByText('文章 B 功耗实测'));
    expect(evalSignalA?.aborted).toBe(true);
    expect(screen.getByTestId('geo-score-value').textContent).toBe('76');

    // Resolve stale Article A evaluation with score 99 -> MUST NOT clobber Article B (76)!
    await act(async () => {
      resolveEvalA({
        geoScore: 99,
        geoScoreDetail: SAMPLE_ARTICLE.geoScoreDetail as unknown as Awaited<
          ReturnType<typeof studioApi.evaluateArticleGeo>
        >['geoScoreDetail'],
        uncoveredFanOuts: [],
        schemaJsonLd: SAMPLE_ARTICLE.schemaJsonLd,
        llmsTxtSnippet: null,
        crawlerChecklist: [],
        recommendedChannels: [],
      });
    });
    expect(screen.getByTestId('geo-score-value').textContent).toBe('76');

    // Trigger .docx export on Article B, then switch CN -> GLOBAL -> must abort & NOT download!
    fireEvent.click(screen.getByTestId('delivery-download-docx'));
    expect(exportSignal).toBeDefined();
    expect(exportSignal?.aborted).toBe(false);

    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL');
    });
    expect(exportSignal?.aborted).toBe(true);

    await act(async () => {
      resolveExport({
        blob: new Blob(['stale']),
        filename: 'stale.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    });
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('terminates retest polling cleanly with warning when run reaches COMPLETED with afterMetrics === null (D-3)', async () => {
    vi.useFakeTimers();
    try {
      useWorkspaceStore.setState({
        brandsLoading: false,
        brandsLoaded: true,
        brands: [DUAL_BRAND],
        activeBrandId: DUAL_BRAND.id,
        activeMarket: 'CN',
      });

      const pubRecord = {
        id: 'pub_poll_1',
        brandId: 'brand_studio_1',
        brandMarketId: 'bm_cn_1',
        articleId: 'art_st_1',
        publishedUrl: 'https://star.example.com/guides/poll',
        channel: '官网博客',
        publishedAt: '2026-11-21T00:00:00.000Z',
        baselineRunId: null,
        latestRetestRunId: 'run_term_1',
        beforeMetrics: null,
        afterMetrics: null,
      };
      vi.spyOn(studioApi, 'fetchPublishRecords').mockResolvedValue({ items: [pubRecord] });
      vi.spyOn(studioApi, 'triggerPublishRetest').mockResolvedValueOnce({
        id: 'run_term_1',
        triggerType: 'RETEST',
        status: 'QUEUED',
      } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);
      const runDetailSpy = vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue({
        id: 'run_term_1',
        status: 'COMPLETED',
        doneCount: 0,
      } as unknown as Awaited<ReturnType<typeof visibilityApi.fetchVisibilityRunDetail>>);

      render(
        <ConsoleProvider value={makeConsoleContext()}>
          <StudioWorkspace />
        </ConsoleProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByText('星辰存储 DXP4800 静音实测报告'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByTestId('publish-retest-btn'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByTestId('publish-retest-confirm-btn'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Advance across 4 poll intervals (10s) -> must stop after the first terminal check!
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(2_600);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      expect(runDetailSpy).toHaveBeenCalledTimes(1);
      expect(mockNotifyWarning).toHaveBeenCalledWith('复测已结束，本次无引擎返回有效观测结果');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes clipboard Markdown and HTML copies via @geomix/shared even when article.contentHtml is empty', async () => {
    const copySpy = vi.spyOn(studioApi, 'copyTextToClipboard').mockResolvedValue(true);
    const unsafeArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_copy_parity',
      title: '<script>alert(9)</script> Clean Title',
      contentMarkdown: 'Safe body <script>alert(1)</script> [evil](javascript:alert(2))',
      contentHtml: '',
    };

    render(
      <StudioDeliveryPack
        activeMarket="CN"
        localBrandName="星辰存储"
        article={unsafeArticle}
        evaluation={null}
        streaming={false}
      />,
    );

    fireEvent.click(screen.getByTestId('delivery-copy-md'));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledTimes(1);
    });
    const copiedMd = copySpy.mock.calls[0]?.[0] ?? '';
    expect(copiedMd).toContain('# Clean Title');
    expect(copiedMd).toContain('Safe body');
    expect(copiedMd).toContain('evil');
    expect(copiedMd).not.toMatch(/<script/i);
    expect(copiedMd).not.toContain('alert(1)');
    expect(copiedMd).not.toContain('alert(2)');
    expect(copiedMd).not.toContain('alert(9)');
    expect(copiedMd).not.toContain('javascript:');

    fireEvent.click(screen.getByTestId('delivery-copy-html'));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledTimes(2);
    });
    const copiedHtml = copySpy.mock.calls[1]?.[0] ?? '';
    expect(copiedHtml).toContain('<p>');
    expect(copiedHtml).toContain('Safe body');
    expect(copiedHtml).not.toMatch(/<script/i);
    expect(copiedHtml).not.toContain('alert(1)');
    expect(copiedHtml).not.toContain('alert(2)');
    expect(copiedHtml).not.toContain('javascript:');
  });

  it('hydrates ?articleId= on cold load (brandsLoading: true -> false) with strictly 1 fetch and enables editor controls', async () => {
    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=CN&articleId=${SAMPLE_ARTICLE.id}`,
    );
    useWorkspaceStore.setState({
      brandsLoading: true,
      brandsLoaded: false,
      brands: [],
      activeBrandId: null,
      activeMarket: 'CN',
    });

    const fetchArticlesSpy = vi.mocked(studioApi.fetchArticles);
    fetchArticlesSpy.mockClear();

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    expect(screen.getByTestId('studio-loading')).toBeTruthy();
    expect(fetchArticlesSpy).not.toHaveBeenCalled();

    act(() => {
      useWorkspaceStore.setState({
        brandsLoading: false,
        brandsLoaded: true,
        brands: [DUAL_BRAND],
        activeBrandId: DUAL_BRAND.id,
        activeMarket: 'CN',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('missing-fact-pill')).toBeTruthy();
    });

    expect(fetchArticlesSpy).toHaveBeenCalledTimes(1);
    const insertBtn = screen.getByTestId('studio-insert-media-btn') as HTMLButtonElement;
    expect(insertBtn.disabled).toBe(false);
    expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe(
      SAMPLE_ARTICLE.title,
    );
  });

  it('preserves ?briefId= URL hydration if invalidateFreshness fires mid-flight during initial cold load', async () => {
    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=CN&briefId=${BRIEF_1.id}`,
    );
    useWorkspaceStore.setState({
      brandsLoading: true,
      brandsLoaded: false,
      brands: [],
      activeBrandId: null,
      activeMarket: 'CN',
    });

    let resolveFirstBriefs!: (value: { items: GeoBriefRecord[]; total: number }) => void;
    const firstBriefsPromise = new Promise<{ items: GeoBriefRecord[]; total: number }>(
      (resolve) => {
        resolveFirstBriefs = resolve;
      },
    );
    const fetchBriefsSpy = vi.spyOn(briefsApi, 'fetchBriefs');
    fetchBriefsSpy
      .mockReturnValueOnce(firstBriefsPromise)
      .mockResolvedValueOnce({ items: [BRIEF_1, BRIEF_2], total: 2 });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    act(() => {
      useWorkspaceStore.setState({
        brandsLoading: false,
        brandsLoaded: true,
        brands: [DUAL_BRAND],
        activeBrandId: DUAL_BRAND.id,
        activeMarket: 'CN',
      });
    });

    await waitFor(() => {
      expect(fetchBriefsSpy).toHaveBeenCalledTimes(1);
    });

    // External freshness invalidation arrives while initial load is still in flight
    act(() => {
      invalidateFreshness('brand-facts');
    });

    await waitFor(() => {
      expect(fetchBriefsSpy).toHaveBeenCalledTimes(2);
    });

    // Resolve aborted first request late (should be ignored) and verify ?briefId= still hydrated
    await act(async () => {
      resolveFirstBriefs({ items: [BRIEF_1, BRIEF_2], total: 2 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect((screen.getByLabelText('目标问题') as HTMLTextAreaElement).value).toBe(
        BRIEF_1.targetPrompt,
      );
    });
  });

  it('clears rewrite preview on article switch, preserves literal $ sequences, and keeps preview open on PATCH failure (W-01)', async () => {
    const articleB: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_st_2',
      title: '第二篇独立对比文章',
      contentMarkdown: '第二篇文章的正文内容，绝不可被第一篇改写污染。',
    };
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [SAMPLE_ARTICLE, articleB],
      total: 2,
    });
    vi.spyOn(studioApi, 'rewriteArticleSection').mockResolvedValue({
      action: 'DE_AD',
      rewrittenText: '实测售价 $$199（支持 $& 模式）',
      complianceFlags: [],
      model: 'fake',
      tokensIn: 10,
      tokensOut: 12,
    });
    const updateSpy = vi
      .spyOn(studioApi, 'updateArticle')
      .mockRejectedValueOnce(new GatewayApiError(500, -1, '保存失败，请重试'))
      .mockImplementationOnce(async (_id, patch) => ({
        ...SAMPLE_ARTICLE,
        title: patch.title ?? SAMPLE_ARTICLE.title,
        contentMarkdown: patch.contentMarkdown ?? SAMPLE_ARTICLE.contentMarkdown,
      }));

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Open Article A and trigger rewrite preview
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(await screen.findByRole('button', { name: '更客观去广告味' }));
    expect(await screen.findByTestId('studio-rewrite-preview')).toBeTruthy();

    // First apply fails -> preview MUST stay open for retry
    fireEvent.click(screen.getByRole('button', { name: '应用替换' }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('studio-rewrite-preview')).toBeTruthy();

    // Second apply succeeds -> literal $$199 and $& MUST NOT be expanded by String.prototype.replace
    fireEvent.click(screen.getByRole('button', { name: '应用替换' }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(2);
    });
    const secondPatch = updateSpy.mock.calls[1]?.[1];
    expect(secondPatch?.contentMarkdown).toContain('实测售价 $$199（支持 $& 模式）');
    expect(screen.queryByTestId('studio-rewrite-preview')).toBeNull();

    // Re-open rewrite preview on Article A, then switch to Article B -> preview clears immediately
    fireEvent.click(screen.getByRole('button', { name: '更客观去广告味' }));
    expect(await screen.findByTestId('studio-rewrite-preview')).toBeTruthy();
    fireEvent.click(screen.getByText('第二篇独立对比文章'));
    await waitFor(() => {
      expect(screen.queryByTestId('studio-rewrite-preview')).toBeNull();
    });
  });

  it('renders SignalError on brandsError (W-04) and strips stale studio URL params on brand switch (W-05)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: '品牌加载失败',
      brands: [],
      activeBrandId: null,
      activeMarket: 'CN',
    });

    const { unmount } = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    expect(screen.getByText('品牌加载失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(screen.queryByText('尚未创建品牌资产')).toBeNull();
    unmount();

    const secondBrand: BrandRecord = {
      ...DUAL_BRAND,
      id: 'brand_studio_2',
      name: '第二品牌',
      markets: [
        {
          ...DUAL_BRAND.markets[0]!,
          id: 'bm_cn_2',
          brandId: 'brand_studio_2',
          localBrandName: '第二品牌',
        },
      ],
    };
    window.history.replaceState(
      window.history.state,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=CN&articleId=art_st_1&briefId=brief_st_1&batchJobId=bj_stale_1`,
    );
    const getBatchJobSpy = vi.spyOn(studioApi, 'getBatchJob').mockResolvedValue({
      id: 'bj_stale_1',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      briefIds: ['brief_st_1', 'brief_st_2'],
      total: 2,
      doneCount: 0,
      failCount: 0,
      unitPrice: 10,
      reservationId: 'res_stale_1',
      status: 'QUEUED',
      lastError: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      finishedAt: null,
    });

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      brands: [DUAL_BRAND, secondBrand],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    await waitFor(() => {
      expect(getBatchJobSpy).toHaveBeenCalledWith(DUAL_BRAND.id, 'bj_stale_1', expect.anything());
    });
    getBatchJobSpy.mockClear();

    act(() => {
      useWorkspaceStore.getState().setActiveBrand(secondBrand.id, 'CN', window.localStorage);
    });

    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get('articleId')).toBeNull();
      expect(sp.get('briefId')).toBeNull();
      expect(sp.get('batchJobId')).toBeNull();
    });
    expect(getBatchJobSpy).not.toHaveBeenCalled();
  });

  it('guards W-03 mutations across article/brand switches, preserves draftTitle on backfill, and keeps media popover open on insert failure', async () => {
    const articleB: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_st_2',
      title: '第二篇独立文章',
      status: 'DRAFT',
      contentMarkdown: '第二篇正文内容。',
    };
    const secondBrand: BrandRecord = {
      ...DUAL_BRAND,
      id: 'brand_studio_2',
      name: '第二品牌',
      markets: [
        {
          ...DUAL_BRAND.markets[0]!,
          id: 'bm_cn_2',
          brandId: 'brand_studio_2',
          localBrandName: '第二品牌',
        },
      ],
    };
    const sampleMedia: BrandMediaAssetRecord = {
      id: 'media_w03_1',
      brandId: DUAL_BRAND.id,
      origin: 'PRODUCT_UPLOAD',
      title: '产品实拍正面图',
      objectKey: 'tenants/t1/brand-media-media_w03_1.jpg',
      thumbKey: 'tenants/t1/brand-media-media_w03_1-thumb.jpg',
      url: `/api/v2/brands/${DUAL_BRAND.id}/media/media_w03_1/file`,
      thumbUrl: `/api/v2/brands/${DUAL_BRAND.id}/media/media_w03_1/thumb`,
      mime: 'image/jpeg',
      bytes: 2048,
      width: 800,
      height: 600,
      aiPrompt: null,
      aiModel: null,
      usedCount: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      brands: [DUAL_BRAND, secondBrand],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockImplementation(async (brandId) =>
      brandId === DUAL_BRAND.id
        ? { items: [SAMPLE_ARTICLE, articleB], total: 2 }
        : { items: [], total: 0 },
    );
    vi.spyOn(briefsApi, 'fetchBriefs').mockImplementation(async (brandId) =>
      brandId === DUAL_BRAND.id ? { items: [BRIEF_1, BRIEF_2], total: 2 } : { items: [], total: 0 },
    );
    vi.spyOn(brandsApi, 'listBrandMedia').mockResolvedValue({
      items: [sampleMedia],
      storage: {
        used: '2048',
        limit: '104857600',
        usedText: '2 KB',
        limitText: '100 MB',
      },
    });

    let resolveStatusPatch!: (art: GeoArticleRecord) => void;
    let resolveBatchCreate!: (job: GeoBatchJobRecord) => void;
    const updateSpy = vi
      .spyOn(studioApi, 'updateArticle')
      // 1st call: deferred handleChangeStatus on Article A
      .mockImplementationOnce(
        () =>
          new Promise<GeoArticleRecord>((resolve) => {
            resolveStatusPatch = resolve;
          }),
      )
      // 2nd call: handleBackfillMissingFact preserving edited draftTitle
      .mockImplementationOnce(async (_id, patch) => ({
        ...SAMPLE_ARTICLE,
        title: patch.title ?? SAMPLE_ARTICLE.title,
        contentMarkdown: patch.contentMarkdown ?? SAMPLE_ARTICLE.contentMarkdown,
      }))
      // 3rd call: handleInsertMedia fails -> popover must stay open
      .mockRejectedValueOnce(new GatewayApiError(500, -1, '插图保存失败'));

    vi.spyOn(studioApi, 'createBatchJob').mockImplementationOnce(
      () =>
        new Promise<GeoBatchJobRecord>((resolve) => {
          resolveBatchCreate = resolve;
        }),
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // 1) handleChangeStatus race across article switch (Article A -> Article B before PATCH resolves)
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    const statusSelect = (await screen.findByLabelText('成稿状态')) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'READY' } });
    fireEvent.click(screen.getByText('第二篇独立文章'));
    await waitFor(() => {
      expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe('第二篇独立文章');
    });
    await act(async () => {
      resolveStatusPatch({ ...SAMPLE_ARTICLE, status: 'READY' });
      await Promise.resolve();
    });
    expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe('第二篇独立文章');
    expect((screen.getByLabelText('成稿状态') as HTMLSelectElement).value).toBe('DRAFT');

    // 2) handleBackfillMissingFact preserves edited draftTitle
    fireEvent.click(screen.getByText('星辰存储 DXP4800 静音实测报告'));
    const titleInput = (await screen.findByLabelText('文章标题')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '手动编辑的新标题' } });
    fireEvent.click(await screen.findByTestId('missing-fact-pill'));
    const slotInput = await screen.findByPlaceholderText('输入真实实测数值或参数');
    fireEvent.change(slotInput, { target: { value: '14W' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '同步存入品牌事实卡' }));
    fireEvent.click(screen.getByRole('button', { name: '确认填入' }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(2);
    });
    expect(updateSpy.mock.calls[1]?.[1]?.title).toBe('手动编辑的新标题');
    expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe('手动编辑的新标题');

    // 3) handleInsertMedia rejection keeps media popover open for retry
    fireEvent.click(screen.getByTestId('studio-insert-media-btn'));
    expect(await screen.findByTestId('studio-media-popover')).toBeTruthy();
    fireEvent.click(await screen.findByText('产品实拍正面图'));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(3);
      expect(mockNotifyError).toHaveBeenCalled();
    });
    expect(screen.getByTestId('studio-media-popover')).toBeTruthy();

    // 4) handleLaunchBatch across brand switch does not pollute Brand B
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '[data-testid^="studio-brief-item-"] input[type="checkbox"]',
    );
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByTestId('studio-batch-btn'));
    const w03BatchOnOk = mockConfirm.mock.calls.at(-1)?.[0]?.onOk as
      (() => Promise<void>) | undefined;
    expect(w03BatchOnOk).toBeTypeOf('function');
    const batchPromise = w03BatchOnOk?.();
    act(() => {
      useWorkspaceStore.getState().setActiveBrand(secondBrand.id, 'CN', window.localStorage);
    });
    await act(async () => {
      resolveBatchCreate({
        id: 'bj_brand_a_stale',
        brandId: DUAL_BRAND.id,
        brandMarketId: 'bm_cn_1',
        market: 'CN',
        briefIds: ['brief_st_1', 'brief_st_2'],
        total: 2,
        doneCount: 0,
        failCount: 0,
        unitPrice: 10,
        reservationId: 'res_bj_stale',
        status: 'QUEUED',
        lastError: null,
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
        finishedAt: null,
      });
      await batchPromise;
      await Promise.resolve();
    });
    expect(new URLSearchParams(window.location.search).get('batchJobId')).toBeNull();
  });

  it('retains streamed partial draft and shows recovery banner on SSE timeout/error (#336)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    const streamedPartial =
      '## 核心结论\n\n星辰存储 DXP4800 在静音测试中实测 18.5dB，待机功耗 14W。';
    vi.spyOn(studioApi, 'streamGenerateArticle').mockImplementationOnce(
      async (_brandId, _input, handlers) => {
        handlers.onDelta?.({ text: streamedPartial });
        handlers.onErrorEvent?.({
          code: 50401,
          msg: '外部服务超时',
          refunded: true,
        });
        return { aborted: false, receivedEvents: 2 };
      },
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    const promptBox = await screen.findByLabelText('目标问题');
    fireEvent.change(promptBox, { target: { value: '四盘位静音家用 NAS 推荐' } });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    // Partial draft recovery banner must be visible and retain the streamed content in the editor
    const banner = await screen.findByTestId('studio-partial-draft-banner');
    expect(banner.textContent).toContain('外部服务超时');
    expect(banner.textContent).toContain('已自动退还');
    expect(screen.getByTestId('studio-copy-partial-draft-btn')).toBeTruthy();
    const previewBody = screen.getByTestId('studio-preview-body');
    expect(previewBody.textContent).toContain('星辰存储 DXP4800');
  });

  it('opens Distribution Drawer from Delivery Pack CTA, returns to editor on missing-fact jump, and auto-closes on market context switch (M6A #354)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(distributionApi, 'runArticlePreflight').mockResolvedValue({
      ok: false,
      blockers: [
        {
          code: 'MISSING_FACT_SLOTS',
          severity: 'blocker',
          message: '检测到 1 处未补全的待补充事实占位符',
          details: ['[待补充：如待机功耗 W]'],
        },
      ],
      warnings: [],
    });
    vi.spyOn(distributionApi, 'listArticleDistributions').mockResolvedValue({ items: [] });
    vi.spyOn(distributionApi, 'listChannelConnections').mockResolvedValue({ items: [] });
    vi.spyOn(briefsApi, 'getBrief').mockResolvedValue(BRIEF_1);

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Select article so CTA becomes enabled
    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    const openBtn = screen.getByTestId('studio-open-distribution-btn') as HTMLButtonElement;
    expect(openBtn.disabled).toBe(false);

    // Open drawer
    fireEvent.click(openBtn);
    expect(await screen.findByTestId('studio-distribution-drawer')).toBeTruthy();
    expect(await screen.findByTestId('distribution-preflight-blockers')).toBeTruthy();

    // Return to editor closes drawer and notifies user
    fireEvent.click(screen.getByTestId('distribution-back-to-editor-btn'));
    await waitFor(() => {
      expect(mockNotifyWarning).toHaveBeenCalledWith('已定位到待补充事实胶囊，点击即可行内补填');
    });

    // Re-open drawer, then switch market CN -> GLOBAL -> drawer auto-closes immediately
    fireEvent.click(screen.getByTestId('studio-open-distribution-btn'));
    expect(await screen.findByTestId('studio-distribution-drawer')).toBeTruthy();
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    });
    await waitFor(() => {
      const openDrawer = document.querySelector('.ant-drawer-open');
      expect(openDrawer).toBeNull();
    });
  });

  it('guards GLOBAL copy/export in StudioDeliveryPack using unified evaluateDistributionPreflight (GLOBAL_CJK_LEAK blocker confirm)', async () => {
    const copySpy = vi.spyOn(studioApi, 'copyTextToClipboard').mockResolvedValue(true);
    const leakedGlobalArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_gl_leak',
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      title: 'Best 4-Bay Quiet NAS 2026',
      contentMarkdown: 'AstraVault DXP4800 runs at 18.5dB with 静音散热设计.',
      contentHtml: '<p>AstraVault DXP4800 runs at 18.5dB with 静音散热设计.</p>',
      geoScore: 86,
      complianceFlags: [],
    };

    render(
      <StudioDeliveryPack
        activeMarket="GLOBAL"
        localBrandName="AstraVault"
        brandNames={['AstraVault']}
        matchedFactCount={1}
        article={leakedGlobalArticle}
        evaluation={null}
        streaming={false}
      />,
    );

    fireEvent.click(screen.getByTestId('delivery-copy-md'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(copySpy).not.toHaveBeenCalled();

    // Confirming override proceeds with copy
    const onOk = mockConfirm.mock.calls[0]?.[0]?.onOk as (() => void) | undefined;
    act(() => {
      onOk?.();
    });
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledTimes(1);
    });
  });

  it('W-02: preserves CrawlProbe and 3x sampling edits across instant retest start and reloads publishRecords on external publish-records freshness invalidation', async () => {
    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=GLOBAL&articleId=${SAMPLE_ARTICLE.id}`,
    );
    const globalArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
    };
    const initialRecord: GeoPublishRecordDto = {
      id: 'pub_w02_1',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_gl_1',
      articleId: globalArticle.id,
      publishedUrl: 'https://blog.example.com/nas-2026-review',
      channel: 'Shopify 博客',
      publishedAt: '2026-11-20T08:00:00.000Z',
      baselineRunId: null,
      latestRetestRunId: null,
      beforeMetrics: null,
      afterMetrics: null,
      distributionTaskId: null,
      crawlStatus: 'PENDING',
      crawlCheckedAt: null,
      crawlReportJson: null,
      indexNowSubmitted: false,
      retestSchedules: [
        {
          id: 'sched_w02_7',
          publishRecordId: 'pub_w02_1',
          milestoneDay: 7,
          sampleCount: 1,
          dueAt: '2026-11-27T08:00:00.000Z',
          status: 'PENDING',
          visibilityRunId: null,
          metricsSnapshot: null,
          skipReason: null,
          executedAt: null,
          createdAt: '2026-11-20T08:00:00.000Z',
          updatedAt: '2026-11-20T08:00:00.000Z',
        },
        {
          id: 'sched_w02_14',
          publishRecordId: 'pub_w02_1',
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
      ],
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [globalArticle],
      total: 1,
    });
    const fetchPubSpy = vi
      .spyOn(studioApi, 'fetchPublishRecords')
      .mockResolvedValue({ items: [initialRecord] });

    const probedRecord: GeoPublishRecordDto = {
      ...initialRecord,
      crawlStatus: 'OK',
      crawlCheckedAt: '2026-11-23T10:00:00.000Z',
      crawlReportJson: {
        checkedUrl: initialRecord.publishedUrl,
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
        jsonLdTypes: ['Article'],
        jsonLdParseErrors: [],
        canonicalUrl: initialRecord.publishedUrl,
        canonicalMatches: true,
        issues: [],
      },
    };
    const probeSpy = vi.spyOn(distributionApi, 'triggerCrawlProbe').mockResolvedValue(probedRecord);

    const updatedSchedules = initialRecord.retestSchedules!.map((s) => ({
      ...s,
      sampleCount: 3 as const,
    }));
    const schedSpy = vi.spyOn(distributionApi, 'updateRetestSchedules').mockResolvedValue({
      publishRecordId: initialRecord.id,
      items: updatedSchedules,
    });

    vi.spyOn(studioApi, 'triggerPublishRetest').mockResolvedValue({
      id: 'run_instant_w02',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      name: '即时复测',
      engines: ['perplexity'],
      prompts: ['test'],
      triggerType: 'RETEST',
      retestArticleId: globalArticle.id,
      status: 'QUEUED',
      totalChecks: 1,
      doneCount: 0,
      failCount: 0,
      unitPrice: 2,
      settledPoints: 0,
      releasedPoints: 0,
      lastError: null,
      createdAt: '2026-11-23T10:01:00.000Z',
      finishedAt: null,
    } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    const crawlBadges = await screen.findByTestId('publish-crawl-badges-pub_w02_1');
    expect(crawlBadges.textContent).toContain('待体检');

    // 1. Trigger CrawlProbe -> updates to OK + HTTP 200 without redundant self-reload
    const fetchCountAfterMount = fetchPubSpy.mock.calls.length;
    fireEvent.click(screen.getByTestId('publish-crawl-recheck-btn-pub_w02_1'));
    await waitFor(() => {
      expect(probeSpy).toHaveBeenCalledTimes(1);
      expect(crawlBadges.textContent).toContain('HTTP 200');
      expect(crawlBadges.textContent).toContain('可抓取');
    });
    expect(fetchPubSpy).toHaveBeenCalledTimes(fetchCountAfterMount);

    // 2. Switch sampling to 3x -> budget reflects 3 次采样 without redundant self-reload
    const sampleToggle = screen.getByTestId('publish-retest-sample-toggle-pub_w02_1');
    fireEvent.click(within(sampleToggle).getByRole('button', { name: '3 次高置信' }));
    await waitFor(() => {
      expect(schedSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('publish-retest-budget-pub_w02_1').textContent).toContain(
        '3 次采样',
      );
    });
    expect(fetchPubSpy).toHaveBeenCalledTimes(fetchCountAfterMount);

    // 3. Trigger instant retest ("一键立刻复测") -> confirm modal -> CrawlProbe & 3x sampling MUST NOT revert!
    fireEvent.click(screen.getByTestId('publish-retest-btn'));
    const confirmRetestBtn = (await screen.findByTestId(
      'publish-retest-confirm-btn',
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirmRetestBtn.disabled).toBe(false);
    });
    fireEvent.click(confirmRetestBtn);

    await waitFor(() => {
      expect(studioApi.triggerPublishRetest).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('publish-crawl-badges-pub_w02_1').textContent).toContain('HTTP 200');
    expect(screen.getByTestId('publish-crawl-badges-pub_w02_1').textContent).toContain('可抓取');
    expect(screen.getByTestId('publish-retest-budget-pub_w02_1').textContent).toContain('3 次采样');

    // 4. External invalidateFreshness('publish-records') reloads fetchPublishRecords for the active article
    const countBeforeExternal = fetchPubSpy.mock.calls.length;
    act(() => {
      invalidateFreshness('publish-records');
    });
    await waitFor(() => {
      expect(fetchPubSpy.mock.calls.length).toBeGreaterThan(countBeforeExternal);
    });
  });

  it('Issue #364: preserves ?articleId= across refresh (including outside top-50 list), warns & cleans invalid/mismatched articleId, and auto-switches bare ?articleId= links', async () => {
    const globalArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_gl_deep_364',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      title: 'Deep Link GLOBAL Article 364',
      contentMarkdown: '# Deep Link GLOBAL Article 364\n\nVerified lab benchmarks.',
    };

    // 1. Refresh on /studio?brandId=...&market=GLOBAL&articleId=art_gl_deep_364 when article is NOT in initial top-50 list
    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=GLOBAL&articleId=${globalArticle.id}`,
    );
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
      hydrated: true,
      contextEpoch: 1,
    });
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(studioApi, 'getArticle').mockResolvedValueOnce(globalArticle);

    const { unmount } = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    await waitFor(() => {
      expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe(
        'Deep Link GLOBAL Article 364',
      );
    });
    expect((screen.getByTestId('studio-open-distribution-btn') as HTMLButtonElement).disabled).toBe(
      false,
    );
    unmount();

    // 2. Missing / 404 articleId shows friendly warning and cleans URL parameter
    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=GLOBAL&articleId=art_nonexistent_364`,
    );
    vi.spyOn(studioApi, 'getArticle').mockRejectedValueOnce(new Error('404 not found'));

    const res2 = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('articleId')).toBeNull();
    });
    res2.unmount();

    // 3. Explicit brand/market mismatch warns & cleans stale articleId
    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=CN&articleId=${globalArticle.id}`,
    );
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
      hydrated: true,
      contextEpoch: 2,
    });
    vi.spyOn(studioApi, 'getArticle').mockResolvedValueOnce(globalArticle);

    const res3 = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('articleId')).toBeNull();
    });
    res3.unmount();

    // 4. Bare /studio?articleId=... (no conflicting brand/market in URL) auto-switches from CN -> GLOBAL and opens article
    window.history.replaceState(null, '', `/studio?articleId=${globalArticle.id}`);
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
      hydrated: true,
      contextEpoch: 3,
    });
    vi.spyOn(studioApi, 'fetchArticles').mockImplementation(async (_bid, mkt) => ({
      items: mkt === 'GLOBAL' ? [globalArticle] : [],
      total: mkt === 'GLOBAL' ? 1 : 0,
    }));
    vi.spyOn(studioApi, 'getArticle').mockResolvedValue(globalArticle);

    const res4 = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');
      expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe(
        'Deep Link GLOBAL Article 364',
      );
    });
    expect(new URLSearchParams(window.location.search).get('articleId')).toBe(globalArticle.id);
    res4.unmount();
  });
});
