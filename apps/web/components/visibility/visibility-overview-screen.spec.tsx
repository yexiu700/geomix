// @vitest-environment jsdom

import type {
  ImportQuestionsInput,
  KeywordRecord,
  VisibilityCitationListResponse,
  VisibilityCitationQuery,
  VisibilityOpportunitiesQuery,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewQuery,
  VisibilityOverviewResponse,
  VisibilityProfileRecord,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VisibilityGateway } from '../../lib/visibility';
import { VisibilityOverviewScreen } from './visibility-overview-screen';

const DEFAULT_PROFILE_STORAGE_KEY = 'geomix:visibility:default-profile-id';
const SKIP_DEFAULT_PROFILE_ONCE_KEY = 'geomix:visibility:overview:skip-default-once';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  cleanup();
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildProfile(id: string, name: string, brandName: string): VisibilityProfileRecord {
  return {
    id,
    name,
    brandName,
    brandAliases: [],
    ownedDomains: [],
    competitors: [],
    runCount: 1,
    createdAt: '2026-11-16T08:00:00.000Z',
    updatedAt: '2026-11-16T08:00:00.000Z',
  };
}

const PROFILE_ALPHA = buildProfile('vprof_alpha', '阿尔法档案', '阿尔法');
const PROFILE_BETA = buildProfile('vprof_beta', '贝塔档案', '贝塔');

function buildOverview(
  visibilityPct: number,
  profileId: string | null,
): VisibilityOverviewResponse {
  return {
    profileId,
    metrics: {
      completedChecks: 10,
      mentionedChecks: Math.round(visibilityPct / 10),
      visibilityPct,
      shareOfVoice: {
        totalMentions: 10,
        brandMentions: 5,
        brandSharePct: 50,
        entries: [{ name: '阿尔法', isBrand: true, mentions: 5, sharePct: 50 }],
      },
      avgPosition: 2,
      sentimentSummary: {
        positive: 1,
        neutral: 0,
        mixed: 0,
        negative: 0,
        total: 1,
        positivePct: 100,
        negativePct: 0,
      },
      totalCitations: 4,
      ownedCitations: 1,
      ownedCitationChecks: 1,
      ownedCitationRatePct: 25,
      ownedCitationCheckRatePct: 10,
      topDomains: [],
    },
    trend: [
      {
        date: '2026-11-17',
        engine: 'all',
        completedChecks: 4,
        mentionedChecks: 2,
        visibilityPct: 50,
        shareOfVoicePct: 40,
      },
      {
        date: '2026-11-18',
        engine: 'all',
        completedChecks: 6,
        mentionedChecks: 3,
        visibilityPct: 50,
        shareOfVoicePct: 60,
      },
    ],
    byEngine: [],
  };
}

function buildCitations(
  query: Partial<VisibilityCitationQuery>,
  total = 3,
  domainPrefix = 'site',
): VisibilityCitationListResponse {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 10;
  const start = (page - 1) * pageSize;
  const count = Math.max(0, Math.min(pageSize, total - start));
  return {
    page,
    pageSize,
    total,
    totalCitations: total * 2,
    sourceBreakdown: { OWNED: 0, COMPETITOR: 0, SOCIAL: 0, AUTHORITY: 0, OTHER: total * 2 },
    items: Array.from({ length: count }, (_v, i) => ({
      domain: `${domainPrefix}-${start + i + 1}.example.org`,
      sourceKind: 'OTHER' as const,
      citationCount: 2,
      questionCount: 1,
      topUrls: [],
    })),
  };
}

const SAMPLE_OPPORTUNITIES: VisibilityOpportunitiesResponse = {
  gaps: [
    {
      promptText: '哪款便携屏适合出差',
      questionId: null,
      competitors: ['竞品甲'],
      engines: ['deepseek'],
      observationCount: 2,
    },
  ],
  fanOutQueries: [
    {
      query: '便携屏续航对比',
      frequency: 3,
      sourcePrompts: ['便携屏怎么选'],
      engines: ['deepseek'],
      brandMentionedPct: 20,
    },
  ],
};

const SAMPLE_KEYWORDS: KeywordRecord[] = [
  {
    id: 'kw_alpha_01',
    main: '阿尔法便携屏',
    brands: ['阿尔法'],
    optStatus: 'INCLUDED',
    questionCount: 2,
    createdAt: '2026-11-15T08:00:00.000Z',
  },
];

