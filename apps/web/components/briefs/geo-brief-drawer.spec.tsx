// @vitest-environment jsdom
import type { BrandFactRecord, GeoBriefRecord } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoBriefDrawer } from './geo-brief-drawer';

const mockConfirm = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: vi.fn(),
    notifyWarning: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

const SAMPLE_BRIEF: GeoBriefRecord = {
  id: 'cm8briefcuid1234567890',
  brandId: 'cm8brandcuid1234567890',
  brandMarketId: 'cm8market1234567890',
  market: 'CN',
  sourceType: 'AUTO_GAP',
  sourceRunId: 'cm8runcuid1234567890',
  sourceObservationIds: ['cm8obscuid1234567890'],
  sourceCitationUrl: 'https://review.example/nas-2026',
  targetPrompt: '2026 安静四盘位家用 NAS 推荐',
  priorityScore: 95,
  diagnosisSummary: '豆包与 DeepSeek 未提及本品牌，竞品甲占据首要推荐位。',
  recommendedRecipe: 'AUTHORITY_GUIDE',
  targetFormat: 'CN_DEEP_REVIEW',
  suggestedTitle: '2026 安静四盘位家用 NAS 权威选购指南',
  outlineH2: [
    { heading: '一、核心选购结论', intent: '首段直答', fanOutRef: '安静NAS噪音' },
    { heading: '二、四盘位参数对比', intent: '横向表格对比' },
    { heading: '三、高频疑问 FAQ', intent: '独立切片问答' },
  ],
  targetFanOuts: ['安静NAS噪音', '待机功耗实测'],
  competitorFocus: ['竞品甲', '竞品乙'],
  matchedFactIds: ['cm8factcuid1111111111'],
  missingFactHints: ['建议补充 2026 款满载噪音 dB 实测值'],
  recommendedChannels: [
    { channel: '字节头条/抖音图文', reason: '豆包高频引用阵地' },
    { channel: '知乎', reason: '高权重问答社区' },
  ],
  status: 'OPEN',
  createdAt: '2026-11-20T01:00:00.000Z',
  updatedAt: '2026-11-20T01:00:00.000Z',
};

const SAMPLE_FACTS: BrandFactRecord[] = [
  {
    id: 'cm8factcuid1111111111',
    brandId: 'cm8brandcuid1234567890',
    slot: 'PRODUCT_SPECS',
    title: '核心硬件与静音参数',
    content: '四盘位铝合金机身，满载噪音 21dB，待机功耗 9W。',
    sourceType: 'MANUAL',
    sourceUrl: null,
    indexStatus: 'NONE',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  },
];

describe('GeoBriefDrawer', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all 5 PRD §4.3 sections inside geo-brief-drawer, exposes title text, resolves BrandFact titles without leaking raw CUIDs', () => {
    render(
      <GeoBriefDrawer
        open
        brief={SAMPLE_BRIEF}
        brandFacts={SAMPLE_FACTS}
        readOnly={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
        onWrite={vi.fn()}
      />,
    );

    const drawer = screen.getByTestId('geo-brief-drawer');
    expect(within(drawer).getByTestId('brief-section-diagnosis')).toBeTruthy();
    expect(within(drawer).getByTestId('brief-section-recipe')).toBeTruthy();
    expect(within(drawer).getByTestId('brief-section-outline')).toBeTruthy();
    expect(within(drawer).getByTestId('brief-section-facts')).toBeTruthy();
    expect(within(drawer).getByTestId('brief-section-channels')).toBeTruthy();

    // Visible title text node inside drawer (for Playwright expect(drawer).toContainText)
    expect(drawer.textContent).toContain('2026 安静四盘位家用 NAS 权威选购指南');
    // Resolved BrandFact title shown, ZERO raw CUIDs leaked
    expect(drawer.textContent).toContain('核心硬件与静音参数');
    expect(drawer.textContent).not.toContain('cm8factcuid1111111111');
    expect(drawer.textContent).not.toContain('cm8briefcuid1234567890');
    expect(drawer.textContent).toContain('建议补充 2026 款满载噪音 dB 实测值');
    expect(drawer.textContent).toContain('字节头条/抖音图文');

    // Safe https citation link
    const link = within(drawer).getByRole('link', { name: /review\.example/i });
    expect(link.getAttribute('href')).toBe('https://review.example/nas-2026');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('blocks unsafe javascript:/data: sourceCitationUrl from rendering an anchor link', () => {
    render(
      <GeoBriefDrawer
        open
        brief={{ ...SAMPLE_BRIEF, sourceCitationUrl: 'javascript:alert(1)' }}
        brandFacts={SAMPLE_FACTS}
        readOnly={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
        onWrite={vi.fn()}
      />,
    );

    const drawer = screen.getByTestId('geo-brief-drawer');
    expect(within(drawer).queryByRole('link')).toBeNull();
    expect(drawer.textContent).toContain('javascript:alert(1)');
  });

  it('auto-saves dirty edits (title, recipe, outline H2) before calling onWrite on brief-drawer-write-btn click', async () => {
    const editedTitle = '2026 家用四盘位 NAS 静音实测横评（已微调）';
    const onSave = vi.fn().mockImplementation(async (_id, patch) => ({
      ...SAMPLE_BRIEF,
      ...patch,
      updatedAt: '2026-11-20T02:00:00.000Z',
    }));
    const onWrite = vi.fn();

    render(
      <GeoBriefDrawer
        open
        brief={SAMPLE_BRIEF}
        brandFacts={SAMPLE_FACTS}
        readOnly={false}
        onClose={vi.fn()}
        onSave={onSave}
        onDismiss={vi.fn()}
        onWrite={onWrite}
      />,
    );

    const drawer = screen.getByTestId('geo-brief-drawer');
    fireEvent.change(within(drawer).getByTestId('brief-drawer-title'), {
      target: { value: editedTitle },
    });
    expect(drawer.textContent).toContain(editedTitle);

    fireEvent.click(within(drawer).getByTestId('brief-recipe-COMPARISON_MATRIX'));
    fireEvent.change(within(drawer).getByTestId('brief-outline-heading-0'), {
      target: { value: '一、满载噪音与功耗实测结论' },
    });

    fireEvent.click(within(drawer).getByTestId('brief-drawer-write-btn'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenCalledWith(
      SAMPLE_BRIEF.id,
      expect.objectContaining({
        suggestedTitle: editedTitle,
        recommendedRecipe: 'COMPARISON_MATRIX',
        outlineH2: expect.arrayContaining([
          expect.objectContaining({ heading: '一、满载噪音与功耗实测结论' }),
        ]),
      }),
    );
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ suggestedTitle: editedTitle }));
  });

  it('uses useUxFeedback().confirm on dismiss and disables mutating actions when readOnly', async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <GeoBriefDrawer
        open
        brief={SAMPLE_BRIEF}
        brandFacts={SAMPLE_FACTS}
        readOnly={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDismiss={onDismiss}
        onWrite={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('brief-drawer-dismiss-btn'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmCfg = mockConfirm.mock.calls[0]?.[0] as { onOk: () => Promise<void> };
    await confirmCfg.onOk();
    expect(onDismiss).toHaveBeenCalledWith(SAMPLE_BRIEF);

    rerender(
      <GeoBriefDrawer
        open
        brief={SAMPLE_BRIEF}
        brandFacts={SAMPLE_FACTS}
        readOnly
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDismiss={onDismiss}
        onWrite={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('brief-drawer-dismiss-btn')).toBeNull();
    expect((screen.getByTestId('brief-drawer-write-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});
