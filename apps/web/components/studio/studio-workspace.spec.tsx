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

    // Select article -> open AI rewrite dropdown -> TO_TABLE -> delete via feedback.confirm
    fireEvent.click(screen.getByText('星辰存储 DXP4800 静音实测报告'));
    fireEvent.click(await screen.findByTestId('studio-rewrite-dropdown-btn'));
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

    // Expand collapsed prewrite bar & start an active SSE stream so we can verify filtering does NOT abort it
    fireEvent.click(await screen.findByTestId('studio-prewrite-expand-btn'));
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

  it('shows conditional targetLocale selector only for multi-locale GLOBAL brands, wires it into streamGenerateArticle, and prevents ja-JP preflight false positives', async () => {
    const multiLocaleBrand: BrandRecord = {
      ...DUAL_BRAND,
      markets: [
        DUAL_BRAND.markets[0]!,
        {
          ...DUAL_BRAND.markets[1]!,
          supportedLocales: ['en-US', 'ja-JP', 'de-DE'],
        },
      ],
    };

    // 1. CN market: targetLocale selector MUST be hidden
    useWorkspaceStore.setState({
      brands: [multiLocaleBrand],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: multiLocaleBrand.id,
      activeMarket: 'CN',
      hydrated: true,
      contextEpoch: 10,
    });
    const streamSpy = vi
      .spyOn(studioApi, 'streamGenerateArticle')
      .mockResolvedValue({ aborted: false, receivedEvents: 0 });

    const { unmount } = render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('studio-prewrite-bar')).toBeTruthy());
    expect(screen.queryByTestId('studio-target-locale-selector')).toBeNull();

    // 2. Switch to GLOBAL multi-locale brand: selector appears and wires selected ja-JP to streamGenerateArticle
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    });
    const selector = await screen.findByTestId('studio-target-locale-selector');
    expect(within(selector).getByTestId('studio-locale-en-US')).toBeTruthy();
    expect(within(selector).getByTestId('studio-locale-ja-JP')).toBeTruthy();
    expect(within(selector).getByTestId('studio-locale-de-DE')).toBeTruthy();

    fireEvent.click(within(selector).getByTestId('studio-locale-ja-JP'));
    fireEvent.change(screen.getByLabelText('目标问题'), {
      target: { value: '静音ホームNASおすすめ2026' },
    });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));
    await waitFor(() => {
      expect(streamSpy).toHaveBeenCalledWith(
        multiLocaleBrand.id,
        expect.objectContaining({
          market: 'GLOBAL',
          targetLocale: 'ja-JP',
          targetPrompt: '静音ホームNASおすすめ2026',
        }),
        expect.anything(),
        expect.anything(),
      );
    });
    unmount();

    // 3. StudioDeliveryPack ja-JP article copy triggers ZERO false-positive GLOBAL_CJK_LEAK confirm dialogs
    mockConfirm.mockClear();
    const copySpy = vi.spyOn(studioApi, 'copyTextToClipboard').mockResolvedValue(true);
    const jaArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_ja_delivery',
      brandId: multiLocaleBrand.id,
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      targetLocale: 'ja-JP',
      briefId: null,
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      targetPrompt: '静音ホームNASおすすめ2026',
      title: '2026年 静音ホームNASの選び方と実測データ',
      contentMarkdown:
        '# 静音ホームNASの選び方\n\nAstraVaultは18.5dBの静音設計で、家庭用サーバーとして高い信頼性を提供します。',
      contentHtml:
        '<h1>静音ホームNASの選び方</h1><p>AstraVaultは18.5dBの静音設計で、家庭用サーバーとして高い信頼性を提供します。</p>',
      geoScore: 86,
      complianceFlags: [],
      status: 'DRAFT',
      tags: [],
    };

    render(
      <StudioDeliveryPack
        activeMarket="GLOBAL"
        localBrandName="AstraVault"
        category="Home NAS"
        ownedDomains={['astravault.example.com']}
        brandNames={['AstraVault']}
        matchedFactCount={3}
        readOnly={false}
        article={jaArticle}
        evaluation={null}
        streaming={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /复制.*Markdown/ }));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledTimes(1);
    });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('Defect 2 regression: background brands refresh with cloned supportedLocales array preserves unsaved editor draft without resetting workspace', async () => {
    const multiLocaleBrand: BrandRecord = {
      ...DUAL_BRAND,
      markets: [
        DUAL_BRAND.markets[0]!,
        {
          ...DUAL_BRAND.markets[1]!,
          supportedLocales: ['en-US', 'de-DE', 'ja-JP'],
        },
      ],
    };
    const globalArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_gl_draft_preserve',
      brandId: multiLocaleBrand.id,
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      targetLocale: 'en-US',
      title: 'Original Title',
      contentMarkdown: '# Original Title\n\nInitial content.',
    };

    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${multiLocaleBrand.id}&market=GLOBAL&articleId=${globalArticle.id}`,
    );
    useWorkspaceStore.setState({
      brands: [multiLocaleBrand],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: multiLocaleBrand.id,
      activeMarket: 'GLOBAL',
      hydrated: true,
      contextEpoch: 20,
    });
    const fetchArticlesSpy = vi
      .spyOn(studioApi, 'fetchArticles')
      .mockResolvedValue({ items: [globalArticle], total: 1 });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    const titleInput = (await screen.findByLabelText('文章标题')) as HTMLInputElement;
    await waitFor(() => {
      expect(titleInput.value).toBe('Original Title');
    });
    const fetchCountBeforeRefresh = fetchArticlesSpy.mock.calls.length;

    // User makes unsaved edit in editor
    fireEvent.change(titleInput, { target: { value: 'Unsaved Important User Edit' } });
    expect(titleInput.value).toBe('Unsaved Important User Edit');

    // Simulate background brands refresh returning cloned brand + cloned supportedLocales array
    act(() => {
      useWorkspaceStore.setState({
        brands: [
          {
            ...multiLocaleBrand,
            markets: multiLocaleBrand.markets.map((m) => ({
              ...m,
              supportedLocales: [...(m.supportedLocales ?? [])],
            })),
          },
        ],
      });
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect((screen.getByLabelText('文章标题') as HTMLInputElement).value).toBe(
      'Unsaved Important User Edit',
    );
    expect(fetchArticlesSpy).toHaveBeenCalledTimes(fetchCountBeforeRefresh);
  });

  it('#384: auto-collapses prewrite bar with locale pill, supports Focus Mode, Selection Bubble + Escape overlay guard, inline [TBD] highlight, dual-tab anti-fight, and sticky single-CTA footer', async () => {
    const multiLocaleBrand: BrandRecord = {
      ...DUAL_BRAND,
      id: 'brand_384_ux',
      markets: DUAL_BRAND.markets.map((m) =>
        m.market === 'GLOBAL' ? { ...m, locale: 'en-US', supportedLocales: ['en-US', 'ja-JP'] } : m,
      ),
    };
    const articleWithTbd: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_384_tbd',
      brandId: multiLocaleBrand.id,
      market: 'GLOBAL',
      targetLocale: 'ja-JP',
      title: 'Quiet NAS 2026 Review',
      contentMarkdown:
        '## Summary\n\nThis quiet home NAS runs smoothly with [TBD: idle power draw] in daily tests.\n\nSecond paragraph for selection testing in preview canvas.',
      contentHtml: '',
      status: 'DRAFT',
    };
    const cleanPublishedArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_384_pub',
      brandId: multiLocaleBrand.id,
      market: 'GLOBAL',
      targetLocale: 'en-US',
      title: 'Clean Published Guide',
      contentMarkdown: '## Overview\n\nAll facts verified at 11.4W idle draw.',
      contentHtml: '',
      status: 'PUBLISHED',
      geoScore: 91,
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [multiLocaleBrand],
      activeBrandId: multiLocaleBrand.id,
      activeMarket: 'GLOBAL',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [articleWithTbd, cleanPublishedArticle],
      total: 2,
    });
    vi.spyOn(studioApi, 'fetchPublishRecords').mockImplementation(async (articleId) => {
      if (articleId === cleanPublishedArticle.id) {
        return {
          items: [
            {
              id: 'pub_384_blocked',
              brandId: multiLocaleBrand.id,
              brandMarketId: 'bm_global',
              articleId: cleanPublishedArticle.id,
              channel: 'Official Blog / Docs',
              publishedUrl: 'https://example.com/clean-guide',
              publishedAt: '2026-11-24T08:00:00.000Z',
              baselineRunId: null,
              beforeMetrics: null,
              afterMetrics: null,
              latestRetestRunId: null,
              crawlStatus: 'BLOCKED',
              crawlCheckedAt: '2026-11-24T09:00:00.000Z',
              crawlReportJson: null,
              indexNowSubmitted: false,
              retestSchedules: [],
            },
          ],
        };
      }
      return { items: [] };
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // 0-article initial state: prewrite bar is expanded & footer CTA is disabled default button
    expect(await screen.findByTestId('studio-prewrite-bar')).toBeTruthy();
    const emptyFooterBtn = screen.getByTestId('studio-open-distribution-btn') as HTMLButtonElement;
    expect(emptyFooterBtn.disabled).toBe(true);

    // 1. Select DRAFT article with [TBD] -> prewrite auto-collapses & displays locale pill
    await screen.findByTestId(`studio-article-item-${articleWithTbd.id}`);
    fireEvent.click(screen.getByText('Quiet NAS 2026 Review'));
    const collapsedBar = await screen.findByTestId('studio-prewrite-collapsed-bar');
    expect(collapsedBar.textContent).toContain('ja-JP');
    expect(screen.getByTestId('studio-collapsed-locale-pill').textContent).toContain('日本語');

    // Expand -> reveals target locale selector -> collapse back
    fireEvent.click(screen.getByTestId('studio-prewrite-expand-btn'));
    expect(await screen.findByTestId('studio-target-locale-selector')).toBeTruthy();
    fireEvent.click(screen.getByTestId('studio-prewrite-collapse-btn'));
    expect(await screen.findByTestId('studio-prewrite-collapsed-bar')).toBeTruthy();

    // 2. Restrained [TBD] bar + inline preview span + sticky footer state machine (with TBD)
    expect(screen.getByTestId('studio-batch-tbd-open-btn').textContent).toContain(
      '补齐 1 组待补充事实',
    );
    const fallbackDistBtn = screen.getByTestId('studio-open-distribution-btn') as HTMLButtonElement;
    expect(fallbackDistBtn.disabled).toBe(false);
    expect(fallbackDistBtn.textContent).toContain('仍要预览分发');
    const previewBody = screen.getByTestId('studio-preview-body');
    expect(previewBody.querySelectorAll('.gm-studio-tbd-inline').length).toBe(1);

    // 3. Right pane dual-tab: DRAFT opens on 体检 showing UX_TERMS.fanOutCoverage ('AI 追问覆盖度')
    const rightPane = screen.getByTestId('studio-right-pane');
    expect(rightPane.textContent).toContain('AI 追问覆盖度');
    expect(screen.getByTestId('studio-right-tab-checkup').getAttribute('aria-selected')).toBe(
      'true',
    );

    // 4. Focus Mode hides left & right panes and restores them on toggle off
    const focusBtn = screen.getByTestId('studio-focus-mode-btn');
    expect(focusBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(focusBtn);
    expect(focusBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('studio-left-pane')).toBeNull();
    expect(screen.queryByTestId('studio-right-pane')).toBeNull();
    fireEvent.click(focusBtn);
    expect(await screen.findByTestId('studio-left-pane')).toBeTruthy();
    expect(await screen.findByTestId('studio-right-pane')).toBeTruthy();

    // 5. Selection Bubble Toolbar in preview HTML + Escape respects open floating overlay
    const pEl = previewBody.querySelector('p');
    expect(pEl).toBeTruthy();
    const textNode = pEl!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(18, (textNode.textContent ?? '').length));
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    fireEvent.mouseUp(previewBody, { clientX: 420, clientY: 280 });
    expect(await screen.findByTestId('studio-selection-bubble')).toBeTruthy();

    // Simulate open AntD dropdown overlay -> Escape must NOT dismiss selection bubble
    const fakeOverlay = document.createElement('div');
    fakeOverlay.className = 'ant-dropdown';
    fakeOverlay.getBoundingClientRect = () =>
      ({ width: 120, height: 80, top: 10, left: 10, right: 130, bottom: 90 }) as DOMRect;
    document.body.appendChild(fakeOverlay);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('studio-selection-bubble')).toBeTruthy();
    document.body.removeChild(fakeOverlay);

    // With no overlay open -> Escape dismisses selection bubble
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('studio-selection-bubble')).toBeNull();
    });

    // 6. Switch to PUBLISHED clean article -> auto-selects 交付 tab with count & crawl alert dot,
    //    and footer switches to primary '进入分发工作台'
    fireEvent.click(screen.getByText('Clean Published Guide'));
    await waitFor(() => {
      expect(screen.getByTestId('studio-right-tab-delivery').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.getByTestId('studio-right-tab-delivery').textContent).toContain('交付 (1)');
      expect(screen.getByTestId('studio-delivery-crawl-alert-dot')).toBeTruthy();
    });
    expect(screen.queryByTestId('studio-batch-tbd-open-btn')).toBeNull();
    expect(screen.getByTestId('studio-open-distribution-btn').textContent).toContain(
      '进入分发工作台',
    );

    // Anti-fight: manually clicking 体检 stays on 体检
    fireEvent.click(screen.getByTestId('studio-right-tab-checkup'));
    expect(screen.getByTestId('studio-right-tab-checkup').getAttribute('aria-selected')).toBe(
      'true',
    );

    // Clicking + 自由选题 auto-expands prewrite bar
    fireEvent.click(screen.getByTestId('studio-free-topic-btn'));
    expect(await screen.findByTestId('studio-prewrite-bar')).toBeTruthy();
  });

  it('#384 responsive: auto-collapses left rail at <1360px (icon-only expand) and renders 队列/体检 drawers at <=920px', async () => {
    const origMatchMedia = window.matchMedia;
    let activeQuery: 'compact' | 'narrow' = 'compact';
    window.matchMedia = vi.fn((query: string) => ({
      matches:
        (activeQuery === 'compact' && query.includes('max-width: 1359px')) ||
        (activeQuery === 'narrow' && query.includes('max-width: 920px')),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    try {
      window.history.replaceState(
        null,
        '',
        `/studio?brandId=${DUAL_BRAND.id}&market=CN&articleId=${SAMPLE_ARTICLE.id}`,
      );
      useWorkspaceStore.setState({
        brandsLoading: false,
        brandsLoaded: true,
        brands: [DUAL_BRAND],
        activeBrandId: DUAL_BRAND.id,
        activeMarket: 'CN',
      });

      const { unmount } = render(
        <ConsoleProvider value={makeConsoleContext()}>
          <StudioWorkspace />
        </ConsoleProvider>,
      );

      // At 1280px (<1360px) with existing article -> auto-collapsed 44px rail with icon-only 展开队列 button
      const expandRailBtn = await screen.findByRole('button', { name: '展开队列' });
      expect(expandRailBtn.textContent?.trim()).toBe('');
      fireEvent.click(expandRailBtn);
      expect(await screen.findByTestId(`studio-article-item-${SAMPLE_ARTICLE.id}`)).toBeTruthy();
      unmount();

      // At <=920px -> single-column center canvas with 队列 & 体检 Drawer buttons
      activeQuery = 'narrow';
      render(
        <ConsoleProvider value={makeConsoleContext()}>
          <StudioWorkspace />
        </ConsoleProvider>,
      );

      expect(await screen.findByTestId('studio-center-pane')).toBeTruthy();
      expect(screen.queryByTestId('studio-left-pane')).toBeNull();
      expect(screen.queryByTestId('studio-right-pane')).toBeNull();

      fireEvent.click(screen.getByTestId('studio-mobile-queue-btn'));
      expect(await screen.findByTestId(`studio-article-item-${SAMPLE_ARTICLE.id}`)).toBeTruthy();

      fireEvent.click(screen.getByTestId('studio-mobile-right-btn'));
      expect(await screen.findByTestId('geo-score-value')).toBeTruthy();
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it('#384 regression (Fix 1 & Fix 3): PUBLISHED -> DRAFT switch clears stale publishRecords/tab lock and keeps strictly 1 primary CTA in States 6A & 6B', async () => {
    const draftWithTbd: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_reg_draft',
      brandId: DUAL_BRAND.id,
      market: 'CN',
      title: '回归测试草稿文章',
      contentMarkdown: '## 实测\n\n待机功耗为 [待补充：待机功耗]，噪音表现优秀。',
      contentHtml: '',
      status: 'DRAFT',
      geoScore: 78,
    };
    const publishedArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_reg_pub',
      brandId: DUAL_BRAND.id,
      market: 'CN',
      title: '回归测试已发布文章',
      contentMarkdown: '## 总览\n\n所有实测参数均已核验完成。',
      contentHtml: '',
      status: 'PUBLISHED',
      geoScore: 92,
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({
      items: [BRIEF_1],
      total: 1,
    });
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [draftWithTbd, publishedArticle],
      total: 2,
    });
    vi.spyOn(studioApi, 'fetchPublishRecords').mockImplementation(async (articleId) => {
      if (articleId === publishedArticle.id) {
        return {
          items: [
            {
              id: 'pub_reg_blocked',
              brandId: DUAL_BRAND.id,
              brandMarketId: 'bm_cn_1',
              articleId: publishedArticle.id,
              channel: '官网博客',
              publishedUrl: 'https://star.example.com/published',
              publishedAt: '2026-11-24T08:00:00.000Z',
              baselineRunId: null,
              beforeMetrics: null,
              afterMetrics: null,
              latestRetestRunId: null,
              crawlStatus: 'BLOCKED',
              crawlCheckedAt: '2026-11-24T09:00:00.000Z',
              crawlReportJson: null,
              indexNowSubmitted: false,
              retestSchedules: [],
            },
          ],
        };
      }
      return { items: [] };
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    const workspace = await screen.findByTestId('studio-workspace');

    // Open PUBLISHED article (1 blocked publish record) -> 交付 tab active with (1) & red dot
    fireEvent.click(await screen.findByText('回归测试已发布文章'));
    await waitFor(() => {
      expect(screen.getByTestId('studio-right-tab-delivery').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.getByTestId('studio-right-tab-delivery').textContent).toContain('交付 (1)');
      expect(screen.getByTestId('studio-delivery-crawl-alert-dot')).toBeTruthy();
    });

    // State 6A: expand prewrite manually while existing PUBLISHED article is open -> strictly 1 primary CTA
    fireEvent.click(screen.getByTestId('studio-prewrite-expand-btn'));
    expect(await screen.findByTestId('studio-prewrite-bar')).toBeTruthy();
    const primaries6A = Array.from(workspace.querySelectorAll('button.ant-btn-primary'));
    expect(primaries6A).toHaveLength(1);
    expect(primaries6A[0]?.getAttribute('data-testid')).toBe('studio-stream-btn');

    // Collapse back -> footer CTA immediately returns to sole primary
    fireEvent.click(screen.getByTestId('studio-prewrite-collapse-btn'));
    expect(await screen.findByTestId('studio-prewrite-collapsed-bar')).toBeTruthy();
    const primariesCollapsed = Array.from(workspace.querySelectorAll('button.ant-btn-primary'));
    expect(primariesCollapsed).toHaveLength(1);
    expect(primariesCollapsed[0]?.getAttribute('data-testid')).toBe('studio-open-distribution-btn');

    // Fix 1: Switch in-app from PUBLISHED -> DRAFT (0 publish records) -> MUST reset to 体检 tab, no (1), no red dot!
    fireEvent.click(screen.getByText('回归测试草稿文章'));
    await waitFor(() => {
      expect(screen.getByTestId('studio-right-tab-checkup').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.getByTestId('studio-right-tab-delivery').getAttribute('aria-selected')).toBe(
        'false',
      );
    });
    expect(screen.getByTestId('studio-right-tab-delivery').textContent).not.toContain('(1)');
    expect(screen.queryByTestId('studio-delivery-crawl-alert-dot')).toBeNull();

    // State 6B: With DRAFT+TBD article open, click pending brief -> strictly 1 primary CTA (studio-stream-btn)
    const briefItem = screen.getByTestId(`studio-brief-item-${BRIEF_1.id}`);
    fireEvent.click(within(briefItem).getByRole('button'));
    expect(await screen.findByTestId('studio-prewrite-bar')).toBeTruthy();
    const primaries6B = Array.from(workspace.querySelectorAll('button.ant-btn-primary'));
    expect(primaries6B).toHaveLength(1);
    expect(primaries6B[0]?.getAttribute('data-testid')).toBe('studio-stream-btn');
  });

  it('#384 regression (Fix 2): highlightMissingFactHtml aligns data-tbd-index with missingSlots across link-wrapped & special slots without wrong-slot overwrite', async () => {
    const linkWrappedMarkdown =
      '参考 [待补充：价格](https://example.com/pricing) 以及 [待补充：保修期]\n\n![[TBD: 图注]](https://example.com/a.png)\n\n符号测试 [TBD: $& $$ $1]';
    const articleMixedTbd: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_reg_tbd_align',
      brandId: DUAL_BRAND.id,
      market: 'CN',
      title: '内联留槽索引对齐测试',
      contentMarkdown: linkWrappedMarkdown,
      contentHtml: '',
      status: 'DRAFT',
    };

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [articleMixedTbd],
      total: 1,
    });
    const updateSpy = vi
      .spyOn(studioApi, 'updateArticle')
      .mockImplementation(async (_id, patch) => ({
        ...articleMixedTbd,
        contentMarkdown: patch.contentMarkdown ?? articleMixedTbd.contentMarkdown,
        title: patch.title ?? articleMixedTbd.title,
      }));

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByText('内联留槽索引对齐测试'));
    const previewBody = await screen.findByTestId('studio-preview-body');
    const inlineSpans = Array.from(
      previewBody.querySelectorAll<HTMLElement>('.gm-studio-tbd-inline'),
    );
    // Slot 0 is link-wrapped, slot 1 is [待补充：保修期], slot 2 is in img alt, slot 3 is [TBD: $& $$ $1]
    expect(inlineSpans).toHaveLength(2);
    expect(inlineSpans[0]?.textContent).toBe('[待补充：保修期]');
    expect(inlineSpans[0]?.getAttribute('data-tbd-index')).toBe('1');
    expect(inlineSpans[1]?.textContent).toBe('[TBD: $& $$ $1]');
    expect(inlineSpans[1]?.getAttribute('data-tbd-index')).toBe('3');

    // Click inline [待补充：保修期] -> MUST open Popover for 保修期 (NOT 价格)
    fireEvent.click(inlineSpans[0]!);
    expect(await screen.findByText('补充缺失事实：保修期')).toBeTruthy();
    expect(screen.queryByText('补充缺失事实：价格')).toBeNull();

    const valueInput = screen.getByLabelText('补充-保修期');
    fireEvent.change(valueInput, { target: { value: '3 年整机质保' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '同步存入品牌事实卡' }));
    fireEvent.click(screen.getByRole('button', { name: '确认填入' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    const updatedMd = updateSpy.mock.calls[0]?.[1]?.contentMarkdown ?? '';
    expect(updatedMd).toContain('[待补充：价格](https://example.com/pricing)');
    expect(updatedMd).toContain('以及 3 年整机质保');
    expect(updatedMd).not.toContain('[待补充：保修期]');
  });

  it('#384 regression (Fix 4): split-mode textarea selection bubble survives document selectionchange', async () => {
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

    fireEvent.click(await screen.findByText('星辰存储 DXP4800 静音实测报告'));
    await screen.findByTestId('studio-preview-body');

    // Switch to 分栏 (split) mode so both textarea and previewBodyRef are mounted simultaneously
    fireEvent.click(screen.getByText('分栏'));
    const textarea = (await screen.findByLabelText('文章 Markdown 正文')) as HTMLTextAreaElement;
    expect(screen.getByTestId('studio-preview-body')).toBeTruthy();

    textarea.focus();
    textarea.setSelectionRange(0, 12);
    fireEvent.select(textarea);
    fireEvent.mouseUp(textarea, { clientX: 300, clientY: 220 });
    expect(await screen.findByTestId('studio-selection-bubble')).toBeTruthy();

    // Simulate Chromium firing document selectionchange with empty window.getSelection() while textarea is focused
    window.getSelection()?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });

    expect(screen.getByTestId('studio-selection-bubble')).toBeTruthy();

    // Fix C: clicking/focusing a non-editor textarea (目标问题) MUST dismiss studio-selection-bubble immediately
    fireEvent.click(screen.getByTestId('studio-prewrite-expand-btn'));
    const promptTextarea = (await screen.findByLabelText('目标问题')) as HTMLTextAreaElement;
    expect(promptTextarea.classList.contains('gm-studio-markdown-textarea')).toBe(false);
    expect(textarea.classList.contains('gm-studio-markdown-textarea')).toBe(true);

    // Re-open bubble from split-mode editor textarea, then interact with 目标问题 textarea
    textarea.focus();
    textarea.setSelectionRange(0, 12);
    fireEvent.select(textarea);
    fireEvent.mouseUp(textarea, { clientX: 300, clientY: 220 });
    expect(await screen.findByTestId('studio-selection-bubble')).toBeTruthy();

    fireEvent.mouseDown(promptTextarea);
    promptTextarea.focus();
    window.getSelection()?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('studio-selection-bubble')).toBeNull();
    });

    // Also verify preview-mode selection bubble is dismissed on non-editor textarea click + selectionchange
    fireEvent.click(screen.getByText('实时预览'));
    const previewBody = await screen.findByTestId('studio-preview-body');
    const previewPara = previewBody.querySelector('p');
    expect(previewPara?.firstChild).toBeTruthy();
    const previewRange = document.createRange();
    previewRange.setStart(previewPara!.firstChild!, 0);
    previewRange.setEnd(
      previewPara!.firstChild!,
      Math.min(12, (previewPara!.firstChild!.textContent ?? '').length),
    );
    const previewSel = window.getSelection();
    previewSel?.removeAllRanges();
    previewSel?.addRange(previewRange);
    fireEvent.mouseUp(previewBody, { clientX: 320, clientY: 240 });
    expect(await screen.findByTestId('studio-selection-bubble')).toBeTruthy();

    fireEvent.mouseDown(promptTextarea);
    promptTextarea.focus();
    window.getSelection()?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('studio-selection-bubble')).toBeNull();
    });
  });

  it('#384 regression (Iter 3 Fix A): highlightMissingFactHtml preserves exact data-tbd-index across link href deferral, img alt-before-src, and skipped non-literal slots', async () => {
    const cases: Array<{
      id: string;
      title: string;
      markdown: string;
      expectedIndices: string[];
    }> = [
      {
        id: 'art_1b1',
        title: '复合留槽用例 1B-1',
        markdown:
          '参考 [待补充：价格](https://example.com/pricing)\n\n![[TBD: 图注]](https://example.com/a.png)\n\n实测 [TBD: 图注]',
        expectedIndices: ['2'],
      },
      {
        id: 'art_1b2',
        title: '复合留槽用例 1B-2',
        markdown:
          '参数 [TBD: **出厂价**]\n\n查看 [说明](https://example.com/[TBD:y])\n\n实测 [TBD:y]',
        expectedIndices: ['2'],
      },
      {
        id: 'art_1b3',
        title: '复合留槽用例 1B-3',
        markdown: '![[TBD:A]](https://example.com/[TBD:B])\n\n实测 [TBD:B]',
        expectedIndices: ['2'],
      },
      {
        id: 'art_1b4',
        title: '复合留槽用例 1B-4',
        markdown: '查看 [[TBD:A]](https://example.com/[TBD:B])\n\n实测 [TBD:B]',
        expectedIndices: ['0', '2'],
      },
      {
        id: 'art_1b5',
        title: '复合留槽用例 1B-5',
        markdown: '查看 [[TBD:A]](https://example.com/[TBD:A])\n\n实测 [TBD:A]',
        expectedIndices: ['0', '2'],
      },
      {
        id: 'art_1b7',
        title: '复合留槽用例 1B-7',
        markdown: '参数 [TBD: `foo`]\n\n![[TBD:图]](https://example.com/a.png)\n\n实测 [TBD:图]',
        expectedIndices: ['2'],
      },
    ];

    const articles: GeoArticleRecord[] = cases.map((c) => ({
      ...SAMPLE_ARTICLE,
      id: c.id,
      brandId: DUAL_BRAND.id,
      market: 'CN',
      title: c.title,
      contentMarkdown: c.markdown,
      contentHtml: '',
      status: 'DRAFT',
    }));

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: articles,
      total: articles.length,
    });
    const updateSpy = vi.spyOn(studioApi, 'updateArticle').mockImplementation(async (id, patch) => {
      const base = articles.find((a) => a.id === id) ?? articles[0]!;
      return {
        ...base,
        contentMarkdown: patch.contentMarkdown ?? base.contentMarkdown,
        title: patch.title ?? base.title,
      };
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <StudioWorkspace />
      </ConsoleProvider>,
    );

    // Check every compound Markdown case emits exact data-tbd-index values
    for (const c of cases) {
      fireEvent.click(await screen.findByText(c.title));
      await waitFor(() => {
        const previewBody = screen.getByTestId('studio-preview-body');
        const spans = Array.from(
          previewBody.querySelectorAll<HTMLElement>('.gm-studio-tbd-inline'),
        );
        expect(spans.map((el) => el.getAttribute('data-tbd-index'))).toEqual(c.expectedIndices);
      });
    }

    // Backfill 1B-1 inline span -> MUST replace ONLY body `实测 [TBD: 图注]` and preserve `![[TBD: 图注]](https://example.com/a.png)`
    fireEvent.click(screen.getByText('复合留槽用例 1B-1'));
    await waitFor(() => {
      const previewBody = screen.getByTestId('studio-preview-body');
      const spans = previewBody.querySelectorAll<HTMLElement>('.gm-studio-tbd-inline');
      expect(spans).toHaveLength(1);
      expect(spans[0]?.getAttribute('data-tbd-index')).toBe('2');
    });

    const bodySpan = screen
      .getByTestId('studio-preview-body')
      .querySelector<HTMLElement>('.gm-studio-tbd-inline')!;
    fireEvent.click(bodySpan);
    const valueInput = await screen.findByLabelText('补充-图注');
    fireEvent.change(valueInput, { target: { value: '18.5dB 实测曲线图' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '同步存入品牌事实卡' }));
    fireEvent.click(screen.getByRole('button', { name: '确认填入' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    const updatedMd = updateSpy.mock.calls[0]?.[1]?.contentMarkdown ?? '';
    expect(updatedMd).toContain('[待补充：价格](https://example.com/pricing)');
    expect(updatedMd).toContain('![[TBD: 图注]](https://example.com/a.png)');
    expect(updatedMd).toContain('实测 18.5dB 实测曲线图');
    expect(updatedMd).not.toContain('实测 [TBD: 图注]');
  });

  it('#385: opens QuickFactExtractModal for 0-fact brand and supports skip escape hatch + deduplicated batch [TBD] fill merging facts safely', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    // Part A: 0-fact brand clicking studio-stream-btn -> opens QuickFactExtractModal (no premature stream) -> skip resumes stream
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValueOnce({
      brandId: DUAL_BRAND.id,
      truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
      totalChars: 0,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    });
    const streamSpy = vi.spyOn(studioApi, 'streamGenerateArticle').mockResolvedValue({
      aborted: false,
      receivedEvents: 0,
    });

    render(<StudioWorkspace />);
    const promptInput = await screen.findByLabelText('目标问题');
    fireEvent.change(promptInput, { target: { value: '2026 便携储能哪款静音表现最好' } });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    expect(await screen.findByTestId('quick-fact-extract-modal')).toBeTruthy();
    expect(streamSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('quick-fact-skip-btn'));
    await waitFor(() => {
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });
    cleanup();

    // Part B: Article with 3 [待补充] tokens across 2 unique hints -> deduplicated batch drawer merges onto existing PRODUCT_SPECS fact without overwriting
    const multiTbdArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_batch_tbd',
      title: '便携储能实测报告',
      contentMarkdown: [
        '# 便携储能实测报告',
        '',
        '实测满载功耗为 [待补充：满载功耗]，静音控制出色。',
        '',
        '| 项目 | 数值 |',
        '| --- | --- |',
        '| 满载功耗 | [待补充：满载功耗] |',
        '| 官方质保 | [待补充：质保周期] |',
      ].join('\n'),
    };
    const existingFact = {
      ...SAMPLE_FACT,
      id: 'fact_specs_existing',
      slot: 'PRODUCT_SPECS' as const,
      content: '- 满载噪音：18.5dB',
    };
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [multiTbdArticle],
      total: 1,
    });
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValue({
      brandId: 'brand_1',
      truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
      totalChars: existingFact.content.length,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [existingFact],
    });
    const saveFactsSpy = vi.spyOn(brandsApi, 'saveBrandFacts').mockResolvedValue({
      brandId: 'brand_1',
      truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
      totalChars: 64,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [existingFact],
    });
    const updateArticleSpy = vi
      .spyOn(studioApi, 'updateArticle')
      .mockImplementation(async (_id, payload) => ({
        ...multiTbdArticle,
        title: payload.title ?? multiTbdArticle.title,
        contentMarkdown: payload.contentMarkdown ?? multiTbdArticle.contentMarkdown,
      }));

    render(<StudioWorkspace />);
    fireEvent.click(await screen.findByText('便携储能实测报告'));

    // Strictly 1 primary CTA in workspace even with studio-missing-bar-batch-btn rendered
    const batchFooterBtn = await screen.findByTestId('studio-batch-tbd-open-btn');
    expect(batchFooterBtn.textContent).toContain('补齐 2 组待补充事实');
    const barBatchBtn = screen.getByTestId('studio-missing-bar-batch-btn');
    expect(barBatchBtn.textContent).toContain('批量补填（2 组）');
    expect(
      screen.getByTestId('studio-workspace').querySelectorAll('button.ant-btn-primary'),
    ).toHaveLength(1);

    // Open deduplicated batch drawer
    fireEvent.click(batchFooterBtn);
    const batchDrawer = await screen.findByTestId('studio-batch-tbd-drawer');
    expect(batchDrawer.textContent).toContain('出现 2 处');
    expect(batchDrawer.querySelectorAll('input[type="text"], textarea')).toHaveLength(2);

    fireEvent.change(within(batchDrawer).getByLabelText('满载功耗'), { target: { value: '42W' } });
    fireEvent.change(within(batchDrawer).getByLabelText('质保周期'), {
      target: { value: '3 年质保' },
    });
    fireEvent.click(screen.getByTestId('batch-tbd-submit-btn'));

    await waitFor(() => {
      expect(saveFactsSpy).toHaveBeenCalledTimes(1);
      expect(updateArticleSpy).toHaveBeenCalledTimes(1);
    });

    // Existing fact content MUST be preserved alongside BOTH newly added facts in a single slot item!
    const savedFactItems = saveFactsSpy.mock.calls[0]?.[1]?.facts ?? [];
    expect(savedFactItems).toHaveLength(1);
    expect(savedFactItems[0]?.id).toBe('fact_specs_existing');
    expect(savedFactItems[0]?.content).toContain('满载噪音：18.5dB');
    expect(savedFactItems[0]?.content).toContain('42W');
    expect(savedFactItems[0]?.content).toContain('3 年质保');

    // Updated markdown replaces all 3 tokens and footer CTA transitions to 进入分发工作台
    const updatedMarkdown = updateArticleSpy.mock.calls[0]?.[1]?.contentMarkdown ?? '';
    expect(updatedMarkdown).not.toContain('[待补充');
    expect(updatedMarkdown.match(/42W/g)).toHaveLength(2);
    expect(updatedMarkdown).toContain('| 官方质保 | 3 年质保 |');

    await waitFor(() => {
      expect(screen.getByTestId('studio-open-distribution-btn').textContent).toContain(
        '进入分发工作台',
      );
    });
  });

  it('#385 C2-1 regression: aborts batch [TBD] sync without overwriting facts or closing drawer when getBrandFacts fails', async () => {
    const tbdArticle: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_batch_tbd_err',
      title: '事实拉取失败防覆盖文章',
      contentMarkdown: '# 实测\n\n满载噪音实测为 [待补充：满载噪音]。',
    };
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({
      items: [tbdArticle],
      total: 1,
    });
    const getFactsSpy = vi
      .spyOn(brandsApi, 'getBrandFacts')
      .mockRejectedValue(new Error('500 Server Error'));
    const saveFactsSpy = vi.spyOn(brandsApi, 'saveBrandFacts');
    const updateArticleSpy = vi.spyOn(studioApi, 'updateArticle');

    render(<StudioWorkspace />);
    fireEvent.click(await screen.findByText('事实拉取失败防覆盖文章'));
    fireEvent.click(await screen.findByTestId('studio-batch-tbd-open-btn'));

    const batchDrawer = await screen.findByTestId('studio-batch-tbd-drawer');
    const noiseInput = within(batchDrawer).getByLabelText('满载噪音') as HTMLInputElement;
    fireEvent.change(noiseInput, { target: { value: '18.5 dB' } });

    const callsBeforeSubmit = getFactsSpy.mock.calls.length;
    fireEvent.click(screen.getByTestId('batch-tbd-submit-btn'));

    await waitFor(() => {
      expect(getFactsSpy.mock.calls.length).toBeGreaterThan(callsBeforeSubmit);
      expect(mockNotifyError).toHaveBeenCalled();
    });

    // Existing server facts MUST NOT be overwritten and article MUST NOT be updated
    expect(saveFactsSpy).not.toHaveBeenCalled();
    expect(updateArticleSpy).not.toHaveBeenCalled();
    // Drawer stays open with user-typed value preserved for retry
    expect(screen.getByTestId('studio-batch-tbd-drawer')).toBeTruthy();
    expect((within(batchDrawer).getByLabelText('满载噪音') as HTMLInputElement).value).toBe(
      '18.5 dB',
    );
  });

  it('#385 C2-2 regression: stale Brand B getBrandFacts settlement across brand switch cannot clobber Brand C mutex or fire duplicate SSE streams', async () => {
    const brandB: BrandRecord = {
      ...DUAL_BRAND,
      id: 'brand_b_race',
      name: '品牌B',
      markets: DUAL_BRAND.markets.map((m) => ({
        ...m,
        id: `${m.id}_b`,
        brandId: 'brand_b_race',
      })),
    };
    const brandC: BrandRecord = {
      ...DUAL_BRAND,
      id: 'brand_c_race',
      name: '品牌C',
      markets: DUAL_BRAND.markets.map((m) => ({
        ...m,
        id: `${m.id}_c`,
        brandId: 'brand_c_race',
      })),
    };

    const createDeferred = <T,>() => {
      let resolve!: (val: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    const brandBFacts = createDeferred<Awaited<ReturnType<typeof brandsApi.getBrandFacts>>>();
    const brandCFacts = createDeferred<Awaited<ReturnType<typeof brandsApi.getBrandFacts>>>();

    const getFactsSpy = vi.spyOn(brandsApi, 'getBrandFacts').mockImplementation((brandId) => {
      if (brandId === 'brand_b_race') return brandBFacts.promise;
      if (brandId === 'brand_c_race') return brandCFacts.promise;
      return Promise.resolve({
        brandId,
        truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
        totalChars: 0,
        vectorIndexRequired: false,
        vectorIndexed: false,
        items: [],
      });
    });

    const streamDeferred = createDeferred<{ aborted: boolean; receivedEvents: number }>();
    const streamSpy = vi
      .spyOn(studioApi, 'streamGenerateArticle')
      .mockImplementation(() => streamDeferred.promise);

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [brandB, brandC],
      activeBrandId: brandB.id,
      activeMarket: 'CN',
    });

    render(<StudioWorkspace />);
    await waitFor(() => {
      expect(getFactsSpy).toHaveBeenCalledWith('brand_b_race', expect.anything());
    });

    // 1. On Brand B (facts pending), click start stream -> enters checkingFactsRef
    fireEvent.change(screen.getByLabelText('目标问题'), {
      target: { value: '品牌B 核心参数对比' },
    });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    // 2. Switch to Brand C while Brand B's getBrandFacts is still pending
    act(() => {
      useWorkspaceStore.getState().setActiveBrand(brandC.id, 'CN', window.localStorage);
    });
    await waitFor(() => {
      expect(getFactsSpy).toHaveBeenCalledWith('brand_c_race', expect.anything());
    });

    // 3. On Brand C (facts pending), click start stream once
    fireEvent.change(screen.getByLabelText('目标问题'), {
      target: { value: '品牌C 实测静音对比' },
    });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    // 4. Stale Brand B promise settles -> MUST NOT clear Brand C's checkingFactsRef
    await act(async () => {
      brandBFacts.resolve({
        brandId: 'brand_b_race',
        truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
        totalChars: 0,
        vectorIndexRequired: false,
        vectorIndexed: false,
        items: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // 5. Second click on Brand C while Brand C facts are still pending
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    // 6. Now Brand C facts resolve with valid fact -> MUST trigger strictly 1 SSE stream
    await act(async () => {
      brandCFacts.resolve({
        brandId: 'brand_c_race',
        truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
        totalChars: SAMPLE_FACT.content.length,
        vectorIndexRequired: false,
        vectorIndexed: false,
        items: [{ ...SAMPLE_FACT, brandId: 'brand_c_race' }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });
    expect(streamSpy).toHaveBeenCalledWith(
      'brand_c_race',
      expect.objectContaining({ targetPrompt: '品牌C 实测静音对比' }),
      expect.anything(),
      expect.anything(),
    );

    await act(async () => {
      streamDeferred.resolve({ aborted: false, receivedEvents: 0 });
      await Promise.resolve();
    });
  });

  it('#387 R2-01 regression: switching activeProductLineId clears ?articleId= and never fetches or injects Line A article into Line B', async () => {
    const lineA = {
      id: 'pl_power',
      brandId: DUAL_BRAND.id,
      name: 'Portable Power',
      localNamesJson: {},
      category: 'Power',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const lineB = {
      ...lineA,
      id: 'pl_nas',
      name: 'Home NAS',
      category: 'NAS',
      sortOrder: 1,
    };
    const artLineA: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_line_a',
      market: 'GLOBAL',
      brandMarketId: 'bm_gl_1',
      productLineId: 'pl_power',
      title: 'Line A Portable Power Guide',
    };
    const artLineB: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_line_b',
      market: 'GLOBAL',
      brandMarketId: 'bm_gl_1',
      productLineId: 'pl_nas',
      title: 'Line B Home NAS Guide',
    };

    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=GLOBAL&productLineId=pl_power&articleId=art_line_a`,
    );

    vi.spyOn(studioApi, 'fetchArticles').mockImplementation(async (_brandId, _market, query) => {
      if (query?.productLineId === 'pl_power') return { items: [artLineA], total: 1 };
      if (query?.productLineId === 'pl_nas') return { items: [artLineB], total: 1 };
      return { items: [artLineA, artLineB], total: 2 };
    });
    const getArticleSpy = vi.spyOn(studioApi, 'getArticle').mockResolvedValue(artLineA);

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
      productLines: [lineA, lineB],
      productLinesBrandId: DUAL_BRAND.id,
      productLinesLoaded: true,
      productLinesLoading: false,
      activeProductLineId: 'pl_power',
    });

    render(<StudioWorkspace />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Line A Portable Power Guide')).toBeTruthy();
    });
    expect(new URLSearchParams(window.location.search).get('articleId')).toBe('art_line_a');

    // Switch product line from pl_power -> pl_nas via store action
    act(() => {
      useWorkspaceStore.getState().setActiveProductLine('pl_nas');
    });

    await waitFor(() => {
      expect(screen.getByText('Line B Home NAS Guide')).toBeTruthy();
    });
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBe('pl_nas');
    expect(new URLSearchParams(window.location.search).get('articleId')).toBeNull();
    expect(getArticleSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Line A Portable Power Guide')).toBeNull();
    expect(screen.queryByDisplayValue('Line A Portable Power Guide')).toBeNull();
  });

  it('#387 R2-01 regression: deep-linking conflicting ?articleId= and ?briefId= for Line A while on Line B rejects and strips them instead of bleeding into Line B', async () => {
    const lineA = {
      id: 'pl_power',
      brandId: DUAL_BRAND.id,
      name: 'Portable Power',
      localNamesJson: {},
      category: 'Power',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const lineB = {
      ...lineA,
      id: 'pl_nas',
      name: 'Home NAS',
      category: 'NAS',
      sortOrder: 1,
    };
    const artLineA: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_foreign_line_a',
      market: 'GLOBAL',
      brandMarketId: 'bm_gl_1',
      productLineId: 'pl_power',
      title: 'Foreign Line A Article',
    };
    const briefLineA: GeoBriefRecord = {
      ...BRIEF_1,
      id: 'brief_foreign_line_a',
      market: 'GLOBAL',
      brandMarketId: 'bm_gl_1',
      productLineId: 'pl_power',
      targetPrompt: 'Foreign Line A Brief Prompt',
    };
    const artLineB: GeoArticleRecord = {
      ...SAMPLE_ARTICLE,
      id: 'art_only_line_b',
      market: 'GLOBAL',
      brandMarketId: 'bm_gl_1',
      productLineId: 'pl_nas',
      title: 'Line B Only Article',
    };

    window.history.replaceState(
      null,
      '',
      `/studio?brandId=${DUAL_BRAND.id}&market=GLOBAL&productLineId=pl_nas&articleId=art_foreign_line_a&briefId=brief_foreign_line_a`,
    );

    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(briefsApi, 'getBrief').mockResolvedValue(briefLineA);
    vi.spyOn(studioApi, 'fetchArticles').mockResolvedValue({ items: [artLineB], total: 1 });
    const getArticleSpy = vi.spyOn(studioApi, 'getArticle').mockResolvedValue(artLineA);

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
      productLines: [lineA, lineB],
      productLinesBrandId: DUAL_BRAND.id,
      productLinesLoaded: true,
      productLinesLoading: false,
      activeProductLineId: 'pl_nas',
    });

    render(<StudioWorkspace />);

    await waitFor(() => {
      expect(getArticleSpy).toHaveBeenCalledWith('art_foreign_line_a', expect.anything());
      expect(new URLSearchParams(window.location.search).get('articleId')).toBeNull();
      expect(new URLSearchParams(window.location.search).get('briefId')).toBeNull();
    });

    expect(screen.getByText('Line B Only Article')).toBeTruthy();
    expect(screen.queryByText('Foreign Line A Article')).toBeNull();
    expect(screen.queryByDisplayValue('Foreign Line A Article')).toBeNull();
    expect(screen.queryByDisplayValue('Foreign Line A Brief Prompt')).toBeNull();
    expect(mockNotifyWarning).toHaveBeenCalledWith(
      '该文章不属于当前产品线，已清除链接中的文章参数',
    );
  });

  it('#387 R2-02 regression: fallback getBrandFacts pre-generation check forwards activeProductLineId', async () => {
    const lineB = {
      id: 'pl_nas',
      brandId: DUAL_BRAND.id,
      name: 'Home NAS',
      localNamesJson: {},
      category: 'NAS',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };

    const getFactsSpy = vi
      .spyOn(brandsApi, 'getBrandFacts')
      // Initial workspace load fails transiently -> brandFactsLoadedRef stays false and pending ref clears
      .mockRejectedValueOnce(new Error('transient facts timeout'))
      // Fallback check on clicking Generate succeeds with empty facts for pl_nas
      .mockResolvedValueOnce({
        brandId: DUAL_BRAND.id,
        truthAgreementSignedAt: '2026-04-01T00:00:00.000Z',
        totalChars: 0,
        vectorIndexRequired: false,
        vectorIndexed: false,
        items: [],
      });

    const streamSpy = vi
      .spyOn(studioApi, 'streamGenerateArticle')
      .mockResolvedValue({ aborted: false, receivedEvents: 0 });

    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'GLOBAL',
      productLines: [lineB],
      productLinesBrandId: DUAL_BRAND.id,
      productLinesLoaded: true,
      productLinesLoading: false,
      activeProductLineId: 'pl_nas',
    });

    render(<StudioWorkspace />);

    await waitFor(() => {
      expect(getFactsSpy).toHaveBeenCalledTimes(1);
    });
    expect(getFactsSpy).toHaveBeenNthCalledWith(
      1,
      DUAL_BRAND.id,
      expect.objectContaining({ productLineId: 'pl_nas' }),
    );

    fireEvent.change(screen.getByLabelText('目标问题'), {
      target: { value: 'Best quiet 4-bay Home NAS' },
    });
    fireEvent.click(screen.getByTestId('studio-stream-btn'));

    await waitFor(() => {
      expect(getFactsSpy).toHaveBeenCalledTimes(2);
    });
    expect(getFactsSpy).toHaveBeenNthCalledWith(2, DUAL_BRAND.id, {
      productLineId: 'pl_nas',
    });
    expect(streamSpy).not.toHaveBeenCalled();
  });
});
