// @vitest-environment jsdom

import {
  publishRecordCreateSchema,
  type ChannelConnectionDto,
  type DistributionPreflightResult,
  type GeoArticleRecord,
  type GeoBriefRecord,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apiLib from '../../lib/api';
import * as briefsApi from '../../lib/briefs';
import { PreflightBlockedError, type ArticleDistributionTaskItem } from '../../lib/distribution';
import * as studioLib from '../../lib/studio';
import { StudioDistributionDrawer } from './studio-distribution-drawer';

const runArticlePreflightMock = vi.fn();
const listArticleDistributionsMock = vi.fn();
const listChannelConnectionsMock = vi.fn();
const generateDistributionVariantsMock = vi.fn();
const updateDistributionTaskMock = vi.fn();
const publishDistributionTaskMock = vi.fn();
const createPrShareLinkMock = vi.fn();
const revokePrShareLinkMock = vi.fn();

vi.mock('../../lib/distribution', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/distribution')>('../../lib/distribution');
  return {
    ...actual,
    runArticlePreflight: (...args: unknown[]) => runArticlePreflightMock(...args),
    listArticleDistributions: (...args: unknown[]) => listArticleDistributionsMock(...args),
    listChannelConnections: (...args: unknown[]) => listChannelConnectionsMock(...args),
    generateDistributionVariants: (...args: unknown[]) => generateDistributionVariantsMock(...args),
    updateDistributionTask: (...args: unknown[]) => updateDistributionTaskMock(...args),
    publishDistributionTask: (...args: unknown[]) => publishDistributionTaskMock(...args),
    createPrShareLink: (...args: unknown[]) => createPrShareLinkMock(...args),
    revokePrShareLink: (...args: unknown[]) => revokePrShareLinkMock(...args),
  };
});

const confirmMock = vi.fn();
const notifySuccessMock = vi.fn();
const notifyWarningMock = vi.fn();
const notifyErrorMock = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: confirmMock,
    notifySuccess: notifySuccessMock,
    notifyWarning: notifyWarningMock,
    notifyError: notifyErrorMock,
  }),
}));

let capturedPollingCallback: (() => Promise<void> | void) | null = null;
let capturedPollingEnabled = false;

vi.mock('../../lib/use-task-polling', () => ({
  useTaskPolling: (opts: { enabled: boolean; onPoll: () => Promise<void> | void }) => {
    capturedPollingEnabled = opts.enabled;
    capturedPollingCallback = opts.enabled ? opts.onPoll : null;
  },
}));

