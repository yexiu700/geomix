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

  it('defaults manual article status to NORMAL and category/cover to 不选择, shows 抖音/小红书 1000-char tip + >1000 warning + plain-text copy, and supports gallery cover replace/remove (#75)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const gw = makeGateway();

    render(<ArticleManageScreen title="文章列表" tabId="tab_articles" gateway={gw} />);

    await waitFor(() => {
      expect(screen.getByText('光纤激光切割机选型全攻略')).toBeTruthy();
    });

    fireEvent.click(findButton('添加'));

    const dialog = await screen.findByRole('dialog', { name: '手动添加文章' });
    expect(dialog).toBeTruthy();

    // Red formatting notice & word count (#75)
    expect(dialog.textContent).toContain('排版提示：');
    expect(dialog.textContent).toContain('抖音、小红书类文字建议控制在1000字之内');
    expect(screen.getByLabelText('字数统计').textContent).toContain('0 字');

    // Default status radio is NORMAL ('正常'), while category & cover group default to unselected ('不选择')
    const normalRadio = dialog.querySelector(
      'input[type="radio"][value="NORMAL"]',
    ) as HTMLInputElement;
    expect(normalRadio.checked).toBe(true);

    const catSelect = screen.getByLabelText('归属分类') as HTMLSelectElement;
    const mediaCatSelect = screen.getByLabelText('画像封面分组') as HTMLSelectElement;
    expect(catSelect.value).toBe('');
    expect(mediaCatSelect.value).toBe('');
    expect(dialog.textContent).toContain('未设置封面');

    // Explicitly select category and gallery group -> loads candidate covers and picks first cover
    fireEvent.change(catSelect, { target: { value: 'cat_laser_000000000001' } });
    fireEvent.change(mediaCatSelect, { target: { value: 'gal_1' } });

    await waitFor(() => {
      expect(screen.getByLabelText('选择封面图 2')).toBeTruthy();
    });
    expect(dialog.textContent).toContain('/uploads/tenant_1/cover_auto.jpg');

    // Pick second candidate cover from gallery
    fireEvent.click(screen.getByLabelText('选择封面图 2'));
    expect(dialog.textContent).toContain('/uploads/tenant_1/cover_alt.jpg');

    // Remove cover -> sets coverUrl to null
    fireEvent.click(findButton('移除封面'));
    expect(dialog.textContent).toContain('未设置封面');

    // Entering >1000 plain-text chars in default WYSIWYG editor triggers live >1000 warning
    const richEditor = screen.getByLabelText('文章富文本内容') as HTMLDivElement;
    expect(richEditor.getAttribute('contenteditable')).toBe('true');
    expect(screen.queryByLabelText('HTML 源码内容')).toBeNull();
    richEditor.innerHTML = `<p>${'精'.repeat(1005)}</p>`;
    fireEvent.input(richEditor);
    expect(dialog.textContent).toContain('超过抖音、小红书建议的 1000 字上限');

    // Fill title and rich content, check live word count update & plain-text copy without HTML tags
    fireEvent.change(screen.getByLabelText('文章标题'), {
      target: { value: '手动撰写的激光打标维护手册' },
    });
    richEditor.innerHTML = '<h2>每日点检</h2><p>开机前先检查冷水机水位与镜片洁净度。</p>';
    fireEvent.input(richEditor);
    expect(screen.getByLabelText('字数统计').textContent).not.toContain('0 字');
    expect(dialog.textContent).not.toContain('超过抖音、小红书建议的 1000 字上限');
    expect(richEditor.textContent).not.toContain('<h2>');
    expect(richEditor.querySelector('h2')?.textContent).toBe('每日点检');

    fireEvent.click(findButton('复制纯文本'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copiedText = writeText.mock.calls[0]?.[0] as string;
    expect(copiedText).toContain('每日点检');
    expect(copiedText).toContain('开机前先检查冷水机水位与镜片洁净度。');
    expect(copiedText).not.toContain('<h2>');

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

  it('defaults Edit Modal to WYSIWYG without exposing raw HTML tags, keeps HTML 源码 as optional advanced mode, and unifies 设为正常 (#149, #156)', async () => {
    const gw = makeGateway();

    render(<ArticleManageScreen title="文章列表" tabId="tab_articles" gateway={gw} />);

    await waitFor(() => {
      expect(screen.getByText('光纤激光切割机选型全攻略')).toBeTruthy();
    });

    // Row action uses 设为正常 instead of 标记为已审核 (#156)
    expect(screen.queryByText('标记为已审核')).toBeNull();
    const rowNormalBtn = findButton('设为正常');
    expect(rowNormalBtn).toBeTruthy();
    fireEvent.click(rowNormalBtn);
    await waitFor(() => {
      expect(gw.approve).toHaveBeenCalledWith('art_pending_001');
      expect(screen.getByText('文章「光纤激光切割机选型全攻略」已设为「正常」')).toBeTruthy();
    });

    // Open Edit modal -> defaults to 可视化编辑 without raw HTML tags in visible text (#149)
    fireEvent.click(findButton('编辑'));
    const dialog = await screen.findByRole('dialog', { name: '编辑文章' });
    expect(dialog).toBeTruthy();
    expect(findButton('弹窗设为正常').textContent?.trim()).toBe('设为正常');

    const richEditor = screen.getByLabelText('文章富文本内容') as HTMLDivElement;
    expect(richEditor.querySelector('h2')?.textContent).toBe('核心参数');
    expect(richEditor.textContent).not.toContain('<h2>');
    expect(richEditor.textContent).not.toContain('<p>');
    expect(screen.queryByLabelText('HTML 源码内容')).toBeNull();

    // Formatting toolbar button inserts block cleanly in WYSIWYG mode
    fireEvent.click(findButton('H3'));
    expect(richEditor.querySelector('h3')?.textContent).toBe('三级小标题');

    // Switching to optional HTML 源码 mode exposes raw HTML textarea and syncs back
    fireEvent.click(findButton('HTML 源码'));
    const sourceArea = screen.getByLabelText('HTML 源码内容') as HTMLTextAreaElement;
    expect(sourceArea.value).toContain('<h2>核心参数</h2>');
    fireEvent.change(sourceArea, {
      target: { value: '<h2>更新参数</h2><p>排版已更新。</p>' },
    });

    fireEvent.click(findButton('可视化编辑'));
    const restoredRich = screen.getByLabelText('文章富文本内容') as HTMLDivElement;
    expect(restoredRich.querySelector('h2')?.textContent).toBe('更新参数');
    expect(restoredRich.textContent).not.toContain('<h2>');
  });

  it('syncs URL, h3 title, and tab retitle when switching category filter or resetting filters (#149)', async () => {
    const dispatched: ShellAction[] = [];
    const gw = makeGateway({
      loadFormOptions: vi.fn().mockResolvedValue({
        ...makeOptions(),
        categories: [
          {
            id: 'cmwlsdssk007ooiprwynekggi',
            name: 'Anker 电源专题',
            total: 1,
            remaining: 1,
            createdAt: '2026-11-17T06:00:00.000Z',
          },
          {
            id: 'cmwlsdssk008ooiprwynekggj',
            name: 'ARZOPA便携屏评测',
            total: 2,
            remaining: 2,
            createdAt: '2026-11-17T06:10:00.000Z',
          },
        ],
      }),
      list: vi.fn().mockImplementation(async (q) => {
        if (q.categoryId === 'cmwlsdssk008ooiprwynekggj') {
          return {
            page: 1,
            pageSize: 10,
            total: 1,
            categorySummary: {
              id: 'cmwlsdssk008ooiprwynekggj',
              name: 'ARZOPA便携屏评测',
              total: 2,
              remaining: 2,
            },
            items: [makeItem({ id: 'art_arzopa', title: 'ARZOPA 便携屏评测指南' })],
          };
        }
        if (q.categoryId === 'cmwlsdssk007ooiprwynekggi') {
          return {
            page: 1,
            pageSize: 10,
            total: 1,
            categorySummary: {
              id: 'cmwlsdssk007ooiprwynekggi',
              name: 'Anker 电源专题',
              total: 1,
              remaining: 1,
            },
            items: [makeItem({ id: 'art_anker', title: 'Anker 快充技术解析' })],
          };
        }
        return {
          page: 1,
          pageSize: 10,
          total: 2,
          categorySummary: null,
          items: [makeItem()],
        };
      }),
    });

    const initialHref =
      '/writing/articles?categoryId=cmwlsdssk007ooiprwynekggi&taskId=task_run_001';
    const { rerender } = render(
      <ArticleManageScreen
        title="文章列表 · 按分类筛选 · 按任务筛选"
        tabId={initialHref}
        href={initialHref}
        gateway={gw}
        onDispatch={(act) => dispatched.push(act)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
        '文章列表 · Anker 电源专题 · 十篇激光选型计划',
      );
    });

    // Switch category dropdown to ARZOPA and clear taskId, then click 查询
    fireEvent.change(screen.getByLabelText('分类筛选'), {
      target: { value: 'cmwlsdssk008ooiprwynekggj' },
    });
    fireEvent.change(screen.getByLabelText('AI 任务筛选'), {
      target: { value: '' },
    });
    dispatched.length = 0;
    fireEvent.click(findButton('查询'));

    expect(dispatched).toContainEqual({
      type: 'navigate',
      id: initialHref,
      href: '/writing/articles?categoryId=cmwlsdssk008ooiprwynekggj',
    });

    // Simulate ShellFrame updating href/tabId/title after navigate
    const nextHref = '/writing/articles?categoryId=cmwlsdssk008ooiprwynekggj';
    rerender(
      <ArticleManageScreen
        title="文章列表 · 按分类筛选"
        tabId={nextHref}
        href={nextHref}
        gateway={gw}
        onDispatch={(act) => dispatched.push(act)}
      />,
    );

    await waitFor(() => {
      const heading = screen.getByRole('heading', { level: 3 }).textContent ?? '';
      expect(heading).toBe('文章列表 · ARZOPA便携屏评测');
      expect(heading).not.toContain('Anker');
      expect(heading).not.toContain('cmwlsdssk007ooiprwynekggi');
    });

    // Click 重置筛选 -> clears URL, category summary, h3 heading, and retitles back to 文章列表
    dispatched.length = 0;
    fireEvent.click(findButton('重置筛选'));

    expect(dispatched).toContainEqual({
      type: 'navigate',
      id: nextHref,
      href: '/writing/articles',
    });
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('文章列表');
    expect(screen.queryByText(/当前分类：/)).toBeNull();
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
