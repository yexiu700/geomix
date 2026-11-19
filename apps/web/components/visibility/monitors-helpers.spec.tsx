// @vitest-environment jsdom

import {
  VISIBILITY_BRAND_NAME_MAX,
  VISIBILITY_PROFILE_NAME_MAX,
  containsRawCuid,
  formatShanghaiDateTime,
  type KeywordRecord,
  type QuestionRecord,
  type VisibilityCitationListResponse,
  type VisibilityOverviewResponse,
  type VisibilityPrefillSources,
  type VisibilityProfileListResponse,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunListResponse,
  type VisibilityRunRecord,
} from '@geomix/shared';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ShellAction, tabFromHref } from '../../lib/tab-stack';
import { VisibilityApiError, type VisibilityGateway } from '../../lib/visibility';
import { UxFeedbackProvider } from '../crud/ux-feedback';
import {
  DEFAULT_PROFILE_STORAGE_KEY,
  applyKbPrefillToDraft,
  applyKeywordPrefillToDraft,
  buildEmptyProfileDraft,
  buildRunsExportBytes,
  buildRunsExportFile,
  buildRunsExportTable,
  clampVisibilityPct,
  computeRunProgressPercents,
  countUniqueRunPrompts,
  parseHrefParams,
  splitPromptLines,
  splitTagList,
  useDefaultProfileId,
  validateProfileBrandName,
  validateProfileName,
  type DefaultProfileStorageLike,
} from './monitors-helpers';
import { VisibilityMonitorsScreen, citationSourceBadgeColor } from './visibility-monitors-screen';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
  cleanup();
  vi.restoreAllMocks();
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeProfile(overrides: Partial<VisibilityProfileRecord> = {}): VisibilityProfileRecord {
  return {
    id: overrides.id ?? 'prof-default',
    name: overrides.name ?? '便携显示器核心监测档案',
    brandName: overrides.brandName ?? '星图显示',
    brandAliases: overrides.brandAliases ?? ['StarView'],
    ownedDomains: overrides.ownedDomains ?? ['starview.cn'],
    competitors: overrides.competitors ?? [
      { name: '领航视界', aliases: ['NaviDisplay'], domains: ['navidisplay.cn'] },
    ],
    runCount: overrides.runCount ?? 1,
    createdAt: overrides.createdAt ?? '2026-11-15T09:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-11-16T09:00:00.000Z',
  };
}

function makeRunSummary(overrides: Partial<VisibilityRunRecord> = {}): VisibilityRunRecord {
  return {
    id: overrides.id ?? 'run-default',
    profileId: overrides.profileId ?? 'prof-default',
    profileName: overrides.profileName ?? '便携显示器核心监测档案',
    brandName: overrides.brandName ?? '星图显示',
    keywordId: overrides.keywordId ?? 'kw-1',
    keywordMain: overrides.keywordMain !== undefined ? overrides.keywordMain : '4K便携显示器',
    name: overrides.name ?? '默认监测巡检任务',
    engines: overrides.engines ?? ['deepseek', 'doubao'],
    questionIds: overrides.questionIds ?? ['q-1'],
    totalChecks: overrides.totalChecks ?? 4,
    doneCount: overrides.doneCount ?? 4,
    failCount: overrides.failCount ?? 0,
    skipCount: overrides.skipCount ?? 0,
    unitPrice: overrides.unitPrice ?? 2,
    frozenPoints: overrides.frozenPoints !== undefined ? overrides.frozenPoints : 8,
    settledPoints: overrides.settledPoints !== undefined ? overrides.settledPoints : 8,
    releasedPoints: overrides.releasedPoints ?? 0,
    reservationId: overrides.reservationId ?? 'resv-1',
    status: overrides.status ?? 'COMPLETED',
    lastError: overrides.lastError ?? null,
    visibilityPct: overrides.visibilityPct !== undefined ? overrides.visibilityPct : 75,
    createdAt: overrides.createdAt ?? '2026-11-17T06:20:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-11-17T06:25:00.000Z',
    finishedAt: overrides.finishedAt ?? '2026-11-17T06:25:00.000Z',
  };
}