function buildGateway(overrides: Partial<VisibilityGateway> = {}) {
  const overviewQueries: VisibilityOverviewQuery[] = [];
  const citationQueries: VisibilityCitationQuery[] = [];
  const opportunityQueries: VisibilityOpportunitiesQuery[] = [];
  const importCalls: ImportQuestionsInput[] = [];
  const notImplemented = () => Promise.reject(new Error('not implemented in overview spec'));

  const base: VisibilityGateway = {
    listProfiles: async () => ({ items: [PROFILE_ALPHA, PROFILE_BETA] }),
    createProfile: notImplemented,
    updateProfile: notImplemented,
    deleteProfile: notImplemented,
    listRuns: notImplemented,
    getRun: notImplemented,
    createRun: notImplemented,
    pauseRun: notImplemented,
    resumeRun: notImplemented,
    cancelRun: notImplemented,
    bulkDeleteRuns: notImplemented,
    listKeywords: async () => SAMPLE_KEYWORDS,
    listQuestionsByKeyword: async () => [],
    listPrices: async () => [],
    getOverview: async (query) => buildOverview(65, query.profileId ?? null),
    listCitations: async (query) => buildCitations(query),
    listOpportunities: async () => SAMPLE_OPPORTUNITIES,
    importOpportunityQuestions: async (input) => ({
      insertedCount: input.titles.length,
      skippedCount: 0,
      keywordId: input.keywordId,
    }),
  };

  const merged: VisibilityGateway = { ...base, ...overrides };
  const gateway: VisibilityGateway = {
    ...merged,
    getOverview: (query) => {
      overviewQueries.push(query);
      return merged.getOverview(query);
    },
    listCitations: (query) => {
      citationQueries.push(query);
      return merged.listCitations(query);
    },
    listOpportunities: (query) => {
      opportunityQueries.push(query);
      return merged.listOpportunities!(query);
    },
    importOpportunityQuestions: (input) => {
      importCalls.push(input);
      return merged.importOpportunityQuestions!(input);
    },
  };

  return { gateway, overviewQueries, citationQueries, opportunityQueries, importCalls };
}

async function waitForKpi(text: string) {
  await waitFor(() => {
    expect(within(screen.getByTestId('kpi-visibility')).getByText(text)).toBeTruthy();
  });
}

function profileSelect(): HTMLSelectElement {
  return screen.getByLabelText('看板监测档案') as HTMLSelectElement;
}

describe('VisibilityOverviewScreen · 默认画像与深链', () => {
  it('applies the localStorage default profile when no deep link is present', async () => {
    window.localStorage.setItem(DEFAULT_PROFILE_STORAGE_KEY, PROFILE_BETA.id);
    const { gateway, overviewQueries } = buildGateway();

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);

    await waitFor(() => {
      expect(overviewQueries.some((q) => q.profileId === PROFILE_BETA.id)).toBe(true);
    });
    await waitFor(() => {
      expect(profileSelect().value).toBe(PROFILE_BETA.id);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('贝塔档案');
    });
  });

  it('falls back to 全部监测档案 when no default is stored or the stored default is unknown', async () => {
    window.localStorage.setItem(DEFAULT_PROFILE_STORAGE_KEY, 'vprof_missing');
    const { gateway, overviewQueries } = buildGateway();

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);

    await waitForKpi('65.0%');
    await waitFor(() => {
      expect(profileSelect().options.length).toBeGreaterThan(1);
    });
    expect(profileSelect().value).toBe('');
    expect(overviewQueries.every((q) => q.profileId === undefined)).toBe(true);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('AI数据看板');
  });

  it('skips the default profile exactly once when skip-default-once is set, and consumes the flag', async () => {
    window.localStorage.setItem(DEFAULT_PROFILE_STORAGE_KEY, PROFILE_BETA.id);
    window.sessionStorage.setItem(SKIP_DEFAULT_PROFILE_ONCE_KEY, '1');
    const { gateway, overviewQueries } = buildGateway();

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);

    await waitForKpi('65.0%');
    await waitFor(() => {
      expect(profileSelect().options.length).toBeGreaterThan(1);
    });
    expect(profileSelect().value).toBe('');
    expect(overviewQueries.some((q) => q.profileId === PROFILE_BETA.id)).toBe(false);
    expect(window.sessionStorage.getItem(SKIP_DEFAULT_PROFILE_ONCE_KEY)).toBeNull();

    // A fresh mount afterwards honours the default again (the skip is one-shot).
    cleanup();
    const second = buildGateway();
    render(<VisibilityOverviewScreen title="AI数据看板" gateway={second.gateway} />);
    await waitFor(() => {
      expect(second.overviewQueries.some((q) => q.profileId === PROFILE_BETA.id)).toBe(true);
    });
  });

  it('prefers the deep-linked ?profileId over the stored default profile', async () => {
    window.localStorage.setItem(DEFAULT_PROFILE_STORAGE_KEY, PROFILE_BETA.id);
    const { gateway, overviewQueries, citationQueries } = buildGateway();

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href={`/visibility/overview?profileId=${PROFILE_ALPHA.id}`}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('阿尔法档案');
    });
    expect(profileSelect().value).toBe(PROFILE_ALPHA.id);
    expect(overviewQueries.length).toBeGreaterThan(0);
    expect(overviewQueries.every((q) => q.profileId === PROFILE_ALPHA.id)).toBe(true);
    expect(citationQueries.every((q) => q.profileId === PROFILE_ALPHA.id)).toBe(true);
  });
});

