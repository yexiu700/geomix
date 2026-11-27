// @vitest-environment jsdom
import type { ActionHomeResponse, BrandRecord, GeoBriefRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandsApi from '../../lib/brands';
import * as briefsApi from '../../lib/briefs';
import * as homeApi from '../../lib/home';
import * as reportsApi from '../../lib/reports';
import * as studioApi from '../../lib/studio';
import * as visibilityApi from '../../lib/visibility';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider, type ConsoleContextValue } from '../shell/console-context';
import { HomeWorkspace } from './home-workspace';

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

const BRAND_A: BrandRecord = {
  id: 'brand_home_a',
  name: '星辰存储',
  category: '家用 NAS',
  truthAgreementSignedAt: null,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  markets: [
    {
      id: 'bm_a_cn',
      brandId: 'brand_home_a',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '星辰存储',
      aliases: [],
      ownedDomains: ['star.example.com'],
      competitors: [],
      seedPrompts: ['静音 NAS'],
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    {
      id: 'bm_a_gl',
      brandId: 'brand_home_a',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AstraVault',
      aliases: [],
      ownedDomains: ['astravault.example.com'],
      competitors: [],
      seedPrompts: ['Best quiet NAS'],
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
  ],
};

const BRAND_B: BrandRecord = {
  id: 'brand_home_b',
  name: '蓝鲸电源',
  category: '户外电源',
  truthAgreementSignedAt: null,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  markets: [
    {
      id: 'bm_b_cn',
      brandId: 'brand_home_b',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '蓝鲸电源',
      aliases: [],
      ownedDomains: ['bluewhale.example.com'],
      competitors: [],
      seedPrompts: ['露营户外电源推荐'],
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    },
  ],
};

function makeHomeData(
  brandId: string,
  market: 'CN' | 'GLOBAL',
  countOverride?: number,
): ActionHomeResponse {
  const briefCount = countOverride ?? 4;
  const artCount = countOverride ?? 6;
  const brandMarketId =
    brandId === BRAND_B.id ? 'bm_b_cn' : market === 'GLOBAL' ? 'bm_a_gl' : 'bm_a_cn';
  return {
    brandId,
    brandMarketId,
    market,
    health: {
      days: 14,
      mentionRatePct: 68.5,
      shareOfVoicePct: 42,
      avgPosition: 2.1,
      ownedCitationRatePct: 35,
      completedChecks: 16,
    },
    topBriefs: Array.from({ length: briefCount }, (_, idx) => ({
      id: `brief_${brandId}_${idx + 1}`,
      sourceType: idx === 0 ? 'AUTO_GAP' : 'LOW_RANK',
      priorityScore: 95 - idx * 5,
      diagnosisSummary: `品牌 ${brandId} 缺口诊断 ${idx + 1}`,
      suggestedTitle: `${brandId} 优先建议标题 ${idx + 1}`,
      targetPrompt: `核心问句 ${idx + 1}`,
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: market === 'GLOBAL' ? 'GLOBAL_AUTHORITY_GUIDE' : 'CN_DEEP_REVIEW',
      recommendedChannels: [
        { channel: market === 'GLOBAL' ? 'Reddit' : '知乎', reason: '高权阵地' },
      ],
    })),
    recentArticles: Array.from({ length: artCount }, (_, idx) => ({
      id: `art_${brandId}_${idx + 1}`,
      title: `${brandId} 成稿标题 ${idx + 1}`,
      recipe: 'AUTHORITY_GUIDE',
      geoScore: 88,
      status: idx === 0 ? 'PUBLISHED' : 'DRAFT',
      updatedAt: '2026-11-21T00:00:00.000Z',
      publishRecord:
        idx === 0
          ? {
              id: `pub_${brandId}_1`,
              brandId,
              brandMarketId: market === 'GLOBAL' ? 'bm_a_gl' : 'bm_a_cn',
              articleId: `art_${brandId}_1`,
              publishedUrl: 'https://star.example.com/guides/1',
              channel: '官网博客',
              publishedAt: '2026-11-21T00:00:00.000Z',
              baselineRunId: 'run_base_1',
              latestRetestRunId: 'run_ret_1',
              beforeMetrics: {
                mentionRate: 0,
                avgPosition: null,
                sentiment: null,
                citationHit: false,
              },
              afterMetrics: {
                mentionRate: 100,
                avgPosition: 1,
                sentiment: 'positive',
                citationHit: true,
              },
            }
          : null,
    })),
  };
}

const SAMPLE_ACCOUNT: ConsoleContextValue['account'] = {
  id: 'u-home-1',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-home-1',
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
      billingMode: 'STRICT',
      billingModeSource: 'tenant',
      tenantBillingMode: 'STRICT',
    },
    walletLoading: false,
    openCreateBrandModal: vi.fn(),
    openEnableMarketModal: vi.fn(),
    refreshWallet: vi.fn().mockResolvedValue(undefined),
    navigateWorkspace: vi.fn(),
    ...overrides,
  };
}