function makeRunDetail(
  overrides: Partial<VisibilityRunDetailRecord> = {},
): VisibilityRunDetailRecord {
  const base = makeRunSummary(overrides);
  return {
    ...base,
    metrics: overrides.metrics ?? {
      completedChecks: base.doneCount,
      mentionedChecks: 1,
      visibilityPct: base.visibilityPct ?? 50,
      shareOfVoice: {
        totalMentions: 2,
        brandMentions: 1,
        brandSharePct: 50,
        entries: [
          { name: base.brandName, isBrand: true, mentions: 1, sharePct: 50 },
          { name: '领航视界', isBrand: false, mentions: 1, sharePct: 50 },
        ],
      },
      avgPosition: 1,
      sentimentSummary: {
        positive: 1,
        neutral: 0,
        mixed: 0,
        negative: 0,
        total: 1,
        positivePct: 100,
        negativePct: 0,
      },
      totalCitations: 1,
      ownedCitations: 1,
      ownedCitationChecks: 1,
      ownedCitationRatePct: 100,
      ownedCitationCheckRatePct: 100,
      topDomains: [{ domain: 'starview.cn', sourceKind: 'OWNED', count: 1, observationCount: 1 }],
    },
    observations: overrides.observations ?? [
      {
        id: 'vobs_deep_01',
        runId: base.id,
        profileId: base.profileId,
        questionId: 'q-1',
        promptText: '2026黑五便携显示器推荐哪款？',
        engine: 'deepseek',
        status: 'SUCCESS',
        collectorKind: 'fake',
        answerText: '首推星图显示（StarView）旗舰 4K 便携显示器，色准与接口兼容性表现优异。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        brandPassage: '首推星图显示（StarView）旗舰 4K 便携显示器',
        competitorHits: [],
        fanOutQueries: ['黑五4K便携屏推荐'],
        judgeModel: 'deepseek-chat',
        tokensIn: 210,
        tokensOut: 300,
        error: null,
        checkedAt: '2026-11-17T06:21:00.000Z',
        createdAt: '2026-11-17T06:20:30.000Z',
        citations: [
          {
            id: 'vcite_deep_01',
            url: 'https://starview.cn/pro16',
            domain: 'starview.cn',
            title: '星图显示官方产品页',
            snippet: '旗舰 4K Type-C 便携显示器技术规格',
            sourceKind: 'OWNED',
            position: 1,
            createdAt: '2026-11-17T06:21:00.000Z',
          },
        ],
      },
    ],
  };
}

function createMonitorsTestGateway(overrides: Partial<VisibilityGateway> = {}): VisibilityGateway {
  const emptyOverview = {} as VisibilityOverviewResponse;
  const emptyCitations: VisibilityCitationListResponse = {
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
  };
  return {
    listProfiles: vi.fn<VisibilityGateway['listProfiles']>().mockResolvedValue({
      items: [makeProfile()],
      prefillSources: { keywords: [], knowledgeBases: [] },
    }),
    createProfile: vi.fn<VisibilityGateway['createProfile']>().mockImplementation(async (input) =>
      makeProfile({
        id: 'prof-created',
        name: input.name,
        brandName: input.brandName ?? '未命名品牌',
        brandAliases: input.brandAliases ?? [],
        ownedDomains: input.ownedDomains ?? [],
        competitors: (input.competitors ?? []).map((item) => ({
          name: item.name,
          aliases: item.aliases ?? [],
          domains: item.domains ?? [],
        })),
        runCount: 0,
      }),
    ),
    updateProfile: vi
      .fn<VisibilityGateway['updateProfile']>()
      .mockImplementation(async (id, input) =>
        makeProfile({
          id,
          name: input.name ?? '更新档案',
          brandName: input.brandName ?? '星图显示',
          brandAliases: input.brandAliases ?? [],
          ownedDomains: input.ownedDomains ?? [],
          competitors: (input.competitors ?? []).map((item) => ({
            name: item.name,
            aliases: item.aliases ?? [],
            domains: item.domains ?? [],
          })),
        }),
      ),
    deleteProfile: vi.fn<VisibilityGateway['deleteProfile']>().mockResolvedValue({ deleted: 1 }),
    listRuns: vi.fn<VisibilityGateway['listRuns']>().mockResolvedValue({
      page: 1,
      pageSize: 10,
      total: 1,
      items: [makeRunSummary()],
    }),
    getRun: vi
      .fn<VisibilityGateway['getRun']>()
      .mockImplementation(async (id) => makeRunDetail({ id })),
    createRun: vi.fn<VisibilityGateway['createRun']>().mockImplementation(async (input) =>
      makeRunDetail({
        id: 'run-created',
        profileId: input.profileId,
        name: input.name ?? '新建监测任务',
        engines: input.engines,
        status: 'QUEUED',
      }),
    ),
    pauseRun: vi
      .fn<VisibilityGateway['pauseRun']>()
      .mockImplementation(async (id) => makeRunDetail({ id, status: 'PAUSED' })),
    resumeRun: vi
      .fn<VisibilityGateway['resumeRun']>()
      .mockImplementation(async (id) => makeRunDetail({ id, status: 'RUNNING' })),
    cancelRun: vi
      .fn<VisibilityGateway['cancelRun']>()
      .mockImplementation(async (id) => makeRunDetail({ id, status: 'CANCELLED' })),
    bulkDeleteRuns: vi
      .fn<VisibilityGateway['bulkDeleteRuns']>()
      .mockImplementation(async (ids) => ({ deleted: ids.length })),
    listKeywords: vi.fn<() => Promise<KeywordRecord[]>>().mockResolvedValue([]),
    listQuestionsByKeyword: vi
      .fn<(id: string) => Promise<QuestionRecord[]>>()
      .mockResolvedValue([]),
    listPrices: vi
      .fn<VisibilityGateway['listPrices']>()
      .mockResolvedValue([
        { action: 'visibility_check', unitPoints: 2, enabled: true, label: 'AI可见性监测' },
      ]),
    getOverview: vi.fn<VisibilityGateway['getOverview']>().mockResolvedValue(emptyOverview),
    listCitations: vi.fn<VisibilityGateway['listCitations']>().mockResolvedValue(emptyCitations),
    ...overrides,
  };
}