describe('VisibilityOverviewScreen · 筛选与竞态', () => {
  it('blocks an invalid date range without issuing any overview / citations request', async () => {
    const { gateway, overviewQueries, citationQueries, opportunityQueries } = buildGateway();

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);
    await waitForKpi('65.0%');

    const overviewCount = overviewQueries.length;
    const citationCount = citationQueries.length;
    const opportunityCount = opportunityQueries.length;

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-11-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByLabelText('查询看板数据'));

    expect(await screen.findByText(/开始日期不能晚于结束日期/)).toBeTruthy();
    expect(overviewQueries.length).toBe(overviewCount);
    expect(citationQueries.length).toBe(citationCount);
    expect(opportunityQueries.length).toBe(opportunityCount);

    // A valid range is applied with +08:00 day boundaries.
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-11-25' } });
    fireEvent.click(screen.getByLabelText('查询看板数据'));
    await waitFor(() => {
      expect(screen.queryByText(/开始日期不能晚于结束日期/)).toBeNull();
      expect(overviewQueries.at(-1)).toMatchObject({
        from: '2026-11-20T00:00:00+08:00',
        to: '2026-11-25T23:59:59.999+08:00',
      });
    });
  });

  it('renders only the latest filter result when two quick switches resolve out of order', async () => {
    const pending = new Map<number, Deferred<VisibilityOverviewResponse>>();
    const pendingCitations = new Map<number, Deferred<VisibilityCitationListResponse>>();
    const { gateway } = buildGateway({
      getOverview: (query) => {
        if (query.days === 14) return Promise.resolve(buildOverview(65, null));
        const d = deferred<VisibilityOverviewResponse>();
        pending.set(query.days, d);
        return d.promise;
      },
      listCitations: (query) => {
        if (query.days === 14) return Promise.resolve(buildCitations(query, 1, 'initial'));
        const d = deferred<VisibilityCitationListResponse>();
        pendingCitations.set(query.days, d);
        return d.promise;
      },
    });

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);
    await waitForKpi('65.0%');
    expect(await screen.findByText('initial-1.example.org')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('近7天'));
    fireEvent.click(screen.getByLabelText('近30天'));
    await waitFor(() => {
      expect(pending.has(7)).toBe(true);
      expect(pending.has(30)).toBe(true);
      expect(pendingCitations.has(7)).toBe(true);
      expect(pendingCitations.has(30)).toBe(true);
    });

    // Latest (30d) resolves first, then the stale 7d response arrives late.
    await act(async () => {
      pending.get(30)!.resolve(buildOverview(30, null));
      pendingCitations.get(30)!.resolve(buildCitations({ days: 30 }, 1, 'latest'));
    });
    await waitForKpi('30.0%');
    expect(await screen.findByText('latest-1.example.org')).toBeTruthy();

    await act(async () => {
      pending.get(7)!.resolve(buildOverview(7, null));
      pendingCitations.get(7)!.resolve(buildCitations({ days: 7 }, 1, 'stale'));
    });

    expect(within(screen.getByTestId('kpi-visibility')).getByText('30.0%')).toBeTruthy();
    expect(within(screen.getByTestId('kpi-visibility')).queryByText('7.0%')).toBeNull();
    expect(screen.getByText('latest-1.example.org')).toBeTruthy();
    expect(screen.queryByText('stale-1.example.org')).toBeNull();
    expect(screen.getByLabelText('近30天').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('VisibilityOverviewScreen · 引用溯源页签', () => {
  it('paginates the citations leaderboard and resets to page 1 when the filter changes', async () => {
    const { gateway, citationQueries } = buildGateway({
      listCitations: async (query) => buildCitations(query, 25),
    });

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);
    expect(await screen.findByText('site-1.example.org')).toBeTruthy();
    expect(screen.getByText('共 25 条')).toBeTruthy();

    fireEvent.click(screen.getByTitle('2'));
    await waitFor(() => {
      expect(citationQueries.at(-1)).toMatchObject({ page: 2, pageSize: 10 });
      expect(screen.getByText('site-11.example.org')).toBeTruthy();
    });
    expect(screen.getByText('#11')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('近7天'));
    await waitFor(() => {
      expect(citationQueries.at(-1)).toMatchObject({ page: 1, days: 7 });
      expect(screen.getByText('site-1.example.org')).toBeTruthy();
    });
  });

  it('shows an inline error with 重试 and recovers on retry', async () => {
    let failNext = true;
    const { gateway, citationQueries } = buildGateway({
      listCitations: async (query) => {
        if (failNext) {
          failNext = false;
          throw new Error('引用服务暂时不可用');
        }
        return buildCitations(query, 2, 'retry');
      },
    });

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);
    const alert = await screen.findByText('引用服务暂时不可用');
    const callsBeforeRetry = citationQueries.length;

    const errorBox = alert.closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(errorBox).getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => {
      expect(citationQueries.length).toBe(callsBeforeRetry + 1);
      expect(screen.getByText('retry-1.example.org')).toBeTruthy();
    });
    expect(screen.queryByText('引用服务暂时不可用')).toBeNull();
  });
});

