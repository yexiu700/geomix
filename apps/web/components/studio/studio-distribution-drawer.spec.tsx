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
import * as extensionApi from '../../lib/extension';
import {
  PreflightBlockedError,
  type ArticleDistributionTaskItem,
  type GeoVariantJobDto,
} from '../../lib/distribution';
import { GatewayApiError } from '../../lib/envelope';
import * as studioLib from '../../lib/studio';
import { StudioDistributionDrawer } from './studio-distribution-drawer';

const createChannelConnectionMock = vi.fn();
const runArticlePreflightMock = vi.fn();
const listArticleDistributionsMock = vi.fn();
const listChannelConnectionsMock = vi.fn();
const createDistributionVariantJobMock = vi.fn();
const listDistributionVariantJobsMock = vi.fn();
const getDistributionVariantJobMock = vi.fn();
const updateDistributionTaskMock = vi.fn();
const publishDistributionTaskMock = vi.fn();
const createPrShareLinkMock = vi.fn();
const revokePrShareLinkMock = vi.fn();

vi.mock('../../lib/distribution', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/distribution')>('../../lib/distribution');
  return {
    ...actual,
    createChannelConnection: (...args: unknown[]) => createChannelConnectionMock(...args),
    runArticlePreflight: (...args: unknown[]) => runArticlePreflightMock(...args),
    listArticleDistributions: (...args: unknown[]) => listArticleDistributionsMock(...args),
    listChannelConnections: (...args: unknown[]) => listChannelConnectionsMock(...args),
    createDistributionVariantJob: (...args: unknown[]) => createDistributionVariantJobMock(...args),
    listDistributionVariantJobs: (...args: unknown[]) => listDistributionVariantJobsMock(...args),
    getDistributionVariantJob: (...args: unknown[]) => getDistributionVariantJobMock(...args),
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
let capturedVariantJobPollingCallback: (() => Promise<void> | void) | null = null;
let capturedVariantJobPollingEnabled = false;

vi.mock('../../lib/use-task-polling', () => ({
  useTaskPolling: (opts: {
    enabled: boolean;
    intervalMs?: number;
    onPoll: () => Promise<void> | void;
  }) => {
    if (opts.intervalMs === 1_500) {
      capturedVariantJobPollingEnabled = opts.enabled;
      capturedVariantJobPollingCallback = opts.enabled ? opts.onPoll : null;
    } else {
      capturedPollingEnabled = opts.enabled;
      capturedPollingCallback = opts.enabled ? opts.onPoll : null;
    }
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

function makeVariantJob(overrides: Partial<GeoVariantJobDto> = {}): GeoVariantJobDto {
  return {
    id: 'gvj_test_1',
    articleId: GLOBAL_ARTICLE.id,
    brandId: 'brand_1',
    brandMarketId: 'bm_gl_1',
    status: 'COMPLETED',
    total: 1,
    doneCount: 1,
    failCount: 0,
    unitPrice: 2,
    totalChargedPoints: 2,
    refundedCount: 0,
    refundedPoints: 0,
    reservationId: 'res_1',
    billingMode: 'SHADOW',
    replayed: false,
    taskIds: ['task_gen_1'],
    failures: [],
    lastError: null,
    createdAt: '2026-11-23T06:00:00.000Z',
    updatedAt: '2026-11-23T06:00:05.000Z',
    finishedAt: '2026-11-23T06:00:05.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPollingCallback = null;
  capturedPollingEnabled = false;
  capturedVariantJobPollingCallback = null;
  capturedVariantJobPollingEnabled = false;
  runArticlePreflightMock.mockResolvedValue({
    ok: true,
    blockers: [],
    warnings: [],
  } satisfies DistributionPreflightResult);
  listArticleDistributionsMock.mockResolvedValue({ items: [] });
  listDistributionVariantJobsMock.mockResolvedValue({ items: [] });
  listChannelConnectionsMock.mockResolvedValue({ items: [SHOPIFY_CONN] });
  vi.spyOn(briefsApi, 'getBrief').mockResolvedValue(BRIEF_WITH_CITATIONS);
  vi.spyOn(extensionApi, 'listExtensionTokens').mockResolvedValue({ items: [] });
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
      expect(screen.getByText(/推送被拦截|推送被发布前体检门禁拦截/)).toBeTruthy();
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

    createDistributionVariantJobMock.mockResolvedValueOnce(
      makeVariantJob({
        total: 2,
        doneCount: 1,
        totalChargedPoints: 4,
        taskIds: [generatedTask.id],
      }),
    );
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

    // Citation-driven recommendation hydrated on target channel row (Y22 removed duplicate rec box)
    await waitFor(() => {
      const redditBtn = screen.getByTestId('distribution-target-REDDIT_ASSIST');
      expect(redditBtn.textContent).toContain('Reddit');
      expect(redditBtn.textContent).toContain('高频被引');
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
      expect(createDistributionVariantJobMock).toHaveBeenCalledWith(
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
        article={{
          ...GLOBAL_ARTICLE,
          id: 'art_cn_2',
          brandId: 'brand_2',
          brandMarketId: 'bm_cn_2',
          market: 'CN',
          briefId: null,
        }}
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

    createDistributionVariantJobMock.mockResolvedValueOnce(
      makeVariantJob({
        reservationId: 'res_race',
        taskIds: [leakedTask.id],
      }),
    );

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
        article={{ ...GLOBAL_ARTICLE, brandId: 'brand_a', brandMarketId: 'bm_a' }}
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
    expect(prShareBtn.textContent).toContain('重签链接');

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
    createDistributionVariantJobMock.mockImplementation(
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
    expect(createDistributionVariantJobMock).toHaveBeenCalledTimes(1);
    expect(firstGenSignal?.aborted).toBe(false);

    await act(async () => {
      resolveGenerate(
        makeVariantJob({
          taskIds: [l1Task.id],
        }),
      );
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

    const drawer = await screen.findByTestId('publish-distribution-workbench');
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

  it('W-01-R2: rotates Idempotency-Key after definitive 502 error inside open modal, preserves key on 504 gateway timeout, and rotates on cancel+reopen', async () => {
    const conn: ChannelConnectionDto = {
      ...SHOPIFY_CONN,
      id: 'conn_sh_idem_r2',
      displayName: 'Idempotency Retry Blog',
    };
    const generatedTask = makeTask({
      id: 'task_idem_ok',
      provider: 'SHOPIFY',
      channelLabel: 'Idempotency Retry Blog',
      connectionId: conn.id,
    });
    listChannelConnectionsMock.mockResolvedValue({ items: [conn] });
    listArticleDistributionsMock.mockResolvedValue({ items: [] });

    const seenKeys: Array<string | undefined> = [];
    createDistributionVariantJobMock
      // Attempt 1: definitive 502 from server -> must rotate key on immediate retry
      .mockImplementationOnce(
        (_articleId: string, _body: unknown, opts?: { idempotencyKey?: string }) => {
          seenKeys.push(opts?.idempotencyKey);
          return Promise.reject(new GatewayApiError(502, 50002, '渠道变体生成失败，请稍后重试'));
        },
      )
      // Attempt 2: ambiguous 504 gateway timeout -> must preserve key2 on immediate retry
      .mockImplementationOnce(
        (_articleId: string, _body: unknown, opts?: { idempotencyKey?: string }) => {
          seenKeys.push(opts?.idempotencyKey);
          return Promise.reject(new GatewayApiError(504, -1, '服务响应超时，请稍后重试'));
        },
      )
      // Attempt 3: immediate retry after 504 -> preserves key2; then we cancel & reopen to verify rotation
      .mockImplementationOnce(
        (_articleId: string, _body: unknown, opts?: { idempotencyKey?: string }) => {
          seenKeys.push(opts?.idempotencyKey);
          return Promise.reject(new GatewayApiError(504, -1, '服务响应超时，请稍后重试'));
        },
      )
      // Attempt 4: after cancel + reopen -> must rotate to a brand-new key and succeed
      .mockImplementationOnce(
        (_articleId: string, _body: unknown, opts?: { idempotencyKey?: string }) => {
          seenKeys.push(opts?.idempotencyKey);
          return Promise.resolve(
            makeVariantJob({
              reservationId: 'res_r2_ok',
              taskIds: [generatedTask.id],
            }),
          );
        },
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

    // Select target & open Points Confirmation Modal
    fireEvent.click(await screen.findByTestId('distribution-target-l1:conn_sh_idem_r2'));
    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    const confirmBtn = await screen.findByTestId('distribution-points-confirm-submit-btn');

    // Attempt 1 -> 502 error (modal stays open, pending key cleared)
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(createDistributionVariantJobMock).toHaveBeenCalledTimes(1);
      expect(notifyErrorMock).toHaveBeenCalledWith('渠道变体生成失败，请稍后重试');
    });

    // Attempt 2 -> immediate retry inside still-open modal MUST rotate key (key2 !== key1), fails with 504
    fireEvent.click(screen.getByTestId('distribution-points-confirm-submit-btn'));
    await waitFor(() => {
      expect(createDistributionVariantJobMock).toHaveBeenCalledTimes(2);
    });

    // Attempt 3 -> immediate retry after 504 MUST preserve key2 (key3 === key2)
    fireEvent.click(screen.getByTestId('distribution-points-confirm-submit-btn'));
    await waitFor(() => {
      expect(createDistributionVariantJobMock).toHaveBeenCalledTimes(3);
    });

    // Cancel modal & reopen -> MUST rotate key (key4 !== key3) and succeed
    const modal = screen.getByTestId('distribution-points-confirm-modal');
    const modalContent = modal.closest('.ant-modal-content') as HTMLElement;
    expect(modalContent).toBeTruthy();
    fireEvent.click(within(modalContent).getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => {
      expect(screen.queryByTestId('distribution-points-confirm-modal')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    fireEvent.click(await screen.findByTestId('distribution-points-confirm-submit-btn'));
    await waitFor(() => {
      expect(createDistributionVariantJobMock).toHaveBeenCalledTimes(4);
      expect(screen.queryByTestId('distribution-points-confirm-modal')).toBeNull();
    });

    expect(seenKeys).toHaveLength(4);
    expect(seenKeys[0]).toMatch(/^dist_var_/);
    expect(seenKeys[1]).toMatch(/^dist_var_/);
    expect(seenKeys[1]).not.toBe(seenKeys[0]); // 502 rotated key!
    expect(seenKeys[2]).toBe(seenKeys[1]); // 504 preserved key!
    expect(seenKeys[3]).toMatch(/^dist_var_/);
    expect(seenKeys[3]).not.toBe(seenKeys[2]); // cancel + reopen rotated key!
  });

  it('Issue #363: tracks async variant job progress via useTaskPolling, displays partial failure refund, and recovers active job after refresh/reopen', async () => {
    const task1 = makeTask({ id: 'task_async_1', channelLabel: 'AstraVault Shopify Blog' });
    const queuedJob = makeVariantJob({
      id: 'gvj_async_progress',
      status: 'QUEUED',
      total: 2,
      doneCount: 0,
      failCount: 0,
      totalChargedPoints: 0,
      taskIds: [],
      finishedAt: null,
    });
    const runningJob = makeVariantJob({
      ...queuedJob,
      status: 'RUNNING',
      doneCount: 1,
      totalChargedPoints: 2,
      taskIds: [task1.id],
    });
    const partialJob = makeVariantJob({
      ...runningJob,
      status: 'PARTIAL',
      doneCount: 1,
      failCount: 1,
      refundedCount: 1,
      refundedPoints: 2,
      failures: [
        {
          index: 1,
          provider: 'REDDIT_ASSIST',
          channelLabel: 'Reddit 社区合规辅发',
          templateKey: 'REDDIT_DISCUSSION',
          error: '单渠道变体生成超过 45 秒超时，已自动退还该渠道点数',
        },
      ],
      finishedAt: '2026-11-23T06:01:00.000Z',
    });

    createDistributionVariantJobMock.mockResolvedValueOnce(queuedJob);
    getDistributionVariantJobMock
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValueOnce(partialJob);
    listArticleDistributionsMock
      .mockResolvedValueOnce({ items: [] }) // initial hydrate
      .mockResolvedValueOnce({ items: [task1] }) // mid-job refresh when doneCount grows
      .mockResolvedValueOnce({ items: [task1] }); // final refresh on PARTIAL

    const onRefreshWallet = vi.fn();

    const { unmount } = render(
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
      />,
    );

    fireEvent.click(await screen.findByTestId('distribution-target-l1:conn_shopify_1'));
    fireEvent.click(screen.getByTestId('distribution-target-REDDIT_ASSIST'));
    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    fireEvent.click(await screen.findByTestId('distribution-points-confirm-submit-btn'));

    // Modal closes immediately upon QUEUED enqueue and progress card becomes visible
    await waitFor(() => {
      expect(screen.queryByTestId('distribution-points-confirm-modal')).toBeNull();
      expect(screen.getByTestId('distribution-variant-job-progress')).toBeTruthy();
    });
    expect(capturedVariantJobPollingEnabled).toBe(true);
    expect(capturedVariantJobPollingCallback).toBeTypeOf('function');

    // Tick 1: RUNNING (1/2)
    await act(async () => {
      await capturedVariantJobPollingCallback?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('distribution-variant-job-progress').textContent).toContain(
        '后台并行生成中',
      );
    });

    // Tick 2: PARTIAL (1 done, 1 failed + auto refund)
    await act(async () => {
      await capturedVariantJobPollingCallback?.();
    });
    await waitFor(() => {
      const progressCard = screen.getByTestId('distribution-variant-job-progress');
      expect(progressCard.textContent).toContain('部分渠道生成完成');
      expect(progressCard.textContent).toContain('已自动退还');
      expect(notifyWarningMock).toHaveBeenCalledWith(expect.stringContaining('已自动退还 2 点'));
      expect(capturedVariantJobPollingEnabled).toBe(false);
    });

    unmount();

    // Refresh / reopen recovery: drawer hydrates an in-progress RUNNING job automatically
    listDistributionVariantJobsMock.mockResolvedValueOnce({ items: [runningJob] });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [task1] });
    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={2}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    const recovered = await screen.findByTestId('distribution-variant-job-progress');
    expect(recovered.textContent).toContain('后台并行生成中');
    expect(capturedVariantJobPollingEnabled).toBe(true);
  });

  it('Issue #365: renders GLOBAL exaggerated claim blocker/warning details and passes matchedTerm to onReturnToEditor', async () => {
    runArticlePreflightMock.mockResolvedValueOnce({
      ok: false,
      blockers: [
        {
          code: 'COMPLIANCE_BLOCKED',
          severity: 'blocker',
          message: '海外（GLOBAL）稿件命中高风险医疗/功效或金融收益违禁宣称',
          details: ['"cure-all" (第 2 行)'],
          matches: [
            {
              category: 'medical',
              term: 'cure-all',
              matchedText: 'cure-all',
              line: 2,
              excerpt: 'Guaranteed #1 cure-all miracle!',
            },
          ],
        },
      ],
      warnings: [
        {
          code: 'GLOBAL_CLAIM_WARNING',
          severity: 'warning',
          message: '海外（GLOBAL）稿件包含绝对化/未经证实的夸大表述',
          details: ['"risk-free" (第 2 行)'],
          matches: [
            {
              category: 'superlative',
              term: 'risk-free',
              matchedText: 'risk-free',
              line: 2,
              excerpt: '100% safe and risk-free for everyone.',
            },
          ],
        },
      ],
    } satisfies DistributionPreflightResult);

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
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={onReturnToEditor}
      />,
    );

    const blockerBox = await screen.findByTestId('distribution-preflight-blockers');
    expect(blockerBox.textContent).toContain('"cure-all" (第 2 行)');
    fireEvent.click(screen.getByTestId('distribution-back-to-editor-btn'));
    expect(onReturnToEditor).toHaveBeenCalledWith('COMPLIANCE_BLOCKED', 'cure-all');

    const warningBox = screen.getByTestId('distribution-preflight-warnings');
    expect(warningBox.textContent).toContain('"risk-free" (第 2 行)');
    fireEvent.click(screen.getByTestId('distribution-warning-locate-btn'));
    expect(onReturnToEditor).toHaveBeenCalledWith('GLOBAL_CLAIM_WARNING', 'risk-free');
  });

  it('supports v2.2 multi-locale variant job, ja-JP preflight without false-positive CJK block, and new L1 affordances (GITHUB_MDX, DEVTO, WECHAT_OFFICIAL)', async () => {
    const jaArticle: GeoArticleRecord = {
      ...GLOBAL_ARTICLE,
      id: 'art_ja_drawer',
      targetLocale: 'ja-JP',
      title: '2026年 静音ホームNAS比較ガイド',
      contentMarkdown:
        '# 静音ホームNAS比較\n\nAstraVault X4は18.5dBの静音設計で、24時間稼働でも快適です。',
    };
    // Simulate server preflight failure -> falls back to local evaluateDistributionPreflight with ja-JP
    runArticlePreflightMock.mockRejectedValueOnce(new Error('offline'));
    listChannelConnectionsMock.mockResolvedValueOnce({
      items: [
        {
          id: 'conn_gh_1',
          brandId: 'brand_1',
          brandMarketId: 'bm_gl_1',
          market: 'GLOBAL',
          provider: 'GITHUB_MDX',
          displayName: 'Docs MDX Repo',
          siteBaseUrl: 'https://github.com/acme/docs',
          credentialHint: 'ghp_****1234',
          configJson: { repoOwner: 'acme', repoName: 'docs', branch: 'main' },
          status: 'ACTIVE',
          authType: 'API_KEY',
          targetLocale: 'ja-JP',
          lastTestedAt: '2026-11-23T00:00:00.000Z',
          lastError: null,
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-23T00:00:00.000Z',
        } satisfies ChannelConnectionDto,
      ],
    });
    const ghTask = makeTask({
      id: 'task_gh_1',
      articleId: jaArticle.id,
      targetLocale: 'ja-JP',
      connectionId: 'conn_gh_1',
      provider: 'GITHUB_MDX',
      mode: 'L1_API',
      channelLabel: 'Docs MDX Repo',
      variantTitle: '2026年 静音ホームNAS比較ガイド',
      variantSlug: 'quiet-home-nas-ja-2026',
      variantMetaDesc: '静音ホームNASの比較データ',
      variantMarkdown: '# MDX Content',
      variantHtml: '',
      variantExtrasJson: { tags: ['nas', 'homelab'] },
      status: 'DRAFT_PUSHED',
      publishAsDraft: true,
      remotePostId: 'pr#42',
      remoteAdminUrl: 'https://github.com/acme/docs/pull/42',
      remotePublishedUrl: null,
    });
    const devtoTask: ArticleDistributionTaskItem = {
      ...ghTask,
      id: 'task_devto_1',
      provider: 'DEVTO',
      channelLabel: 'Dev.to Official',
      status: 'DRAFT_VARIANT',
      remotePostId: null,
      remoteAdminUrl: null,
      variantExtrasJson: {
        canonicalUrl: 'https://astravault.example.com/guides/nas-2026',
        tags: ['homelab', 'selfhosted'],
      },
    };
    listArticleDistributionsMock.mockResolvedValue({ items: [ghTask, devtoTask] });
    createDistributionVariantJobMock.mockResolvedValueOnce({
      id: 'vjob_ja_1',
      articleId: jaArticle.id,
      brandId: 'brand_1',
      brandMarketId: 'bm_gl_1',
      status: 'COMPLETED',
      total: 1,
      doneCount: 1,
      failCount: 0,
      unitPrice: 2,
      totalChargedPoints: 2,
      refundedCount: 0,
      refundedPoints: 0,
      reservationId: null,
      billingMode: 'SHADOW',
      replayed: false,
      taskIds: ['task_gh_1'],
      failures: [],
      lastError: null,
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
      finishedAt: '2026-11-24T00:00:01.000Z',
    } satisfies GeoVariantJobDto);

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_gl_1"
        market="GLOBAL"
        contextEpoch={1}
        article={jaArticle}
        draftTitle={jaArticle.title}
        draftMarkdown={jaArticle.contentMarkdown}
        brandNames={['AstraVault']}
        supportedLocales={['en-US', 'ja-JP', 'de-DE']}
        defaultTargetLocale="ja-JP"
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    // 1. ja-JP preflight passes locally with ZERO GLOBAL_CJK_LEAK blockers
    await screen.findByTestId('distribution-preflight-card');
    expect(runArticlePreflightMock).toHaveBeenCalledWith(
      jaArticle.id,
      expect.objectContaining({ targetLocale: 'ja-JP' }),
      expect.anything(),
    );
    expect(screen.queryByTestId('distribution-preflight-blockers')).toBeNull();

    // 2. Step 2 shows conditional variant locale selector & submits targetLocale on variant job
    expect(await screen.findByTestId('distribution-target-locale-select')).toBeTruthy();
    expect(screen.queryByTestId('distribution-l2-extension-group')).toBeNull();
    fireEvent.click(screen.getByTestId('distribution-target-l1:conn_gh_1'));
    fireEvent.click(screen.getByTestId('distribution-generate-variants-btn'));
    fireEvent.click(await screen.findByTestId('distribution-points-confirm-submit-btn'));
    await waitFor(() => {
      expect(createDistributionVariantJobMock).toHaveBeenCalledWith(
        jaArticle.id,
        {
          targets: [
            expect.objectContaining({
              provider: 'GITHUB_MDX',
              connectionId: 'conn_gh_1',
              targetLocale: 'ja-JP',
            }),
          ],
        },
        expect.anything(),
      );
    });

    // 3. Step 3 GITHUB_MDX shows PR review link & locale tag
    const prLink = await screen.findByTestId('distribution-github-pr-link');
    expect(prLink.getAttribute('href')).toBe('https://github.com/acme/docs/pull/42');
    expect(prLink.textContent).toContain('pr#42');
    expect(screen.getByTestId('distribution-task-locale-tag').textContent).toContain('ja-JP');

    // 4. Switch to DEVTO tab -> expand parameter details -> shows canonical URL & tags preview
    fireEvent.click(await screen.findByRole('tab', { name: /Dev\.to Official/ }));
    fireEvent.click(await screen.findByTestId('distribution-eng-details-toggle'));
    const canonicalBox = await screen.findByTestId('distribution-canonical-preview');
    expect(canonicalBox.textContent).toContain('https://astravault.example.com/guides/nas-2026');
    expect(canonicalBox.textContent).toContain('#homelab');
  });

  it('supports CN WECHAT_OFFICIAL draft-only/media_id/40164 and 3 CN L2 Extension queues with pairing guides', async () => {
    const cnArticle: GeoArticleRecord = {
      ...GLOBAL_ARTICLE,
      id: 'art_cn_v22',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      targetLocale: 'zh-CN',
      title: '2026 静音四盘位 NAS 选购指南',
      contentMarkdown: '# 2026 静音四盘位 NAS 选购指南\n\n星辰存储实测 18.5dB。',
    };
    const onNavigateExtensionPairing = vi.fn();
    const onNavigateAccount = vi.fn();
    const onClose = vi.fn();

    runArticlePreflightMock.mockResolvedValueOnce({ ok: true, blockers: [], warnings: [] });
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [] });

    const wechatTask = makeTask({
      id: 'task_wx_1',
      articleId: cnArticle.id,
      brandMarketId: 'bm_cn_1',
      targetLocale: 'zh-CN',
      connectionId: 'conn_wx_1',
      provider: 'WECHAT_OFFICIAL',
      mode: 'L1_API',
      channelLabel: '官方服务号草稿箱',
      variantTitle: '2026 静音四盘位 NAS 选购指南',
      variantSlug: null,
      variantMetaDesc: '星辰存储实测 18.5dB 静音表现。',
      variantMarkdown: '# 公众号正文',
      variantHtml: '',
      variantExtrasJson: { digest: '星辰存储实测 18.5dB 静音表现。' },
      status: 'DRAFT_PUSHED',
      publishAsDraft: true,
      remotePostId: 'wx_media_id_8899',
      remoteAdminUrl: 'https://mp.weixin.qq.com/',
      remotePublishedUrl: null,
      lastError: '错误码 40164：invalid ip',
    });
    const zhihuExtTask = makeTask({
      ...wechatTask,
      id: 'task_zhihu_ext_1',
      connectionId: null,
      provider: 'ZHIHU_EXT',
      mode: 'L2_EXTENSION',
      channelLabel: '知乎（Chrome 扩展）',
      status: 'DRAFT_VARIANT',
      remotePostId: null,
      remoteAdminUrl: null,
      lastError: null,
      variantExtrasJson: {
        antiBanChecklist: ['确认已移除营销诱导话术', '人工核对草稿箱排版后发布'],
      },
    });
    listArticleDistributionsMock.mockResolvedValue({ items: [wechatTask, zhihuExtTask] });
    updateDistributionTaskMock.mockResolvedValueOnce({
      ...zhihuExtTask,
      status: 'READY_TO_PUBLISH',
    });

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_cn_1"
        market="CN"
        contextEpoch={1}
        article={cnArticle}
        draftTitle={cnArticle.title}
        draftMarkdown={cnArticle.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={onClose}
        onReturnToEditor={vi.fn()}
        onNavigateExtensionPairing={onNavigateExtensionPairing}
        onNavigateAccount={onNavigateAccount}
        onCreatePublishRecord={vi.fn().mockResolvedValue(true)}
      />,
    );

    // 1. CN Step 2 collapses L2 Extension targets when unpaired (Y26), then expands on click
    const collapsedL2 = await screen.findByTestId('distribution-l2-extension-collapsed');
    expect(collapsedL2).toBeTruthy();
    fireEvent.click(screen.getByTestId('distribution-l2-expand-btn'));

    const l2Group = await screen.findByTestId('distribution-l2-extension-group');
    expect(within(l2Group).getByTestId('distribution-target-ZHIHU_EXT')).toBeTruthy();
    expect(within(l2Group).getByTestId('distribution-target-TOUTIAO_EXT')).toBeTruthy();
    expect(within(l2Group).getByTestId('distribution-target-SMZDM_EXT')).toBeTruthy();

    // 2. WECHAT_OFFICIAL Step 3 tab: draft-only notice, expandable media_id (Y27), 40164 hint, NO live publish button, NO URL Slug
    expect(await screen.findByTestId('distribution-wechat-draft-only-notice')).toBeTruthy();
    expect(screen.queryByTestId('distribution-wechat-media-id')).toBeNull();
    fireEvent.click(screen.getByTestId('distribution-eng-details-toggle'));
    expect(screen.getByTestId('distribution-wechat-media-id').textContent).toContain(
      'wx_media_id_8899',
    );
    expect(screen.getByText(/处理指引：前往微信公众平台/)).toBeTruthy();
    expect(screen.queryByTestId('distribution-publish-live-btn')).toBeNull();
    expect(screen.queryByLabelText('URL Slug')).toBeNull();

    // 3. Switch to ZHIHU_EXT L2 Extension tab -> panel, mark-ready, anti-ban checklist & pairing links
    fireEvent.click(await screen.findByRole('tab', { name: /知乎（Chrome 扩展）/ }));
    const l2Panel = await screen.findByTestId('distribution-l2-extension-panel');
    expect(l2Panel.textContent).toContain('等待 Chrome 扩展拉取');
    expect(l2Panel.textContent).toContain('确认已移除营销诱导话术');

    fireEvent.click(within(l2Panel).getByTestId('distribution-l2-mark-ready-btn'));
    await waitFor(() => {
      expect(updateDistributionTaskMock).toHaveBeenCalledWith(
        'task_zhihu_ext_1',
        { status: 'READY_TO_PUBLISH' },
        expect.anything(),
      );
    });

    fireEvent.click(within(l2Panel).getByTestId('distribution-l2-pair-brands-btn'));
    expect(onNavigateExtensionPairing).toHaveBeenCalledTimes(1);
    fireEvent.click(within(l2Panel).getByTestId('distribution-l2-pair-account-btn'));
    expect(onNavigateAccount).toHaveBeenCalledTimes(1);
  });

  it('Defect 1 regression: blocks loopback, private, metadata, IPv6-mapped, obfuscated IPv4, and non-HTTPS GitHub PR links from rendering as clickable <a> elements', async () => {
    runArticlePreflightMock.mockResolvedValueOnce({ ok: true, blockers: [], warnings: [] });
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [] });

    const unsafeGhTask = makeTask({
      id: 'task_gh_unsafe',
      provider: 'GITHUB_MDX',
      mode: 'L1_API',
      channelLabel: 'Unsafe GitHub PR',
      status: 'DRAFT_PUSHED',
      remotePostId: 'pr#99',
      remoteAdminUrl: 'http://127.0.0.1/pr',
      remotePublishedUrl: 'http://169.254.169.254/latest/meta-data',
    });
    const httpGhTask = makeTask({
      id: 'task_gh_http',
      provider: 'GITHUB_MDX',
      mode: 'L1_API',
      channelLabel: 'HTTP GitHub PR',
      status: 'DRAFT_PUSHED',
      remotePostId: 'pr#100',
      remoteAdminUrl: 'http://github.com/acme/docs/pull/100',
      remotePublishedUrl: 'http://2130706433/article',
    });
    const unsafeDevtoTask = makeTask({
      id: 'task_devto_unsafe',
      provider: 'DEVTO',
      mode: 'L1_API',
      channelLabel: 'Unsafe Dev.to',
      status: 'DRAFT_VARIANT',
      remoteAdminUrl: 'http://[::ffff:127.0.0.1]/admin',
      remotePublishedUrl: 'http://localhost:3000/post',
      variantExtrasJson: {
        canonicalUrl: 'http://0x7f000001/canonical',
      },
    });
    listArticleDistributionsMock.mockResolvedValueOnce({
      items: [unsafeGhTask, httpGhTask, unsafeDevtoTask],
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

    const unsafeGhTab = await screen.findByRole('tab', { name: /Unsafe GitHub PR/ });
    expect(listArticleDistributionsMock).toHaveBeenCalledTimes(1);
    expect(unsafeGhTab.getAttribute('aria-selected')).toBe('true');
    // Active tab 1: GITHUB_MDX with 127.0.0.1 / 169.254.169.254 -> zero clickable links
    expect(screen.queryByTestId('distribution-github-pr-link')).toBeNull();
    expect(screen.queryByRole('link', { name: /查看已上线公开文章/ })).toBeNull();

    // Tab 2: GITHUB_MDX with plain http://github.com & single-integer 2130706433 -> zero clickable links
    const httpGhTab = await screen.findByRole('tab', { name: /HTTP GitHub PR/ });
    fireEvent.click(httpGhTab);
    await waitFor(() => {
      expect(httpGhTab.getAttribute('aria-selected')).toBe('true');
    });
    expect(screen.queryByTestId('distribution-github-pr-link')).toBeNull();
    expect(screen.queryByRole('link', { name: /查看已上线公开文章/ })).toBeNull();

    // Tab 3: DEVTO with hex IPv4 canonicalUrl & ::ffff:127.0.0.1 / localhost -> rendered as plain text only, zero <a> tags
    fireEvent.click(await screen.findByRole('tab', { name: /Unsafe Dev\.to/ }));
    fireEvent.click(await screen.findByTestId('distribution-eng-details-toggle'));
    const canonicalBox = await screen.findByTestId('distribution-canonical-preview');
    expect(canonicalBox.querySelector('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /打开站点后台草稿/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /查看已上线公开文章/ })).toBeNull();
  });

  it('Defect 4 regression: CN market drawer forces zh-CN preflight and never leaks stale non-CN defaultTargetLocale into preflight blockers', async () => {
    const cnArticle: GeoArticleRecord = {
      ...GLOBAL_ARTICLE,
      id: 'art_cn_locale_gate',
      brandMarketId: 'bm_cn_1',
      market: 'CN',
      targetLocale: undefined,
      title: '2026 静音四盘位 NAS 选购指南',
      contentMarkdown:
        '# 2026 静音四盘位 NAS 选购指南\n\n星辰存储实测 18.5dB 静音表现，适合家庭长期稳定运行。',
    };
    // Force fallback to local evaluateDistributionPreflight so any ja-JP leak would trigger GLOBAL_CJK_LEAK
    runArticlePreflightMock.mockRejectedValueOnce(new Error('network fallback'));
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [] });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [] });

    render(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_cn_1"
        market="CN"
        contextEpoch={1}
        article={cnArticle}
        draftTitle={cnArticle.title}
        draftMarkdown={cnArticle.contentMarkdown}
        brandNames={['星辰存储']}
        defaultTargetLocale="ja-JP"
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await screen.findByTestId('distribution-preflight-card');
    expect(runArticlePreflightMock).toHaveBeenCalledWith(
      cnArticle.id,
      expect.objectContaining({ targetLocale: 'zh-CN' }),
      expect.anything(),
    );
    expect(screen.queryByTestId('distribution-preflight-blockers')).toBeNull();
  });

  it('Defect R1-01 regression: fires ZERO distribution/preflight API calls during transient GLOBAL->CN or cross-brand stale article renders before parent closes drawer', async () => {
    const getBriefSpy = vi.spyOn(briefsApi, 'getBrief').mockResolvedValue(BRIEF_WITH_CITATIONS);
    runArticlePreflightMock.mockResolvedValue({ ok: true, blockers: [], warnings: [] });
    listChannelConnectionsMock.mockResolvedValue({ items: [SHOPIFY_CONN] });
    listArticleDistributionsMock.mockResolvedValue({ items: [makeTask({ id: 'task_gl_init' })] });
    listDistributionVariantJobsMock.mockResolvedValue({ items: [] });

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
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await screen.findByTestId('distribution-preflight-card');
    await waitFor(() => {
      expect(runArticlePreflightMock).toHaveBeenCalledTimes(1);
      expect(listArticleDistributionsMock).toHaveBeenCalledTimes(1);
      expect(listChannelConnectionsMock).toHaveBeenCalledTimes(1);
      expect(listDistributionVariantJobsMock).toHaveBeenCalledTimes(1);
    });

    runArticlePreflightMock.mockClear();
    listArticleDistributionsMock.mockClear();
    listChannelConnectionsMock.mockClear();
    listDistributionVariantJobsMock.mockClear();
    getBriefSpy.mockClear();

    // Transient render 1: market switches GLOBAL -> CN while open=true and stale GLOBAL article is still mounted
    rerender(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_1"
        brandMarketId="bm_cn_1"
        market="CN"
        contextEpoch={2}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(runArticlePreflightMock).not.toHaveBeenCalled();
    expect(listArticleDistributionsMock).not.toHaveBeenCalled();
    expect(listChannelConnectionsMock).not.toHaveBeenCalled();
    expect(listDistributionVariantJobsMock).not.toHaveBeenCalled();
    expect(getBriefSpy).not.toHaveBeenCalled();

    // Transient render 2: brand switches brand_1 -> brand_2 on GLOBAL while open=true and stale brand_1 article is still mounted
    rerender(
      <StudioDistributionDrawer
        open={true}
        brandId="brand_2"
        brandMarketId="bm_gl_2"
        market="GLOBAL"
        contextEpoch={3}
        article={GLOBAL_ARTICLE}
        draftTitle={GLOBAL_ARTICLE.title}
        draftMarkdown={GLOBAL_ARTICLE.contentMarkdown}
        readOnly={false}
        walletAvailable={500}
        onClose={vi.fn()}
        onReturnToEditor={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(runArticlePreflightMock).not.toHaveBeenCalled();
    expect(listArticleDistributionsMock).not.toHaveBeenCalled();
    expect(listChannelConnectionsMock).not.toHaveBeenCalled();
    expect(listDistributionVariantJobsMock).not.toHaveBeenCalled();
    expect(getBriefSpy).not.toHaveBeenCalled();

    getBriefSpy.mockRestore();
  });

  it('#385: hides DISABLED connections with count notice and allows inline 快捷绑站 without leaving StudioDistributionDrawer', async () => {
    const disabledConn: ChannelConnectionDto = {
      id: 'conn_disabled_wh',
      brandId: 'brand_1',
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      provider: 'WEBHOOK',
      displayName: 'Paused Webhook',
      siteBaseUrl: 'https://hooks.example.com/paused',
      credentialHint: 'whse****1234',
      configJson: { defaultPublishAsDraft: true, inlineJsonLd: true },
      status: 'DISABLED',
      authType: 'API_KEY',
      targetLocale: null,
      externalShopDomain: null,
      lastTestedAt: null,
      lastError: null,
      createdAt: '2026-11-25T09:00:00.000Z',
      updatedAt: '2026-11-25T09:00:00.000Z',
    };
    const createdWpConn: ChannelConnectionDto = {
      id: 'conn_inline_wp',
      brandId: 'brand_1',
      brandMarketId: 'bm_gl_1',
      market: 'GLOBAL',
      provider: 'WORDPRESS',
      displayName: 'Studio Inline WP',
      siteBaseUrl: 'https://blog.example.com',
      credentialHint: 'edit****abcd',
      configJson: { defaultPublishAsDraft: true, inlineJsonLd: true },
      status: 'ACTIVE',
      authType: 'API_KEY',
      targetLocale: null,
      externalShopDomain: null,
      lastTestedAt: null,
      lastError: null,
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:00:00.000Z',
    };

    listChannelConnectionsMock.mockResolvedValueOnce({ items: [disabledConn] });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [] });
    createChannelConnectionMock.mockResolvedValueOnce(createdWpConn);

    const onClose = vi.fn();
    const onNavigateBrands = vi.fn();

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
        onClose={onClose}
        onReturnToEditor={vi.fn()}
        onNavigateBrands={onNavigateBrands}
      />,
    );

    const hint = await screen.findByTestId('studio-distribution-disabled-conns-hint');
    expect(hint.textContent).toContain('已停用 1 个连接');
    expect(screen.queryByTestId('distribution-target-l1:conn_disabled_wh')).toBeNull();

    // Open inline ChannelConnectionCreateModal without closing drawer or navigating away
    fireEvent.click(screen.getByTestId('studio-inline-bind-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');
    expect(onClose).not.toHaveBeenCalled();
    expect(onNavigateBrands).not.toHaveBeenCalled();

    // Switch to Shopify 手动配置 (Custom App Token) tab and submit
    fireEvent.click(within(modal).getByRole('tab', { name: '手动配置' }));
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Studio Inline WP' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://blog.example.com' },
    });
    fireEvent.change(within(modal).getByLabelText('Shopify Access Token'), {
      target: { value: 'shpat_inline_secret_1234' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));

    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledTimes(1);
    });

    // Newly created connection immediately appears as L1 target card while disabled hint stays visible
    expect(await screen.findByTestId('distribution-target-l1:conn_inline_wp')).toBeTruthy();
    expect(screen.getByText('Studio Inline WP')).toBeTruthy();
    expect(screen.getByTestId('studio-distribution-disabled-conns-hint')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onNavigateBrands).not.toHaveBeenCalled();
  });

  it('Tier 5 #4: omits unchanged DISABLED connectionId when saving variant draft edits', async () => {
    const disabledConnTask: ArticleDistributionTaskItem = {
      id: 'task_wp_disabled_conn',
      articleId: GLOBAL_ARTICLE.id,
      brandId: 'brand_1',
      brandMarketId: 'bm_gl_1',
      mode: 'L1_API',
      provider: 'WORDPRESS',
      channelLabel: 'Paused WP Blog',
      status: 'DRAFT_VARIANT',
      connectionId: 'conn_wp_disabled',
      targetLocale: 'en-US',
      variantTitle: 'Original WP Draft Title',
      variantMarkdown: '## Draft\n\nOriginal markdown.',
      variantHtml: '<h2>Draft</h2><p>Original markdown.</p>',
      variantSlug: 'original-wp-draft',
      variantMetaDesc: 'Original desc',
      variantExtrasJson: {},
      preflightJson: { ok: true, blockers: [], warnings: [] },
      shareLinkActive: false,
      shareExpiresAt: null,
      targetUrlHint: null,
      publishAsDraft: true,
      remotePostId: null,
      remotePublishedUrl: null,
      remoteAdminUrl: null,
      indexNowStatus: 'NOT_APPLICABLE',
      lastError: null,
      publishedAt: null,
      createdAt: '2026-11-24T08:00:00.000Z',
      updatedAt: '2026-11-24T08:00:00.000Z',
      publishRecords: [],
    };
    runArticlePreflightMock.mockResolvedValueOnce({ ok: true, blockers: [], warnings: [] });
    listChannelConnectionsMock.mockResolvedValueOnce({
      items: [
        {
          id: 'conn_wp_disabled',
          brandId: 'brand_1',
          brandMarketId: 'bm_gl_1',
          market: 'GLOBAL',
          provider: 'WORDPRESS',
          displayName: 'Paused WP Blog',
          siteBaseUrl: 'https://blog.example.com',
          status: 'DISABLED',
          authType: 'API_KEY',
          credentialHint: 'wp_****1234',
          configJson: {},
          targetLocale: 'en-US',
          lastTestedAt: null,
          lastError: null,
          createdAt: '2026-11-24T08:00:00.000Z',
          updatedAt: '2026-11-24T08:00:00.000Z',
        },
      ],
    });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [disabledConnTask] });
    updateDistributionTaskMock.mockResolvedValueOnce({
      ...disabledConnTask,
      variantTitle: 'Edited Title While Paused',
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
        onNavigateBrands={vi.fn()}
      />,
    );

    const titleInput = await screen.findByLabelText('变体标题');
    fireEvent.change(titleInput, { target: { value: 'Edited Title While Paused' } });
    fireEvent.click(screen.getByTestId('distribution-save-variant-btn'));

    await waitFor(() => {
      expect(updateDistributionTaskMock).toHaveBeenCalledTimes(1);
    });
    const sentPayload = updateDistributionTaskMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentPayload.variantTitle).toBe('Edited Title While Paused');
    expect(sentPayload).not.toHaveProperty('connectionId');
  });

  it('always renders DistributionWorkbench inline without Drawer wrapper (Y12)', async () => {
    const { DistributionWorkbench } = await import('./studio-distribution-drawer');
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [SHOPIFY_CONN] });
    listArticleDistributionsMock.mockResolvedValueOnce({ items: [] });

    render(
      <DistributionWorkbench
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
        onReturnToEditor={vi.fn()}
        onNavigateBrands={vi.fn()}
      />,
    );

    const workbench = await screen.findByTestId('publish-distribution-workbench');
    expect(workbench).toBeTruthy();
    expect(screen.queryByTestId('studio-distribution-drawer')).toBeNull();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    expect(await screen.findByTestId('distribution-preflight-card')).toBeTruthy();
    expect(await screen.findByTestId(`distribution-target-l1:${SHOPIFY_CONN.id}`)).toBeTruthy();
  });
});