describe('VisibilityMonitorsScreen deep-link & state guard boundaries (#269)', () => {
  it('auto-selects profile filter, opens RunWorkspace drawer, masks CUIDs in heading and tab retitle, and resets URL on filter clear for ?profileId=<cuid>&runId=<cuid>', async () => {
    const cuidProfile = 'cmwlq3uem0019oiprcxr58lpa';
    const cuidRun = 'cmwrun8820019oiprcxr99kqa';
    const href = `/visibility/monitors?profileId=${cuidProfile}&runId=${cuidRun}`;
    const tab = tabFromHref(href)!;
    expect(tab.title).toBe('AI可见度诊断 · 当前监测档案 · 当前诊断任务');

    const deferredProfiles = createDeferred<VisibilityProfileListResponse>();
    const deferredRunDetail = createDeferred<VisibilityRunDetailRecord>();
    const deferredRunsList = createDeferred<VisibilityRunListResponse>();

    const gateway = createMonitorsTestGateway({
      listProfiles: vi.fn(() => deferredProfiles.promise),
      listRuns: vi.fn(() => deferredRunsList.promise),
      getRun: vi.fn(() => deferredRunDetail.promise),
    });

    const dispatched: ShellAction[] = [];

    const { container } = render(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title={tab.title}
          tabId={tab.id}
          href={href}
          gateway={gateway}
          pollIntervalMs={0}
          onDispatch={(action) => dispatched.push(action)}
        />
      </UxFeedbackProvider>,
    );

    const pageSection = container.querySelector('section')!;

    // Pre-resolution: CUIDs are masked in heading, profile select retains value via loading option, and gateway receives deep-link IDs
    expect(within(pageSection).getByRole('heading', { level: 3 }).textContent).toBe(
      'AI可见度诊断 · 当前监测档案 · 当前诊断任务',
    );
    expect(document.body.textContent ?? '').not.toContain(cuidProfile);
    expect(document.body.textContent ?? '').not.toContain(cuidRun);
    expect(containsRawCuid(document.body.textContent ?? '')).toBe(false);

    const profileSelect = screen.getByLabelText('筛选监测档案') as HTMLSelectElement;
    expect(profileSelect.value).toBe(cuidProfile);
    expect(gateway.listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, profileId: cuidProfile }),
    );
    expect(gateway.getRun).toHaveBeenCalledWith(cuidRun);

    // Resolve profile, run list, and run detail
    const resolvedProfile = makeProfile({
      id: cuidProfile,
      name: '星图便携屏全球监测档案',
      brandName: '星图显示',
    });
    const resolvedDetail = makeRunDetail({
      id: cuidRun,
      profileId: cuidProfile,
      profileName: '星图便携屏全球监测档案',
      name: '北美黑五多模型巡检',
      status: 'COMPLETED',
    });

    deferredProfiles.resolve({
      items: [resolvedProfile],
      prefillSources: { keywords: [], knowledgeBases: [] },
    });
    deferredRunsList.resolve({
      page: 1,
      pageSize: 10,
      total: 1,
      items: [resolvedDetail],
    });
    deferredRunDetail.resolve(resolvedDetail);

    await waitFor(() => {
      expect(within(pageSection).getByRole('heading', { level: 3 }).textContent).toBe(
        'AI可见度诊断 · 星图便携屏全球监测档案 · 北美黑五多模型巡检',
      );
    });

    expect(dispatched).toContainEqual({
      type: 'retitle',
      id: tab.id,
      title: 'AI可见度诊断 · 星图便携屏全球监测档案 · 北美黑五多模型巡检',
    });
    for (const action of dispatched) {
      if (action.type === 'retitle') {
        expect(containsRawCuid(action.title)).toBe(false);
        expect(action.title).not.toContain(cuidProfile);
        expect(action.title).not.toContain(cuidRun);
      }
    }

    expect(await screen.findByText('可见度诊断明细 · 北美黑五多模型巡检')).toBeTruthy();
    expect(await screen.findByTestId('observation-card-vobs_deep_01')).toBeTruthy();

    // Resetting task filters clears profileId select and navigates away from query string
    fireEvent.click(screen.getByLabelText('重置任务筛选'));
    await waitFor(() => {
      expect((screen.getByLabelText('筛选监测档案') as HTMLSelectElement).value).toBe('');
    });
    expect(dispatched).toContainEqual({
      type: 'navigate',
      id: tab.id,
      href: '/visibility/monitors',
    });
  });

  it('handles getRun 404 (VisibilityApiError) gracefully on ?profileId=<cuid>&runId=<missingCuid> without crashing or leaking CUID, keeping list interactive', async () => {
    const cuidProfile = 'cmwlq3uem0019oiprcxr58lpa';
    const missingRunCuid = 'cmwmissing4040019oipr0000z';
    const href = `/visibility/monitors?profileId=${cuidProfile}&runId=${missingRunCuid}`;
    const tab = tabFromHref(href)!;

    const gateway = createMonitorsTestGateway({
      listProfiles: vi.fn().mockResolvedValue({
        items: [
          makeProfile({
            id: cuidProfile,
            name: '星图便携屏全球监测档案',
            brandName: '星图显示',
          }),
        ],
        prefillSources: { keywords: [], knowledgeBases: [] },
      }),
      listRuns: vi.fn().mockResolvedValue({
        page: 1,
        pageSize: 10,
        total: 1,
        items: [
          makeRunSummary({
            id: 'run-normal-01',
            profileId: cuidProfile,
            profileName: '星图便携屏全球监测档案',
            name: '日常巡检任务A',
            status: 'COMPLETED',
          }),
        ],
      }),
      getRun: vi
        .fn()
        .mockRejectedValue(new VisibilityApiError(404, 40401, '监测任务不存在或已被删除')),
    });

    const dispatched: ShellAction[] = [];

    render(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title={tab.title}
          tabId={tab.id}
          href={href}
          gateway={gateway}
          pollIntervalMs={0}
          onDispatch={(action) => dispatched.push(action)}
        />
      </UxFeedbackProvider>,
    );

    expect(await screen.findByText('监测任务不存在或已被删除')).toBeTruthy();

    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
        'AI可见度诊断 · 星图便携屏全球监测档案 · 当前诊断任务',
      );
    });

    expect(dispatched).toContainEqual({
      type: 'retitle',
      id: tab.id,
      title: 'AI可见度诊断 · 星图便携屏全球监测档案 · 当前诊断任务',
    });
    expect(document.body.textContent ?? '').not.toContain(missingRunCuid);
    for (const action of dispatched) {
      if (action.type === 'retitle') {
        expect(action.title).not.toContain(missingRunCuid);
        expect(containsRawCuid(action.title)).toBe(false);
      }
    }

    // Main table remains interactive
    expect(screen.getByText('日常巡检任务A')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('筛选任务状态'), { target: { value: 'COMPLETED' } });
    await waitFor(() => {
      expect(gateway.listRuns).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'COMPLETED' }),
      );
    });
  });

  it('preserves the stored default on non-default creation and ignores a stale stored profile ID (#192)', async () => {
    // Scenario A: Pre-populated localStorage ('prof-1', second in list) stays 'prof-1' when creating non-default 'prof-2'
    window.localStorage.setItem('geomix:visibility:default-profile-id', 'prof-1');

    const prof0 = makeProfile({ id: 'prof-0', name: '第一档案', brandName: '品牌零' });
    const prof1 = makeProfile({ id: 'prof-1', name: '既有默认档案', brandName: '品牌一' });
    const storeA: VisibilityProfileRecord[] = [prof0, prof1];
    const gatewayA = createMonitorsTestGateway({
      listProfiles: vi.fn().mockImplementation(async () => ({
        items: [...storeA],
        prefillSources: { keywords: [], knowledgeBases: [] },
      })),
      createProfile: vi.fn().mockImplementation(async (input) => {
        const created = makeProfile({
          id: 'prof-2',
          name: input.name,
          brandName: input.brandName ?? '新锐品牌',
          runCount: 0,
        });
        storeA.unshift(created);
        return created;
      }),
    });

    const viewA = render(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title="AI可见度诊断"
          tabId="/visibility/monitors"
          gateway={gatewayA}
          pollIntervalMs={0}
        />
      </UxFeedbackProvider>,
    );

    fireEvent.click(await screen.findByRole('tab', { name: /品牌与竞品档案/ }));
    const cardProf1 = await screen.findByTestId('profile-card-prof-1');
    const cardProf0 = screen.getByTestId('profile-card-prof-0');
    expect(within(cardProf1).getByText('默认档案')).toBeTruthy();
    expect(within(cardProf0).queryByText('默认档案')).toBeNull();

    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    const defaultSwitchA = screen.getByRole('switch', { name: '设为默认档案' });
    expect(defaultSwitchA.getAttribute('aria-checked')).toBe('false');

    fireEvent.change(screen.getByLabelText('档案名称'), {
      target: { value: '第二品牌监测档案' },
    });
    fireEvent.change(screen.getByLabelText('主品牌名称'), {
      target: { value: '新锐品牌' },
    });
    fireEvent.click(screen.getByLabelText('保存品牌档案'));

    const cardProf2 = await screen.findByTestId('profile-card-prof-2');
    expect(within(cardProf2).queryByText('默认档案')).toBeNull();
    expect(within(screen.getByTestId('profile-card-prof-1')).getByText('默认档案')).toBeTruthy();
    expect(window.localStorage.getItem('geomix:visibility:default-profile-id')).toBe('prof-1');

    viewA.unmount();
    cleanup();

    // Scenario B: A deleted profile ID neither highlights nor persists the first profile.
    window.localStorage.setItem('geomix:visibility:default-profile-id', 'prof-deleted-ghost');
    const profA = makeProfile({ id: 'prof-a', name: '首位档案', brandName: '品牌A' });
    const profB = makeProfile({ id: 'prof-b', name: '次位档案', brandName: '品牌B' });
    const storeB: VisibilityProfileRecord[] = [profA, profB];
    const gatewayB = createMonitorsTestGateway({
      listProfiles: vi.fn().mockImplementation(async () => ({
        items: [...storeB],
        prefillSources: { keywords: [], knowledgeBases: [] },
      })),
      createProfile: vi.fn().mockImplementation(async (input) => {
        const created = makeProfile({
          id: 'prof-c',
          name: input.name,
          brandName: input.brandName ?? '品牌C',
          runCount: 0,
        });
        storeB.unshift(created);
        return created;
      }),
    });

    render(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title="AI可见度诊断"
          tabId="/visibility/monitors"
          gateway={gatewayB}
          pollIntervalMs={0}
        />
      </UxFeedbackProvider>,
    );

    fireEvent.click(await screen.findByRole('tab', { name: /品牌与竞品档案/ }));
    const cardProfA = await screen.findByTestId('profile-card-prof-a');
    expect(within(cardProfA).queryByText('默认档案')).toBeNull();

    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    expect(screen.getByRole('switch', { name: '设为默认档案' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.change(screen.getByLabelText('档案名称'), { target: { value: '第三品牌监测档案' } });
    fireEvent.change(screen.getByLabelText('主品牌名称'), { target: { value: '品牌C' } });
    fireEvent.click(screen.getByLabelText('保存品牌档案'));

    const cardProfC = await screen.findByTestId('profile-card-prof-c');
    expect(within(cardProfC).queryByText('默认档案')).toBeNull();
    expect(screen.queryByText('默认档案')).toBeNull();
    expect(window.localStorage.getItem('geomix:visibility:default-profile-id')).toBe(
      'prof-deleted-ghost',
    );
  });

  it('leaves the first profile without a default when the switch is off (#192)', async () => {
    const profiles: VisibilityProfileRecord[] = [];
    const gateway = createMonitorsTestGateway({
      listProfiles: vi.fn(async () => ({
        items: [...profiles],
        prefillSources: { keywords: [], knowledgeBases: [] },
      })),
      createProfile: vi.fn(async (input) => {
        const profile = makeProfile({ id: 'first-profile', name: input.name });
        profiles.push(profile);
        return profile;
      }),
    });
    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: /品牌与竞品档案/ }));
    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    const toggle = screen.getByRole('switch', { name: '设为默认档案' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('档案名称'), { target: { value: '首个档案' } });
    fireEvent.change(screen.getByLabelText('主品牌名称'), { target: { value: '测试品牌' } });
    fireEvent.click(screen.getByLabelText('保存品牌档案'));

    const card = await screen.findByTestId('profile-card-first-profile');
    expect(within(card).queryByText('默认档案')).toBeNull();
    expect(window.localStorage.getItem(DEFAULT_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it('protects both RUNNING and QUEUED runs from bulk delete across single and mixed selections while allowing COMPLETED bulk delete', async () => {
    const runQueued = makeRunSummary({
      id: 'run_queued',
      name: '排队中巡检任务',
      status: 'QUEUED',
      doneCount: 0,
    });
    const runRunning = makeRunSummary({
      id: 'run_running',
      name: '运行中巡检任务',
      status: 'RUNNING',
      doneCount: 2,
    });
    const runDone = makeRunSummary({
      id: 'run_done',
      name: '已完成巡检任务',
      status: 'COMPLETED',
      doneCount: 4,
    });

    const gateway = createMonitorsTestGateway({
      listRuns: vi.fn().mockResolvedValue({
        page: 1,
        pageSize: 10,
        total: 3,
        items: [runQueued, runRunning, runDone],
      }),
    });

    render(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title="AI可见度诊断"
          tabId="/visibility/monitors"
          gateway={gateway}
          pollIntervalMs={0}
        />
      </UxFeedbackProvider>,
    );

    expect(await screen.findByText('排队中巡检任务')).toBeTruthy();

    // Row-level 删除 hidden on QUEUED and RUNNING, shown on COMPLETED
    expect(screen.queryByLabelText('删除-排队中巡检任务')).toBeNull();
    expect(screen.queryByLabelText('删除-运行中巡检任务')).toBeNull();
    expect(screen.getByLabelText('删除-已完成巡检任务')).toBeTruthy();

    const queuedCheckbox = within(screen.getByText('排队中巡检任务').closest('tr')!).getByRole(
      'checkbox',
    );
    const runningCheckbox = within(screen.getByText('运行中巡检任务').closest('tr')!).getByRole(
      'checkbox',
    );
    const doneCheckbox = within(screen.getByText('已完成巡检任务').closest('tr')!).getByRole(
      'checkbox',
    );

    // 1. Single QUEUED selection -> blocked delete dialog with [取消, 立即终止该任务] -> transitions to cancel confirmation
    fireEvent.click(queuedCheckbox);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText('无法删除进行中的监测任务')).toBeTruthy();
    expect(screen.getByText(/包含 1 条尚未结束的监测任务/)).toBeTruthy();
    expect(gateway.bulkDeleteRuns).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('立即终止该任务'));
    expect(await screen.findByText('确认终止可见度监测任务')).toBeTruthy();
    expect(screen.getByText(/确定终止监测任务「排队中巡检任务」吗/)).toBeTruthy();
    const cancelDialog = screen.getByRole('dialog', { name: '确认终止可见度监测任务' });
    fireEvent.click(within(cancelDialog).getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => {
      expect(screen.queryByText('确认终止可见度监测任务')).toBeNull();
    });

    // 2. Mixed QUEUED + RUNNING + COMPLETED selection -> blocked delete dialog with [知道了] only
    fireEvent.click(runningCheckbox);
    fireEvent.click(doneCheckbox);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText('无法删除进行中的监测任务')).toBeTruthy();
    expect(screen.getByText(/包含 2 条尚未结束的监测任务/)).toBeTruthy();
    expect(screen.queryByLabelText('立即终止该任务')).toBeNull();
    expect(screen.getByLabelText('知道了')).toBeTruthy();
    expect(gateway.bulkDeleteRuns).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('知道了'));
    await waitFor(() => {
      expect(screen.queryByText('无法删除进行中的监测任务')).toBeNull();
    });

    // 3. Uncheck QUEUED and RUNNING leaving only COMPLETED -> allows bulk delete
    fireEvent.click(queuedCheckbox);
    fireEvent.click(runningCheckbox);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText('确认删除监测任务记录')).toBeTruthy();
    expect(screen.getByText(/确定删除已选中的 1 条已结束监测任务记录吗/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(gateway.bulkDeleteRuns).toHaveBeenCalledTimes(1);
      expect(gateway.bulkDeleteRuns).toHaveBeenCalledWith(['run_done']);
    });
  });

  it('pauses background polling when active={false} and resumes polling when active={true} via useTaskPolling (#264)', async () => {
    vi.useFakeTimers();

    const listRunsMock = vi.fn<VisibilityGateway['listRuns']>().mockResolvedValue({
      page: 1,
      pageSize: 10,
      total: 1,
      items: [makeRunSummary({ id: 'run-poll-1', status: 'RUNNING', doneCount: 1 })],
    });
    const gateway = createMonitorsTestGateway({ listRuns: listRunsMock });

    const { rerender } = render(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title="AI可见度诊断"
          tabId="/visibility/monitors"
          active={false}
          gateway={gateway}
          pollIntervalMs={1_000}
        />
      </UxFeedbackProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(listRunsMock).toHaveBeenCalledTimes(1);

    // While active={false}, advancing timers must NOT trigger background polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    expect(listRunsMock).toHaveBeenCalledTimes(1);

    // Activate tab -> useTabFreshness triggers activation refresh (+1), and useTaskPolling resumes interval ticks
    rerender(
      <UxFeedbackProvider>
        <VisibilityMonitorsScreen
          title="AI可见度诊断"
          tabId="/visibility/monitors"
          active={true}
          gateway={gateway}
          pollIntervalMs={1_000}
        />
      </UxFeedbackProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    const callsAfterActivate = listRunsMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(listRunsMock.mock.calls.length).toBeGreaterThanOrEqual(callsAfterActivate + 2);
  });
});