describe('VisibilityOverviewScreen · 优化机会页签', () => {
  async function openOpportunitiesTab() {
    const oppTab = await screen.findByRole('tab', { name: /优化机会 & 搜索拆解词（Query Fan-Out/ });
    fireEvent.click(oppTab);
    await waitFor(() => {
      expect(oppTab.getAttribute('aria-selected')).toBe('true');
    });
    expect(await screen.findByLabelText('勾选缺口问题-哪款便携屏适合出差')).toBeTruthy();
  }

  it('imports selected opportunity titles into the target keyword and shows success feedback', async () => {
    const { gateway, importCalls } = buildGateway();

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href={`/visibility/overview?profileId=${PROFILE_ALPHA.id}`}
        gateway={gateway}
      />,
    );
    await waitForKpi('65.0%');
    await openOpportunitiesTab();

    const tab = screen.getByRole('tab', { name: /优化机会 & 搜索拆解词（Query Fan-Out · 2）/ });
    expect(tab).toBeTruthy();

    await waitFor(() => {
      expect((screen.getByLabelText('目标主词') as HTMLSelectElement).value).toBe('kw_alpha_01');
    });

    fireEvent.click(screen.getByLabelText('勾选缺口问题-哪款便携屏适合出差'));
    fireEvent.click(screen.getByLabelText('勾选拆解词-便携屏续航对比'));
    expect(screen.getByText('已选 2 条')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '一键加入写作标题' }));
    await waitFor(() => {
      expect(importCalls).toEqual([
        { keywordId: 'kw_alpha_01', titles: ['哪款便携屏适合出差', '便携屏续航对比'] },
      ]);
    });
    expect(
      (await screen.findAllByText('已导入「写作标题」：新增 2 条，跳过重复 0 条')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('已选 0 条')).toBeTruthy();
  });

  it('keeps the selection and shows error feedback when importing fails', async () => {
    const { gateway, importCalls } = buildGateway({
      importOpportunityQuestions: async () => {
        throw new Error('写作标题导入失败：主词已归档');
      },
    });

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href={`/visibility/overview?profileId=${PROFILE_ALPHA.id}`}
        gateway={gateway}
      />,
    );
    await waitForKpi('65.0%');
    await openOpportunitiesTab();
    await waitFor(() => {
      expect((screen.getByLabelText('目标主词') as HTMLSelectElement).value).toBe('kw_alpha_01');
    });

    fireEvent.click(screen.getByLabelText('勾选拆解词-便携屏续航对比'));
    fireEvent.click(screen.getByRole('button', { name: '一键加入写作标题' }));

    await waitFor(() => {
      expect(importCalls).toHaveLength(1);
    });
    expect(
      (await screen.findAllByText('写作标题导入失败：主词已归档')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('已选 1 条')).toBeTruthy();
  });

  it('disables importing in read-only mode', async () => {
    const { gateway } = buildGateway();

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href={`/visibility/overview?profileId=${PROFILE_ALPHA.id}`}
        gateway={gateway}
        readOnly
      />,
    );
    await waitForKpi('65.0%');
    await openOpportunitiesTab();

    expect(
      (screen.getByRole('button', { name: '一键加入写作标题' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText('目标主词') as HTMLSelectElement).disabled).toBe(true);
  });
});