describe('HomeWorkspace 3-Block Action Home (M5 #333)', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockNotifyWarning.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders cold-load Skeleton with aria-busy=true and zero 0 点 / 免费体验期 / ¥0.00 flash', () => {
    useWorkspaceStore.setState({
      brandsLoading: true,
      brandsLoaded: false,
      brands: [],
    });

    const fetchSpy = vi.spyOn(homeApi, 'fetchActionHome');
    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    const loading = screen.getByTestId('home-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/(?:^|[^\d])0\s*点/);
    expect(text).not.toContain('免费体验期');
    expect(text).not.toContain('¥0.00');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders 0-brand onboarding with exact "60 秒创建首个品牌" CTA and fires zero /home API requests', () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [],
      activeBrandId: null,
    });

    const fetchSpy = vi.spyOn(homeApi, 'fetchActionHome');
    const openCreateBrandModal = vi.fn();
    render(
      <ConsoleProvider value={makeConsoleContext({ openCreateBrandModal })}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    const btn = screen.getByRole('button', { name: '60 秒创建首个品牌' });
    fireEvent.click(btn);
    expect(openCreateBrandModal).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders 3-block Action Home capped strictly to <= 3 briefs and <= 5 articles, opens GeoBriefDrawer, navigates to /studio?briefId=..., and triggers retest', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [BRAND_A],
      activeBrandId: BRAND_A.id,
      activeMarket: 'CN',
    });

    vi.spyOn(homeApi, 'fetchActionHome').mockResolvedValueOnce(makeHomeData(BRAND_A.id, 'CN'));
    const fullBrief: GeoBriefRecord = {
      id: 'brief_brand_home_a_1',
      brandId: BRAND_A.id,
      brandMarketId: 'bm_a_cn',
      market: 'CN',
      sourceType: 'AUTO_GAP',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: null,
      targetPrompt: '核心问句 1',
      priorityScore: 95,
      diagnosisSummary: '竞品霸榜缺口诊断详情',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: 'brand_home_a 优先建议标题 1',
      outlineH2: [{ heading: '实测参数对比', intent: '提供对比表格' }],
      targetFanOuts: ['满载噪音'],
      competitorFocus: ['群晖'],
      matchedFactIds: [],
      missingFactHints: [],
      recommendedChannels: [{ channel: '知乎', reason: '高权阵地' }],
      status: 'OPEN',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };
    const getBriefSpy = vi.spyOn(briefsApi, 'getBrief').mockResolvedValueOnce(fullBrief);
    const getFactsSpy = vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValueOnce({
      brandId: BRAND_A.id,
      truthAgreementSignedAt: null,
      totalChars: 0,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    });
    const retestSpy = vi.spyOn(studioApi, 'triggerPublishRetest').mockResolvedValueOnce({
      id: 'run_retest_home_1',
      triggerType: 'RETEST',
      status: 'QUEUED',
    } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);

    const navigateWorkspace = vi.fn();
    const refreshWallet = vi.fn().mockResolvedValue(undefined);
    render(
      <ConsoleProvider value={makeConsoleContext({ navigateWorkspace, refreshWallet })}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    expect(await screen.findByTestId('home-health-strip')).toBeTruthy();
    expect(screen.getByTestId('home-kpi-mention').textContent).toContain('68.5%');
    expect(screen.getByTestId('home-kpi-position').textContent).toContain('#2.1');
    expect(document.body.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);

    // Strictly <= 3 briefs and <= 5 recent articles even when payload has 4 & 6
    const briefCards = screen.getAllByTestId(/^home-brief-card-/);
    expect(briefCards).toHaveLength(3);
    const articleRows = screen.getAllByTestId(/^home-article-row-/);
    expect(articleRows).toHaveLength(5);

    // Before -> After badge visible
    expect(screen.getByTestId('home-retest-badge-art_brand_home_a_1').textContent).toContain(
      '发布前 0% → 发布后 100%',
    );

    // Health strip CTAs navigate cleanly
    fireEvent.click(screen.getByRole('button', { name: /发起新一轮监测/ }));
    expect(navigateWorkspace).toHaveBeenCalledWith('/visibility?tab=runs');
    fireEvent.click(screen.getByRole('button', { name: /直接写 GEO 文章/ }));
    expect(navigateWorkspace).toHaveBeenCalledWith('/studio');

    // Open GeoBriefDrawer
    fireEvent.click(screen.getAllByRole('button', { name: /查看详细意见/ })[0]!);
    await waitFor(() => {
      expect(getBriefSpy).toHaveBeenCalledWith(
        'brief_brand_home_a_1',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(getFactsSpy).toHaveBeenCalled();
      expect(screen.getByTestId('geo-brief-drawer')).toBeTruthy();
    });

    // Click 一键去写 -> navigates to /studio?briefId=...
    fireEvent.click(screen.getAllByRole('button', { name: /一键去写/ })[0]!);
    expect(navigateWorkspace).toHaveBeenCalledWith('/studio?briefId=brief_brand_home_a_1');

    // Click 一键复测 on published recent article
    fireEvent.click(screen.getByTestId('home-article-retest-btn-art_brand_home_a_1'));
    await waitFor(() => {
      expect(retestSpy).toHaveBeenCalledWith(
        'pub_brand_home_a_1',
        undefined,
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(refreshWallet).toHaveBeenCalled();
    });
  });

  it('aborts in-flight Brand A /home request and ignores stale response on rapid Brand A -> Brand B switch (T3-01 anti-race)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [BRAND_A, BRAND_B],
      activeBrandId: BRAND_A.id,
      activeMarket: 'CN',
    });

    let resolveBrandA!: (value: ActionHomeResponse) => void;
    let signalA: AbortSignal | undefined;

    vi.spyOn(homeApi, 'fetchActionHome').mockImplementation((brandId, market, opts) => {
      if (brandId === BRAND_A.id) {
        signalA = opts?.signal;
        return new Promise<ActionHomeResponse>((resolve) => {
          resolveBrandA = resolve;
        });
      }
      return Promise.resolve(makeHomeData(BRAND_B.id, market, 1));
    });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    await waitFor(() => {
      expect(signalA).toBeDefined();
    });

    // Switch rapidly to Brand B while Brand A is still pending
    useWorkspaceStore.setState({ activeBrandId: BRAND_B.id, activeMarket: 'CN' });

    await waitFor(() => {
      expect(signalA?.aborted).toBe(true);
      expect(screen.getByText('brand_home_b 成稿标题 1')).toBeTruthy();
    });

    // Now resolve stale Brand A response -> MUST NOT overwrite Brand B UI!
    resolveBrandA(makeHomeData(BRAND_A.id, 'CN', 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('brand_home_a 成稿标题 1')).toBeNull();
    expect(screen.getByText('brand_home_b 成稿标题 1')).toBeTruthy();
  });

  it('renders <Skeleton> on the very first client commit before useEffect with zero 0% / empty-state flash (D-4)', () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [BRAND_A],
      activeBrandId: BRAND_A.id,
      activeMarket: 'CN',
    });

    vi.spyOn(homeApi, 'fetchActionHome').mockImplementation(() => new Promise(() => undefined));

    let firstCommitHasSkeleton = false;
    let firstCommitText = '';
    function FirstCommitProbe() {
      useLayoutEffect(() => {
        firstCommitHasSkeleton = Boolean(document.querySelector('[data-testid="home-loading"]'));
        firstCommitText = document.body.textContent ?? '';
      }, []);
      return <HomeWorkspace />;
    }

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <FirstCommitProbe />
      </ConsoleProvider>,
    );

    expect(firstCommitHasSkeleton).toBe(true);
    expect(firstCommitText).not.toContain('0%');
    expect(firstCommitText).not.toContain('暂无待处理的优先写作建议');
    expect(firstCommitText).not.toContain('尚未生成 GEO 成稿');
  });

  it('blocks same-tick billable retest double-click (D-1) and emits warning (never success) on FAILED & terminates COMPLETED with null afterMetrics (D-3)', async () => {
    vi.useFakeTimers();
    try {
      useWorkspaceStore.setState({
        brandsLoading: false,
        brandsLoaded: true,
        brands: [BRAND_A],
        activeBrandId: BRAND_A.id,
        activeMarket: 'CN',
      });

      const homeWithNullAfter = makeHomeData(BRAND_A.id, 'CN', 1);
      homeWithNullAfter.recentArticles[0]!.publishRecord = {
        ...homeWithNullAfter.recentArticles[0]!.publishRecord!,
        latestRetestRunId: 'run_home_fail_1',
        afterMetrics: null,
      };
      vi.spyOn(homeApi, 'fetchActionHome').mockResolvedValue(homeWithNullAfter);

      let resolveRetest!: (v: Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>) => void;
      const retestSpy = vi
        .spyOn(studioApi, 'triggerPublishRetest')
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRetest = resolve;
            }),
        )
        .mockResolvedValueOnce({
          id: 'run_home_comp_null',
          triggerType: 'RETEST',
          status: 'QUEUED',
        } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);

      const runDetailSpy = vi
        .spyOn(visibilityApi, 'fetchVisibilityRunDetail')
        .mockResolvedValueOnce({
          id: 'run_home_fail_1',
          status: 'FAILED',
          doneCount: 0,
        } as unknown as Awaited<ReturnType<typeof visibilityApi.fetchVisibilityRunDetail>>)
        .mockResolvedValue({
          id: 'run_home_comp_null',
          status: 'COMPLETED',
          doneCount: 1,
        } as unknown as Awaited<ReturnType<typeof visibilityApi.fetchVisibilityRunDetail>>);

      render(
        <ConsoleProvider value={makeConsoleContext()}>
          <HomeWorkspace />
        </ConsoleProvider>,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const btn = screen.getByTestId('home-article-retest-btn-art_brand_home_a_1');

      // D-1: same-tick double-click fires strictly 1 request
      act(() => {
        btn.click();
        btn.click();
      });
      expect(retestSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRetest({
          id: 'run_home_fail_1',
          triggerType: 'RETEST',
          status: 'QUEUED',
        } as unknown as Awaited<ReturnType<typeof studioApi.triggerPublishRetest>>);
      });

      mockNotifySuccess.mockClear();
      mockNotifyWarning.mockClear();

      // D-3a: FAILED run must emit warning and NEVER emit success
      await act(async () => {
        vi.advanceTimersByTime(2_600);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockNotifySuccess).not.toHaveBeenCalled();
      expect(mockNotifyWarning).toHaveBeenCalledWith(
        '本次复测未成功完成，已按规则退还异常引擎点数',
      );

      // D-3b: COMPLETED run with afterMetrics === null must stop polling after 1 check + warning
      mockNotifyWarning.mockClear();
      act(() => {
        btn.click();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const detailCallsBefore = runDetailSpy.mock.calls.length;
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(2_600);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      expect(runDetailSpy.mock.calls.length - detailCallsBefore).toBe(1);
      expect(mockNotifyWarning).toHaveBeenCalledWith('复测已结束，暂未生成对比指标');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches action home strictly once on cold load transition (brandsLoading: true -> false)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: true,
      brandsLoaded: false,
      brands: [],
      activeBrandId: null,
      activeMarket: 'CN',
    });

    const fetchSpy = vi
      .spyOn(homeApi, 'fetchActionHome')
      .mockResolvedValue(makeHomeData(BRAND_A.id, 'CN'));

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    expect(screen.getByTestId('home-loading')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      useWorkspaceStore.setState({
        brandsLoading: false,
        brandsLoaded: true,
        brands: [BRAND_A],
        activeBrandId: BRAND_A.id,
        activeMarket: 'CN',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-health-strip')).toBeTruthy();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(BRAND_A.id, 'CN', expect.anything());
  });

  it('does not re-fetch Brand A or lock in skeleton when drawer brief save resolves after switching to Brand B (W-02)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [BRAND_A, BRAND_B],
      activeBrandId: BRAND_A.id,
      activeMarket: 'CN',
    });

    const fetchHomeSpy = vi
      .spyOn(homeApi, 'fetchActionHome')
      .mockImplementation(async (brandId, market) => makeHomeData(brandId, market));

    const briefA: GeoBriefRecord = {
      id: 'brief_brand_home_a_1',
      brandId: BRAND_A.id,
      brandMarketId: 'bm_a_cn',
      market: 'CN',
      sourceType: 'AUTO_GAP',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: null,
      targetPrompt: '核心问句 1',
      priorityScore: 95,
      diagnosisSummary: '竞品霸榜缺口诊断详情',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: 'brand_home_a 优先建议标题 1',
      outlineH2: [{ heading: '实测参数对比', intent: '提供对比表格' }],
      targetFanOuts: ['满载噪音'],
      competitorFocus: ['群晖'],
      matchedFactIds: [],
      missingFactHints: [],
      recommendedChannels: [{ channel: '知乎', reason: '高权阵地' }],
      status: 'OPEN',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };
    vi.spyOn(briefsApi, 'getBrief').mockResolvedValueOnce(briefA);
    vi.spyOn(brandsApi, 'getBrandFacts').mockResolvedValueOnce({
      brandId: BRAND_A.id,
      truthAgreementSignedAt: null,
      totalChars: 0,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    });

    let resolveUpdate!: (value: GeoBriefRecord) => void;
    vi.spyOn(briefsApi, 'updateBrief').mockImplementationOnce(
      () =>
        new Promise<GeoBriefRecord>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    await screen.findByTestId('home-health-strip');
    fireEvent.click(screen.getAllByRole('button', { name: '查看详细意见' })[0]!);
    const drawer = await screen.findByTestId('geo-brief-drawer');
    fireEvent.change(within(drawer).getByTestId('brief-drawer-title'), {
      target: { value: '已修改标题' },
    });
    fireEvent.click(within(drawer).getByTestId('brief-drawer-save-btn'));

    // Switch active brand to Brand B while Brand A's updateBrief is still pending
    act(() => {
      useWorkspaceStore.getState().setActiveBrand(BRAND_B.id, 'CN', window.localStorage);
    });

    // Resolve Brand A's updateBrief after brand switch
    await act(async () => {
      resolveUpdate({ ...briefA, suggestedTitle: '已修改标题' });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-health-strip')).toBeTruthy();
      expect(screen.getByText('brand_home_b 优先建议标题 1')).toBeTruthy();
    });
    expect(screen.queryByTestId('home-loading')).toBeNull();
    // Brand A must NOT have been re-fetched after Brand B was selected
    const brandAFetches = fetchHomeSpy.mock.calls.filter(([bid]) => bid === BRAND_A.id);
    expect(brandAFetches).toHaveLength(1);
  });

  it('renders M6B distributionSummary (crawl alerts, upcoming retests, PRD D5 channel attribution) and navigates to /studio and /account?tab=points (#355)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [BRAND_A],
      activeBrandId: BRAND_A.id,
      activeMarket: 'GLOBAL',
    });

    const dataWithDist: ActionHomeResponse = {
      ...makeHomeData(BRAND_A.id, 'GLOBAL', 2),
      distributionSummary: {
        crawlAlerts: [
          {
            publishRecordId: 'pub_alert_1',
            articleId: 'art_brand_home_a_1',
            articleTitle: 'AstraVault Quiet NAS Benchmark',
            channel: 'Official Blog / Docs',
            publishedUrl: 'https://astravault.example.com/nas',
            crawlStatus: 'BLOCKED',
            crawlCheckedAt: '2026-11-23T04:00:00.000Z',
            issues: ['robots.txt 拦截了 GPTBot'],
          },
        ],
        upcomingRetests: [
          {
            scheduleId: 'sched_skip_home_1',
            publishRecordId: 'pub_brand_home_a_1',
            articleId: 'art_brand_home_a_1',
            articleTitle: 'AstraVault Quiet NAS Benchmark',
            channel: 'Official Blog / Docs',
            milestoneDay: 7,
            sampleCount: 1,
            dueAt: '2026-11-28T08:00:00.000Z',
            status: 'SKIPPED_INSUFFICIENT_POINTS',
            skipReason: '点数不足，已温和跳过本次自动复测',
          },
        ],
        channelAttribution: [
          {
            channel: 'Official Blog / Docs',
            publishedCount: 2,
            crawlOkCount: 1,
            completedRetestCount: 2,
            citationHitCount: 0,
            citationHitRate: null,
            avgMentionRateDelta: 30.0,
            avgPosition: 2.0,
            avgPositionDelta: -1.0,
            positiveSentimentRate: 1,
            sentimentSummary: 'positive',
          },
        ],
      },
    };

    vi.spyOn(homeApi, 'fetchActionHome').mockResolvedValueOnce(dataWithDist);
    const navigateWorkspace = vi.fn();

    render(
      <ConsoleProvider value={makeConsoleContext({ navigateWorkspace })}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    const summary = await screen.findByTestId('home-distribution-summary');
    const allCrawlAlertBanners = screen.getAllByTestId('home-crawl-alerts');
    expect(allCrawlAlertBanners).toHaveLength(1);
    const crawlAlerts = allCrawlAlertBanners[0]!;
    expect(within(summary).queryByTestId('home-crawl-alerts')).toBeNull();
    expect(crawlAlerts.textContent).toContain('robots.txt 拦截了 GPTBot');

    // Hoisted directly after KpiStrip and before Top 3 Briefs
    const kpiStrip = screen.getByTestId('home-health-strip');
    const topBriefs = screen.getByTestId('home-top-briefs');
    expect(
      Boolean(kpiStrip.compareDocumentPosition(crawlAlerts) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(crawlAlerts.compareDocumentPosition(topBriefs) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    // Strictly 1 Phosphor primary CTA inside home-workspace
    const workspace = screen.getByTestId('home-workspace');
    expect(workspace.querySelectorAll('.ant-btn-primary')).toHaveLength(1);

    expect(within(summary).getByTestId('home-upcoming-retests').textContent).toContain('T+7');
    const attrText = within(summary).getByTestId('home-channel-attribution').textContent ?? '';
    expect(attrText).toContain('待引文就绪');
    expect(attrText).toContain('+30.0%');
    expect(attrText).not.toContain('NaN');
    expect(document.body.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);

    fireEvent.click(within(crawlAlerts).getByRole('button', { name: '立即排查' }));
    expect(navigateWorkspace).toHaveBeenCalledWith(
      '/publish?articleId=art_brand_home_a_1&tab=tracking',
    );

    fireEvent.click(within(summary).getByRole('button', { name: '查看点数' }));
    expect(navigateWorkspace).toHaveBeenCalledWith('/account?tab=points');
  });

  it('opens Monthly GEO ROI Report modal from /home and renders NEAR_MISS_BOOST badge cleanly (#372)', async () => {
    useWorkspaceStore.setState({
      brandsLoading: false,
      brandsLoaded: true,
      brands: [BRAND_A],
      activeBrandId: BRAND_A.id,
      activeMarket: 'CN',
    });

    const baseData = makeHomeData(BRAND_A.id, 'CN', 1);
    const dataWithNearMissBrief: ActionHomeResponse = {
      ...baseData,
      topBriefs: [
        {
          ...baseData.topBriefs[0]!,
          sourceType: 'NEAR_MISS_BOOST',
          suggestedTitle: '差一步被引用补强专题',
        },
      ],
    };

    vi.spyOn(homeApi, 'fetchActionHome').mockResolvedValueOnce(dataWithNearMissBrief);
    const listReportsSpy = vi
      .spyOn(reportsApi, 'fetchGeoRoiReports')
      .mockResolvedValueOnce({ items: [] });

    render(
      <ConsoleProvider value={makeConsoleContext()}>
        <HomeWorkspace />
      </ConsoleProvider>,
    );

    const workspace = await screen.findByTestId('home-workspace');
    expect(workspace.textContent).toContain('差一步被引用补强');
    expect(document.body.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);

    fireEvent.click(screen.getByTestId('home-open-roi-report-btn'));

    expect(await screen.findByTestId('home-roi-report-modal')).toBeTruthy();
    await waitFor(() => {
      expect(listReportsSpy).toHaveBeenCalledWith(
        BRAND_A.id,
        { market: 'CN', limit: 20 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});
