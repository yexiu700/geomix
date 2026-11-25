// @vitest-environment jsdom
import type {
  BrandRecord,
  GeoBriefRecord,
  VisibilityCitationListResponse,
  VisibilityEngineAvailabilityResponse,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewResponse,
  VisibilityRunDetailRecord,
  VisibilityRunListResponse,
} from '@geomix/shared';
import { API_ERROR, CITATION_SOURCE_KINDS } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandsApi from '../../lib/brands';
import * as briefsApi from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import * as studioApi from '../../lib/studio';
import * as freshnessLib from '../../lib/tab-freshness';
import * as visibilityApi from '../../lib/visibility';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider, type ConsoleContextValue } from '../shell/console-context';
import { VisibilityWorkspace } from './visibility-workspace';

const mockConfirm = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: mockNotifySuccess,
    notifyWarning: vi.fn(),
    notifyError: mockNotifyError,
  }),
}));

const DUAL_BRAND: BrandRecord = {
  id: 'brand_dual_1',
  name: '极光NAS',
  category: '家用NAS',
  truthAgreementSignedAt: '2026-11-18T00:00:00.000Z',
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  markets: [
    {
      id: 'bm_cn_1',
      brandId: 'brand_dual_1',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '极光NAS',
      aliases: ['JiguangNAS'],
      ownedDomains: ['jiguangnas.cn'],
      competitors: [{ name: '群晖', aliases: ['Synology'], domains: ['synology.com'] }],
      seedPrompts: ['家用静音四盘位NAS推荐', '客厅静音NAS功耗对比'],
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    {
      id: 'bm_gl_1',
      brandId: 'brand_dual_1',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AuroraNAS',
      aliases: ['Aurora NAS'],
      ownedDomains: ['auroranas.com'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['Best quiet 4-bay NAS for home office'],
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
  ],
};

const CN_ENGINES_RES: VisibilityEngineAvailabilityResponse = {
  collector: 'fake',
  market: 'CN',
  checkedAt: '2026-11-20T00:00:00.000Z',
  refreshIntervalMs: 300_000,
  engines: [
    {
      key: 'deepseek',
      label: 'DeepSeek',
      domestic: true,
      market: 'CN',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
    {
      key: 'doubao',
      label: '豆包',
      domestic: true,
      market: 'CN',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
    {
      key: 'yuanbao',
      label: '腾讯元宝',
      domestic: true,
      market: 'CN',
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    },
    {
      key: 'tongyi',
      label: '通义千问',
      domestic: true,
      market: 'CN',
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    },
    {
      key: 'wenxin',
      label: '文心一言',
      domestic: true,
      market: 'CN',
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    },
    {
      key: 'nami',
      label: '纳米',
      domestic: true,
      market: 'CN',
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    },
    {
      key: 'kimi',
      label: 'Kimi',
      domestic: true,
      market: 'CN',
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    },
    {
      key: 'zhipu',
      label: '智谱',
      domestic: true,
      market: 'CN',
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    },
  ],
};

const GLOBAL_ENGINES_RES: VisibilityEngineAvailabilityResponse = {
  collector: 'fake',
  market: 'GLOBAL',
  checkedAt: '2026-11-20T00:00:00.000Z',
  refreshIntervalMs: 300_000,
  engines: [
    {
      key: 'chatgpt',
      label: 'ChatGPT',
      domestic: false,
      market: 'GLOBAL',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
    {
      key: 'perplexity',
      label: 'Perplexity',
      domestic: false,
      market: 'GLOBAL',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
    {
      key: 'claude',
      label: 'Claude',
      domestic: false,
      market: 'GLOBAL',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
    {
      key: 'gemini',
      label: 'Gemini',
      domestic: false,
      market: 'GLOBAL',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
    {
      key: 'google_aio',
      label: 'Google AI Overviews',
      domestic: false,
      market: 'GLOBAL',
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    },
  ],
};

const CN_OVERVIEW_RES: VisibilityOverviewResponse = {
  profileId: 'bm_cn_1',
  brandId: 'brand_dual_1',
  brandMarketId: 'bm_cn_1',
  market: 'CN',
  metrics: {
    completedChecks: 4,
    mentionedChecks: 3,
    visibilityPct: 75,
    avgPosition: 1.5,
    sentimentSummary: {
      positive: 2,
      neutral: 1,
      mixed: 0,
      negative: 0,
      total: 3,
      positivePct: 66.7,
      negativePct: 0,
    },
    totalCitations: 3,
    ownedCitations: 1,
    ownedCitationChecks: 1,
    ownedCitationRatePct: 33.3,
    ownedCitationCheckRatePct: 25,
    shareOfVoice: {
      totalMentions: 5,
      brandMentions: 3,
      brandSharePct: 60,
      entries: [
        { name: '极光NAS', isBrand: true, mentions: 3, sharePct: 60 },
        { name: '群晖', isBrand: false, mentions: 2, sharePct: 40 },
      ],
    },
    topDomains: [],
  },
  trend: [
    {
      date: '2026-11-19',
      engine: 'all',
      completedChecks: 2,
      mentionedChecks: 1,
      visibilityPct: 50,
    },
    {
      date: '2026-11-20',
      engine: 'all',
      completedChecks: 2,
      mentionedChecks: 2,
      visibilityPct: 100,
    },
  ],
  byEngine: [
    {
      engine: 'deepseek',
      completedChecks: 2,
      mentionedChecks: 2,
      visibilityPct: 100,
      avgPosition: 1,
    },
    { engine: 'doubao', completedChecks: 2, mentionedChecks: 1, visibilityPct: 50, avgPosition: 2 },
  ],
};

const GLOBAL_OVERVIEW_RES: VisibilityOverviewResponse = {
  ...CN_OVERVIEW_RES,
  profileId: 'bm_gl_1',
  brandMarketId: 'bm_gl_1',
  market: 'GLOBAL',
  metrics: {
    ...CN_OVERVIEW_RES.metrics,
    visibilityPct: 40,
    completedChecks: 5,
    mentionedChecks: 2,
  },
  byEngine: [
    {
      engine: 'chatgpt',
      completedChecks: 3,
      mentionedChecks: 1,
      visibilityPct: 33.3,
      avgPosition: 2,
    },
    {
      engine: 'perplexity',
      completedChecks: 2,
      mentionedChecks: 1,
      visibilityPct: 50,
      avgPosition: 1,
    },
  ],
};

const SAMPLE_RUN_DETAIL: VisibilityRunDetailRecord = {
  id: 'vrun_sample_1',
  profileId: 'bm_cn_1',
  profileName: '极光NAS',
  brandName: '极光NAS',
  brandId: 'brand_dual_1',
  brandMarketId: 'bm_cn_1',
  market: 'CN',
  keywordId: null,
  keywordMain: null,
  name: 'CN首轮监测',
  engines: ['deepseek', 'doubao'],
  prompts: ['家用静音四盘位NAS推荐'],
  questionIds: [],
  triggerType: 'MANUAL',
  retestArticleId: null,
  totalChecks: 2,
  doneCount: 2,
  failCount: 0,
  skipCount: 0,
  unitPrice: 2,
  frozenPoints: 4,
  settledPoints: 4,
  releasedPoints: 0,
  reservationId: null,
  status: 'COMPLETED',
  visibilityPct: 100,
  lastError: null,
  createdAt: '2026-11-20T06:00:00.000Z',
  updatedAt: '2026-11-20T06:01:00.000Z',
  finishedAt: '2026-11-20T06:01:00.000Z',
  metrics: CN_OVERVIEW_RES.metrics,
  observations: [
    {
      id: 'obs_1',
      runId: 'vrun_sample_1',
      profileId: 'bm_cn_1',
      brandId: 'brand_dual_1',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      questionId: null,
      promptText: '家用静音四盘位NAS推荐',
      engine: 'deepseek',
      status: 'SUCCESS',
      collectorKind: 'fake',
      answerText: '1. 极光NAS：静音且功耗低。\n2. 群晖：生态成熟。',
      brandMentioned: true,
      brandPosition: 1,
      brandSentiment: 'positive',
      brandPassage: '1. 极光NAS：静音且功耗低。',
      competitorHits: [{ name: '群晖', mentioned: true, position: 2, sentiment: 'neutral' }],
      fanOutQueries: ['安静NAS', '四盘位NAS'],
      judgeModel: 'fake',
      tokensIn: 10,
      tokensOut: 10,
      error: null,
      checkedAt: '2026-11-20T06:01:00.000Z',
      createdAt: '2026-11-20T06:00:00.000Z',
      citations: [
        {
          id: 'cite_1',
          url: 'https://jiguangnas.cn/specs',
          domain: 'jiguangnas.cn',
          title: '极光NAS参数',
          snippet: '实测噪音 19dB',
          sourceKind: 'OWNED',
          position: 1,
          createdAt: '2026-11-20T06:01:00.000Z',
        },
      ],
    },
  ],
};

const SAMPLE_RUNS_RES: VisibilityRunListResponse = {
  page: 1,
  pageSize: 25,
  total: 1,
  items: [SAMPLE_RUN_DETAIL],
};

const SAMPLE_CITATIONS_RES: VisibilityCitationListResponse = {
  page: 1,
  pageSize: 25,
  total: 2,
  totalCitations: 3,
  sourceBreakdown: {
    OWNED: 1,
    COMPETITOR: 1,
    SOCIAL: 1,
    AUTHORITY: 0,
    ECOMMERCE: 0,
    OTHER: 0,
  },
  items: [
    {
      domain: 'synology.com',
      sourceKind: 'COMPETITOR',
      citationCount: 2,
      questionCount: 1,
      topUrls: [
        { url: 'https://synology.com/review', title: '群晖对比页', count: 2 },
        { url: 'javascript:alert(1)', title: '恶意脚本测试链接', count: 1 },
      ],
    },
  ],
};

const SAMPLE_OPPS_RES: VisibilityOpportunitiesResponse = {
  gaps: [
    {
      promptText: '入门四盘位NAS推荐',
      questionId: null,
      competitors: ['群晖'],
      engines: ['deepseek'],
      observationCount: 1,
      latestCheckedAt: '2026-11-20T06:00:00.000Z',
    },
  ],
  fanOutQueries: [
    {
      query: '安静NAS',
      frequency: 3,
      sourcePrompts: ['家用静音四盘位NAS推荐'],
      engines: ['deepseek'],
      brandMentionedPct: 66.7,
    },
    {
      query: '家用NAS功耗',
      frequency: 2,
      sourcePrompts: ['家用静音四盘位NAS推荐'],
      engines: ['doubao'],
      brandMentionedPct: 50,
    },
  ],
};

const SAMPLE_ACCOUNT: ConsoleContextValue['account'] = {
  id: 'u-vis-1',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-vis-1',
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

describe('VisibilityWorkspace 3-Tab dual-market UI', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
    mockConfirm.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    window.history.replaceState(null, '', '/visibility');
    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(visibilityApi, 'fetchVisibilityNearMiss').mockResolvedValue({
      brandId: 'brand_dual_1',
      market: 'CN',
      days: 14,
      total: 0,
      tierCounts: {
        OPENED_NOT_CITED: 0,
        RETRIEVED_NOT_CITED: 0,
        CRAWLED_NOT_CITED: 0,
        MENTIONED_NOT_OWNED: 0,
      },
      hasRawRetrievalSignals: false,
      items: [],
    });
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValue({
      brandId: 'brand_dual_1',
      truthAgreementSignedAt: '2026-11-18T00:00:00.000Z',
      totalChars: 0,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders cold-load Skeleton without 0% / 0 点 / 免费体验期 flash while brandsLoading=true', () => {
    useWorkspaceStore.setState({ brandsLoading: true, brandsLoaded: false, brands: [] });

    render(
      <ConsoleProvider value={makeConsoleContext({ walletLoading: true, wallet: null })}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    const loadingEl = screen.getByTestId('visibility-loading');
    expect(loadingEl.getAttribute('aria-busy')).toBe('true');
    expect(loadingEl.textContent).not.toContain('0 点');
    expect(loadingEl.textContent).not.toContain('免费体验期');
    expect(loadingEl.textContent).not.toContain('0.0%');
  });

  it('switches 3 tabs cleanly, enforces CN (8) vs GLOBAL (5) isolation with AbortController anti-race, and pre-checks only online engines', async () => {
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: 'brand_dual_1',
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    let resolveDelayedCnOverview!: (val: VisibilityOverviewResponse) => void;
    let cnOverviewSignal: AbortSignal | undefined;
    let overviewCalls = 0;

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockImplementation(
      (_bid, market, _p, opts) => {
        overviewCalls += 1;
        if (market === 'CN' && overviewCalls === 1) {
          return Promise.resolve(CN_OVERVIEW_RES);
        }
        if (market === 'CN') {
          cnOverviewSignal = opts?.signal;
          return new Promise((resolve) => {
            resolveDelayedCnOverview = resolve;
          });
        }
        return Promise.resolve(GLOBAL_OVERVIEW_RES);
      },
    );
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockImplementation(async (_bid, market) =>
      market === 'CN' ? CN_ENGINES_RES : GLOBAL_ENGINES_RES,
    );
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    // Tab 1: CN SonarDial has exactly 8 spokes
    await waitFor(() => {
      expect(document.querySelector('.gm-sonar')?.getAttribute('data-engine-count')).toBe('8');
    });
    expect(screen.getAllByText('75.0%').length).toBeGreaterThan(0);

    // Switch to Tab 2 (Runs): 8 CN engines, ONLY 2 online pre-checked, 6 offline disabled with 暂未上线
    fireEvent.click(screen.getByTestId('visibility-tab-runs'));
    expect(window.location.search).toContain('tab=runs');

    await waitFor(() => {
      expect(screen.getByTestId('engine-option-deepseek')).toBeTruthy();
      expect(screen.getByTestId('engine-option-yuanbao')).toBeTruthy();
    });
    expect(document.querySelectorAll('[data-testid^="engine-option-"]')).toHaveLength(8);
    expect(screen.queryByTestId('engine-option-chatgpt')).toBeNull();

    const deepseekBox = within(screen.getByTestId('engine-option-deepseek')).getByRole('checkbox');
    const yuanbaoBox = within(screen.getByTestId('engine-option-yuanbao')).getByRole('checkbox');
    expect((deepseekBox as HTMLInputElement).checked).toBe(true);
    expect((yuanbaoBox as HTMLInputElement).checked).toBe(false);
    expect((yuanbaoBox as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('engine-option-yuanbao').textContent).toContain('暂未上线');

    // Trigger a delayed CN overview request, then immediately switch global market to GLOBAL
    fireEvent.click(screen.getByTestId('visibility-tab-overview'));
    fireEvent.click(screen.getByText('30 天'));
    expect(cnOverviewSignal?.aborted).toBe(false);

    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL');
    });

    // Previous in-flight CN request MUST be aborted!
    expect(cnOverviewSignal?.aborted).toBe(true);

    // Late resolution of stale CN response must be ignored; GLOBAL 5 spokes & 40.0% must win
    await act(async () => {
      resolveDelayedCnOverview(CN_OVERVIEW_RES);
    });

    await waitFor(() => {
      expect(document.querySelector('.gm-sonar')?.getAttribute('data-engine-count')).toBe('5');
      expect(screen.getAllByText('40.0%').length).toBeGreaterThan(0);
    });

    // Switch to Tab 2 on GLOBAL: strictly 5 GLOBAL engines, zero CN engines
    fireEvent.click(screen.getByTestId('visibility-tab-runs'));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="engine-option-"]')).toHaveLength(5);
    });
    expect(screen.getByTestId('engine-option-chatgpt')).toBeTruthy();
    expect(screen.queryByTestId('engine-option-deepseek')).toBeNull();
  });

  it('creates run with Idempotency-Key, refreshes wallet, uses useUxFeedback().confirm on delete, renders Tab 3 XSS-safe citations & Fan-Out, and respects readOnly', async () => {
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: 'brand_dual_1',
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);
    const createSpy = vi
      .spyOn(visibilityApi, 'createVisibilityRun')
      .mockResolvedValue(SAMPLE_RUN_DETAIL);
    const deleteSpy = vi
      .spyOn(visibilityApi, 'deleteVisibilityRun')
      .mockResolvedValue({ deleted: 1 });

    const refreshWallet = vi.fn(async () => undefined);
    const { rerender } = render(
      <ConsoleProvider value={makeConsoleContext({ refreshWallet })}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    // Tab 2: click seedPrompt chip, verify live estimate (1 prompt * 2 online engines * 2 = 4 pts) & submit
    fireEvent.click(screen.getByTestId('visibility-tab-runs'));
    await waitFor(() => {
      expect(screen.getByTestId('engine-option-deepseek')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('+ 家用静音四盘位NAS推荐'));
    const submitBtn = screen.getByRole('button', { name: /发起监测（4 点）/ });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    const [brandArg, payloadArg, idemArg] = createSpy.mock.calls[0]!;
    expect(brandArg).toBe('brand_dual_1');
    expect(payloadArg).toEqual({
      market: 'CN',
      prompts: ['家用静音四盘位NAS推荐'],
      engines: ['deepseek', 'doubao'],
    });
    expect(typeof idemArg).toBe('string');
    expect(idemArg.length).toBeGreaterThanOrEqual(8);
    expect(refreshWallet).toHaveBeenCalled();

    // Delete run triggers useUxFeedback().confirm (NOT Modal.confirm)
    const deleteBtn = screen.getByRole('button', { name: '删除' });
    fireEvent.click(deleteBtn);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmOpts = mockConfirm.mock.calls[0]![0] as { onOk?: () => Promise<void> };
    await act(async () => {
      await confirmOpts.onOk?.();
    });
    expect(deleteSpy).toHaveBeenCalledWith('brand_dual_1', 'vrun_sample_1', 'CN');

    // Tab 3: all 6 CITATION_SOURCE_KINDS filter pills, XSS-safe links, Fan-Out multi-select
    fireEvent.click(screen.getByTestId('visibility-tab-citations'));
    await waitFor(() => {
      for (const kind of CITATION_SOURCE_KINDS) {
        expect(screen.getByTestId(`citation-filter-${kind}`)).toBeTruthy();
      }
    });

    // Safe https link has rel="noopener noreferrer"; javascript: link is NOT rendered as <a href>
    const safeLink = screen.getByRole('link', { name: /synology\.com\/review/ });
    expect(safeLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();

    // Fan-Out checkbox multi-select
    const fanOutCb = screen.getByLabelText('选择拆解词-安静NAS');
    fireEvent.click(fanOutCb);
    expect(screen.getByText(/个拆解词/).textContent).toContain('1');

    // Read-only expired tenant mode disables mutating CTA while allowing browsing
    rerender(
      <ConsoleProvider value={makeConsoleContext({ readOnly: true })}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );
    const topCta = screen.getByRole('button', { name: '发起新监测' });
    expect((topCta as HTMLButtonElement).disabled).toBe(true);
  });

  it('never fires cross-market fetchVisibilityRunDetail on CN->GLOBAL switch and resets submitting lockout when createVisibilityRun is in-flight (B1 & B2)', async () => {
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: 'brand_dual_1',
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockImplementation(async (_b, market) =>
      market === 'CN' ? CN_OVERVIEW_RES : GLOBAL_OVERVIEW_RES,
    );
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockImplementation(async (_b, market) =>
      market === 'CN' ? CN_ENGINES_RES : GLOBAL_ENGINES_RES,
    );
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockImplementation(async (_b, market) =>
      market === 'CN' ? SAMPLE_RUNS_RES : { page: 1, pageSize: 25, total: 0, items: [] },
    );
    const runDetailSpy = vi
      .spyOn(visibilityApi, 'fetchVisibilityRunDetail')
      .mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);

    let resolvePendingCreate!: (val: VisibilityRunDetailRecord) => void;
    vi.spyOn(visibilityApi, 'createVisibilityRun').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePendingCreate = resolve;
        }),
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    // Wait for CN run auto-selection and CN detail load
    await waitFor(() => {
      expect(runDetailSpy).toHaveBeenCalledWith(
        'brand_dual_1',
        'vrun_sample_1',
        'CN',
        expect.anything(),
      );
    });

    // Open Tab 2 and submit a CN run (stays in-flight)
    fireEvent.click(screen.getByTestId('visibility-tab-runs'));
    await waitFor(() => {
      expect(screen.getByText('+ 家用静音四盘位NAS推荐')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('+ 家用静音四盘位NAS推荐'));
    fireEvent.click(screen.getByRole('button', { name: /发起监测（4 点）/ }));

    const promptsTextarea = screen.getByLabelText('监测问题列表') as HTMLTextAreaElement;
    expect(promptsTextarea.disabled).toBe(true);

    // Switch market CN -> GLOBAL while createVisibilityRun is still pending
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL');
    });

    // Form MUST unlock immediately on GLOBAL, and zero cross-market fetchVisibilityRunDetail calls may occur
    await waitFor(() => {
      expect((screen.getByLabelText('监测问题列表') as HTMLTextAreaElement).disabled).toBe(false);
    });

    await act(async () => {
      resolvePendingCreate(SAMPLE_RUN_DETAIL);
    });

    const crossMarketDetailCalls = runDetailSpy.mock.calls.filter(
      ([_b, runId, market]) => runId === 'vrun_sample_1' && market === 'GLOBAL',
    );
    expect(crossMarketDetailCalls).toEqual([]);
    expect((screen.getByLabelText('监测问题列表') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('enforces table-layout: fixed on Tab 2 runs table and both Tab 3 citation/fan-out tables (#306)', async () => {
    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: 'brand_dual_1',
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue({
      ...SAMPLE_OPPS_RES,
      fanOutQueries: [
        ...SAMPLE_OPPS_RES.fanOutQueries,
        {
          query: '无覆盖率字段测试词',
          frequency: 1,
          sourcePrompts: ['家用静音四盘位NAS推荐'],
          engines: ['deepseek'],
          brandMentionedPct: undefined,
        },
      ],
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(screen.getByTestId('visibility-tab-runs'));
    await waitFor(() => {
      const runsTable = document.querySelector(
        '.gm-vis-table-wrap table',
      ) as HTMLTableElement | null;
      expect(runsTable).not.toBeNull();
      expect(runsTable?.style.tableLayout).toBe('fixed');
    });

    fireEvent.click(screen.getByTestId('visibility-tab-citations'));
    await waitFor(() => {
      const allVisTables = Array.from(
        document.querySelectorAll('.gm-vis-table-wrap table'),
      ) as HTMLTableElement[];
      expect(allVisTables).toHaveLength(3);
      expect(allVisTables.map((t) => t.style.tableLayout)).toEqual(['fixed', 'fixed', 'fixed']);
    });
    expect(document.body.textContent).not.toContain('NaN%');
  });

  it('integrates M3 BriefListPanel + GeoBriefDrawer across all 3 tabs and aborts/closes drawer on market switch', async () => {
    const sampleBrief1: GeoBriefRecord = {
      id: 'brief_m3_1',
      brandId: 'brand_dual_1',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      sourceType: 'AUTO_GAP',
      sourceRunId: 'vrun_sample_1',
      sourceObservationIds: ['obs_1'],
      sourceCitationUrl: null,
      targetPrompt: '家用静音四盘位NAS推荐',
      priorityScore: 95,
      diagnosisSummary: '豆包与 DeepSeek 未提及本品牌，群晖占据主要推荐位。',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: '2026 家用静音四盘位 NAS 权威选购指南',
      outlineH2: [
        { heading: '一、核心选购结论', intent: '首段直答' },
        { heading: '二、四盘位参数对比表', intent: '横向对比' },
        { heading: '三、常见痛点 FAQ', intent: '切片答疑' },
      ],
      targetFanOuts: ['安静NAS'],
      competitorFocus: ['群晖'],
      matchedFactIds: [],
      missingFactHints: ['建议补充待机功耗实测'],
      recommendedChannels: [{ channel: '知乎', reason: '高权重问答社区' }],
      status: 'OPEN',
      createdAt: '2026-11-20T06:00:00.000Z',
      updatedAt: '2026-11-20T06:00:00.000Z',
    };

    const sampleBrief2: GeoBriefRecord = {
      ...sampleBrief1,
      id: 'brief_m3_2',
      sourceType: 'LOW_RANK',
      priorityScore: 76,
      suggestedTitle: '2026 四盘位 NAS 性价比实测对比',
    };

    useWorkspaceStore.setState({
      brands: [DUAL_BRAND],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: 'brand_dual_1',
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);

    const fetchBriefsSpy = vi
      .spyOn(briefsApi, 'fetchBriefs')
      .mockResolvedValue({ items: [sampleBrief1, sampleBrief2], total: 2 });
    const generateBriefSpy = vi.spyOn(briefsApi, 'generateBrief').mockResolvedValue(sampleBrief1);
    const counterFromUrlSpy = vi.spyOn(briefsApi, 'createBriefFromCitationUrl').mockResolvedValue({
      ...sampleBrief1,
      sourceType: 'CITATION_COUNTER',
      recommendedRecipe: 'CITATION_COUNTER',
      sourceCitationUrl: 'https://synology.com/review',
    });
    const updateBriefSpy = vi
      .spyOn(briefsApi, 'updateBrief')
      .mockImplementation(async (_id, patch) => ({
        ...sampleBrief1,
        ...patch,
        updatedAt: '2026-11-20T07:00:00.000Z',
      }));
    const dismissBriefSpy = vi
      .spyOn(briefsApi, 'dismissBrief')
      .mockResolvedValue({ ...sampleBrief2, status: 'DISMISSED' });

    const navigateWorkspace = vi.fn();

    render(
      <ConsoleProvider value={makeConsoleContext({ navigateWorkspace })}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    // Tab 1: BriefListPanel renders both cards, supports 2-item multi-select, filter, dismiss, and drawer handoff
    await waitFor(() => {
      expect(screen.getByTestId('brief-card-brief_m3_1')).toBeTruthy();
      expect(screen.getByTestId('brief-card-brief_m3_2')).toBeTruthy();
    });

    const batchBtn = screen.getByTestId('briefs-batch-btn') as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(`选择写作建议-${sampleBrief1.suggestedTitle}`));
    fireEvent.click(screen.getByLabelText(`选择写作建议-${sampleBrief2.suggestedTitle}`));
    expect(batchBtn.disabled).toBe(false);

    // Dismiss card 2 via useUxFeedback().confirm
    const card2 = screen.getByTestId('brief-card-brief_m3_2');
    fireEvent.click(within(card2).getByRole('button', { name: '忽略' }));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = mockConfirm.mock.calls[0]?.[0] as { onOk: () => Promise<void> };
    await act(async () => {
      await confirmArg.onOk();
    });
    expect(dismissBriefSpy).toHaveBeenCalledWith('brief_m3_2');

    // Open drawer from card 1, edit title, click write -> auto-saves PATCH & navigates to /studio?brandId=&market=&briefId=
    const card1 = screen.getByTestId('brief-card-brief_m3_1');
    fireEvent.click(within(card1).getByRole('button', { name: '查看详细意见' }));
    const drawer = await screen.findByTestId('geo-brief-drawer');
    fireEvent.change(within(drawer).getByTestId('brief-drawer-title'), {
      target: { value: '2026 家用四盘位 NAS 终极选购指南' },
    });
    fireEvent.click(within(drawer).getByTestId('brief-drawer-write-btn'));

    await waitFor(() => {
      expect(updateBriefSpy).toHaveBeenCalledWith(
        'brief_m3_1',
        expect.objectContaining({ suggestedTitle: '2026 家用四盘位 NAS 终极选购指南' }),
      );
      expect(navigateWorkspace).toHaveBeenCalledWith(
        '/studio?brandId=brand_dual_1&market=CN&briefId=brief_m3_1',
      );
    });

    // Tab 2: answer-brief-btn generates brief from observationIds and opens drawer
    fireEvent.click(screen.getByTestId('visibility-tab-runs'));
    const answerBtn = await screen.findByTestId('answer-brief-btn');
    fireEvent.click(answerBtn);
    await waitFor(() => {
      expect(generateBriefSpy).toHaveBeenCalledWith(
        'brand_dual_1',
        expect.objectContaining({
          market: 'CN',
          observationIds: ['obs_1'],
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(await screen.findByTestId('geo-brief-drawer')).toBeTruthy();

    // Market switch closes stale drawer & resets selections synchronously
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('geo-brief-drawer')).toBeNull();
    });
    expect(fetchBriefsSpy).toHaveBeenCalledWith(
      'brand_dual_1',
      'GLOBAL',
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    // Tab 3: citation-counter-btn rendered ONLY for safe https URL (NOT javascript:alert(1)), and fanout-cluster-btn works
    fireEvent.click(screen.getByTestId('visibility-tab-citations'));
    await waitFor(() => {
      const counterBtns = screen.getAllByTestId('citation-counter-btn');
      expect(counterBtns).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('citation-counter-btn'));
    await waitFor(() => {
      expect(counterFromUrlSpy).toHaveBeenCalledWith(
        'brand_dual_1',
        expect.objectContaining({
          market: 'GLOBAL',
          citationUrl: 'https://synology.com/review',
        }),
        expect.any(Object),
      );
    });

    // Close drawer, check 2 fan-outs, click fanout-cluster-btn
    fireEvent.click(screen.getByLabelText('关闭写作意见抽屉'));
    fireEvent.click(screen.getByLabelText('选择拆解词-安静NAS'));
    fireEvent.click(screen.getByLabelText('选择拆解词-家用NAS功耗'));
    fireEvent.click(screen.getByTestId('fanout-cluster-btn'));
    await waitFor(() => {
      expect(generateBriefSpy).toHaveBeenCalledWith(
        'brand_dual_1',
        expect.objectContaining({
          market: 'GLOBAL',
          sourceType: 'FANOUT_CLUSTER',
          fanOutQueries: ['安静NAS', '家用NAS功耗'],
        }),
        expect.any(Object),
      );
    });

    // Switching back to Tab 1 (overview) triggers an immediate silent brief refresh
    const callsBeforeOverviewSwitch = fetchBriefsSpy.mock.calls.length;
    fireEvent.click(screen.getByTestId('visibility-tab-overview'));
    await waitFor(() => {
      expect(fetchBriefsSpy.mock.calls.length).toBeGreaterThan(callsBeforeOverviewSwitch);
    });
  });

  it('launches POST /articles/batch from Tab 1 briefs-batch-btn and navigates to /studio with batchJobId', async () => {
    const brief1: GeoBriefRecord = {
      id: 'brief_b_1',
      brandId: 'brand_dual_1',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      sourceType: 'AUTO_GAP',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: null,
      targetPrompt: '四盘位静音家用 NAS 推荐',
      priorityScore: 95,
      diagnosisSummary: '竞品命中 2 引擎',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: '静音 NAS 选购指南',
      outlineH2: [],
      targetFanOuts: [],
      competitorFocus: ['群晖'],
      matchedFactIds: [],
      missingFactHints: [],
      recommendedChannels: [],
      status: 'OPEN',
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const brief2: GeoBriefRecord = {
      ...brief1,
      id: 'brief_b_2',
      suggestedTitle: '静音 NAS 功耗横评',
      priorityScore: 88,
    };

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);
    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({ items: [brief1, brief2], total: 2 });

    const createBatchSpy = vi.spyOn(studioApi, 'createBatchJob').mockResolvedValue({
      id: 'gb_from_vis_1',
      brandId: 'brand_dual_1',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      briefIds: ['brief_b_1', 'brief_b_2'],
      total: 2,
      doneCount: 0,
      failCount: 0,
      unitPrice: 10,
      reservationId: 'res_vis_1',
      status: 'QUEUED',
      lastError: null,
      createdAt: '2026-11-20T01:00:00.000Z',
      updatedAt: '2026-11-20T01:00:00.000Z',
      finishedAt: null,
    });

    const navigateWorkspace = vi.fn();
    const refreshWallet = vi.fn(async () => undefined);
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
    });

    render(
      <ConsoleProvider value={makeConsoleContext({ navigateWorkspace, refreshWallet })}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(await screen.findByLabelText('选择写作建议-静音 NAS 选购指南'));
    fireEvent.click(screen.getByLabelText('选择写作建议-静音 NAS 功耗横评'));
    fireEvent.click(screen.getByTestId('briefs-batch-btn'));

    await waitFor(() => {
      expect(createBatchSpy).toHaveBeenCalledWith(
        'brand_dual_1',
        { market: 'CN', briefIds: ['brief_b_1', 'brief_b_2'] },
        expect.any(String),
      );
      expect(navigateWorkspace).toHaveBeenCalledWith(
        '/studio?brandId=brand_dual_1&market=CN&batchJobId=gb_from_vis_1',
      );
      expect(refreshWallet).toHaveBeenCalled();
    });
  });

  it('opens CitationCounterModal pasted-content fallback on 422/42201 from Tab 3 citation-counter-btn and resets synchronously on market switch (M4-B #332)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);
    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValue({
      brandId: DUAL_BRAND.id,
      truthAgreementSignedAt: null,
      totalChars: 0,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    });

    const createdCounterBrief: GeoBriefRecord = {
      id: 'brief_fallback_1',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      sourceType: 'CITATION_COUNTER',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: 'https://synology.com/review',
      targetPrompt: '四盘位家用 NAS 对比评测反制',
      priorityScore: 74,
      diagnosisSummary: '已基于粘贴参考正文提炼核心议题并生成超越版意见卡。',
      recommendedRecipe: 'CITATION_COUNTER',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: '2026 四盘位家用 NAS 实测超越指南',
      outlineH2: [{ heading: '噪音与功耗对比表', intent: '提供对比表格' }],
      targetFanOuts: ['安静NAS'],
      competitorFocus: ['群晖'],
      matchedFactIds: ['fact_1'],
      missingFactHints: [],
      recommendedChannels: [{ channel: '知乎', reason: '覆盖深度评测问答' }],
      status: 'OPEN',
      createdAt: '2026-11-20T08:00:00.000Z',
      updatedAt: '2026-11-20T08:00:00.000Z',
    };

    const counterSpy = vi
      .spyOn(briefsApi, 'createBriefFromCitationUrl')
      .mockRejectedValueOnce(
        new GatewayApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '目标网页受反爬限制无法直接抓取，请改用「粘贴参考正文」继续反制',
        ),
      )
      .mockRejectedValueOnce(
        new GatewayApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '目标网页触发反爬拦截，请改用「粘贴参考正文」继续反制',
        ),
      )
      .mockResolvedValueOnce({ ...createdCounterBrief, market: 'GLOBAL' });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(screen.getByTestId('visibility-tab-citations'));
    fireEvent.click(await screen.findByTestId('citation-counter-btn'));

    // 422/42201 opens CitationCounterModal in fallback mode
    const fallbackBox = await screen.findByTestId('counter-pasted-fallback');
    expect(fallbackBox.textContent).toContain('粘贴参考正文');

    // Market switch closes fallback modal synchronously
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('citation-counter-modal')).toBeNull();
    });

    // Trigger again on GLOBAL -> submit pasted fallback -> opens GeoBriefDrawer
    fireEvent.click(await screen.findByTestId('citation-counter-btn'));
    await screen.findByTestId('counter-pasted-fallback');
    fireEvent.change(screen.getByTestId('counter-pasted-content'), {
      target: {
        value:
          '## Benchmark Summary\nCompetitor model runs at 32dB and 24W idle without local AI photo indexing.',
      },
    });
    fireEvent.click(screen.getByTestId('counter-submit-btn'));

    await waitFor(() => {
      expect(counterSpy).toHaveBeenLastCalledWith(
        DUAL_BRAND.id,
        expect.objectContaining({
          market: 'GLOBAL',
          citationUrl: 'https://synology.com/review',
          pastedContent: expect.stringContaining('Benchmark Summary'),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByTestId('geo-brief-drawer')).toBeTruthy();
    });
  });

  it('renders SignalError with retry instead of zero-brand empty state when brandsError is set (W-04)', () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: '品牌服务暂时不可用',
      brands: [],
      activeBrandId: null,
      activeMarket: 'CN',
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    expect(screen.getByText('品牌服务暂时不可用')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(screen.queryByText('尚未创建品牌资产')).toBeNull();
  });

  it('integrates Near-Miss panel in Citations tab, filters THIRD_PARTY client-side without leaking sourceKind=THIRD_PARTY, and navigates to /studio after boost-brief (#372)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);

    const nearMissSpy = vi.spyOn(visibilityApi, 'fetchVisibilityNearMiss').mockResolvedValue({
      brandId: DUAL_BRAND.id,
      market: 'CN',
      days: 14,
      total: 2,
      tierCounts: {
        OPENED_NOT_CITED: 1,
        RETRIEVED_NOT_CITED: 1,
        CRAWLED_NOT_CITED: 0,
        MENTIONED_NOT_OWNED: 0,
      },
      hasRawRetrievalSignals: true,
      items: [
        {
          id: 'nm_owned_1',
          tier: 'OPENED_NOT_CITED',
          opportunityScore: 93,
          url: 'https://aurora-nas.cn/quiet-benchmark',
          domain: 'aurora-nas.cn',
          title: '极光NAS 静音实测参数页',
          snippet: '实测 18dB 低噪表现',
          sourceKind: 'OWNED',
          isOwned: true,
          engines: ['deepseek'],
          prompts: ['静音四盘位家用NAS推荐'],
          observationIds: ['obs_1'],
          openedCount: 2,
          retrievedCount: 4,
          lastSeenAt: '2026-11-23T08:00:00.000Z',
        },
        {
          id: 'nm_third_1',
          tier: 'RETRIEVED_NOT_CITED',
          opportunityScore: 80,
          url: 'https://zhihu.com/question/999',
          domain: 'zhihu.com',
          title: '知乎 NAS 选型讨论',
          snippet: '第三方检索候选页面',
          sourceKind: 'SOCIAL',
          isOwned: false,
          engines: ['deepseek'],
          prompts: ['家用NAS选型指南'],
          observationIds: ['obs_2'],
          openedCount: 0,
          retrievedCount: 3,
          lastSeenAt: '2026-11-23T07:00:00.000Z',
        },
      ],
    });

    const createdBoostBrief: GeoBriefRecord = {
      id: 'brief_near_miss_1',
      brandId: DUAL_BRAND.id,
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      sourceType: 'NEAR_MISS_BOOST',
      sourceRunId: null,
      sourceObservationIds: ['obs_1'],
      sourceCitationUrl: 'https://aurora-nas.cn/quiet-benchmark',
      targetPrompt: '静音四盘位家用NAS推荐',
      priorityScore: 93,
      diagnosisSummary: 'AI 已点开官网页但尚未正式引用，建议补充首段直答与参数对比表。',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: '极光NAS 四盘位静音实测补强指南',
      outlineH2: [{ heading: '首段直接结论', intent: '补充可引用结论' }],
      targetFanOuts: ['静音NAS'],
      competitorFocus: ['群晖'],
      matchedFactIds: ['fact_1'],
      missingFactHints: [],
      recommendedChannels: [{ channel: '官网博客 / 文档', reason: '承接直连引用' }],
      status: 'OPEN',
      createdAt: '2026-11-23T09:00:00.000Z',
      updatedAt: '2026-11-23T09:00:00.000Z',
    };

    const boostSpy = vi
      .spyOn(briefsApi, 'createBriefFromNearMiss')
      .mockResolvedValueOnce(createdBoostBrief);
    const invalidateSpy = vi.spyOn(freshnessLib, 'invalidateFreshness');
    const navigateWorkspace = vi.fn();

    render(
      <ConsoleProvider value={makeConsoleContext({ navigateWorkspace })}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(screen.getByTestId('visibility-tab-citations'));
    const nmPanel = await screen.findByTestId('visibility-near-miss-panel');
    expect(nmPanel.textContent).toContain('差一步被引用（Near-Miss）');
    expect(await screen.findByTestId('near-miss-boost-btn-nm_owned_1')).toBeTruthy();

    // Switch to THIRD_PARTY -> MUST NOT pass sourceKind='THIRD_PARTY' to backend!
    fireEvent.click(screen.getByTestId('near-miss-ownership-THIRD_PARTY'));
    await waitFor(() => {
      const lastCallParams = nearMissSpy.mock.calls.at(-1)?.[2];
      expect(lastCallParams?.sourceKind).toBeUndefined();
      expect(screen.queryByTestId('near-miss-boost-btn-nm_owned_1')).toBeNull();
      expect(screen.getByTestId('near-miss-boost-btn-nm_third_1')).toBeTruthy();
    });

    // Switch to OWNED -> passes sourceKind='OWNED'
    fireEvent.click(screen.getByTestId('near-miss-ownership-OWNED'));
    await waitFor(() => {
      const lastCallParams = nearMissSpy.mock.calls.at(-1)?.[2];
      expect(lastCallParams?.sourceKind).toBe('OWNED');
    });

    // One-click boost -> POST /briefs/from-near-miss + invalidateFreshness('briefs') + navigate /studio
    fireEvent.click(await screen.findByTestId('near-miss-boost-btn-nm_owned_1'));
    await waitFor(() => {
      expect(boostSpy).toHaveBeenCalledWith(
        DUAL_BRAND.id,
        expect.objectContaining({
          market: 'CN',
          tier: 'OPENED_NOT_CITED',
          targetPrompt: '静音四盘位家用NAS推荐',
          sourceUrl: 'https://aurora-nas.cn/quiet-benchmark',
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith('briefs');
      expect(navigateWorkspace).toHaveBeenCalledWith(
        '/studio?brandId=brand_dual_1&market=CN&briefId=brief_near_miss_1',
      );
    });
  });

  it('Tier 5 regression: clicking 重置 Near-Miss 筛选 dispatches a single non-aborted unfiltered request and restores Near-Miss items', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      brands: [DUAL_BRAND],
      activeBrandId: DUAL_BRAND.id,
      activeMarket: 'CN',
      contextEpoch: 1,
    });

    vi.spyOn(visibilityApi, 'fetchVisibilityOverview').mockResolvedValue(CN_OVERVIEW_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityEngines').mockResolvedValue(CN_ENGINES_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRuns').mockResolvedValue(SAMPLE_RUNS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityRunDetail').mockResolvedValue(SAMPLE_RUN_DETAIL);
    vi.spyOn(visibilityApi, 'fetchVisibilityCitations').mockResolvedValue(SAMPLE_CITATIONS_RES);
    vi.spyOn(visibilityApi, 'fetchVisibilityOpportunities').mockResolvedValue(SAMPLE_OPPS_RES);
    vi.spyOn(briefsApi, 'fetchBriefs').mockResolvedValue({ items: [], total: 0 });

    const allItem = {
      id: 'nm_reset_1',
      tier: 'OPENED_NOT_CITED' as const,
      opportunityScore: 91,
      url: 'https://aurora-nas.cn/reset-test',
      domain: 'aurora-nas.cn',
      title: '极光NAS 静音对比',
      snippet: '高潜候选页',
      sourceKind: 'OWNED' as const,
      isOwned: true,
      engines: ['deepseek' as const],
      prompts: ['家用四盘位NAS推荐'],
      observationIds: ['obs_1'],
      openedCount: 2,
      retrievedCount: 3,
      lastSeenAt: '2026-11-23T08:00:00.000Z',
    };

    const recordedCalls: Array<{
      tier?: string;
      sourceKind?: string;
      signal?: AbortSignal;
    }> = [];

    vi.spyOn(visibilityApi, 'fetchVisibilityNearMiss').mockImplementation(
      async (_brandId, _market, params, options) => {
        recordedCalls.push({
          tier: params?.tier,
          sourceKind: params?.sourceKind,
          signal: options?.signal,
        });
        const items = params?.tier && params.tier !== 'OPENED_NOT_CITED' ? [] : [allItem];
        return {
          brandId: DUAL_BRAND.id,
          market: 'CN',
          days: 30,
          total: items.length,
          tierCounts: {
            OPENED_NOT_CITED: 1,
            RETRIEVED_NOT_CITED: 0,
            CRAWLED_NOT_CITED: 0,
            MENTIONED_NOT_OWNED: 0,
          },
          hasRawRetrievalSignals: true,
          items,
        };
      },
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <VisibilityWorkspace />
      </ConsoleProvider>,
    );

    fireEvent.click(screen.getByTestId('visibility-tab-citations'));
    expect(await screen.findByTestId('near-miss-boost-btn-nm_reset_1')).toBeTruthy();

    // Select an empty tier -> renders empty state with reset CTA
    fireEvent.click(screen.getByTestId('near-miss-tier-CRAWLED_NOT_CITED'));
    const resetBtn = await screen.findByRole('button', { name: '重置 Near-Miss 筛选' });
    expect(screen.queryByTestId('near-miss-boost-btn-nm_reset_1')).toBeNull();

    const callsBeforeReset = recordedCalls.length;
    fireEvent.click(resetBtn);

    // Must restore all items with a SINGLE non-aborted unfiltered request
    expect(await screen.findByTestId('near-miss-boost-btn-nm_reset_1')).toBeTruthy();
    const resetCalls = recordedCalls.slice(callsBeforeReset);
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0]?.tier).toBeUndefined();
    expect(resetCalls[0]?.sourceKind).toBeUndefined();
    expect(resetCalls[0]?.signal?.aborted).toBe(false);
  });
});