describe('monitors-helpers pure functions & useDefaultProfileId hook (#269)', () => {
  it('parses href query params cleanly across missing, empty, whitespace, encoded, and extra params', () => {
    expect(parseHrefParams()).toEqual({});
    expect(parseHrefParams('')).toEqual({});
    expect(parseHrefParams('/visibility/monitors')).toEqual({});
    expect(parseHrefParams('/visibility/monitors?profileId=%20%20&runId=')).toEqual({});
    expect(
      parseHrefParams('/visibility/monitors?profileId=prof_alpha%20&runId=%20run_99&foo=ignored'),
    ).toEqual({
      profileId: 'prof_alpha',
      runId: 'run_99',
    });
  });

  it('honors explicit defaults, clears them without picking a substitute, and tolerates storage errors (#192)', () => {
    const map = new Map<string, string>();
    const memStorage: DefaultProfileStorageLike = {
      getItem: vi.fn((k: string) => map.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        map.set(k, v);
      }),
      removeItem: vi.fn((k: string) => {
        map.delete(k);
      }),
    };

    const p1 = makeProfile({ id: 'p-1', name: '档案1' });
    const p2 = makeProfile({ id: 'p-2', name: '档案2' });

    // 1. Empty storage never picks a default by list order.
    const { result, rerender } = renderHook(
      ({ profiles }) => useDefaultProfileId(profiles, memStorage),
      { initialProps: { profiles: [p1, p2] } },
    );
    expect(result.current.defaultProfileId).toBe('');
    expect(result.current.effectiveDefaultProfileId).toBe('');

    act(() => result.current.syncDefaultAfterProfileSave('p-1', true));
    expect(result.current.effectiveDefaultProfileId).toBe('p-1');

    const p3 = makeProfile({ id: 'p-3', name: '档案3' });
    act(() => result.current.syncDefaultAfterProfileSave('p-3', false));
    rerender({ profiles: [p3, p1, p2] });
    expect(result.current.effectiveDefaultProfileId).toBe('p-1');
    expect(map.get(DEFAULT_PROFILE_STORAGE_KEY)).toBe('p-1');

    // 2. Turning default off on the current profile clears it.
    act(() => result.current.syncDefaultAfterProfileSave('p-1', false));
    expect(result.current.effectiveDefaultProfileId).toBe('');
    expect(map.has(DEFAULT_PROFILE_STORAGE_KEY)).toBe(false);

    // 3. Removing the selected default preserves the unset state.
    act(() => result.current.persistDefaultProfile('p-3'));
    act(() => {
      result.current.clearDefaultIfRemoved('p-3');
    });
    expect(memStorage.removeItem).toHaveBeenCalledWith(DEFAULT_PROFILE_STORAGE_KEY);
    expect(map.has(DEFAULT_PROFILE_STORAGE_KEY)).toBe(false);
    rerender({ profiles: [p1, p2] });
    expect(result.current.effectiveDefaultProfileId).toBe('');

    // 4. Stale records, unavailable storage and throwing storage never infer a default.
    map.set(DEFAULT_PROFILE_STORAGE_KEY, 'ghost-id');
    const staleHook = renderHook(() => useDefaultProfileId([p2, p1], memStorage));
    expect(staleHook.result.current.effectiveDefaultProfileId).toBe('');

    const throwingStorage: DefaultProfileStorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const resilientHook = renderHook(() => useDefaultProfileId([p1], throwingStorage));
    expect(resilientHook.result.current.effectiveDefaultProfileId).toBe('');
    act(() => {
      resilientHook.result.current.persistDefaultProfile('p-1');
    });
    expect(resilientHook.result.current.defaultProfileId).toBe('p-1');

    const nullStorageHook = renderHook(() => useDefaultProfileId([p2], null));
    expect(nullStorageHook.result.current.effectiveDefaultProfileId).toBe('');
  });

  it('prefills keyword and knowledge-base brand terms idempotently without overwriting user edits or duplicating aliases', () => {
    const prefill: VisibilityPrefillSources = {
      keywords: [
        {
          id: 'kw-prefill-1',
          main: '氮化镓快充头',
          brands: ['安克创新', 'Anker', 'ANKER', '安克氮化镓'],
        },
      ],
      knowledgeBases: [
        {
          id: 'kb-prefill-1',
          name: '星图显示企业白皮书',
          brandShort: '星图显示',
          companyName: '深圳星图显示技术有限公司',
        },
      ],
    };

    // Keyword prefill on empty draft fills name, brandName, and deduplicated aliases excluding primaryBrand
    const empty = buildEmptyProfileDraft(true);
    const fromKw = applyKeywordPrefillToDraft(empty, 'kw-prefill-1', prefill.keywords);
    expect(fromKw).toMatchObject({
      importFromKeywordId: 'kw-prefill-1',
      name: '安克创新品牌监测档案',
      brandName: '安克创新',
      brandAliasesText: 'Anker, 安克氮化镓',
    });

    // Unknown keyword ID returns draft untouched; empty string clears importFromKeywordId only
    expect(applyKeywordPrefillToDraft(fromKw, 'unknown-kw', prefill.keywords)).toBe(fromKw);
    expect(applyKeywordPrefillToDraft(fromKw, '', prefill.keywords).importFromKeywordId).toBe('');

    // Preserves non-empty user-typed name & brandName while merging new aliases case-insensitively
    const userTyped = {
      ...buildEmptyProfileDraft(false),
      name: '自定义北美监测档案',
      brandName: 'Anker',
      brandAliasesText: 'anker, 安克充电',
    };
    const mergedKw = applyKeywordPrefillToDraft(userTyped, 'kw-prefill-1', prefill.keywords);
    expect(mergedKw.name).toBe('自定义北美监测档案');
    expect(mergedKw.brandName).toBe('Anker');
    expect(mergedKw.brandAliasesText).toBe('安克充电, 安克创新, 安克氮化镓');

    // Knowledge-base prefill fills brandShort as primaryBrand and companyName as alias
    const fromKb = applyKbPrefillToDraft(empty, 'kb-prefill-1', prefill.knowledgeBases);
    expect(fromKb).toMatchObject({
      importFromKbId: 'kb-prefill-1',
      name: '星图显示监测档案',
      brandName: '星图显示',
      brandAliasesText: '深圳星图显示技术有限公司',
    });
    expect(applyKbPrefillToDraft(fromKb, 'unknown-kb', prefill.knowledgeBases)).toBe(fromKb);
    expect(applyKbPrefillToDraft(fromKb, '', prefill.knowledgeBases).importFromKbId).toBe('');
  });

  it('validates profile name and brand name boundaries including create-mode prefill exemption', () => {
    expect(validateProfileName('   ')).toBe('请填写档案名称');
    expect(validateProfileName('A'.repeat(VISIBILITY_PROFILE_NAME_MAX))).toBeUndefined();
    expect(validateProfileName('A'.repeat(VISIBILITY_PROFILE_NAME_MAX + 1))).toBe(
      `档案名称不能超过 ${VISIBILITY_PROFILE_NAME_MAX} 个字符`,
    );

    expect(
      validateProfileBrandName({
        mode: 'create',
        brandName: '  ',
        importFromKeywordId: '',
        importFromKbId: '',
      }),
    ).toBe('请填写主品牌名称');

    // Create mode with keyword or KB prefill selected allows blank brandName (backend resolves it)
    expect(
      validateProfileBrandName({
        mode: 'create',
        brandName: '',
        importFromKeywordId: 'kw-1',
        importFromKbId: '',
      }),
    ).toBeUndefined();
    expect(
      validateProfileBrandName({
        mode: 'create',
        brandName: '',
        importFromKeywordId: '',
        importFromKbId: 'kb-1',
      }),
    ).toBeUndefined();

    // Edit mode still requires brandName
    expect(
      validateProfileBrandName({
        mode: 'edit',
        brandName: '',
        importFromKeywordId: 'kw-1',
        importFromKbId: '',
      }),
    ).toBe('请填写主品牌名称');

    expect(
      validateProfileBrandName({
        mode: 'create',
        brandName: 'B'.repeat(VISIBILITY_BRAND_NAME_MAX + 1),
        importFromKeywordId: '',
        importFromKbId: '',
      }),
    ).toBe(`主品牌名称不能超过 ${VISIBILITY_BRAND_NAME_MAX} 个字符`);
  });

  it('splits tags/prompts, deduplicates checked questions vs custom prompts, and computes progress & badge helpers', () => {
    expect(splitTagList(' StarView，starview; 星图便携屏\n  星图显示； ')).toEqual([
      'StarView',
      '星图便携屏',
      '星图显示',
    ]);
    expect(
      splitPromptLines('  便携屏推荐哪款？ \r\n\r\n便携屏推荐哪款？\n4K触控副屏横评  '),
    ).toEqual(['便携屏推荐哪款？', '4K触控副屏横评']);

    const questions: QuestionRecord[] = [
      {
        id: 'q-1',
        keywordId: 'kw-1',
        keywordMain: '便携屏',
        text: '2026年便携显示器推荐哪款？',
        included: true,
        source: 'AI',
        usedCount: 1,
        createdAt: '2026-11-15T08:00:00.000Z',
      },
    ];
    expect(
      countUniqueRunPrompts(
        {
          questionIds: ['q-1'],
          customPromptsText: '  2026年便携显示器推荐哪款？ \n出差双屏笔记本扩展屏推荐',
        },
        questions,
      ),
    ).toBe(2);

    expect(
      computeRunProgressPercents({ totalChecks: 0, doneCount: 0, failCount: 0, skipCount: 0 }),
    ).toEqual({ donePct: 0, failPct: 0, skipPct: 0 });
    expect(
      computeRunProgressPercents({ totalChecks: 10, doneCount: 6, failCount: 3, skipCount: 5 }),
    ).toEqual({ donePct: 60, failPct: 30, skipPct: 10 });

    expect(clampVisibilityPct(null)).toBe(0);
    expect(clampVisibilityPct(Number.NaN)).toBe(0);
    expect(clampVisibilityPct(-12)).toBe(0);
    expect(clampVisibilityPct(135)).toBe(100);
    expect(clampVisibilityPct(62.5)).toBe(62.5);

    expect(citationSourceBadgeColor('OWNED')).toBe('blue');
    expect(citationSourceBadgeColor('COMPETITOR')).toBe('orange');
    expect(citationSourceBadgeColor('AUTHORITY')).toBe('cyan');
    expect(citationSourceBadgeColor('SOCIAL')).toBe('purple');
    expect(citationSourceBadgeColor('OTHER')).toBe('default');
  });

  it('builds CSV (UTF-8 BOM + RFC-4180 escaping + Shanghai time) and XLSX (ZIP PK header) run exports', () => {
    const createdIso = '2026-11-17T16:30:00.000Z';
    const expectedShanghaiTime = formatShanghaiDateTime(createdIso);
    expect(expectedShanghaiTime).toContain('2026-11-18 00:30');

    const rows: VisibilityRunRecord[] = [
      {
        ...makeRunSummary({
          id: 'run_export_1',
          name: '双十一"旗舰",巡检\n批次A',
          profileName: '星图核心档案',
          brandName: '星图显示',
          keywordMain: null,
          engines: ['deepseek', 'google_aio'],
          doneCount: 3,
          totalChecks: 6,
          unitPrice: 3,
          settledPoints: 9,
          visibilityPct: 66.7,
          status: 'RUNNING',
          createdAt: createdIso,
        }),
        frozenPoints: undefined,
      },
    ];

    const table = buildRunsExportTable(rows);
    expect(table.headers).toHaveLength(12);
    expect(table.rows[0]).toEqual([
      'run_export_1',
      '双十一"旗舰",巡检\n批次A',
      '星图核心档案',
      '星图显示',
      '自定义问题',
      'DeepSeek / Google AI Overviews',
      '3/6',
      '66.7',
      '18',
      '9',
      '监测中',
      expectedShanghaiTime,
    ]);

    const csvBytes = buildRunsExportBytes(rows);
    expect(Array.from(csvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csvText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes);
    expect(csvText.startsWith('\uFEFF任务编号,任务名称,')).toBe(true);
    expect(csvText).toContain('"双十一""旗舰"",巡检\n批次A"');
    expect(csvText).toContain(expectedShanghaiTime);

    const csvFile = buildRunsExportFile(rows, 'csv');
    expect(csvFile.filename).toBe('geomix-visibility-runs.csv');
    expect(csvFile.mime).toBe('text/csv;charset=utf-8');

    const xlsxFile = buildRunsExportFile(rows, 'xlsx');
    expect(xlsxFile.filename).toBe('geomix-visibility-runs.xlsx');
    expect(xlsxFile.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(Array.from(xlsxFile.body.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
