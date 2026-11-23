// @vitest-environment jsdom

import type {
  ChannelConnectionDto,
  DistributionPreflightResult,
  GeoArticleRecord,
  GeoBriefRecord,
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
});
