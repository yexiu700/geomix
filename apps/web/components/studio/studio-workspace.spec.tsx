// @vitest-environment jsdom
import type {
  BrandFactRecord,
  BrandRecord,
  GeoArticleRecord,
  GeoBatchJobRecord,
  GeoBriefRecord,
  PromptPreferenceRecord,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandsApi from '../../lib/brands';
import * as briefsApi from '../../lib/briefs';
import * as studioApi from '../../lib/studio';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider, type ConsoleContextValue } from '../shell/console-context';
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
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const onOk = mockConfirm.mock.calls[0]?.[0]?.onOk as (() => Promise<void>) | undefined;
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
});
