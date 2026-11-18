// @vitest-environment jsdom

import type {
  CitationSourceKind,
  ImportQuestionsInput,
  KeywordRecord,
  QuestionRecord,
  VisibilityCitationListResponse,
  VisibilityCitationQuery,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewQuery,
  VisibilityOverviewResponse,
  VisibilityProfileCreateWithPrefillInput,
  VisibilityProfileRecord,
  VisibilityRunCreateInput,
  VisibilityRunDetailRecord,
  VisibilityRunRecord,
} from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../../lib/api';
import { initialSnapshot, reduceShell } from '../../lib/tab-stack';
import type { VisibilityGateway } from '../../lib/visibility';
import { ShellFrame } from '../shell/shell-frame';
import { VisibilityMonitorsScreen } from './visibility-monitors-screen';
import { VisibilityOverviewScreen } from './visibility-overview-screen';

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

function buildSampleProfiles(): VisibilityProfileRecord[] {
  return [
    {
      id: 'vprof_starview',
      name: '便携显示器核心监测档案',
      brandName: '星图显示',
      brandAliases: ['StarView', '星图触控便携屏'],
      ownedDomains: ['starview.cn', 'docs.starview.cn'],
      competitors: [
        {
          name: '领航视界',
          aliases: ['NaviDisplay'],
          domains: ['navidisplay.cn'],
        },
        {
          name: '极光屏显',
          aliases: ['AuroraPanel'],
          domains: ['aurorapanel.cn'],
        },
      ],
      runCount: 2,
      createdAt: '2026-11-15T09:00:00.000Z',
      updatedAt: '2026-11-16T09:00:00.000Z',
    },
  ];
}

function buildSampleKeywords(): KeywordRecord[] {
  return [
    {
      id: 'kw_portable_01',
      main: '4K便携显示器',
      brands: ['星图显示', 'StarView'],
      optStatus: 'INCLUDED',
      questionCount: 3,
      createdAt: '2026-11-14T08:00:00.000Z',
    },
    {
      id: 'kw_starview_02',
      main: 'Type-C触控便携副屏',
      brands: ['星图显示'],
      optStatus: 'NONE',
      questionCount: 1,
      createdAt: '2026-11-14T09:00:00.000Z',
    },
    {
      id: 'kw_projector_02',
      main: '商用激光投影仪',
      brands: ['曜石光学', 'ObsidianOptics'],
      optStatus: 'NONE',
      questionCount: 2,
      createdAt: '2026-11-14T10:00:00.000Z',
    },
  ];
}

function buildSampleQuestions(): QuestionRecord[] {
  return [
    {
      id: 'q_01',
      keywordId: 'kw_portable_01',
      keywordMain: '4K便携显示器',
      text: '商务出差4K便携显示器哪个品牌色彩准且轻薄？',
      included: true,
      source: 'MANUAL',
      usedCount: 2,
      createdAt: '2026-11-15T08:00:00.000Z',
    },
    {
      id: 'q_02',
      keywordId: 'kw_portable_01',
      keywordMain: '4K便携显示器',
      text: 'Type-C一线通触控便携屏办公实测推荐哪款？',
      included: false,
      source: 'AI',
      usedCount: 1,
      createdAt: '2026-11-15T08:10:00.000Z',
    },
  ];
}

