// @vitest-environment jsdom
import {
  createNearMissBoostBriefSchema,
  type NearMissItemDto,
  type NearMissListResponse,
} from '@geomix/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VisibilityNearMissPanel,
  buildNearMissBoostInput,
  type VisibilityNearMissPanelProps,
} from './visibility-near-miss-panel';

const ITEMS: NearMissItemDto[] = [
  {
    id: 'nm_1',
    tier: 'OPENED_NOT_CITED',
    opportunityScore: 95,
    url: 'https://astravault.example.com/nas-noise-benchmark',
    domain: 'astravault.example.com',
    title: 'AstraVault X4 静音实测参数页',
    snippet: '18dB 低噪四盘位实测对比',
    sourceKind: 'OWNED',
    isOwned: true,
    engines: ['deepseek', 'chatgpt'],
    prompts: ['家用静音四盘位NAS推荐'],
    observationIds: ['obs_1', 'obs_2'],
    openedCount: 3,
    retrievedCount: 5,
    lastSeenAt: '2026-11-23T08:00:00.000Z',
  },
  {
    id: 'nm_2',
    tier: 'RETRIEVED_NOT_CITED',
    opportunityScore: 81,
    url: 'https://zhihu.example.com/question/12345',
    domain: 'zhihu.example.com',
    title: '2026 家用 NAS 选型知乎热帖',
    snippet: '进入检索候选但未被引用',
    sourceKind: 'SOCIAL',
    isOwned: false,
    engines: ['deepseek'],
    prompts: ['家用 NAS 选型对比'],
    observationIds: ['obs_3'],
    openedCount: 0,
    retrievedCount: 4,
    lastSeenAt: '2026-11-23T07:00:00.000Z',
  },
  {
    id: 'nm_3',
    tier: 'CRAWLED_NOT_CITED',
    opportunityScore: 72,
    url: 'javascript:alert(1)',
    domain: 'astravault.example.com',
    title: '可抓取未进引文文档',
    snippet: null,
    sourceKind: 'OWNED',
    isOwned: true,
    engines: ['perplexity'],
    prompts: [],
    observationIds: [],
    openedCount: 0,
    retrievedCount: 0,
    publishRecordId: 'pub_1',
    lastSeenAt: '2026-11-22T06:00:00.000Z',
  },
  {
    id: 'nm_4',
    tier: 'MENTIONED_NOT_OWNED',
    opportunityScore: 68,
    url: 'https://review.example.org/top-nas',
    domain: 'review.example.org',
    title: '第三方评测提及品牌但未引官网',
    snippet: '品牌被提及但引文指向媒体站',
    sourceKind: 'AUTHORITY',
    isOwned: false,
    engines: ['doubao'],
    prompts: ['静音NAS品牌排行'],
    observationIds: ['obs_4'],
    openedCount: 0,
    retrievedCount: 0,
    lastSeenAt: '2026-11-21T05:00:00.000Z',
  },
];

function makeResponse(overrides?: Partial<NearMissListResponse>): NearMissListResponse {
  return {
    brandId: 'brand_1',
    market: 'CN',
    days: 30,
    total: ITEMS.length,
    tierCounts: {
      OPENED_NOT_CITED: 1,
      RETRIEVED_NOT_CITED: 1,
      CRAWLED_NOT_CITED: 1,
      MENTIONED_NOT_OWNED: 1,
    },
    hasRawRetrievalSignals: true,
    items: ITEMS,
    ...overrides,
  };
}

function renderPanel(overrides?: Partial<VisibilityNearMissPanelProps>) {
  const props: VisibilityNearMissPanelProps = {
    data: makeResponse(),
    loading: false,
    error: null,
    tierFilter: undefined,
    onTierFilterChange: vi.fn(),
    ownershipFilter: 'ALL',
    onOwnershipFilterChange: vi.fn(),
    onRetry: vi.fn(),
    readOnly: false,
    boostingItemId: null,
    onBoostItem: vi.fn(),
    ...overrides,
  };
  return { ...render(<VisibilityNearMissPanel {...props} />), props };
}