const GLOBAL_ARTICLE: GeoArticleRecord = {
  id: 'art_gl_dist_1',
  brandId: 'brand_1',
  brandMarketId: 'bm_gl_1',
  market: 'GLOBAL',
  briefId: 'brief_gl_1',
  batchJobId: null,
  recipe: 'AUTHORITY_GUIDE',
  targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
  title: 'Best 4-Bay Quiet NAS 2026 Guide',
  targetPrompt: 'Best quiet 4-bay NAS 2026',
  outlineJson: [],
  contentMarkdown: 'AstraVault DXP4800 runs at 18.5dB under full load.',
  contentHtml: '<p>AstraVault DXP4800 runs at 18.5dB under full load.</p>',
  schemaJsonLd: { '@context': 'https://schema.org', '@graph': [] },
  llmsTxtSnippet: '# AstraVault',
  geoScore: 88,
  geoScoreDetail: {},
  tags: ['NAS'],
  status: 'DRAFT',
  model: 'fake-quality',
  tokensIn: 100,
  tokensOut: 300,
  complianceFlags: [],
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

const BRIEF_WITH_CITATIONS: GeoBriefRecord = {
  id: 'brief_gl_1',
  brandId: 'brand_1',
  brandMarketId: 'bm_gl_1',
  market: 'GLOBAL',
  sourceType: 'AUTO_GAP',
  sourceRunId: null,
  sourceObservationIds: [],
  sourceCitationUrl: null,
  targetPrompt: 'Best quiet 4-bay NAS 2026',
  priorityScore: 95,
  diagnosisSummary: 'Reddit threads cited frequently by Perplexity',
  recommendedRecipe: 'AUTHORITY_GUIDE',
  targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
  suggestedTitle: 'Best 4-Bay Quiet NAS 2026',
  outlineH2: [],
  targetFanOuts: [],
  competitorFocus: ['Synology'],
  matchedFactIds: ['fact_1'],
  missingFactHints: [],
  recommendedChannels: [
    {
      channel: 'Reddit r/DataHoarder',
      reason: 'Perplexity 高频引用该社区实测帖',
      providerHint: 'REDDIT_ASSIST',
      priority: 'HIGH',
      citedExampleUrls: ['https://www.reddit.com/r/DataHoarder/comments/abc123/quiet_nas'],
    },
  ],
  status: 'DONE',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

const SHOPIFY_CONN: ChannelConnectionDto = {
  id: 'conn_shopify_1',
  brandId: 'brand_1',
  brandMarketId: 'bm_gl_1',
  market: 'GLOBAL',
  provider: 'SHOPIFY',
  displayName: 'AstraVault Shopify Blog',
  siteBaseUrl: 'https://astravault.myshopify.com',
  credentialHint: 'shpat_****1234',
  configJson: { blogId: 'gid://shopify/Blog/1', defaultPublishAsDraft: true, inlineJsonLd: true },
  status: 'ACTIVE',
  authType: 'API_KEY',
  lastTestedAt: '2026-11-22T00:00:00.000Z',
  lastError: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
};

function makeTask(
  overrides: Partial<ArticleDistributionTaskItem> = {},
): ArticleDistributionTaskItem {
  return {
    id: 'task_l1_1',
    brandId: 'brand_1',
    brandMarketId: 'bm_gl_1',
    articleId: GLOBAL_ARTICLE.id,
    connectionId: SHOPIFY_CONN.id,
    provider: 'SHOPIFY',
    mode: 'L1_API',
    channelLabel: 'AstraVault Shopify Blog',
    targetUrlHint: null,
    variantTitle: 'Best 4-Bay Quiet NAS 2026 — Lab Benchmarks',
    variantSlug: 'best-4-bay-quiet-nas-2026',
    variantMetaDesc: 'Independent 18.5dB noise benchmarks for 4-bay home NAS systems in 2026.',
    variantMarkdown: '## Benchmark Summary\n\nAstraVault DXP4800 runs at 18.5dB.',
    variantHtml: '<h2>Benchmark Summary</h2><p>AstraVault DXP4800 runs at 18.5dB.</p>',
    variantExtrasJson: { templateKey: 'OWNED_BLOG_SEO_GEO' },
    preflightJson: { ok: true, blockers: [], warnings: [] },
    status: 'DRAFT_VARIANT',
    publishAsDraft: true,
    remotePostId: null,
    remoteAdminUrl: null,
    remotePublishedUrl: null,
    indexNowStatus: null,
    lastError: null,
    shareLinkActive: false,
    shareExpiresAt: null,
    publishedAt: null,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    publishRecords: [],
    ...overrides,
  };
}

function mockPricingUnitPoints(unitPoints: number) {
  return vi.spyOn(apiLib, 'authorizedRequest').mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          items: [{ action: 'geo_variant', unitPoints, label: '渠道变体改写', enabled: true }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPollingCallback = null;
  capturedPollingEnabled = false;
  runArticlePreflightMock.mockResolvedValue({
    ok: true,
    blockers: [],
    warnings: [],
  } satisfies DistributionPreflightResult);
  listArticleDistributionsMock.mockResolvedValue({ items: [] });
  listChannelConnectionsMock.mockResolvedValue({ items: [SHOPIFY_CONN] });
  vi.spyOn(briefsApi, 'getBrief').mockResolvedValue(BRIEF_WITH_CITATIONS);
  mockPricingUnitPoints(2);
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe('StudioDistributionDrawer (M6A #354)', () => {
  it('renders Step 1 preflight blockers (MISSING_FACT_SLOTS & GLOBAL_CJK_LEAK), jumps back to editor, and handles 422 PreflightBlockedError recovery with risk ack', async () => {
    const blockedPreflight: DistributionPreflightResult = {
      ok: false,
      blockers: [
        {
          code: 'MISSING_FACT_SLOTS',
          severity: 'blocker',
          message: '检测到 1 处未补全的待补充事实占位符',
          details: ['[TBD: standby power W]'],
        },
        {
          code: 'GLOBAL_CJK_LEAK',
          severity: 'blocker',
          message: '海外（GLOBAL）稿件中检测到非品牌专有名词的中文字符',
          details: ['静音测试'],
        },
      ],
      warnings: [{ code: 'LOW_GEO_SCORE', severity: 'warning', message: 'GEO 得分偏低' }],
    };
    const l1Task = makeTask();
    runArticlePreflightMock.mockResolvedValueOnce(blockedPreflight);
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [l1Task] });
    publishDistributionTaskMock
      .mockRejectedValueOnce(
        new PreflightBlockedError(40001, '发布前校验未通过：缺失事实与中文泄露', {
          preflight: blockedPreflight,
          blockers: blockedPreflight.blockers,
          warnings: blockedPreflight.warnings,
        }),
      )
      .mockResolvedValueOnce({ ...l1Task, status: 'PUBLISHING', publishAsDraft: true });

    const onReturnToEditor = vi.fn();

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={1000}
        onClose={vi.fn()}
        onReturnToEditor={onReturnToEditor}
      />,
    );

    const blockerBox = await screen.findByTestId('distribution-preflight-blockers');
    expect(blockerBox.textContent).toContain('[TBD: standby power W]');
    expect(blockerBox.textContent).toContain('静音测试');

    // Click 返回编辑器定位补填
    fireEvent.click(screen.getByTestId('distribution-back-to-editor-btn'));
    expect(onReturnToEditor).toHaveBeenCalledWith('MISSING_FACT_SLOTS');

    // Attempt draft push without ack -> 422 PreflightBlockedError caught cleanly
    fireEvent.click(await screen.findByTestId('distribution-publish-draft-btn'));
    await waitFor(() => {
      expect(publishDistributionTaskMock).toHaveBeenCalledWith(
        'task_l1_1',
        expect.objectContaining({ publishAsDraft: true, acknowledgePreflightWarnings: false }),
        expect.anything(),
      );
      expect(screen.getByText('推送被发布前体检门禁拦截')).toBeTruthy();
    });

    // Check risk ack checkbox & retry -> sends acknowledgePreflightWarnings: true
    fireEvent.click(screen.getByTestId('distribution-ack-warnings-checkbox'));
    fireEvent.click(screen.getByTestId('distribution-publish-draft-btn'));
    await waitFor(() => {
      expect(publishDistributionTaskMock).toHaveBeenLastCalledWith(
        'task_l1_1',
        expect.objectContaining({ publishAsDraft: true, acknowledgePreflightWarnings: true }),
        expect.anything(),
      );
    });
  });

  it('hydrates citation recommendations, shows Points Confirmation Modal (paid & 0-point free without literal "0 点"), generates variants, edits/saves, and polls L1 live publish to PUBLISHED', async () => {
    const generatedTask = makeTask({ id: 'task_gen_1', status: 'DRAFT_VARIANT' });
    const savedTask = { ...generatedTask, variantTitle: 'Updated Lab Benchmarks Title' };
    const publishingTask = { ...savedTask, status: 'PUBLISHING' as const, publishAsDraft: false };
    const publishedTask = {
      ...savedTask,
      status: 'PUBLISHED' as const,
      publishAsDraft: false,
      remotePublishedUrl: 'https://astravault.myshopify.com/blogs/news/best-4-bay-quiet-nas-2026',
      indexNowStatus: '200 OK',
      publishedAt: '2026-11-23T06:20:00.000Z',
    };

    generateDistributionVariantsMock.mockResolvedValueOnce({
      articleId: GLOBAL_ARTICLE.id,
      unitPrice: 2,
      totalChargedPoints: 4,
      refundedCount: 0,
      refundedPoints: 0,
      reservationId: 'res_1',
      billingMode: 'SHADOW',
      replayed: false,
      tasks: [generatedTask],
      failures: [],
    });
    listArticleDistributionsMock
      .mockResolvedValueOnce({ items: [] }) // initial hydrate
      .mockResolvedValueOnce({ items: [generatedTask] }) // post-generate reload
      .mockResolvedValueOnce({ items: [publishedTask] }); // polling tick
    updateDistributionTaskMock.mockResolvedValueOnce(savedTask);
    publishDistributionTaskMock.mockResolvedValueOnce(publishingTask);

    const onRefreshWallet = vi.fn();
    const onPublishRecordsSynced = vi.fn();

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
        onRefreshWallet={onRefreshWallet}
        onPublishRecordsSynced={onPublishRecordsSynced}
      />,
    );

    // Citation-driven recommendation hydrated from getBrief(article.briefId)
    await waitFor(() => {
      expect(screen.getByText('Reddit r/DataHoarder')).toBeTruthy();
      expect(screen.getByText(/高频被引原帖 #1/)).toBeTruthy();
    });

    // Select 1 L1 site + 1 L3 community channel
    fireEvent.click(screen.getByTestId('distribution-target-l1:conn_shopify_1'));
    fireEvent.click(screen.getByTestId('distribution-target-REDDIT_ASSIST'));

    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    const confirmModal = await screen.findByTestId('distribution-points-confirm-modal');
    expect(confirmModal.textContent).toContain('2 × 2 = 4 点');
    expect(confirmModal.textContent).toContain('500 点');

    fireEvent.click(screen.getByTestId('distribution-points-confirm-submit-btn'));
    await waitFor(() => {
      expect(generateDistributionVariantsMock).toHaveBeenCalledWith(
        GLOBAL_ARTICLE.id,
        {
          targets: expect.arrayContaining([
            expect.objectContaining({
              provider: 'SHOPIFY',
              connectionId: 'conn_shopify_1',
              channelLabel: 'AstraVault Shopify Blog',
            }),
            expect.objectContaining({
              provider: 'REDDIT_ASSIST',
              targetUrlHint: 'https://www.reddit.com/r/DataHoarder/comments/abc123/quiet_nas',
            }),
          ]),
        },
        expect.anything(),
      );
      expect(onRefreshWallet).toHaveBeenCalled();
    });

    // Edit variant title and save
    const titleInput = await screen.findByLabelText('变体标题');
    fireEvent.change(titleInput, { target: { value: 'Updated Lab Benchmarks Title' } });
    fireEvent.click(screen.getByTestId('distribution-save-variant-btn'));
    await waitFor(() => {
      expect(updateDistributionTaskMock).toHaveBeenCalledWith(
        'task_gen_1',
        expect.objectContaining({ variantTitle: 'Updated Lab Benchmarks Title' }),
        expect.anything(),
      );
    });

    // Trigger live publish -> enters PUBLISHING -> useTaskPolling detects PUBLISHED -> calls onPublishRecordsSynced
    fireEvent.click(screen.getByTestId('distribution-publish-live-btn'));
    await waitFor(() => {
      expect(publishDistributionTaskMock).toHaveBeenCalledWith(
        'task_gen_1',
        expect.objectContaining({ publishAsDraft: false, connectionId: 'conn_shopify_1' }),
        expect.anything(),
      );
      expect(capturedPollingEnabled).toBe(true);
    });

    await act(async () => {
      await capturedPollingCallback?.();
    });

    await waitFor(() => {
      expect(onPublishRecordsSynced).toHaveBeenCalledWith(GLOBAL_ARTICLE.id);
      expect(screen.getByText('查看已上线公开文章 ↗')).toBeTruthy();
      expect(screen.getByText('IndexNow: 200 OK')).toBeTruthy();
    });
  });

  it('displays 0-point promotional copy without literal "0 点" when geo_variant unitPrice === 0', async () => {
    mockPricingUnitPoints(0);
    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={0}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('distribution-target-PR_PACKET')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('distribution-target-PR_PACKET'));
    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));

    const confirmModal = await screen.findByTestId('distribution-points-confirm-modal');
    expect(confirmModal.textContent).toContain('限时免费（0 积分，不扣减点数）');
    expect(document.body.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);
  });

  it('supports L3 Community Assist (copy, anti-ban checklist, quick register), L3 PR share create/copy/revoke via useUxFeedback().confirm, and full context-switch reset', async () => {
    const copySpy = vi.spyOn(studioLib, 'copyTextToClipboard').mockResolvedValue(true);
    const communityTask = makeTask({
      id: 'task_reddit_1',
      provider: 'REDDIT_ASSIST',
      mode: 'L3_COMMUNITY_ASSIST',
      channelLabel: 'Reddit 社区讨论',
      connectionId: null,
      targetUrlHint: 'https://www.reddit.com/r/DataHoarder/comments/xyz/nas',
      variantTitle: 'Quiet 4-bay NAS acoustics data',
      variantMarkdown: 'Tested at 18.5dB in a 22C room — happy to share raw dB logs.',
      variantExtrasJson: {
        templateKey: 'REDDIT_DISCUSSION',
        antiBanChecklist: ['已声明与品牌关系（如适用）', '已移除推广链接与硬广口吻'],
        targetThreadUrls: ['https://www.reddit.com/r/DataHoarder/comments/xyz/nas'],
      },
    });
    const prTask = makeTask({
      id: 'task_pr_1',
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'PR / KOL 外部媒体协作包',
      connectionId: null,
      variantTitle: 'AstraVault DXP4800 Press Fact Sheet',
      variantMarkdown: 'Press release draft body',
      variantExtrasJson: {
        templateKey: 'PR_MEDIA_PACKET',
        factSheet: {
          brandName: 'AstraVault',
          category: 'Home NAS',
          targetPrompt: 'Best quiet 4-bay NAS 2026',
          keyAngles: ['18.5dB Ultra-Quiet Acoustics'],
          verifiedFacts: [{ title: 'Noise Level', summary: '18.5dB full load' }],
          competitorComparisonAngles: [],
        },
      },
    });

    listArticleDistributionsMock.mockResolvedValueOnce({ items: [communityTask, prTask] });
    createPrShareLinkMock.mockResolvedValueOnce({
      taskId: 'task_pr_1',
      shareUrl: 'https://app.geomix.example/share/pr/tok_abc123456',
      token: 'tok_abc123456',
      expiresAt: '2026-12-23T06:00:00.000Z',
      ttlDays: 30,
    });
    revokePrShareLinkMock.mockResolvedValueOnce({
      taskId: 'task_pr_1',
      revoked: true,
      revokedAt: '2026-11-23T06:30:00.000Z',
    });
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      void onOk?.();
    });

    const onCreatePublishRecord = vi.fn().mockResolvedValue(true);
    const onPublishRecordsSynced = vi.fn();

    const { rerender } = render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={1000}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
        onCreatePublishRecord={onCreatePublishRecord}
        onPublishRecordsSynced={onPublishRecordsSynced}
      />,
    );

    // L3 Community Assist tab is active first
    const copyBtn = await screen.findByTestId('distribution-copy-community-btn');
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith(communityTask.variantMarkdown);
    });

    // Anti-ban checklist & quick register published URL
    const checkItem = screen.getByLabelText('已声明与品牌关系（如适用）') as HTMLInputElement;
    fireEvent.click(checkItem);
    expect(checkItem.checked).toBe(true);

    fireEvent.change(screen.getByLabelText('已发布社区链接'), {
      target: { value: 'https://www.reddit.com/r/DataHoarder/comments/xyz/nas/comment1' },
    });
    fireEvent.click(screen.getByTestId('distribution-quick-register-btn'));
    await waitFor(() => {
      expect(onCreatePublishRecord).toHaveBeenCalledWith({
        channel: 'Reddit 社区讨论',
        publishedUrl: 'https://www.reddit.com/r/DataHoarder/comments/xyz/nas/comment1',
        autoRetest: { enabled: true },
      });
      expect(onPublishRecordsSynced).toHaveBeenCalledWith(GLOBAL_ARTICLE.id);
    });

    // Switch to PR Packet tab
    const tabsRoot = screen.getByTestId('distribution-variant-tabs');
    fireEvent.click(within(tabsRoot).getByText('PR / KOL 外部媒体协作包'));

    expect(await screen.findByText('18.5dB Ultra-Quiet Acoustics')).toBeTruthy();

    // Generate 30-day PR share link
    fireEvent.click(screen.getByTestId('distribution-pr-share-btn'));
    const shareUrlEl = await screen.findByTestId('distribution-pr-share-url');
    expect(shareUrlEl.textContent).toBe('https://app.geomix.example/share/pr/tok_abc123456');

    // Copy share URL
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith('https://app.geomix.example/share/pr/tok_abc123456');
    });

    // Revoke link via useUxFeedback().confirm
    fireEvent.click(screen.getByTestId('distribution-pr-revoke-btn'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(revokePrShareLinkMock).toHaveBeenCalledWith('task_pr_1', expect.anything());
      expect(screen.queryByTestId('distribution-pr-share-url')).toBeNull();
    });

    // Context-switch reset: changing brandId/market resets all internal drawer state cleanly
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [] });
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [] });
    rerender(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_2"
        brandMarketId="bm_cn_2"
        market="CN"
        contextEpoch={2}
        article={{ ...GLOBAL_ARTICLE, id: 'art_cn_2', market: 'CN', briefId: null }}
        draftTitle="国内评测稿"
        draftMarkdown="正文"
        readOnly={false}
        walletAvailable={1000}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('18.5dB Ultra-Quiet Acoustics')).toBeNull();
      expect(screen.getByText('尚未生成渠道变体')).toBeTruthy();
    });
  });

  it('skips remote runArticlePreflight on drawer open and rerun when readOnly is true', async () => {
    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={true}
        walletAvailable={0}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await screen.findByTestId('distribution-preflight-card');
    expect(runArticlePreflightMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重新体检' }));
    await waitFor(() => {
      expect(notifySuccessMock).toHaveBeenCalledWith('发布前体检已通过');
    });
    expect(runArticlePreflightMock).not.toHaveBeenCalled();
  });

  it('prevents Brand A post-generate catch leakage, stale PR revoke confirm after switch, and post-unmount createPrShareLink side effects', async () => {
    const leakedTask = makeTask({
      id: 'task_leaked_a',
      provider: 'REDDIT_ASSIST',
      mode: 'L3_COMMUNITY_ASSIST',
      channelLabel: 'LEAKED_BRAND_A_REDDIT',
      connectionId: null,
    });
    const prTaskA = makeTask({
      id: 'task_pr_a',
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'PR Packet A',
      connectionId: null,
      shareLinkActive: true,
      shareExpiresAt: '2026-12-23T06:00:00.000Z',
    });

    let rejectPostGenRefresh!: (reason?: unknown) => void;
    let postGenSignal: AbortSignal | undefined;
    listArticleDistributionsMock
      .mockResolvedValueOnce({ items: [prTaskA] }) // Brand A initial hydrate
      .mockImplementationOnce((_articleId: string, opts?: { signal?: AbortSignal }) => {
        postGenSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          rejectPostGenRefresh = reject;
        });
      })
      .mockResolvedValueOnce({ items: [] }); // Brand B initial hydrate

    generateDistributionVariantsMock.mockResolvedValueOnce({
      articleId: GLOBAL_ARTICLE.id,
      unitPrice: 2,
      totalChargedPoints: 2,
      refundedCount: 0,
      refundedPoints: 0,
      reservationId: 'res_race',
      billingMode: 'SHADOW',
      replayed: false,
      tasks: [leakedTask],
      failures: [],
    });

    let capturedRevokeOnOk: (() => Promise<void> | void) | undefined;
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      capturedRevokeOnOk = onOk;
    });

    const { rerender, unmount } = render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_a"
        brandMarketId="bm_a"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    // PR button displays regenerate label when shareLinkActive is true
    const prShareBtn = await screen.findByTestId('distribution-pr-share-btn');
    expect(prShareBtn.textContent).toContain('重新生成 30 天免登录供稿链接');

    // Open revoke confirm modal on Brand A (do not resolve yet)
    fireEvent.click(screen.getByTestId('distribution-pr-revoke-btn'));
    expect(capturedRevokeOnOk).toBeTypeOf('function');

    // Trigger variant generation; wait until post-generate refresh is in-flight
    fireEvent.click(screen.getByTestId('distribution-target-REDDIT_ASSIST'));
    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    fireEvent.click(await screen.findByTestId('distribution-points-confirm-submit-btn'));
    await waitFor(() => {
      expect(postGenSignal).toBeInstanceOf(AbortSignal);
    });

    // Switch context to Brand B while post-generate refresh is pending
    rerender(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_b"
        brandMarketId="bm_b"
        market="GLOBAL"
        contextEpoch={2}
        article={{ ...GLOBAL_ARTICLE, id: 'art_b', brandId: 'brand_b', briefId: null }}
        draftTitle="Brand B Article"
        draftMarkdown="Brand B body"
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('尚未生成渠道变体')).toBeTruthy();
    });
    expect(postGenSignal?.aborted).toBe(true);

    // Reject aborted post-generate refresh AND invoke stale Brand A revoke confirm onOk
    await act(async () => {
      rejectPostGenRefresh(new DOMException('The operation was aborted.', 'AbortError'));
      await capturedRevokeOnOk?.();
    });

    expect(screen.queryByText('LEAKED_BRAND_A_REDDIT')).toBeNull();
    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(revokePrShareLinkMock).not.toHaveBeenCalled();

    // Verify unmount aborts & suppresses in-flight createPrShareLink
    const prTaskB = makeTask({
      id: 'task_pr_unmount',
      articleId: 'art_b_2',
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'PR Packet B',
      connectionId: null,
    });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [prTaskB] });
    rerender(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_b"
        brandMarketId="bm_b"
        market="GLOBAL"
        contextEpoch={3}
        article={{ ...GLOBAL_ARTICLE, id: 'art_b_2', brandId: 'brand_b', briefId: null }}
        draftTitle="Brand B Article 2"
        draftMarkdown="Brand B body 2"
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    let resolveCreatePr!: (v: {
      taskId: string;
      shareUrl: string;
      token: string;
      expiresAt: string;
      ttlDays: number;
    }) => void;
    let createPrSignal: AbortSignal | undefined;
    createPrShareLinkMock.mockImplementationOnce(
      (_taskId: string, _input: unknown, opts?: { signal?: AbortSignal }) => {
        createPrSignal = opts?.signal;
        return new Promise((resolve) => {
          resolveCreatePr = resolve;
        });
      },
    );

    fireEvent.click(await screen.findByTestId('distribution-pr-share-btn'));
    expect(createPrSignal?.aborted).toBe(false);

    unmount();
    expect(createPrSignal?.aborted).toBe(true);

    await act(async () => {
      resolveCreatePr({
        taskId: 'task_pr_unmount',
        shareUrl: 'https://app.geomix.example/share/pr/tok_unmount',
        token: 'tok_unmount',
        expiresAt: '2026-12-23T06:00:00.000Z',
        ttlDays: 30,
      });
    });
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('enforces Tabs destroyOnHidden (strictly 1 publish button in DOM), isolates 422 alert per task, and preserves unsaved draft edits across tab switches', async () => {
    const taskA = makeTask({
      id: 'task_l1_a',
      channelLabel: 'Shopify Primary Blog',
      variantTitle: 'Original Title A',
    });
    const taskB = makeTask({
      id: 'task_l1_b',
      provider: 'WORDPRESS',
      channelLabel: 'WordPress Tech Blog',
      variantTitle: 'Original Title B',
    });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [taskA, taskB] });
    publishDistributionTaskMock.mockRejectedValueOnce(
      new PreflightBlockedError(40001, 'Task A 存在硬拦截项', {
        preflight: { ok: false, blockers: [], warnings: [] },
      }),
    );

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    const titleInputA = (await screen.findByLabelText('变体标题')) as HTMLInputElement;
    expect(titleInputA.value).toBe('Original Title A');
    fireEvent.change(titleInputA, { target: { value: 'Unsaved Draft A' } });

    // Trigger 422 alert on Task A
    fireEvent.click(screen.getByTestId('distribution-publish-draft-btn'));
    await waitFor(() => {
      expect(screen.getByText('Task A 存在硬拦截项')).toBeTruthy();
    });

    // Switch to Tab B -> strictly 1 set of L1 testids in DOM AND Task A's 422 alert is not shown on Tab B
    const tabsRoot = screen.getByTestId('distribution-variant-tabs');
    fireEvent.click(within(tabsRoot).getByText('WordPress Tech Blog'));

    await waitFor(() => {
      expect((screen.getByLabelText('变体标题') as HTMLInputElement).value).toBe(
        'Original Title B',
      );
    });
    expect(screen.getAllByTestId('distribution-publish-live-btn')).toHaveLength(1);
    expect(screen.getAllByTestId('distribution-publish-draft-btn')).toHaveLength(1);
    expect(screen.getAllByTestId('distribution-save-variant-btn')).toHaveLength(1);
    expect(screen.queryByText('Task A 存在硬拦截项')).toBeNull();

    // Switch back to Tab A -> unsaved draft edit & Task A alert are preserved
    fireEvent.click(within(tabsRoot).getByText('Shopify Primary Blog'));
    await waitFor(() => {
      expect((screen.getByLabelText('变体标题') as HTMLInputElement).value).toBe('Unsaved Draft A');
      expect(screen.getByText('Task A 存在硬拦截项')).toBeTruthy();
    });
  });

  it('ignores stale in-flight poll resolved after Task 2 publish and fires independent notifications for simultaneous PUBLISHED + FAILED completions', async () => {
    const t1Publishing = makeTask({
      id: 'task_poll_1',
      channelLabel: 'Shopify Blog 1',
      status: 'PUBLISHING',
    });
    const t2Draft = makeTask({
      id: 'task_poll_2',
      provider: 'WORDPRESS',
      channelLabel: 'WordPress Blog 2',
      status: 'DRAFT_VARIANT',
    });
    const t2Publishing = { ...t2Draft, status: 'PUBLISHING' as const };
    const t1Published = {
      ...t1Publishing,
      status: 'PUBLISHED' as const,
      remotePublishedUrl: 'https://store.example.com/blogs/news/post-1',
    };
    const t2Failed = {
      ...t2Publishing,
      status: 'FAILED' as const,
      lastError: 'HTTP 401 Invalid WordPress App Password',
    };

    let resolveStalePoll!: (v: { items: ArticleDistributionTaskItem[] }) => void;
    let stalePollSignal: AbortSignal | undefined;
    listArticleDistributionsMock
      .mockResolvedValueOnce({ items: [t1Publishing, t2Draft] }) // initial hydrate
      .mockImplementationOnce((_articleId: string, opts?: { signal?: AbortSignal }) => {
        stalePollSignal = opts?.signal;
        return new Promise((resolve) => {
          resolveStalePoll = resolve;
        });
      }) // Poll #1 (stale)
      .mockResolvedValueOnce({ items: [t1Published, t2Failed] }); // Poll #2 (simultaneous PUBLISHED + FAILED)

    publishDistributionTaskMock.mockResolvedValueOnce(t2Publishing);
    const onPublishRecordsSynced = vi.fn();

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
        onPublishRecordsSynced={onPublishRecordsSynced}
      />,
    );

    await waitFor(() => {
      expect(capturedPollingEnabled).toBe(true);
    });

    // Start Poll #1 while t1 is PUBLISHING and t2 is DRAFT_VARIANT
    const poll1Promise = capturedPollingCallback?.();
    expect(stalePollSignal?.aborted).toBe(false);

    // Switch to Task 2 and publish live while Poll #1 is still in-flight
    const tabsRoot = screen.getByTestId('distribution-variant-tabs');
    fireEvent.click(within(tabsRoot).getByText('WordPress Blog 2'));
    fireEvent.click(await screen.findByTestId('distribution-publish-live-btn'));

    await waitFor(() => {
      expect(publishDistributionTaskMock).toHaveBeenCalledWith(
        'task_poll_2',
        expect.objectContaining({ publishAsDraft: false }),
        expect.anything(),
      );
    });
    expect(stalePollSignal?.aborted).toBe(true);

    // Resolve stale Poll #1 with old snapshot [t1: PUBLISHED, t2: DRAFT_VARIANT]
    // It MUST be ignored so Task 2 stays PUBLISHING and polling remains enabled!
    await act(async () => {
      resolveStalePoll({ items: [t1Published, t2Draft] });
      await poll1Promise;
    });

    expect(capturedPollingEnabled).toBe(true);
    expect(onPublishRecordsSynced).not.toHaveBeenCalled();

    notifySuccessMock.mockClear();
    notifyErrorMock.mockClear();

    // Poll #2 returns simultaneous t1=PUBLISHED and t2=FAILED -> BOTH notifications must fire!
    await act(async () => {
      await capturedPollingCallback?.();
    });

    await waitFor(() => {
      expect(onPublishRecordsSynced).toHaveBeenCalledWith(GLOBAL_ARTICLE.id);
      expect(notifySuccessMock).toHaveBeenCalledWith(
        '已上线发布，已自动同步至发布记录并排期 T+7/14/30 复测',
      );
      expect(notifyErrorMock).toHaveBeenCalledWith('HTTP 401 Invalid WordPress App Password');
      expect(capturedPollingEnabled).toBe(false);
    });
  });

  it('clamps 80-char L3 Community channelLabel to 60 chars to satisfy publishRecordCreateSchema on quick register', async () => {
    const longChannelLabel =
      'Reddit_r_DataHoarder_Enterprise_NAS_Acoustics_Benchmark_Community_Channel_80Char';
    expect(longChannelLabel.length).toBe(80);
    const communityTask = makeTask({
      id: 'task_comm_long',
      provider: 'REDDIT_ASSIST',
      mode: 'L3_COMMUNITY_ASSIST',
      channelLabel: longChannelLabel,
      connectionId: null,
    });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [communityTask] });
    const onCreatePublishRecord = vi.fn().mockResolvedValue(true);

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
        onCreatePublishRecord={onCreatePublishRecord}
      />,
    );

    const urlInput = await screen.findByLabelText('已发布社区链接');
    fireEvent.change(urlInput, {
      target: { value: 'https://www.reddit.com/r/DataHoarder/comments/long80/nas' },
    });
    fireEvent.click(screen.getByTestId('distribution-quick-register-btn'));

    await waitFor(() => {
      expect(onCreatePublishRecord).toHaveBeenCalledTimes(1);
    });
    const sentPayload = onCreatePublishRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof sentPayload.channel).toBe('string');
    expect((sentPayload.channel as string).length).toBe(60);
    expect(publishRecordCreateSchema.safeParse(sentPayload).success).toBe(true);
  });

  it('W-01: enforces synchronous single-flight mutexes on same-tick double-clicks for variant generation, L1 publish, and PR share link creation', async () => {
    const conn: ChannelConnectionDto = {
      ...SHOPIFY_CONN,
      id: 'conn_sh_mutex',
      provider: 'SHOPIFY',
      status: 'ACTIVE',
    };
    const l1Task = makeTask({
      id: 'task_l1_mutex',
      provider: 'SHOPIFY',
      mode: 'L1_API',
      channelLabel: 'Shopify Official Blog',
      connectionId: conn.id,
      status: 'READY_TO_PUBLISH',
    });
    const prTask = makeTask({
      id: 'task_pr_mutex',
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'PR 外部供稿包',
      connectionId: null,
      status: 'DRAFT_VARIANT',
    });

    listChannelConnectionsMock.mockResolvedValue({ items: [conn] });
    listArticleDistributionsMock.mockResolvedValue({ items: [l1Task, prTask] });

    let resolveGenerate!: (val: unknown) => void;
    let firstGenSignal: AbortSignal | undefined;
    generateDistributionVariantsMock.mockImplementation(
      (_articleId: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
        firstGenSignal = opts?.signal;
        return new Promise((resolve) => {
          resolveGenerate = resolve;
        });
      },
    );

    let resolvePublish!: (val: unknown) => void;
    publishDistributionTaskMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePublish = resolve;
        }),
    );

    let resolvePrShare!: (val: unknown) => void;
    createPrShareLinkMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrShare = resolve;
        }),
    );

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    // 1. Same-tick double-click on Points Confirmation submit button -> strictly 1 API call and signal #1 NOT aborted
    const targetCheckbox = await screen.findByTestId('distribution-target-l1:conn_sh_mutex');
    fireEvent.click(targetCheckbox);
    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    const confirmBtn = await screen.findByTestId('distribution-points-confirm-submit-btn');

    act(() => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(generateDistributionVariantsMock).toHaveBeenCalledTimes(1);
    expect(firstGenSignal?.aborted).toBe(false);

    await act(async () => {
      resolveGenerate({
        tasks: [l1Task],
        failures: [],
        unitPrice: 2,
        chargedPoints: 2,
        refundedPoints: 0,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('distribution-points-confirm-modal')).toBeNull();
    });

    // 2. Same-tick click on publish-draft + publish-live -> strictly 1 publishDistributionTask call
    const draftBtn = await screen.findByTestId('distribution-publish-draft-btn');
    const liveBtn = screen.getByTestId('distribution-publish-live-btn');
    act(() => {
      draftBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      liveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(publishDistributionTaskMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePublish({ ...l1Task, status: 'DRAFT_PUSHED' });
    });

    // 3. Same-tick double-click on PR share creation -> strictly 1 createPrShareLink call
    const tabsRoot = screen.getByTestId('distribution-variant-tabs');
    fireEvent.click(within(tabsRoot).getByText('PR 外部供稿包'));
    const prShareBtn = await screen.findByTestId('distribution-pr-share-btn');
    act(() => {
      prShareBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      prShareBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(createPrShareLinkMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePrShare({
        taskId: 'task_pr_mutex',
        shareUrl: 'https://app.geomix.example/share/pr/tok_single_flight',
        token: 'tok_single_flight',
        expiresAt: '2026-12-23T06:00:00.000Z',
        ttlDays: 30,
      });
    });
    expect((await screen.findByTestId('distribution-pr-share-url')).textContent).toBe(
      'https://app.geomix.example/share/pr/tok_single_flight',
    );
  });

  it('W-04: never exposes raw opaque CUID in L1 connection selector when bound connection is DISABLED or deleted', async () => {
    const disabledConn: ChannelConnectionDto = {
      ...SHOPIFY_CONN,
      id: 'cm1234567890opaque',
      provider: 'SHOPIFY',
      displayName: 'Legacy Disabled Shop',
      status: 'DISABLED',
    };
    const activeConn: ChannelConnectionDto = {
      ...SHOPIFY_CONN,
      id: 'conn_active_shopify',
      provider: 'SHOPIFY',
      displayName: 'Active Global Shop',
      status: 'ACTIVE',
    };
    const taskWithDisabledConn = makeTask({
      id: 'task_disabled_conn',
      provider: 'SHOPIFY',
      mode: 'L1_API',
      channelLabel: 'Disabled Bound Tab',
      connectionId: 'cm1234567890opaque',
    });
    const taskWithDeletedConn = makeTask({
      id: 'task_deleted_conn',
      provider: 'SHOPIFY',
      mode: 'L1_API',
      channelLabel: 'Deleted Bound Tab',
      connectionId: 'cm9999999999deleted',
    });

    listChannelConnectionsMock.mockResolvedValueOnce({ items: [disabledConn, activeConn] });
    listArticleDistributionsMock.mockResolvedValueOnce({
      items: [taskWithDisabledConn, taskWithDeletedConn],
    });

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    const drawer = await screen.findByTestId('studio-distribution-drawer');
    await waitFor(() => {
      expect(drawer.textContent).toContain('Legacy Disabled Shop（已停用）');
    });
    expect(drawer.textContent).not.toContain('cm1234567890opaque');
    expect(drawer.textContent).toContain('原绑定连接已停用或删除，请重新选择可用连接');

    // Switch to tab with deleted connection ID
    const tabsRoot = screen.getByTestId('distribution-variant-tabs');
    fireEvent.click(within(tabsRoot).getByText('Deleted Bound Tab'));
    await waitFor(() => {
      expect(drawer.textContent).toContain('原绑定连接已删除，请重新选择可用连接');
    });
    expect(drawer.textContent).not.toContain('cm9999999999deleted');
  });
});