function buildSampleRunDetail(
  status: VisibilityRunRecord['status'] = 'RUNNING',
): VisibilityRunDetailRecord {
  return {
    id: 'vrun_demo_001',
    profileId: 'vprof_starview',
    profileName: '便携显示器核心监测档案',
    brandName: '星图显示',
    keywordId: 'kw_portable_01',
    keywordMain: '4K便携显示器',
    name: '便携显示器11月国内主流引擎巡检',
    engines: ['deepseek', 'doubao'],
    questionIds: ['q_01', 'q_02'],
    totalChecks: 4,
    doneCount: 2,
    failCount: 0,
    skipCount: 0,
    unitPrice: 2,
    frozenPoints: 8,
    settledPoints: 4,
    releasedPoints: 0,
    reservationId: 'resv_001',
    status,
    lastError: null,
    visibilityPct: 50,
    createdAt: '2026-11-17T06:20:00.000Z',
    updatedAt: '2026-11-17T06:22:00.000Z',
    finishedAt: null,
    metrics: {
      completedChecks: 2,
      mentionedChecks: 1,
      visibilityPct: 50,
      shareOfVoice: {
        totalMentions: 3,
        brandMentions: 1,
        brandSharePct: 33.3,
        entries: [
          { name: '领航视界', isBrand: false, mentions: 2, sharePct: 66.7 },
          { name: '星图显示', isBrand: true, mentions: 1, sharePct: 33.3 },
          { name: '极光屏显', isBrand: false, mentions: 0, sharePct: 0 },
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
      totalCitations: 2,
      ownedCitations: 1,
      ownedCitationChecks: 1,
      ownedCitationRatePct: 50,
      ownedCitationCheckRatePct: 50,
      topDomains: [
        { domain: 'docs.starview.cn', sourceKind: 'OWNED', count: 1, observationCount: 1 },
        { domain: 'zhihu.com', sourceKind: 'SOCIAL', count: 1, observationCount: 1 },
      ],
    },
    observations: [
      {
        id: 'vobs_01',
        runId: 'vrun_demo_001',
        profileId: 'vprof_starview',
        questionId: 'q_01',
        promptText: '商务出差4K便携显示器哪个品牌色彩准且轻薄？',
        engine: 'deepseek',
        status: 'SUCCESS',
        collectorKind: 'fake',
        answerText:
          '针对高频差旅与多屏移动办公场景，首推星图显示（StarView）Pro 16 4K 便携屏，具备 ΔE<1 出厂校色与全功能 Type-C 一线通；其次可对比领航视界商务系列。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        brandPassage:
          '首推星图显示（StarView）Pro 16 4K 便携屏，具备 ΔE<1 出厂校色与全功能 Type-C 一线通',
        competitorHits: [{ name: '领航视界', mentioned: true, position: 2, sentiment: 'neutral' }],
        fanOutQueries: ['4K出差便携屏色准横评', 'Type-C一线通便携显示器推荐'],
        judgeModel: 'deepseek-chat',
        tokensIn: 320,
        tokensOut: 410,
        error: null,
        checkedAt: '2026-11-17T06:21:00.000Z',
        createdAt: '2026-11-17T06:20:10.000Z',
        citations: [
          {
            id: 'vcite_01',
            url: 'https://docs.starview.cn/pro16-color-calibration',
            domain: 'docs.starview.cn',
            title: '星图显示 Pro 16 色彩校色白皮书',
            snippet: '每台设备出厂附带独立 sRGB 与 DCI-P3 校色报告',
            sourceKind: 'OWNED',
            position: 1,
            createdAt: '2026-11-17T06:21:00.000Z',
          },
          {
            id: 'vcite_02',
            url: 'https://www.zhihu.com/question/66881122',
            domain: 'zhihu.com',
            title: '移动办公便携显示器长测对比',
            snippet: '实测多款 16 寸便携办公屏重量与续航',
            sourceKind: 'SOCIAL',
            position: 2,
            createdAt: '2026-11-17T06:21:00.000Z',
          },
        ],
      },
      {
        id: 'vobs_02',
        runId: 'vrun_demo_001',
        profileId: 'vprof_starview',
        questionId: 'q_02',
        promptText: 'Type-C一线通触控便携屏办公实测推荐哪款？',
        engine: 'doubao',
        status: 'SUCCESS',
        collectorKind: 'fake',
        answerText: '在十点触控便携显示器品类中，领航视界办公款支持折叠支架与防眩光涂层。',
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: null,
        brandPassage: null,
        competitorHits: [{ name: '领航视界', mentioned: true, position: 1, sentiment: 'positive' }],
        fanOutQueries: ['十点触控便携屏防眩光实测'],
        judgeModel: 'doubao-pro',
        tokensIn: 280,
        tokensOut: 330,
        error: null,
        checkedAt: '2026-11-17T06:21:30.000Z',
        createdAt: '2026-11-17T06:20:10.000Z',
        citations: [],
      },
    ],
  };
}

function buildMockGateway() {
  const profiles: VisibilityProfileRecord[] = buildSampleProfiles();
  const keywords = buildSampleKeywords();
  const questions = buildSampleQuestions();
  const runs: VisibilityRunDetailRecord[] = [buildSampleRunDetail('RUNNING')];

  const createdProfiles: VisibilityProfileCreateWithPrefillInput[] = [];
  const createdRuns: Array<{ input: VisibilityRunCreateInput; idempotencyKey: string }> = [];
  const pausedIds: string[] = [];
  const cancelledIds: string[] = [];
  const overviewQueries: VisibilityOverviewQuery[] = [];
  const citationQueries: VisibilityCitationQuery[] = [];
  const importedOpportunityCalls: ImportQuestionsInput[] = [];

  const allCitationItems = [
    {
      domain: 'docs.starview.cn',
      sourceKind: 'OWNED' as CitationSourceKind,
      citationCount: 8,
      questionCount: 4,
      topUrls: [
        {
          url: 'https://docs.starview.cn/pro16-color-calibration',
          title: '星图显示 Pro 16 色彩校色白皮书',
          count: 5,
        },
        {
          url: 'https://docs.starview.cn/usb-c-guide',
          title: 'Type-C 一线通笔记本兼容性手册',
          count: 3,
        },
      ],
    },
    {
      domain: 'zhihu.com',
      sourceKind: 'SOCIAL' as CitationSourceKind,
      citationCount: 6,
      questionCount: 3,
      topUrls: [
        {
          url: 'https://www.zhihu.com/question/66881122',
          title: '2026 商务便携屏深度横评',
          count: 6,
        },
      ],
    },
    {
      domain: '36kr.com',
      sourceKind: 'AUTHORITY' as CitationSourceKind,
      citationCount: 4,
      questionCount: 2,
      topUrls: [
        {
          url: 'https://36kr.com/p/29100881',
          title: '移动混合办公外设行业年度报告',
          count: 4,
        },
      ],
    },
  ];

  const gateway: VisibilityGateway = {
    async listProfiles() {
      return {
        items: [...profiles],
        prefillSources: {
          keywords: keywords.map((k) => ({ id: k.id, main: k.main, brands: k.brands })),
          knowledgeBases: [
            {
              id: 'kb_starview_01',
              name: '星图硬件产品技术库',
              companyName: '深圳星图显示技术有限公司',
              brandShort: '星图显示',
            },
          ],
        },
      };
    },
    async createProfile(input) {
      createdProfiles.push(input);
      const created: VisibilityProfileRecord = {
        id: `vprof_new_${profiles.length + 1}`,
        name: input.name,
        brandName: input.brandName || '曜石光学',
        brandAliases: input.brandAliases ?? [],
        ownedDomains: input.ownedDomains ?? [],
        competitors: (input.competitors ?? []).map((c) => ({
          name: c.name,
          aliases: c.aliases ?? [],
          domains: c.domains ?? [],
        })),
        runCount: 0,
        createdAt: '2026-11-17T08:00:00.000Z',
        updatedAt: '2026-11-17T08:00:00.000Z',
      };
      profiles.unshift(created);
      return created;
    },
    async updateProfile(id, input) {
      const target = profiles.find((p) => p.id === id) ?? profiles[0]!;
      const updated: VisibilityProfileRecord = {
        ...target,
        name: input.name ?? target.name,
        brandName: input.brandName ?? target.brandName,
        brandAliases: input.brandAliases ?? target.brandAliases,
        ownedDomains: input.ownedDomains ?? target.ownedDomains,
      };
      return updated;
    },
    async deleteProfile(id) {
      const idx = profiles.findIndex((p) => p.id === id);
      if (idx >= 0) profiles.splice(idx, 1);
      return { deleted: 1 };
    },
    async listRuns(query) {
      const filtered = runs.filter((r) => {
        if (query.profileId && r.profileId !== query.profileId) return false;
        if (query.status && r.status !== query.status) return false;
        if (
          query.keyword &&
          !r.name.includes(query.keyword) &&
          !r.brandName.includes(query.keyword)
        ) {
          return false;
        }
        return true;
      });
      return {
        page: query.page,
        pageSize: query.pageSize,
        total: filtered.length,
        items: filtered,
      };
    },
    async getRun(id) {
      return runs.find((r) => r.id === id) ?? runs[0]!;
    },
    async createRun(input, idempotencyKey) {
      createdRuns.push({ input, idempotencyKey });
      const promptTotal = (input.questionIds?.length ?? 0) + (input.customPrompts?.length ?? 0);
      const checks = promptTotal * input.engines.length;
      const created: VisibilityRunDetailRecord = {
        ...buildSampleRunDetail('QUEUED'),
        id: 'vrun_demo_002',
        profileId: input.profileId,
        name: input.name || '星图显示-新建监测任务',
        engines: input.engines,
        totalChecks: checks,
        doneCount: 0,
        frozenPoints: checks * 2,
        settledPoints: 0,
      };
      runs.unshift(created);
      return created;
    },
    async pauseRun(id) {
      pausedIds.push(id);
      const found = runs.find((r) => r.id === id) ?? runs[0]!;
      found.status = 'PAUSED';
      return { ...found };
    },
    async resumeRun(id) {
      const found = runs.find((r) => r.id === id) ?? runs[0]!;
      found.status = 'RUNNING';
      return { ...found };
    },
    async cancelRun(id) {
      cancelledIds.push(id);
      const found = runs.find((r) => r.id === id) ?? runs[0]!;
      found.status = 'CANCELLED';
      return { ...found };
    },
    async bulkDeleteRuns(ids) {
      for (const id of ids) {
        const idx = runs.findIndex((r) => r.id === id);
        if (idx >= 0) runs.splice(idx, 1);
      }
      return { deleted: ids.length };
    },
    async listKeywords() {
      return keywords;
    },
    async listQuestionsByKeyword(keywordId) {
      return questions.filter((q) => q.keywordId === keywordId);
    },
    async listPrices() {
      return [
        {
          action: 'visibility_check',
          unitPoints: 2,
          enabled: true,
          label: 'AI可见性监测',
        },
      ];
    },
    async getOverview(query): Promise<VisibilityOverviewResponse> {
      overviewQueries.push(query);
      return {
        profileId: query.profileId ?? 'vprof_starview',
        metrics: {
          completedChecks: 20,
          mentionedChecks: 13,
          visibilityPct: 65.0,
          shareOfVoice: {
            totalMentions: 25,
            brandMentions: 13,
            brandSharePct: 52.0,
            entries: [
              { name: '星图显示', isBrand: true, mentions: 13, sharePct: 52.0 },
              { name: '领航视界', isBrand: false, mentions: 8, sharePct: 32.0 },
              { name: '极光屏显', isBrand: false, mentions: 4, sharePct: 16.0 },
            ],
          },
          avgPosition: 1.4,
          sentimentSummary: {
            positive: 10,
            neutral: 2,
            mixed: 1,
            negative: 0,
            total: 13,
            positivePct: 76.9,
            negativePct: 0,
          },
          totalCitations: 18,
          ownedCitations: 8,
          ownedCitationChecks: 7,
          ownedCitationRatePct: 44.4,
          ownedCitationCheckRatePct: 35.0,
          topDomains: [
            { domain: 'docs.starview.cn', sourceKind: 'OWNED', count: 8, observationCount: 7 },
            { domain: 'zhihu.com', sourceKind: 'SOCIAL', count: 6, observationCount: 5 },
          ],
        },
        trend: [
          {
            date: '2026-11-15',
            engine: 'all',
            completedChecks: 6,
            mentionedChecks: 3,
            visibilityPct: 50.0,
          },
          {
            date: '2026-11-16',
            engine: 'all',
            completedChecks: 7,
            mentionedChecks: 5,
            visibilityPct: 71.4,
          },
          {
            date: '2026-11-17',
            engine: 'all',
            completedChecks: 7,
            mentionedChecks: 5,
            visibilityPct: 71.4,
          },
        ],
        byEngine: [
          {
            engine: 'deepseek',
            completedChecks: 10,
            mentionedChecks: 8,
            visibilityPct: 80.0,
            avgPosition: 1.2,
          },
          {
            engine: 'doubao',
            completedChecks: 10,
            mentionedChecks: 5,
            visibilityPct: 50.0,
            avgPosition: 1.8,
          },
        ],
      };
    },
    async listCitations(query): Promise<VisibilityCitationListResponse> {
      citationQueries.push(query);
      const filtered = query.sourceKind
        ? allCitationItems.filter((item) => item.sourceKind === query.sourceKind)
        : allCitationItems;
      return {
        page: query.page,
        pageSize: query.pageSize,
        total: filtered.length,
        totalCitations: filtered.reduce((acc, item) => acc + item.citationCount, 0),
        sourceBreakdown: {
          OWNED: 8,
          COMPETITOR: 0,
          SOCIAL: 6,
          AUTHORITY: 4,
          OTHER: 0,
        },
        items: filtered,
      };
    },
    async listOpportunities(): Promise<VisibilityOpportunitiesResponse> {
      return {
        gaps: [
          {
            promptText: '差旅办公便携屏哪个品牌性价比最高？',
            questionId: null,
            competitors: ['领航视界', '极光屏显'],
            engines: ['deepseek', 'doubao'],
            observationCount: 3,
          },
        ],
        fanOutQueries: [
          {
            query: 'Type-C一线通便携屏实测',
            frequency: 5,
            sourcePrompts: ['商务出差4K便携显示器哪个品牌色彩准且轻薄？'],
            engines: ['deepseek'],
            brandMentionedPct: 40,
          },
          {
            query: '4K便携显示器色准对比',
            frequency: 2,
            sourcePrompts: ['差旅办公便携屏哪个品牌性价比最高？'],
            engines: ['doubao'],
            brandMentionedPct: 0,
          },
        ],
      };
    },
    async importOpportunityQuestions(input: ImportQuestionsInput) {
      importedOpportunityCalls.push(input);
      return {
        insertedCount: input.titles.length,
        skippedCount: 0,
        keywordId: input.keywordId,
      };
    },
  };

  return {
    gateway,
    createdProfiles,
    createdRuns,
    pausedIds,
    cancelledIds,
    overviewQueries,
    citationQueries,
    importedOpportunityCalls,
  };
}

describe('Visibility feature flag & SideMenu', () => {
  it('displays AI数据看板 and AI可见度诊断 by default and hides both when account.features.visibility is false', () => {
    const baseAccount: AccountProfile = {
      id: 'u_vis_01',
      username: 'merchant_vis',
      nickname: '星图品牌运营',
      role: 'MERCHANT',
      features: { aiImage: true, visibility: true },
      tenant: {
        id: 't_vis_01',
        name: '深圳星图显示技术有限公司',
        expiresAt: '2027-12-31T00:00:00.000Z',
        isActive: true,
        readOnly: false,
      },
    };

    const state = reduceShell(initialSnapshot(), { type: 'open', href: '/dashboard' });

    const { container, rerender } = render(
      <ShellFrame
        account={baseAccount}
        state={state}
        onDispatch={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={async () => null}
      />,
    );

    const sider = container.querySelector('aside') as HTMLElement;
    expect(sider).toBeTruthy();
    expect(within(sider).getByText('AI数据看板')).toBeTruthy();
    expect(within(sider).getAllByText('AI可见度诊断').length).toBeGreaterThanOrEqual(2);

    rerender(
      <ShellFrame
        account={{ ...baseAccount, features: { aiImage: true, visibility: false } }}
        state={state}
        onDispatch={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={async () => null}
      />,
    );

    expect(within(sider).queryByText('AI数据看板')).toBeNull();
    expect(within(sider).queryByText('AI可见度诊断')).toBeNull();
  });

  it('preserves independent drafts across /visibility/monitors and /visibility/overview tabs', () => {
    const account: AccountProfile = {
      id: 'u_vis_02',
      username: 'merchant_tabs',
      nickname: '多标签运营',
      role: 'MERCHANT',
      features: { aiImage: true, visibility: true },
      tenant: {
        id: 't_vis_02',
        name: '杭州激光投影企业',
        expiresAt: '2027-12-31T00:00:00.000Z',
        isActive: true,
        readOnly: false,
      },
    };

    let state = initialSnapshot();
    state = reduceShell(state, { type: 'open', href: '/visibility/monitors' });
    state = reduceShell(state, { type: 'open', href: '/visibility/overview' });
    state = reduceShell(state, {
      type: 'draft',
      id: '/visibility/monitors',
      value: '下周补充激光投影仪高亮度对比问题',
    });
    state = reduceShell(state, {
      type: 'draft',
      id: '/visibility/overview',
      value: '重点跟进知乎与36氪高权重评测信源',
    });

    render(
      <ShellFrame
        account={account}
        state={state}
        onDispatch={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={async () => null}
      />,
    );

    expect((screen.getByLabelText('AI数据看板草稿') as HTMLTextAreaElement).value).toBe(
      '重点跟进知乎与36氪高权重评测信源',
    );
    expect(
      (document.querySelector('[aria-label="AI可见度诊断草稿"]') as HTMLTextAreaElement).value,
    ).toBe('下周补充激光投影仪高亮度对比问题');
  });
});

describe('VisibilityMonitorsScreen', () => {
  it('dispatches overview navigation and creates a profile with keyword prefill and competitors', async () => {
    const { gateway, createdProfiles } = buildMockGateway();
    const dispatched: unknown[] = [];

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('去看板分析-便携显示器11月国内主流引擎巡检'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/visibility/overview?profileId=vprof_starview',
      sourceId: '/visibility/monitors',
    });

    fireEvent.click(screen.getByRole('tab', { name: /品牌与竞品档案/ }));
    await waitFor(() => {
      expect(screen.getByText('星图触控便携屏')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    const kwPrefillSelect = screen.getByLabelText('从关键词快捷预填') as HTMLSelectElement;
    fireEvent.change(kwPrefillSelect, { target: { value: 'kw_projector_02' } });

    expect((screen.getByLabelText('主品牌名称') as HTMLInputElement).value).toBe('曜石光学');
    expect((screen.getByLabelText('品牌别名') as HTMLTextAreaElement).value).toContain(
      'ObsidianOptics',
    );

    fireEvent.change(screen.getByLabelText('自有官网域名'), {
      target: { value: 'https://www.obsidianoptics.cn' },
    });
    fireEvent.click(screen.getByLabelText('添加监测竞品'));
    fireEvent.change(screen.getByLabelText('竞品名称-1'), { target: { value: '明眸投影' } });
    fireEvent.change(screen.getByLabelText('竞品域名-1'), { target: { value: 'mingmou.cn' } });

    fireEvent.click(screen.getByLabelText('保存品牌档案'));

    await waitFor(() => {
      expect(createdProfiles).toHaveLength(1);
    });
    expect(createdProfiles[0]).toMatchObject({
      brandName: '曜石光学',
      ownedDomains: ['obsidianoptics.cn'],
      importFromKeywordId: 'kw_projector_02',
      competitors: [{ name: '明眸投影', domains: ['mingmou.cn'] }],
    });
  });

  it('calculates dynamic run points (3×2×2=12) and submits createRun with Idempotency-Key', async () => {
    const { gateway, createdRuns } = buildMockGateway();

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('新建监测任务'));
    await waitFor(() => {
      expect(screen.getByText('商务出差4K便携显示器哪个品牌色彩准且轻薄？')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('全选当前主词问题'));
    fireEvent.change(screen.getByLabelText('自定义监测问题'), {
      target: { value: '双屏笔记本扩展便携屏哪家售后更完善？' },
    });

    fireEvent.click(screen.getByLabelText('清空引擎选择'));
    fireEvent.click(screen.getByLabelText('选择引擎-DeepSeek'));
    fireEvent.click(screen.getByLabelText('选择引擎-豆包'));

    await waitFor(() => {
      expect(screen.getByText(/共 3 个问题 × 2 个引擎 = 6 次检测，预计冻结 12 点数/)).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('开始监测（2点数/次，共 12 点）'));

    await waitFor(() => {
      expect(createdRuns).toHaveLength(1);
    });
    expect(createdRuns[0]?.input).toMatchObject({
      engines: ['deepseek', 'doubao'],
      questionIds: ['q_01', 'q_02'],
      customPrompts: ['双屏笔记本扩展便携屏哪家售后更完善？'],
    });
    expect(createdRuns[0]?.idempotencyKey).toMatch(/^vrun_/);
  });

  it('pauses/cancels runs and inspects diagnostic detail drawer evidence, citations, and raw answer', async () => {
    const { gateway, pausedIds, cancelledIds } = buildMockGateway();

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('暂停-便携显示器11月国内主流引擎巡检'));
    await waitFor(() => {
      expect(pausedIds).toContain('vrun_demo_001');
    });

    fireEvent.click(screen.getByLabelText('终止-便携显示器11月国内主流引擎巡检'));
    const confirmCancelBtn = await screen.findByRole('button', {
      name: '确认终止并退还未用点数',
    });
    fireEvent.click(confirmCancelBtn);
    await waitFor(() => {
      expect(cancelledIds).toContain('vrun_demo_001');
    });

    fireEvent.click(screen.getByLabelText('查看详情-便携显示器11月国内主流引擎巡检'));
    const obsCard = await screen.findByTestId('observation-card-vobs_01');
    expect(within(obsCard).getByText(/首推星图显示（StarView）Pro 16 4K 便携屏/)).toBeTruthy();
    expect(within(obsCard).getByText(/docs\.starview\.cn/)).toBeTruthy();

    fireEvent.click(within(obsCard).getByLabelText('展开原始回答-vobs_01'));
    expect(await screen.findByTestId('raw-answer-vobs_01')).toBeTruthy();
  });

  it('disables write buttons in readOnly mode', async () => {
    const { gateway } = buildMockGateway();
    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        readOnly
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    expect((screen.getByLabelText('新建监测任务') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('新建品牌档案') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('暂停-便携显示器11月国内主流引擎巡检')).toBeNull();
    expect(screen.queryByLabelText('终止-便携显示器11月国内主流引擎巡检')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /品牌与竞品档案/ }));
    await waitFor(() => {
      expect(
        (screen.getByLabelText('发起监测-便携显示器核心监测档案') as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    expect(
      (screen.getByLabelText('编辑档案-便携显示器核心监测档案') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('删除档案-便携显示器核心监测档案') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('eliminates dead AI可见性监测 button and duplicate search/add/toggle toolbar, supports Enter search, export, and tab switching (#190)', async () => {
    const { gateway, listRunsQueries } = (() => {
      const base = buildMockGateway();
      const queries: unknown[] = [];
      return {
        listRunsQueries: queries,
        gateway: {
          ...base.gateway,
          async listRuns(q: Parameters<VisibilityGateway['listRuns']>[0]) {
            queries.push(q);
            return base.gateway.listRuns(q);
          },
        },
      };
    })();
    const downloaded: Array<{ filename: string; mime: string; body: Uint8Array }> = [];

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
        downloadFile={(file) => downloaded.push(file)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    // 1. Dead button 'AI可见性监测（2点数/次）' must not exist as a clickable button
    expect(screen.queryByRole('button', { name: /AI可见性监测/ })).toBeNull();
    expect(screen.getByText(/点数\/次/)).toBeTruthy();

    // 2. Duplicate CrudTable search, add, toggle buttons and redundant second 查询 must not exist
    expect(screen.queryByRole('button', { name: '搜索' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加' })).toBeNull();
    expect(screen.queryByRole('button', { name: '切换' })).toBeNull();
    expect(screen.queryByPlaceholderText('名称或备注')).toBeNull();
    expect(screen.getAllByRole('button', { name: /查询/ })).toHaveLength(1);

    // 3. Pagination includes 共 X 条
    expect(screen.getByText('共 1 条')).toBeTruthy();

    // 4. Enter key in 搜索监测任务 submits search
    const searchInput = screen.getByLabelText('搜索监测任务');
    fireEvent.change(searchInput, { target: { value: '星图' } });
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() => {
      expect(listRunsQueries.some((q) => (q as { keyword?: string }).keyword === '星图')).toBe(
        true,
      );
    });

    // 5. Export CSV works cleanly
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    fireEvent.click(await screen.findByText('CSV'));
    await waitFor(() => {
      expect(downloaded).toHaveLength(1);
    });
    expect(downloaded[0]?.filename).toBe('geomix-visibility-runs.csv');
    expect(new TextDecoder().decode(downloaded[0]?.body)).toContain(
      '便携显示器11月国内主流引擎巡检',
    );

    // 6. Tab switching works cleanly
    fireEvent.click(screen.getByRole('tab', { name: /品牌与竞品档案/ }));
    await waitFor(() => {
      expect(screen.getByText('星图触控便携屏')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('tab', { name: /监测任务/ }));
    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });
  });

  it('keeps existing default profile when creating new profile with default switch OFF, blocks deleting active runs, closes modals on Escape, and clears success banner on tab switch (#192)', async () => {
    const { gateway } = buildMockGateway();

    render(
      <div className="gm-page" data-tab-id="/visibility/monitors">
        <VisibilityMonitorsScreen
          title="AI可见度诊断"
          tabId="/visibility/monitors"
          gateway={gateway}
          pollIntervalMs={0}
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    // 1. Selecting a RUNNING run and clicking bulk 删除 must NOT claim "已结束监测任务记录"
    const rowCheckboxes = document.querySelectorAll<HTMLInputElement>(
      '.ant-table-tbody input[type="checkbox"]',
    );
    expect(rowCheckboxes.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(rowCheckboxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText('无法删除进行中的监测任务')).toBeTruthy();
    expect(screen.queryByText(/已结束监测任务记录/)).toBeNull();
    expect(screen.getByText(/禁止直接删除/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即终止该任务' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(screen.queryByText('无法删除进行中的监测任务')).toBeNull();
    });

    // 2. Switch to 品牌与竞品档案; existing profile vprof_starview is default even when localStorage starts empty
    fireEvent.click(screen.getByRole('tab', { name: /品牌与竞品档案/ }));
    const existingCard = await screen.findByTestId('profile-card-vprof_starview');
    expect(within(existingCard).getByText('默认档案')).toBeTruthy();

    // Open create modal with switch OFF, test Escape closes modal, reopen & submit
    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    expect(screen.getByRole('dialog', { name: '新建品牌与竞品档案' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建品牌与竞品档案' })).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    const defaultSwitch = screen.getByRole('switch', { name: '设为默认档案' });
    expect(defaultSwitch.getAttribute('aria-checked')).toBe('false');

    fireEvent.change(screen.getByLabelText('档案名称'), {
      target: { value: '安克创新（Anker）全品类监测档案' },
    });
    fireEvent.change(screen.getByLabelText('主品牌名称'), {
      target: { value: '安克创新' },
    });
    fireEvent.click(screen.getByLabelText('保存品牌档案'));

    const newCard = await screen.findByTestId('profile-card-vprof_new_2');
    expect(within(newCard).queryByText('默认档案')).toBeNull();
    expect(within(existingCard).getByText('默认档案')).toBeTruthy();
    expect(window.localStorage.getItem('geomix:visibility:default-profile-id')).toBe(
      'vprof_starview',
    );

    // 3. Success banner clears on sub-tab switch
    expect(screen.getByText(/已创建监测档案「安克创新（Anker）全品类监测档案」/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /监测任务/ }));
    await waitFor(() => {
      expect(screen.queryByText(/已创建监测档案「安克创新（Anker）全品类监测档案」/)).toBeNull();
    });

    // 4. Success banner also clears when ShellFrame hides .gm-page on shell tab switch
    fireEvent.click(screen.getByRole('tab', { name: /品牌与竞品档案/ }));
    fireEvent.click(await screen.findByLabelText('设为默认-安克创新（Anker）全品类监测档案'));
    expect(
      await screen.findByText(/已将「安克创新（Anker）全品类监测档案」设为默认监测档案/),
    ).toBeTruthy();

    const pageEl = document.querySelector('.gm-page') as HTMLElement;
    pageEl.setAttribute('hidden', '');
    await waitFor(() => {
      expect(
        screen.queryByText(/已将「安克创新（Anker）全品类监测档案」设为默认监测档案/),
      ).toBeNull();
    });
  });

  it('sets max-content horizontal scroll and non-crushed cell widths, two-row card action layout, and leading red asterisks (#193)', async () => {
    const { gateway } = buildMockGateway();

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    // 1. Table scroll={{ x: 'max-content' }} & cell minWidth / nowrap guards
    const tableEl = document.querySelector('.gm-monitors-table-wrap table') as HTMLTableElement;
    expect(tableEl).toBeTruthy();
    expect(tableEl.style.width).toBe('max-content');
    expect(tableEl.style.minWidth).toBe('100%');

    const profileCell = screen.getByTestId('run-profile-cell-vrun_demo_001');
    expect(profileCell.style.minWidth).toBe('168px');
    const keywordCell = screen.getByTestId('run-keyword-cell-vrun_demo_001');
    expect(keywordCell.style.minWidth).toBe('112px');

    // 2. Two-row aligned profile card footer across default and non-default cards
    fireEvent.click(screen.getByRole('tab', { name: /品牌与竞品档案/ }));
    const actionsBox = await screen.findByTestId('profile-card-actions-vprof_starview');
    const rows = actionsBox.querySelectorAll('.gm-profile-card-actions-row');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByLabelText('发起监测-便携显示器核心监测档案'),
    ).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByLabelText('档案看板-便携显示器核心监测档案'),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByLabelText('编辑档案-便携显示器核心监测档案'),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByLabelText('删除档案-便携显示器核心监测档案'),
    ).toBeTruthy();

    // 3. Leading red asterisks in Profile modal and Run modal
    fireEvent.click(screen.getByLabelText('新增品牌与竞品档案'));
    const profileDialog = screen.getByRole('dialog', { name: '新建品牌与竞品档案' });
    const profileMarks = profileDialog.querySelectorAll('.gm-required-mark');
    expect(profileMarks).toHaveLength(2);
    expect(profileMarks[0]?.parentElement?.textContent).toMatch(/^\*\s*档案名称$/);
    expect(profileMarks[1]?.parentElement?.textContent).toMatch(/^\*\s*主品牌名称$/);
    expect((profileMarks[0] as HTMLElement).style.color).toBe('var(--gm-danger)');
    fireEvent.click(within(profileDialog).getByRole('button', { name: '取消' }));

    fireEvent.click(screen.getByLabelText('新建监测任务'));
    const runDialog = await screen.findByRole('dialog', { name: '新建 AI 可见度监测任务' });
    const runMarks = runDialog.querySelectorAll('.gm-required-mark');
    expect(runMarks).toHaveLength(2);
    expect(runMarks[0]?.parentElement?.textContent).toMatch(/^\*\s*选择监测档案$/);
    expect(runMarks[1]?.parentElement?.textContent).toMatch(/^\*\s*目标 AI 引擎/);
  });

  it('validates required profile name inline on blur and change with consistent field-label wording (#220)', async () => {
    const { gateway } = buildMockGateway();

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('便携显示器11月国内主流引擎巡检')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('新建品牌档案'));
    const nameInput = screen.getByLabelText('档案名称') as HTMLInputElement;

    // 1. Blur empty 档案名称 immediately shows inline error matching label '档案名称'
    fireEvent.focus(nameInput);
    fireEvent.blur(nameInput);

    const inlineErr = await screen.findByTestId('profile-name-error');
    expect(inlineErr.textContent).toBe('请填写档案名称');
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/请填写监测档案名称/)).toBeNull();

    // 2. Typing clears inline error; clearing re-triggers it
    fireEvent.change(nameInput, { target: { value: '星图海外监测' } });
    expect(screen.queryByTestId('profile-name-error')).toBeNull();
    expect(nameInput.getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(nameInput, { target: { value: '' } });
    expect((await screen.findByTestId('profile-name-error')).textContent).toBe('请填写档案名称');

    // 3. Clicking 保存档案 directly on empty form shows consistent '请填写档案名称' (never '监测档案名称')
    fireEvent.click(screen.getByLabelText('重置'));
    fireEvent.click(screen.getByLabelText('保存品牌档案'));

    await waitFor(() => {
      expect(screen.getByTestId('profile-name-error').textContent).toBe('请填写档案名称');
    });
    expect(screen.getAllByText('请填写档案名称').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/请填写监测档案名称/)).toBeNull();
  });

  it('isolates 关联训练主词 by selected profile, avoids prefilling other-brand keywords, and resets keyword & checked questions on profile switch (#218)', async () => {
    const base = buildMockGateway();
    const ankerProfile: VisibilityProfileRecord = {
      id: 'vprof_anker',
      name: '安克创新（Anker）全品类监测档案',
      brandName: '安克创新',
      brandAliases: ['Anker'],
      ownedDomains: ['anker.com'],
      competitors: [
        { name: '绿联 UGREEN', aliases: ['UGREEN'], domains: ['ugreen.com'] },
        { name: '倍思 Baseus', aliases: ['Baseus'], domains: ['baseus.com'] },
      ],
      runCount: 1,
      createdAt: '2026-11-16T08:00:00.000Z',
      updatedAt: '2026-11-16T08:00:00.000Z',
    };
    const arzopaProfile: VisibilityProfileRecord = {
      id: 'vprof_arzopa',
      name: 'ARZOPA便携显示器北美监测档案',
      brandName: 'ARZOPA',
      brandAliases: ['Arzopa Portable Monitor', '便携显示器'],
      ownedDomains: ['arzopa.com'],
      competitors: [
        { name: 'ASUS ZenScreen', aliases: [], domains: ['asus.com'] },
        { name: 'Lenovo ThinkVision', aliases: [], domains: ['lenovo.com'] },
      ],
      runCount: 0,
      createdAt: '2026-11-17T08:00:00.000Z',
      updatedAt: '2026-11-17T08:00:00.000Z',
    };

    const tenantKeywords: KeywordRecord[] = [
      {
        id: 'kw_anker_gan',
        main: 'Anker氮化镓充电器',
        brands: ['Anker'],
        optStatus: 'INCLUDED',
        questionCount: 2,
        createdAt: '2026-11-15T08:00:00.000Z',
      },
      {
        id: 'kw_clouddesk_crm',
        main: '企业客户关系管理CRM',
        brands: ['CloudDesk'],
        optStatus: 'NONE',
        questionCount: 1,
        createdAt: '2026-11-15T09:00:00.000Z',
      },
    ];

    const ankerQuestions: QuestionRecord[] = [
      {
        id: 'q_anker_01',
        keywordId: 'kw_anker_gan',
        keywordMain: 'Anker氮化镓充电器',
        text: 'Anker氮化镓充电器发热控制与安全认证怎么样？',
        included: true,
        source: 'AI',
        usedCount: 1,
        createdAt: '2026-11-15T08:10:00.000Z',
      },
      {
        id: 'q_anker_02',
        keywordId: 'kw_anker_gan',
        keywordMain: 'Anker氮化镓充电器',
        text: 'Anker氮化镓充电器支持MacBook和iPhone快充吗？',
        included: false,
        source: 'MANUAL',
        usedCount: 0,
        createdAt: '2026-11-15T08:20:00.000Z',
      },
    ];

    window.localStorage.setItem('geomix:visibility:default-profile-id', 'vprof_anker');

    const gateway: VisibilityGateway = {
      ...base.gateway,
      async listProfiles() {
        return {
          items: [arzopaProfile, ankerProfile],
          prefillSources: { keywords: [], knowledgeBases: [] },
        };
      },
      async listKeywords() {
        return tenantKeywords;
      },
      async listQuestionsByKeyword(keywordId) {
        return keywordId === 'kw_anker_gan' ? ankerQuestions : [];
      },
    };

    render(
      <VisibilityMonitorsScreen
        title="AI可见度诊断"
        tabId="/visibility/monitors"
        gateway={gateway}
        pollIntervalMs={0}
      />,
    );

    // 1. Go to 品牌与竞品档案 and click 发起监测 directly on ARZOPA (which has 0 matching keywords)
    fireEvent.click(await screen.findByRole('tab', { name: /品牌与竞品档案/ }));
    fireEvent.click(await screen.findByLabelText('发起监测-ARZOPA便携显示器北美监测档案'));

    const runDialog = await screen.findByRole('dialog', { name: '新建 AI 可见度监测任务' });
    const profileSelect = within(runDialog).getByLabelText('选择监测档案') as HTMLSelectElement;
    const kwSelect = within(runDialog).getByLabelText('关联训练主词') as HTMLSelectElement;

    expect(profileSelect.value).toBe('vprof_arzopa');
    expect(kwSelect.value).toBe('');
    const arzopaOptionValues = Array.from(kwSelect.options).map((o) => o.value);
    expect(arzopaOptionValues).toEqual(['']);
    expect(within(runDialog).queryByText(/Anker氮化镓充电器发热控制/)).toBeNull();

    // 2. Switch profile inside modal to Anker -> Anker's keyword becomes available and preselected
    fireEvent.change(profileSelect, { target: { value: 'vprof_anker' } });
    await waitFor(() => {
      expect(kwSelect.value).toBe('kw_anker_gan');
    });
    expect(Array.from(kwSelect.options).map((o) => o.value)).toEqual(['', 'kw_anker_gan']);
    expect(
      await within(runDialog).findByText('Anker氮化镓充电器发热控制与安全认证怎么样？'),
    ).toBeTruthy();

    // Check all Anker questions -> 2 questions × 4 engines = 8 checks
    fireEvent.click(within(runDialog).getByLabelText('全选当前主词问题'));
    expect(within(runDialog).getByText(/共 2 个问题 × 4 个引擎 = 8 次检测/)).toBeTruthy();

    // 3. Switch profile back to ARZOPA -> keywordId and checked questionIds MUST reset immediately!
    fireEvent.change(profileSelect, { target: { value: 'vprof_arzopa' } });
    await waitFor(() => {
      expect(kwSelect.value).toBe('');
    });
    expect(Array.from(kwSelect.options).map((o) => o.value)).toEqual(['']);
    expect(within(runDialog).queryByText(/Anker氮化镓充电器发热控制/)).toBeNull();
    expect(within(runDialog).getByText(/共 0 个问题 × 4 个引擎 = 0 次检测/)).toBeTruthy();
  });
});

describe('VisibilityOverviewScreen', () => {
  it('renders 4 KPI cards, SVG trend chart, competitor SoV comparison, engine breakdown, validates date range, and filters citations by sourceKind', async () => {
    const { gateway, overviewQueries, citationQueries } = buildMockGateway();

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href="/visibility/overview?profileId=vprof_starview"
        gateway={gateway}
      />,
    );

    // 1. Core KPI cards + SVG chart + SoV + Engine breakdown
    await waitFor(() => {
      expect(within(screen.getByTestId('kpi-visibility')).getByText('65.0%')).toBeTruthy();
    });
    expect(within(screen.getByTestId('kpi-sov')).getByText('52.0%')).toBeTruthy();
    expect(within(screen.getByTestId('kpi-position')).getByText('#1.4')).toBeTruthy();
    expect(within(screen.getByTestId('kpi-owned-citation')).getByText('44.4%')).toBeTruthy();

    expect(screen.getByTestId('visibility-trend-svg')).toBeTruthy();
    expect(within(screen.getByTestId('sov-brand-row')).getByText('星图显示')).toBeTruthy();
    expect(
      within(screen.getByTestId('sov-comp-row-领航视界')).getByText('声量 32.0%'),
    ).toBeTruthy();
    expect(screen.getByText('80.0%')).toBeTruthy();

    // 2. Date range validation (from > to shows error without triggering invalid getOverview)
    const countBeforeInvalid = overviewQueries.length;
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-11-18' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-11-10' } });
    fireEvent.click(screen.getByLabelText('查询看板数据'));

    expect(await screen.findByText(/开始日期不能晚于结束日期/)).toBeTruthy();
    expect(overviewQueries.length).toBe(countBeforeInvalid);

    // Reset clears error and reloads
    fireEvent.click(screen.getByLabelText('重置看板筛选'));
    await waitFor(() => {
      expect(screen.queryByText(/开始日期不能晚于结束日期/)).toBeNull();
      expect(overviewQueries.length).toBeGreaterThan(countBeforeInvalid);
    });

    // 3. Citations sourceKind filter pill
    expect(screen.getByText('zhihu.com')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('来源分类-自有阵地'));

    await waitFor(() => {
      expect(citationQueries.some((q) => q.sourceKind === 'OWNED')).toBe(true);
      expect(screen.queryByText('zhihu.com')).toBeNull();
    });
    expect(screen.getByText('docs.starview.cn')).toBeTruthy();
  });

  it('switches to opportunities tab, imports selected gaps & fanOutQueries into Keyword, and dispatches /writing/tasks?keywordId=...', async () => {
    const { gateway, importedOpportunityCalls } = buildMockGateway();
    const dispatched: Array<{ type: string; href?: string }> = [];

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href="/visibility/overview?profileId=vprof_starview"
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action as { type: string; href?: string })}
      />,
    );

    await waitFor(() => {
      expect(within(screen.getByTestId('kpi-visibility')).getByText('65.0%')).toBeTruthy();
    });

    const oppTab = await screen.findByRole('tab', { name: /优化机会 & 搜索拆解词（Query Fan-Out/ });
    fireEvent.click(oppTab);
    await waitFor(() => {
      expect(oppTab.getAttribute('aria-selected')).toBe('true');
    });

    expect(
      (await screen.findAllByText('差旅办公便携屏哪个品牌性价比最高？')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Type-C一线通便携屏实测')).toBeTruthy();

    // Select target Keyword (must only offer vprof_starview's own keywords, excluding kw_projector_02)
    const kwSelect = screen.getByLabelText('目标主词') as HTMLSelectElement;
    expect(Array.from(kwSelect.options).map((o) => o.value)).not.toContain('kw_projector_02');
    fireEvent.change(kwSelect, { target: { value: 'kw_starview_02' } });
    expect(kwSelect.value).toBe('kw_starview_02');

    // Select 1 gap + 1 fan-out query
    fireEvent.click(screen.getByLabelText('勾选缺口问题-差旅办公便携屏哪个品牌性价比最高？'));
    fireEvent.click(screen.getByLabelText('勾选拆解词-Type-C一线通便携屏实测'));
    expect(screen.getByText('已选 2 条')).toBeTruthy();

    // Click 一键加入写作标题
    fireEvent.click(screen.getByRole('button', { name: '一键加入写作标题' }));
    await waitFor(() => {
      expect(importedOpportunityCalls).toHaveLength(1);
    });
    expect(importedOpportunityCalls[0]).toEqual({
      keywordId: 'kw_starview_02',
      titles: ['差旅办公便携屏哪个品牌性价比最高？', 'Type-C一线通便携屏实测'],
    });
    expect(await screen.findByText(/已导入「写作标题」：新增 2 条，跳过重复 0 条/)).toBeTruthy();

    // Click 去创建写作任务 -> dispatches /writing/tasks?keywordId=kw_starview_02
    fireEvent.click(screen.getByRole('button', { name: '去创建写作任务' }));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/writing/tasks?keywordId=kw_starview_02',
    });
  });

  it('does not backfill or flatline SoV on 0-sample historical dates in trend SVG (#186)', async () => {
    const base = buildMockGateway();
    let scenario: 'single-day' | 'two-days' = 'single-day';

    const gateway: VisibilityGateway = {
      ...base.gateway,
      async getOverview(query) {
        const res = await base.gateway.getOverview(query);
        const trend =
          scenario === 'single-day'
            ? [
                {
                  date: '2026-11-14',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-15',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-16',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-17',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-18',
                  engine: 'all' as const,
                  completedChecks: 3,
                  mentionedChecks: 2,
                  visibilityPct: 66.7,
                  shareOfVoicePct: 66.7,
                },
              ]
            : [
                {
                  date: '2026-11-14',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-15',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-16',
                  engine: 'all' as const,
                  completedChecks: 0,
                  mentionedChecks: 0,
                  visibilityPct: 0,
                  shareOfVoicePct: null,
                },
                {
                  date: '2026-11-17',
                  engine: 'all' as const,
                  completedChecks: 4,
                  mentionedChecks: 2,
                  visibilityPct: 50.0,
                  shareOfVoicePct: 40.0,
                },
                {
                  date: '2026-11-18',
                  engine: 'all' as const,
                  completedChecks: 3,
                  mentionedChecks: 2,
                  visibilityPct: 66.7,
                  shareOfVoicePct: 66.7,
                },
              ];

        return {
          ...res,
          metrics: {
            ...res.metrics,
            shareOfVoice: {
              ...res.metrics.shareOfVoice,
              brandSharePct: 66.7,
            },
          },
          trend,
        };
      },
    };

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href="/visibility/overview?profileId=vprof_starview"
        gateway={gateway}
      />,
    );

    const svg = await screen.findByTestId('visibility-trend-svg');
    expect(svg.querySelector('[data-testid="visibility-sov-line"]')).toBeNull();
    expect(svg.querySelector('[data-testid="visibility-sov-node-2026-11-14"]')).toBeNull();
    expect(svg.querySelector('[data-testid="visibility-sov-node-2026-11-17"]')).toBeNull();
    expect(svg.querySelector('[data-testid="visibility-sov-node-2026-11-18"]')).toBeTruthy();

    scenario = 'two-days';
    fireEvent.click(screen.getByLabelText('近7天'));

    await waitFor(() => {
      const updatedSvg = screen.getByTestId('visibility-trend-svg');
      const sovLine = updatedSvg.querySelector('[data-testid="visibility-sov-line"]');
      expect(sovLine).toBeTruthy();
      const pts = (sovLine?.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean);
      expect(pts).toHaveLength(2);
      expect(updatedSvg.querySelector('[data-testid="visibility-sov-node-2026-11-16"]')).toBeNull();
      expect(
        updatedSvg.querySelector('[data-testid="visibility-sov-node-2026-11-17"]'),
      ).toBeTruthy();
      expect(
        updatedSvg.querySelector('[data-testid="visibility-sov-node-2026-11-18"]'),
      ).toBeTruthy();
    });
  });

  it('renders separate brand-competitor SoV groups for each own-brand under 全部监测档案 (#211)', async () => {
    const base = buildMockGateway();
    const multiProfiles: VisibilityProfileRecord[] = [
      ...buildSampleProfiles().map((p) => ({
        ...p,
        id: 'vprof_arzopa',
        name: 'ARZOPA便携屏全链路监测档案',
        brandName: '阿卓帕',
      })),
      {
        id: 'vprof_anker',
        name: '安克创新（Anker）全品类监测档案',
        brandName: '安克创新',
        brandAliases: ['Anker'],
        ownedDomains: ['anker.com'],
        competitors: [
          { name: '绿联 UGREEN', aliases: [], domains: ['ugreen.com'] },
          { name: '倍思 Baseus', aliases: [], domains: ['baseus.com'] },
        ],
        runCount: 1,
        createdAt: '2026-11-16T09:00:00.000Z',
        updatedAt: '2026-11-16T09:00:00.000Z',
      },
    ];

    const gateway: VisibilityGateway = {
      ...base.gateway,
      async listProfiles() {
        const res = await base.gateway.listProfiles();
        return { ...res, items: multiProfiles };
      },
      async getOverview(query) {
        const res = await base.gateway.getOverview(query);
        return {
          ...res,
          profileId: null,
          brandGroups: [
            {
              brandName: '阿卓帕',
              completedChecks: 8,
              mentionedChecks: 8,
              visibilityPct: 100,
              shareOfVoice: {
                totalMentions: 12,
                brandMentions: 8,
                brandSharePct: 66.7,
                entries: [
                  { name: '阿卓帕', isBrand: true, mentions: 8, sharePct: 66.7 },
                  { name: '联想ThinkVision', isBrand: false, mentions: 4, sharePct: 33.3 },
                ],
              },
            },
            {
              brandName: '安克创新',
              completedChecks: 8,
              mentionedChecks: 6,
              visibilityPct: 75,
              shareOfVoice: {
                totalMentions: 10,
                brandMentions: 6,
                brandSharePct: 60.0,
                entries: [
                  { name: '安克创新', isBrand: true, mentions: 6, sharePct: 60.0 },
                  { name: '绿联 UGREEN', isBrand: false, mentions: 4, sharePct: 40.0 },
                ],
              },
            },
          ],
        } as VisibilityOverviewResponse;
      },
    };

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);

    const groupArzopa = await screen.findByTestId('sov-group-阿卓帕');
    const groupAnker = await screen.findByTestId('sov-group-安克创新');

    expect(within(groupArzopa).getByTestId('sov-brand-row').textContent).toContain('阿卓帕');
    expect(within(groupArzopa).getByTestId('sov-brand-row').textContent).toContain('66.7%');
    expect(within(groupArzopa).queryByText('绿联 UGREEN')).toBeNull();

    expect(within(groupAnker).getByTestId('sov-brand-row').textContent).toContain('安克创新');
    expect(within(groupAnker).getByTestId('sov-brand-row').textContent).toContain('60.0%');
    expect(within(groupAnker).queryByText('联想ThinkVision')).toBeNull();
  });

  it('auto-refreshes on 看板监测档案 change, keeps select single-line, and sets nowrap headers on Query Fan-Out table (#214)', async () => {
    const base = buildMockGateway();
    const longName = '安克创新（Anker）全品类AI搜索引擎可见度与竞品监测档案';
    const profiles: VisibilityProfileRecord[] = [
      ...buildSampleProfiles(),
      {
        id: 'vprof_anker',
        name: longName,
        brandName: '安克创新',
        brandAliases: ['Anker'],
        ownedDomains: ['anker.com'],
        competitors: [],
        runCount: 1,
        createdAt: '2026-11-16T09:00:00.000Z',
        updatedAt: '2026-11-16T09:00:00.000Z',
      },
    ];

    const gateway: VisibilityGateway = {
      ...base.gateway,
      async listProfiles() {
        const res = await base.gateway.listProfiles();
        return { ...res, items: profiles };
      },
      async getOverview(query) {
        const res = await base.gateway.getOverview(query);
        if (query.profileId === 'vprof_anker') {
          return {
            ...res,
            profileId: 'vprof_anker',
            metrics: { ...res.metrics, visibilityPct: 88.8 },
          };
        }
        return res;
      },
    };

    render(<VisibilityOverviewScreen title="AI数据看板" gateway={gateway} />);

    await waitFor(() => {
      expect(within(screen.getByTestId('kpi-visibility')).getByText('65.0%')).toBeTruthy();
    });

    const profileSelect = screen.getByLabelText('看板监测档案') as HTMLSelectElement;
    expect(profileSelect.style.whiteSpace).toBe('nowrap');
    expect(profileSelect.style.textOverflow).toBe('ellipsis');

    // Selecting a profile must immediately refresh without clicking 查询
    fireEvent.change(profileSelect, { target: { value: 'vprof_anker' } });
    await waitFor(() => {
      expect(base.overviewQueries.some((q) => q.profileId === 'vprof_anker')).toBe(true);
      expect(within(screen.getByTestId('kpi-visibility')).getByText('88.8%')).toBeTruthy();
    });
    expect(profileSelect.title).toContain(longName);

    // Switch to Opportunities tab and check 来源问题预览 header cell nowrap
    const oppTabLabel = await screen.findByText(/优化机会 & 搜索拆解词（Query Fan-Out/);
    const oppTab = oppTabLabel.closest('[role="tab"]');
    expect(oppTab).toBeTruthy();
    fireEvent.click(oppTab!);
    const sourceHeaders = await screen.findAllByText('来源问题预览');
    const sourceHeader = sourceHeaders
      .map((el) => el.closest('th'))
      .find((th): th is HTMLTableCellElement => th !== null);
    expect(sourceHeader?.style.whiteSpace).toBe('nowrap');
  });

  it('masks raw CUID, preserves ?profileId=... across async profile load & tab switches, and syncs title/tab/URL/draft on profile switch & reset (#188)', async () => {
    const cuidArzopa = 'cmwlq3uem0019oiprcxr58lpa';
    const cuidAnker = 'cmwlsq61a008joiprwh0bvh7a';
    window.localStorage.setItem('geomix:visibility:default-profile-id', cuidAnker);

    const base = buildMockGateway();
    let resolveProfiles!: (items: VisibilityProfileRecord[]) => void;
    const profilesPromise = new Promise<VisibilityProfileRecord[]>((resolve) => {
      resolveProfiles = resolve;
    });

    const twoProfiles: VisibilityProfileRecord[] = [
      {
        ...buildSampleProfiles()[0]!,
        id: cuidArzopa,
        name: 'ARZOPA便携屏全链路监测档案',
        brandName: '阿卓帕',
      },
      {
        ...buildSampleProfiles()[0]!,
        id: cuidAnker,
        name: '安克创新全品类监测档案',
        brandName: '安克创新',
      },
    ];

    const gateway: VisibilityGateway = {
      ...base.gateway,
      async listProfiles() {
        const res = await base.gateway.listProfiles();
        const items = await profilesPromise;
        return { ...res, items };
      },
    };

    function OverviewShellHarness() {
      const [state, setState] = useState(() => {
        let s = initialSnapshot();
        s = reduceShell(s, {
          type: 'open',
          href: `/visibility/overview?profileId=${cuidArzopa}`,
        });
        return s;
      });
      const activeTab = state.tabs.find((t) => t.id === state.activeId)!;
      return (
        <div>
          <div data-testid="tab-bar">
            {state.tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === state.activeId}
                onClick={() =>
                  setState((curr) => reduceShell(curr, { type: 'activate', id: t.id }))
                }
              >
                {t.title}
              </button>
            ))}
          </div>
          <div data-testid="active-href">{activeTab.href}</div>
          {state.tabs
            .filter((t) => t.id.startsWith('/visibility/overview'))
            .map((t) => (
              <div key={t.id} hidden={t.id !== state.activeId}>
                <VisibilityOverviewScreen
                  title={t.title}
                  tabId={t.id}
                  href={t.href}
                  gateway={gateway}
                  onDispatch={(action) => setState((curr) => reduceShell(curr, action))}
                />
                <textarea aria-label={`${t.title}草稿`} readOnly value={state.drafts[t.id] ?? ''} />
              </div>
            ))}
        </div>
      );
    }

    render(<OverviewShellHarness />);

    // Before profiles resolve: raw CUID must NEVER appear in H1, tab bar, or draft label
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('AI数据看板 · 当前监测档案');
    expect(screen.getByTestId('tab-bar').textContent).not.toContain(cuidArzopa);
    expect(screen.getByLabelText('AI数据看板 · 当前监测档案草稿')).toBeTruthy();
    const selectBeforeLoad = screen.getByLabelText('看板监测档案') as HTMLSelectElement;
    expect(selectBeforeLoad.value).toBe(cuidArzopa);

    // Resolve profiles asynchronously
    resolveProfiles(twoProfiles);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'AI数据看板 · ARZOPA便携屏全链路监测档案',
      );
    });
    expect(
      screen.getByRole('tab', { name: 'AI数据看板 · ARZOPA便携屏全链路监测档案' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('AI数据看板 · ARZOPA便携屏全链路监测档案草稿')).toBeTruthy();
    expect((screen.getByLabelText('看板监测档案') as HTMLSelectElement).value).toBe(cuidArzopa);

    // Switch to 首页 tab and switch back -> select must NOT revert to 全部监测档案
    fireEvent.click(screen.getByRole('tab', { name: '首页' }));
    fireEvent.click(screen.getByRole('tab', { name: 'AI数据看板 · ARZOPA便携屏全链路监测档案' }));
    expect((screen.getByLabelText('看板监测档案') as HTMLSelectElement).value).toBe(cuidArzopa);

    // Switch profile dropdown to 安克创新 -> H1, tab title, draft label, and URL all update
    fireEvent.change(screen.getByLabelText('看板监测档案'), { target: { value: cuidAnker } });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'AI数据看板 · 安克创新全品类监测档案',
      );
    });
    expect(screen.getByRole('tab', { name: 'AI数据看板 · 安克创新全品类监测档案' })).toBeTruthy();
    expect(screen.getByLabelText('AI数据看板 · 安克创新全品类监测档案草稿')).toBeTruthy();
    expect(screen.getByTestId('active-href').textContent).toBe(
      `/visibility/overview?profileId=${cuidAnker}`,
    );

    // Click 重置 -> H1, tab title, draft label, URL, and select all reset cleanly to 全部监测档案 (NOT snapping back to localStorage default)
    fireEvent.click(screen.getByLabelText('重置看板筛选'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('AI数据看板');
    });
    expect(screen.getByRole('tab', { name: 'AI数据看板' })).toBeTruthy();
    expect(screen.getByLabelText('AI数据看板草稿')).toBeTruthy();
    expect(screen.getByTestId('active-href').textContent).toBe('/visibility/overview');
    expect((screen.getByLabelText('看板监测档案') as HTMLSelectElement).value).toBe('');
  });

  it('isolates 看板目标主词 by active profile, avoids preselecting other-brand keywords or async race leakage, and clears checked opportunities on profile switch (#213)', async () => {
    const base = buildMockGateway();
    let resolveProfiles!: (items: VisibilityProfileRecord[]) => void;
    const profilesPromise = new Promise<VisibilityProfileRecord[]>((resolve) => {
      resolveProfiles = resolve;
    });

    const multiProfiles: VisibilityProfileRecord[] = [
      {
        id: 'vprof_arzopa',
        name: 'ARZOPA便携显示器北美监测档案',
        brandName: 'ARZOPA',
        brandAliases: ['Arzopa Portable Monitor', '便携显示器'],
        ownedDomains: ['arzopa.com'],
        competitors: [{ name: 'ASUS ZenScreen', aliases: [], domains: ['asus.com'] }],
        runCount: 1,
        createdAt: '2026-11-16T09:00:00.000Z',
        updatedAt: '2026-11-16T09:00:00.000Z',
      },
      {
        id: 'vprof_anker',
        name: '安克创新（Anker）全品类监测档案',
        brandName: '安克创新',
        brandAliases: ['Anker'],
        ownedDomains: ['anker.com'],
        competitors: [{ name: '绿联 UGREEN', aliases: [], domains: ['ugreen.com'] }],
        runCount: 1,
        createdAt: '2026-11-16T10:00:00.000Z',
        updatedAt: '2026-11-16T10:00:00.000Z',
      },
    ];

    const tenantKeywords: KeywordRecord[] = [
      {
        id: 'kw_anker_gan',
        main: 'Anker氮化镓充电器',
        brands: ['Anker'],
        optStatus: 'INCLUDED',
        questionCount: 3,
        createdAt: '2026-11-15T08:00:00.000Z',
      },
      {
        id: 'kw_clouddesk_crm',
        main: '企业客户关系管理CRM',
        brands: ['CloudDesk'],
        optStatus: 'NONE',
        questionCount: 1,
        createdAt: '2026-11-15T09:00:00.000Z',
      },
    ];

    const dispatched: Array<{ type: string; href?: string }> = [];
    const gateway: VisibilityGateway = {
      ...base.gateway,
      async listProfiles() {
        const items = await profilesPromise;
        return { items, prefillSources: { keywords: [], knowledgeBases: [] } };
      },
      async listKeywords() {
        return tenantKeywords;
      },
    };

    render(
      <VisibilityOverviewScreen
        title="AI数据看板"
        href="/visibility/overview?profileId=vprof_arzopa"
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action as { type: string; href?: string })}
      />,
    );

    const oppTab = await screen.findByRole('tab', { name: /优化机会 & 搜索拆解词（Query Fan-Out/ });
    fireEvent.click(oppTab);

    // 1. Even when listKeywords resolves BEFORE listProfiles, ARZOPA view must NEVER flash or select Anker's keyword
    const kwSelect = screen.getByLabelText('目标主词') as HTMLSelectElement;
    expect(kwSelect.value).toBe('');
    expect(Array.from(kwSelect.options).map((o) => o.value)).not.toContain('kw_anker_gan');

    // Resolve profiles -> ARZOPA has 0 matching keywords, so 目标主词 stays '' and disabled with empty hint
    resolveProfiles(multiProfiles);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
        'ARZOPA便携显示器北美监测档案',
      );
    });
    expect(kwSelect.value).toBe('');
    expect(kwSelect.disabled).toBe(true);
    expect(Array.from(kwSelect.options).map((o) => o.value)).toEqual(['']);
    expect(Array.from(kwSelect.options)[0]?.textContent).toContain('当前档案暂无关联主词');
    expect(
      (screen.getByRole('button', { name: '一键加入写作标题' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Clicking 去创建写作任务 on ARZOPA must NOT leak ?keywordId=kw_anker_gan
    fireEvent.click(screen.getByRole('button', { name: '去创建写作任务' }));
    expect(dispatched).toContainEqual({ type: 'open', href: '/writing/tasks' });

    // 2. Switch 看板监测档案 to Anker -> 目标主词 enables and auto-selects Anker氮化镓充电器 (excluding CloudDesk)
    fireEvent.change(screen.getByLabelText('看板监测档案'), { target: { value: 'vprof_anker' } });
    await waitFor(() => {
      expect(kwSelect.disabled).toBe(false);
      expect(kwSelect.value).toBe('kw_anker_gan');
    });
    expect(Array.from(kwSelect.options).map((o) => o.value)).not.toContain('kw_clouddesk_crm');

    // Check an opportunity item under Anker, then switch back to ARZOPA -> checked titles & keywordId both reset!
    fireEvent.click(await screen.findByLabelText('勾选拆解词-Type-C一线通便携屏实测'));
    expect(screen.getByText('已选 1 条')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('看板监测档案'), { target: { value: 'vprof_arzopa' } });
    await waitFor(() => {
      expect(kwSelect.value).toBe('');
      expect(kwSelect.disabled).toBe(true);
    });
    expect(screen.getByText('已选 0 条')).toBeTruthy();

    // 3. Reset to 全部监测档案 in multi-brand tenant -> lists tenant keywords without forcing Anker preselection
    fireEvent.click(screen.getByLabelText('重置看板筛选'));
    await waitFor(() => {
      expect(kwSelect.disabled).toBe(false);
    });
    expect(kwSelect.value).toBe('');
    expect(Array.from(kwSelect.options).map((o) => o.value)).toEqual([
      '',
      'kw_anker_gan',
      'kw_clouddesk_crm',
    ]);
  });
});
