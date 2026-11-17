// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  buildArticleExportZip,
  readZipStoreEntries,
  type ArticleDetailRecord,
  type ArticleManageItem,
  type MediaAssetRecord,
} from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  articleQueryFromHref,
  type ArticleDownloadFile,
  type ArticleFormOptions,
  type ArticleManageGateway,
} from '../../lib/articles';
import type { ShellAction } from '../../lib/tab-stack';
import { ArticleManageScreen } from './article-manage-screen';

function findButton(labelOrText: string): HTMLButtonElement {
  const byLabel = document.querySelector(`button[aria-label="${labelOrText}"]`);
  if (byLabel instanceof HTMLButtonElement) return byLabel;
  const all = Array.from(document.querySelectorAll('button'));
  const normalized = labelOrText.replace(/\s+/g, '');
  const match = all.find((btn) => (btn.textContent ?? '').replace(/\s+/g, '') === normalized);
  if (!match) {
    throw new Error(`Button not found: ${labelOrText}`);
  }
  return match;
}

function makeItem(overrides: Partial<ArticleManageItem> = {}): ArticleManageItem {
  return {
    id: 'art_pending_001',
    categoryId: 'cat_laser_000000000001',
    categoryName: '激光选型指南',
    aiTaskId: 'task_run_001',
    aiTaskName: '十篇激光选型计划',
    title: '光纤激光切割机选型全攻略',
    coverUrl: '/uploads/tenant_1/cover_1.jpg',
    status: 'PENDING',
    source: 'AI_TASK',
    sendCount: 0,
    videoCount: 0,
    wordCount: 380,
    countsAsRemaining: false,
    createdAt: '2026-11-17T08:00:00.000Z',
    updatedAt: '2026-11-17T08:00:00.000Z',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<ArticleDetailRecord> = {}): ArticleDetailRecord {
  const base = makeItem(overrides);
  return {
    ...base,
    contentHtml: '<h2>核心参数</h2><p>光纤激光切割机的功率与台面尺寸决定加工效率。</p>',
    contentText: '核心参数 光纤激光切割机的功率与台面尺寸决定加工效率。',
    sourceUrl: null,
    ...overrides,
  };
}

function makeOptions(): ArticleFormOptions {
  return {
    categories: [
      {
        id: 'cat_laser_000000000001',
        name: '激光选型指南',
        total: 2,
        remaining: 1,
        createdAt: '2026-11-17T06:00:00.000Z',
      },
    ],
    tasks: [
      {
        id: 'task_run_001',
        name: '十篇激光选型计划',
        categoryId: 'cat_laser_000000000001',
        categoryName: '激光选型指南',
        keywordId: 'kw_1',
        keywordMain: '光纤激光切割机',
        mediaCategoryId: 'gal_1',
        mediaCategoryName: '车间实拍图库',
        imageCount: 1,
        kbId: null,
        kbName: null,
        contentTplId: null,
        contentTplName: null,
        titleTplId: null,
        titleTplName: null,
        resultStatus: 'PENDING',
        target: 10,
        doneCount: 2,
        failCount: 0,
        skipCount: 0,
        unitPrice: 10,
        frozenPoints: 100,
        settledPoints: 20,
        releasedPoints: 0,
        status: 'COMPLETED',
        lastError: null,
        lastWrittenAt: '2026-11-17T07:50:00.000Z',
        createdAt: '2026-11-17T07:00:00.000Z',
      },
    ],
    mediaCategories: [
      {
        id: 'gal_1',
        name: '车间实拍图库',
        type: 1,
        assetCount: 2,
        previewAssets: [
          {
            id: 'asset_1',
            url: '/uploads/tenant_1/cover_auto.jpg',
            thumbUrl: '/uploads/tenant_1/cover_auto_thumb.jpg',
            width: 800,
            height: 600,
          },
        ],
        createdAt: '2026-11-17T05:00:00.000Z',
      },
    ],
  };
}

function makeGalleryAssets(): MediaAssetRecord[] {
  return [
    {
      id: 'asset_1',
      categoryId: 'gal_1',
      categoryName: '车间实拍图库',
      origin: 'UPLOAD',
      objectKey: 'tenant_1/cover_auto.jpg',
      url: '/uploads/tenant_1/cover_auto.jpg',
      thumbUrl: '/uploads/tenant_1/cover_auto_thumb.jpg',
      width: 800,
      height: 600,
      bytes: 42000,
      mime: 'image/jpeg',
      usedCount: 0,
      createdAt: '2026-11-17T05:10:00.000Z',
    },
    {
      id: 'asset_2',
      categoryId: 'gal_1',
      categoryName: '车间实拍图库',
      origin: 'UPLOAD',
      objectKey: 'tenant_1/cover_alt.jpg',
      url: '/uploads/tenant_1/cover_alt.jpg',
      thumbUrl: '/uploads/tenant_1/cover_alt_thumb.jpg',
      width: 800,
      height: 600,
      bytes: 45000,
      mime: 'image/jpeg',
      usedCount: 0,
      createdAt: '2026-11-17T05:12:00.000Z',
    },
  ];
}

function makeGateway(overrides: Partial<ArticleManageGateway> = {}): ArticleManageGateway {
  return {
    list: vi.fn().mockResolvedValue({
      page: 1,
      pageSize: 10,
      total: 2,
      categorySummary: {
        id: 'cat_laser_000000000001',
        name: '激光选型指南',
        total: 2,
        remaining: 1,
      },
      items: [
        makeItem(),
        makeItem({
          id: 'art_normal_002',
          title: '激光切割机日常保养清单',
          status: 'NORMAL',
          source: 'MANUAL',
          countsAsRemaining: true,
        }),
      ],
    }),
    detail: vi.fn().mockImplementation(async (id: string) => makeDetail({ id })),
    create: vi.fn().mockImplementation(async (input) =>
      makeDetail({
        id: 'art_manual_new',
        title: input.title,
        categoryId: input.categoryId,
        coverUrl: input.coverUrl ?? null,
        status: input.status ?? 'NORMAL',
        source: 'MANUAL',
        contentHtml: input.contentHtml,
      }),
    ),
    update: vi.fn().mockImplementation(async (id, input) =>
      makeDetail({
        id,
        title: input.title ?? '已更新标题',
        coverUrl: input.coverUrl === undefined ? '/uploads/tenant_1/cover_1.jpg' : input.coverUrl,
        status: input.status ?? 'NORMAL',
      }),
    ),
    approve: vi.fn().mockImplementation(async (id: string) => makeDetail({ id, status: 'NORMAL' })),
    bulkStatus: vi.fn().mockResolvedValue({ updated: 1 }),
    bulkDelete: vi.fn().mockResolvedValue({ deleted: 1 }),
    deleteOne: vi.fn().mockResolvedValue({ deleted: 1 }),
    downloadTable: vi.fn().mockResolvedValue({
      filename: 'geomix-articles.csv',
      mime: 'text/csv',
      body: new TextEncoder().encode('id,title\n'),
    }),
    exportZip: vi.fn().mockImplementation(async ({ format }) => {
      const bytes = buildArticleExportZip(
        [
          {
            id: 'art_pending_001',
            title: '光纤激光切割机选型全攻略',
            categoryName: '激光选型指南',
            contentHtml: '<h2>核心参数</h2><p>光纤激光切割机效率分析。</p>',
            contentText: '核心参数 光纤激光切割机效率分析。',
            coverUrl: null,
            createdAt: '2026-11-17T08:00:00.000Z',
          },
        ],
        format,
      );
      return {
        filename: `geomix-articles-${format}.zip`,
        mime: 'application/zip',
        body: bytes,
      };
    }),
    loadFormOptions: vi.fn().mockResolvedValue(makeOptions()),
    listGalleryAssets: vi.fn().mockResolvedValue(makeGalleryAssets()),
    uploadCoverAsset: vi.fn().mockResolvedValue(makeGalleryAssets()[1]!),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ArticleManageScreen (Issue #18)', () => {
  it('parses categoryId and taskId safely from tab href', () => {
    expect(
      articleQueryFromHref(
        '/writing/articles?categoryId=cat_laser_000000000001&taskId=task_run_001',
      ),
    ).toEqual({
      categoryId: 'cat_laser_000000000001',
      taskId: 'task_run_001',
    });
    expect(articleQueryFromHref('/writing/articles?categoryId=../bad')).toEqual({
      categoryId: undefined,
      taskId: undefined,
    });
  });

  it('renders 7 columns, 7 filters, navigation buttons, and omits non-existent 批量审核通过', async () => {
    const gw = makeGateway();
    const dispatched: ShellAction[] = [];

    render(
      <ArticleManageScreen
        title="文章列表"
        tabId="tab_articles"
        href="/writing/articles?categoryId=cat_laser_000000000001"
        gateway={gw}
        onDispatch={(act) => dispatched.push(act)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('光纤激光切割机选型全攻略')).toBeTruthy();
    });

    // Columns
    for (const colTitle of [
      '分类名',
      '标题',
      '发送次数',
      '转视频次数',
      '状态',
      '创建时间',
      '操作',
    ]) {
      expect(screen.getAllByText(colTitle).length).toBeGreaterThan(0);
    }

    // Filters
    expect(screen.getByLabelText('分类筛选')).toBeTruthy();
    expect(screen.getByLabelText('AI 任务筛选')).toBeTruthy();
    expect(screen.getByLabelText('标题筛选')).toBeTruthy();
    expect(screen.getByLabelText('发送次数筛选')).toBeTruthy();
    expect(screen.getByLabelText('转视频次数筛选')).toBeTruthy();
    expect(screen.getByLabelText('状态筛选')).toBeTruthy();
    expect(screen.getByLabelText('创建开始日期')).toBeTruthy();
    expect(screen.getByLabelText('创建结束日期')).toBeTruthy();

    // Has 批量设为正常, does NOT have 批量审核通过
    expect(findButton('批量设为正常')).toBeTruthy();
    expect(screen.queryByText('批量审核通过')).toBeNull();

    // Navigation actions
    fireEvent.click(findButton('返回上一级'));
    fireEvent.click(findButton('文章分类'));

    expect(dispatched).toEqual([
      { type: 'back', id: 'tab_articles' },
      { type: 'open', href: '/writing/categories', sourceId: 'tab_articles' },
    ]);
  });

  it('opens Edit Modal when double-clicking status cell instead of implicitly filtering list', async () => {
    const gw = makeGateway();

    render(<ArticleManageScreen title="文章列表" tabId="tab_articles" gateway={gw} />);

    await waitFor(() => {
      expect(screen.getByText('光纤激光切割机选型全攻略')).toBeTruthy();
    });

    const initialListCallCount = vi.mocked(gw.list).mock.calls.length;

    // Locate the PENDING status Tag inside the row and double-click it
    const row = screen.getByText('光纤激光切割机选型全攻略').closest('tr')!;
    const statusTag = Array.from(row.querySelectorAll('span')).find(
      (el) => el.textContent === '待审核',
    )!;
    fireEvent.doubleClick(statusTag);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '编辑文章' })).toBeTruthy();
    });

    expect(gw.detail).toHaveBeenCalledWith('art_pending_001');
    // Crucial: list was NOT re-queried with a hidden status filter!
    expect(vi.mocked(gw.list).mock.calls.length).toBe(initialListCallCount);
  });

  it('defaults manual article status to NORMAL, shows red tip & live word count, and supports gallery cover replace/remove', async () => {
    const gw = makeGateway();

    render(<ArticleManageScreen title="文章列表" tabId="tab_articles" gateway={gw} />);

    await waitFor(() => {
      expect(screen.getByText('光纤激光切割机选型全攻略')).toBeTruthy();
    });

    fireEvent.click(findButton('添加'));

    const dialog = await screen.findByRole('dialog', { name: '手动添加文章' });
    expect(dialog).toBeTruthy();

    // Red formatting notice & word count
    expect(dialog.textContent).toContain('排版提示：');
    expect(screen.getByLabelText('字数统计').textContent).toContain('0 字');

    // Default status radio is NORMAL ('正常')
    const normalRadio = dialog.querySelector(
      'input[type="radio"][value="NORMAL"]',
    ) as HTMLInputElement;
    expect(normalRadio.checked).toBe(true);

    // Auto-populated cover from gallery category previewAssets[0]
    expect(dialog.textContent).toContain('/uploads/tenant_1/cover_auto.jpg');

    // Pick second candidate cover from gallery
    await waitFor(() => {
      expect(screen.getByLabelText('选择封面图 2')).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText('选择封面图 2'));
    expect(dialog.textContent).toContain('/uploads/tenant_1/cover_alt.jpg');

    // Remove cover -> sets coverUrl to null
    fireEvent.click(findButton('移除封面'));
    expect(dialog.textContent).toContain('未设置封面');

    // Fill title and rich content, check live word count update
    fireEvent.change(screen.getByLabelText('文章标题'), {
      target: { value: '手动撰写的激光打标维护手册' },
    });
    fireEvent.change(screen.getByLabelText('文章富文本内容'), {
      target: { value: '<h2>每日点检</h2><p>开机前先检查冷水机水位与镜片洁净度。</p>' },
    });
    expect(screen.getByLabelText('字数统计').textContent).not.toContain('0 字');

    fireEvent.click(findButton('保存文章'));

    await waitFor(() => {
      expect(gw.create).toHaveBeenCalledWith({
        title: '手动撰写的激光打标维护手册',
        categoryId: 'cat_laser_000000000001',
        mediaCategoryId: 'gal_1',
        coverUrl: null,
        status: 'NORMAL',
        contentHtml: '<h2>每日点检</h2><p>开机前先检查冷水机水位与镜片洁净度。</p>',
      });
    });
  });

  it('supports 批量设为正常 (updating category remaining count) and zip archive export (md/html/docx)', async () => {
    let remainingCount = 1;
    const gw = makeGateway({
      list: vi.fn().mockImplementation(async () => ({
        page: 1,
        pageSize: 10,
        total: 2,
        categorySummary: {
          id: 'cat_laser_000000000001',
          name: '激光选型指南',
          total: 2,
          remaining: remainingCount,
        },
        items: [
          makeItem({
            status: remainingCount === 2 ? 'NORMAL' : 'PENDING',
            countsAsRemaining: remainingCount === 2,
          }),
          makeItem({
            id: 'art_normal_002',
            title: '激光切割机日常保养清单',
            status: 'NORMAL',
            source: 'MANUAL',
            countsAsRemaining: true,
          }),
        ],
      })),
      bulkStatus: vi.fn().mockImplementation(async () => {
        remainingCount = 2;
        return { updated: 1 };
      }),
    });

    const downloads: ArticleDownloadFile[] = [];

    render(
      <ArticleManageScreen
        title="文章列表"
        tabId="tab_articles"
        href="/writing/articles?categoryId=cat_laser_000000000001"
        gateway={gw}
        onDownload={(f) => downloads.push(f)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/剩余可用 1 篇/)).toBeTruthy();
    });

    // Select first row checkbox
    const checkboxes = document.querySelectorAll('tbody input[type="checkbox"]');
    fireEvent.click(checkboxes[0]!);

    // Click 批量设为正常
    fireEvent.click(findButton('批量设为正常'));

    await waitFor(() => {
      expect(gw.bulkStatus).toHaveBeenCalledWith({
        ids: ['art_pending_001'],
        status: 'NORMAL',
      });
      expect(screen.getByText(/剩余可用 2 篇/)).toBeTruthy();
    });

    // Export Docx zip archive
    fireEvent.change(screen.getByLabelText('压缩包格式'), {
      target: { value: 'docx' },
    });
    fireEvent.click(findButton('打包导出'));

    await waitFor(() => {
      expect(gw.exportZip).toHaveBeenCalledWith({
        format: 'docx',
        ids: undefined,
        categoryId: 'cat_laser_000000000001',
        taskId: null,
        status: undefined,
        keyword: undefined,
      });
      expect(downloads.length).toBe(1);
    });

    const entries = readZipStoreEntries(downloads[0]!.body);
    expect(entries.length).toBe(1);
    expect(entries[0]!.path.endsWith('.docx')).toBe(true);
    // Verify inner docx itself is a valid OOXML zip archive containing word/document.xml
    const docxInner = readZipStoreEntries(entries[0]!.data);
    expect(docxInner.map((e) => e.path)).toContain('word/document.xml');
  });
});
