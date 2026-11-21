// @vitest-environment jsdom

import type {
  VisibilityObservationRecord,
  VisibilityProfileRecord,
  VisibilityRunDetailRecord,
} from '@geomix/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunWorkspace } from './run-workspace';

afterEach(() => {
  cleanup();
});

function makeProfile(overrides: Partial<VisibilityProfileRecord> = {}): VisibilityProfileRecord {
  return {
    id: 'prof_1',
    name: '便携屏核心档案',
    brandName: 'ARZOPA',
    brandAliases: ['阿卓帕'],
    ownedDomains: ['arzopa.com'],
    competitors: [
      { name: '联想ThinkVision', aliases: ['ThinkVision'], domains: ['lenovo.com'] },
      { name: '小米', aliases: ['Xiaomi'], domains: ['mi.com'] },
    ],
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeObservation(
  overrides: Partial<VisibilityObservationRecord> & { id: string },
): VisibilityObservationRecord {
  return {
    runId: 'run_1',
    profileId: 'prof_1',
    questionId: null,
    promptText: 'Switch外接ARZOPA便携屏怎么样',
    engine: 'deepseek',
    status: 'SUCCESS',
    collectorKind: 'llm_api',
    answerText: 'Switch 外接 ARZOPA 便携屏可通过 Type-C 一线直连，画面稳定清晰。',
    brandMentioned: true,
    brandPosition: 1,
    brandSentiment: 'positive',
    brandPassage: 'Switch 外接 ARZOPA 便携屏可通过 Type-C 一线直连',
    competitorHits: [
      { name: '联想ThinkVision', mentioned: false, position: null, sentiment: null },
      { name: '小米', mentioned: false, position: null, sentiment: null },
    ],
    fanOutQueries: ['Switch 外接便携屏 Type-C 一线直连兼容性实测与供电功率要求详细对比说明'],
    judgeModel: 'deepseek-chat',
    tokensIn: 320,
    tokensOut: 410,
    error: null,
    checkedAt: '2026-11-18T06:00:00.000Z',
    createdAt: '2026-11-18T06:00:00.000Z',
    citations: [],
    ...overrides,
  };
}

function makeRunDetail(observations: VisibilityObservationRecord[]): VisibilityRunDetailRecord {
  return {
    id: 'run_1',
    profileId: 'prof_1',
    profileName: '便携屏核心档案',
    brandName: 'ARZOPA',
    keywordId: null,
    keywordMain: null,
    name: '便携屏实测任务',
    engines: ['deepseek'],
    questionIds: [],
    totalChecks: observations.length,
    doneCount: observations.length,
    failCount: 0,
    skipCount: 0,
    unitPrice: 2,
    frozenPoints: observations.length * 2,
    settledPoints: observations.length * 2,
    releasedPoints: 0,
    reservationId: null,
    status: 'COMPLETED',
    lastError: null,
    visibilityPct: 100,
    createdAt: '2026-11-18T06:00:00.000Z',
    updatedAt: '2026-11-18T06:01:00.000Z',
    finishedAt: '2026-11-18T06:01:00.000Z',
    metrics: {
      completedChecks: observations.length,
      mentionedChecks: observations.filter((o) => o.brandMentioned).length,
      visibilityPct: 100,
      shareOfVoice: {
        totalMentions: 1,
        brandMentions: 1,
        brandSharePct: 100,
        entries: [{ name: 'ARZOPA', isBrand: true, mentions: 1, sharePct: 100 }],
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
      totalCitations: 0,
      ownedCitations: 0,
      ownedCitationChecks: 0,
      ownedCitationRatePct: 0,
      ownedCitationCheckRatePct: 0,
      topDomains: [],
    },
    observations,
  };
}

function renderWorkspace(
  observations: VisibilityObservationRecord[],
  filteredObservations: VisibilityObservationRecord[] = observations,
) {
  return render(
    <RunWorkspace
      run={makeRunDetail(observations)}
      profile={makeProfile()}
      obsEngineFilter="all"
      onObsEngineFilterChange={vi.fn()}
      obsMentionFilter="all"
      onObsMentionFilterChange={vi.fn()}
      obsSentimentFilter="all"
      onObsSentimentFilterChange={vi.fn()}
      filteredObservations={filteredObservations}
      onResetFilters={vi.fn()}
    />,
  );
}

describe('RunWorkspace observation detail & fidelity (#191, #217)', () => {
  it('hides raw token counts, filters out unmentioned competitors, and masks debug judge/collector names (#191)', () => {
    const obs = makeObservation({
      id: 'obs_1',
      collectorKind: 'llm_api',
      judgeModel: 'deepseek-flash:deterministic-fallback',
      tokensIn: 320,
      tokensOut: 410,
      competitorHits: [
        { name: '联想ThinkVision', mentioned: false, position: null, sentiment: null },
        { name: '小米', mentioned: false, position: null, sentiment: null },
      ],
    });

    const { container } = renderWorkspace([obs]);
    const card = screen.getByTestId('observation-card-obs_1');

    // No raw Token 320/410 exposed to merchant UI
    expect(card.textContent).not.toContain('Token 320/410');
    expect(card.textContent).not.toContain('deterministic-fallback');

    // Readable labels shown
    expect(within(card).getByText('大模型直连采集')).toBeTruthy();
    expect(within(card).getByText('规则语义判别')).toBeTruthy();

    // No simulated banner when collectorKind is llm_api
    expect(screen.queryByText('演示模式')).toBeNull();

    // Unmentioned competitors are not rendered as pills; explicit empty text is shown
    expect(within(card).queryByText('联想ThinkVision')).toBeNull();
    expect(within(card).queryByText('小米')).toBeNull();
    expect(within(card).getByText('本次回答未命中已配置竞品')).toBeTruthy();

    // Fan-out chip uses single-line ellipsis container
    expect(container.querySelector('.gm-run-ws-fanout-chip-text')).not.toBeNull();
  });

  it('clarifies domain-attributed competitor hits when AnswerLens body text has 0 competitor hits (#191)', () => {
    const obs = makeObservation({
      id: 'obs_domain',
      answerText: 'Switch 外接 ARZOPA 便携屏体验不错，可参考下方行业参数资料。',
      competitorHits: [
        { name: '联想ThinkVision', mentioned: true, position: 2, sentiment: 'neutral' },
        { name: '小米', mentioned: false, position: null, sentiment: null },
      ],
      citations: [
        {
          id: 'cite_lenovo',
          url: 'https://www.lenovo.com/thinkvision',
          domain: 'lenovo.com',
          title: 'ThinkVision 参数',
          snippet: null,
          sourceKind: 'COMPETITOR',
          position: 1,
          createdAt: '2026-11-18T06:00:00.000Z',
        },
      ],
    });

    renderWorkspace([obs]);
    const card = screen.getByTestId('observation-card-obs_domain');

    expect(within(card).getByText(/联想ThinkVision/)).toBeTruthy();
    expect(within(card).queryByText('小米')).toBeNull();
    expect(within(card).getByText('信源域名归因')).toBeTruthy();
    expect(within(card).getByText(/含信源域名归因，正文中未直接出现词面/)).toBeTruthy();
  });

  it('renders Chinese empty state copy when filteredObservations is empty (#191)', () => {
    renderWorkspace([makeObservation({ id: 'obs_only' })], []);
    expect(screen.getByText('选择左侧任一监测问题查看 AI 原文')).toBeTruthy();
    expect(screen.queryByText(/选择左侧任一 Prompt/)).toBeNull();
  });

  it('shows simulated demo banner for fake collector and flags off-topic answers (#217)', () => {
    const offTopicObs = makeObservation({
      id: 'obs_off',
      collectorKind: 'fake',
      promptText: 'Switch外接ARZOPA便携屏怎么样',
      answerText: [
        '在评估「Switch外接ARZOPA便携屏怎么样」时，核心应考察数据可审计性、合规边界与长期运维成本。',
        '目前 ARZOPA 在中文语义理解、引用溯源归类以及团队协作闭环上具备成熟实践。',
      ].join('\n'),
      brandPassage: '目前 ARZOPA 在中文语义理解、引用溯源归类以及团队协作闭环上具备成熟实践',
    });

    renderWorkspace([offTopicObs]);
    expect(screen.getByText('演示模式')).toBeTruthy();

    const card = screen.getByTestId('observation-card-obs_off');
    expect(within(card).getByText('模拟演示采集')).toBeTruthy();
    expect(within(card).getByText('模拟演示数据')).toBeTruthy();
    expect(within(card).getByText('可能跑题')).toBeTruthy();
    expect(within(card).getByRole('alert').textContent).toContain('主题相关性预警');
    expect(within(card).getByText('该回答疑似跑题，已降权处理且不计为品牌推荐证据')).toBeTruthy();
  });

  it('masks internal Judge LLM model slugs like gemini-4-hydrogen-xhigh with 大模型语义判别 (#191)', () => {
    const obs = makeObservation({
      id: 'obs_llm_judge',
      collectorKind: 'llm_api',
      judgeModel: 'gemini-4-hydrogen-xhigh',
    });

    renderWorkspace([obs]);
    const card = screen.getByTestId('observation-card-obs_llm_judge');

    expect(card.textContent).not.toContain('gemini-4-hydrogen-xhigh');
    expect(within(card).getByText('大模型语义判别')).toBeTruthy();
  });

  it('supports v2 brandMarket prop without legacy profile and renders renderObservationAction slot', () => {
    const obs = makeObservation({ id: 'obs_v2_slot' });
    const onBriefClick = vi.fn();

    render(
      <RunWorkspace
        run={makeRunDetail([obs])}
        brandMarket={{
          id: 'bm_cn_1',
          brandId: 'brand_1',
          market: 'CN',
          locale: 'zh-CN',
          region: 'CN',
          localBrandName: 'ARZOPA',
          aliases: ['阿卓帕'],
          ownedDomains: ['arzopa.com'],
          competitors: [{ name: '联想ThinkVision', aliases: [], domains: ['lenovo.com'] }],
          seedPrompts: ['Switch外接ARZOPA便携屏怎么样'],
          createdAt: '2026-11-18T00:00:00.000Z',
          updatedAt: '2026-11-18T00:00:00.000Z',
        }}
        renderObservationAction={(item) => (
          <button
            type="button"
            data-testid="answer-brief-btn"
            onClick={() => onBriefClick(item.id)}
          >
            针对此条提写作意见
          </button>
        )}
        obsEngineFilter=""
        onObsEngineFilterChange={vi.fn()}
        obsMentionFilter="all"
        onObsMentionFilterChange={vi.fn()}
        obsSentimentFilter=""
        onObsSentimentFilterChange={vi.fn()}
        filteredObservations={[obs]}
        onResetFilters={vi.fn()}
      />,
    );

    const btn = screen.getByTestId('answer-brief-btn');
    expect(btn.textContent).toContain('针对此条提写作意见');
    btn.click();
    expect(onBriefClick).toHaveBeenCalledWith('obs_v2_slot');
  });

  it('blocks empty-host http:// and https:// and non-http URLs from rendering as clickable anchors (M1)', () => {
    const obs = makeObservation({
      id: 'obs_urls',
      citations: [
        {
          id: 'c_bad_1',
          url: 'http://',
          domain: '',
          title: 'Empty HTTP',
          snippet: null,
          sourceKind: 'OTHER',
          position: 1,
          createdAt: '2026-11-18T06:00:00.000Z',
        },
        {
          id: 'c_bad_2',
          url: 'https://',
          domain: '',
          title: 'Empty HTTPS',
          snippet: null,
          sourceKind: 'OTHER',
          position: 2,
          createdAt: '2026-11-18T06:00:00.000Z',
        },
        {
          id: 'c_bad_3',
          url: 'javascript:alert(1)',
          domain: '',
          title: 'JS XSS',
          snippet: null,
          sourceKind: 'OTHER',
          position: 3,
          createdAt: '2026-11-18T06:00:00.000Z',
        },
        {
          id: 'c_good',
          url: 'https://valid.example.com/page',
          domain: 'valid.example.com',
          title: 'Valid Source',
          snippet: null,
          sourceKind: 'AUTHORITY',
          position: 4,
          createdAt: '2026-11-18T06:00:00.000Z',
        },
      ],
    });

    const { container } = renderWorkspace([obs]);
    const anchors = Array.from(container.querySelectorAll('.gm-run-ws-cite-list a'));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['https://valid.example.com/page']);
  });
});