describe('VisibilityNearMissPanel (#372)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('buildNearMissBoostInput derives safe targetPrompt fallback (>=2 chars) and strips unsafe URLs', () => {
    // Normal item with prompt and safe https URL
    expect(buildNearMissBoostInput(ITEMS[0]!, 'CN')).toEqual({
      market: 'CN',
      tier: 'OPENED_NOT_CITED',
      targetPrompt: '家用静音四盘位NAS推荐',
      sourceUrl: 'https://astravault.example.com/nas-noise-benchmark',
      sourceTitle: 'AstraVault X4 静音实测参数页',
      observationIds: ['obs_1', 'obs_2'],
    });

    // Tier 3A with empty prompts and unsafe javascript: URL -> strips sourceUrl and uses title fallback
    const builtUnsafe = buildNearMissBoostInput(ITEMS[2]!, 'GLOBAL');
    expect(builtUnsafe).toEqual({
      market: 'GLOBAL',
      tier: 'CRAWLED_NOT_CITED',
      targetPrompt: '可抓取未进引文文档',
      sourceTitle: '可抓取未进引文文档',
    });
    expect(builtUnsafe.sourceUrl).toBeUndefined();
    expect(builtUnsafe.observationIds).toBeUndefined();

    // Missing prompt & 1-char title -> falls back to domain, or default constant when domain also missing
    const domainFallback = buildNearMissBoostInput(
      { ...ITEMS[2]!, prompts: ['x'], title: 'A', domain: 'docs.example.com', url: null },
      'CN',
    );
    expect(domainFallback.targetPrompt).toBe('docs.example.com 补强优化');

    const defaultFallback = buildNearMissBoostInput(
      { ...ITEMS[2]!, prompts: [], title: null, domain: null, url: null },
      'CN',
    );
    expect(defaultFallback.targetPrompt).toBe('高潜页面引用补强');
  });

  it('renders all 4 tiers, safe links only, and invokes boost/filter callbacks', () => {
    const { props } = renderPanel();
    const panel = screen.getByTestId('visibility-near-miss-panel');

    // All 4 tier pills rendered with counts
    expect(screen.getByTestId('near-miss-tier-ALL').textContent).toContain('4');
    expect(screen.getByTestId('near-miss-tier-OPENED_NOT_CITED').textContent).toContain(
      'AI 点开未引用（Tier 1）',
    );
    expect(screen.getByTestId('near-miss-tier-RETRIEVED_NOT_CITED').textContent).toContain(
      'AI 召回未引用（Tier 2）',
    );
    expect(screen.getByTestId('near-miss-tier-CRAWLED_NOT_CITED').textContent).toContain(
      '可抓取未进引文（Tier 3A）',
    );
    expect(screen.getByTestId('near-miss-tier-MENTIONED_NOT_OWNED').textContent).toContain(
      '提及未引官网（Tier 3B）',
    );

    // Safe https URL rendered as anchor; unsafe javascript: URL must NOT render as anchor href
    const links = Array.from(panel.querySelectorAll('a'));
    expect(links.some((a) => a.getAttribute('href') === ITEMS[0]!.url)).toBe(true);
    expect(links.some((a) => (a.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(false);

    // Day-1 fallback hint hidden when hasRawRetrievalSignals === true
    expect(screen.queryByTestId('near-miss-fallback-hint')).toBeNull();

    // Tier filter click
    fireEvent.click(screen.getByTestId('near-miss-tier-OPENED_NOT_CITED'));
    expect(props.onTierFilterChange).toHaveBeenCalledWith('OPENED_NOT_CITED');

    // Ownership filter click
    fireEvent.click(screen.getByTestId('near-miss-ownership-THIRD_PARTY'));
    expect(props.onOwnershipFilterChange).toHaveBeenCalledWith('THIRD_PARTY');

    // One-click boost button
    fireEvent.click(screen.getByTestId('near-miss-boost-btn-nm_1'));
    expect(props.onBoostItem).toHaveBeenCalledWith(ITEMS[0]);
  });

  it('filters THIRD_PARTY strictly client-side via !item.isOwned and recomputes all 4 tierCounts', () => {
    renderPanel({ ownershipFilter: 'THIRD_PARTY' });

    // Only nm_2 (RETRIEVED_NOT_CITED) and nm_4 (MENTIONED_NOT_OWNED) are non-owned
    expect(screen.getByTestId('near-miss-tier-ALL').textContent).toContain('2');
    expect(screen.getByTestId('near-miss-tier-OPENED_NOT_CITED').textContent).toContain('0');
    expect(screen.getByTestId('near-miss-tier-RETRIEVED_NOT_CITED').textContent).toContain('1');
    expect(screen.getByTestId('near-miss-tier-CRAWLED_NOT_CITED').textContent).toContain('0');
    expect(screen.getByTestId('near-miss-tier-MENTIONED_NOT_OWNED').textContent).toContain('1');

    expect(screen.queryByTestId('near-miss-boost-btn-nm_1')).toBeNull();
    expect(screen.getByTestId('near-miss-boost-btn-nm_2')).toBeTruthy();
    expect(screen.queryByTestId('near-miss-boost-btn-nm_3')).toBeNull();
    expect(screen.getByTestId('near-miss-boost-btn-nm_4')).toBeTruthy();
  });

  it('renders Day-1 fallback hint when hasRawRetrievalSignals=false and disables boost when readOnly=true', () => {
    renderPanel({
      data: makeResponse({
        hasRawRetrievalSignals: false,
        tierCounts: {
          OPENED_NOT_CITED: 0,
          RETRIEVED_NOT_CITED: 0,
          CRAWLED_NOT_CITED: 1,
          MENTIONED_NOT_OWNED: 1,
        },
        items: [ITEMS[2]!, ITEMS[3]!],
      }),
      readOnly: true,
    });

    const hint = screen.getByTestId('near-miss-fallback-hint');
    expect(hint.textContent).toContain('Tier 1 / Tier 2');
    expect(hint.textContent).toContain('Tier 3A');

    const boostBtn = screen.getByTestId('near-miss-boost-btn-nm_4') as HTMLButtonElement;
    expect(boostBtn.disabled).toBe(true);
  });

  it('renders error state with retry and empty state with filter reset', () => {
    const onRetry = vi.fn();
    const { rerender } = renderPanel({ error: 'Near-Miss 接口暂时不可用', onRetry });
    const panel = screen.getByTestId('visibility-near-miss-panel');
    expect(panel.textContent).toContain('Near-Miss 接口暂时不可用');
    fireEvent.click(within(panel).getByRole('button', { name: /重\s*试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    const onTierFilterChange = vi.fn();
    const onOwnershipFilterChange = vi.fn();
    rerender(
      <VisibilityNearMissPanel
        data={makeResponse({ items: [], total: 0 })}
        loading={false}
        error={null}
        tierFilter="OPENED_NOT_CITED"
        onTierFilterChange={onTierFilterChange}
        ownershipFilter="OWNED"
        onOwnershipFilterChange={onOwnershipFilterChange}
        onRetry={vi.fn()}
        readOnly={false}
        boostingItemId={null}
        onBoostItem={vi.fn()}
      />,
    );

    expect(panel.textContent).toContain('暂无差一步被引用机会');
    fireEvent.click(within(panel).getByRole('button', { name: '重置 Near-Miss 筛选' }));
    expect(onTierFilterChange).toHaveBeenCalledWith(undefined);
    expect(onOwnershipFilterChange).toHaveBeenCalledWith('ALL');
  });

  it('guarantees buildNearMissBoostInput passes createNearMissBoostBriefSchema and blocks credential/whitespace URLs in DOM', () => {
    const adversarialItems: NearMissItemDto[] = [
      {
        ...ITEMS[0]!,
        id: 'nm_cred_url',
        url: 'https://user:pass@example.com/secret',
        prompts: ['家用静音 NAS 评测'],
      },
      {
        ...ITEMS[0]!,
        id: 'nm_space_url',
        url: 'https://example.com/path with space',
        prompts: ['a' + ' '.repeat(350) + 'b'],
      },
      {
        ...ITEMS[0]!,
        id: 'nm_long_ws_prompt',
        url: `https://example.com/${'a'.repeat(2100)}`,
        prompts: ['a' + ' '.repeat(350)],
        title: 'x'.repeat(198) + '   trailing',
        domain: '   ',
      },
      {
        ...ITEMS[0]!,
        id: 'nm_all_empty',
        url: 'https://user@example.com/only-user',
        prompts: ['  ', '\t\n'],
        title: '   ',
        domain: null,
        observationIds: Array.from({ length: 60 }, (_, idx) => `obs_${idx}`),
      },
    ];

    for (const item of adversarialItems) {
      const payload = buildNearMissBoostInput(item, 'CN');
      const parsed = createNearMissBoostBriefSchema.safeParse(payload);
      expect(parsed.success, `Failed schema for ${item.id}: ${JSON.stringify(parsed)}`).toBe(true);
      expect(payload.sourceUrl).toBeUndefined();
    }

    // Verify specific prompt normalization outcomes
    const spaceUrlPayload = buildNearMissBoostInput(adversarialItems[1]!, 'GLOBAL');
    expect(spaceUrlPayload.targetPrompt).toBe('a b');

    const longWsPayload = buildNearMissBoostInput(adversarialItems[2]!, 'CN');
    expect(longWsPayload.targetPrompt).toBe('x'.repeat(198) + ' trailing');
    expect(longWsPayload.sourceTitle).toBe('x'.repeat(198));

    const emptyPayload = buildNearMissBoostInput(adversarialItems[3]!, 'CN');
    expect(emptyPayload.targetPrompt).toBe('高潜页面引用补强');
    expect(emptyPayload.sourceTitle).toBeUndefined();
    expect(emptyPayload.observationIds).toHaveLength(50);

    // Verify credential URL and whitespace URL are NOT rendered as <a href> in table DOM
    renderPanel({
      data: makeResponse({
        total: 2,
        items: [adversarialItems[0]!, adversarialItems[1]!],
      }),
    });
    const panel = screen.getByTestId('visibility-near-miss-panel');
    const anchors = Array.from(panel.querySelectorAll('a'));
    expect(anchors).toHaveLength(0);
    expect(panel.textContent).toContain('user:pass@example.com');
  });
});
