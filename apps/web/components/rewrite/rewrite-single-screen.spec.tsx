// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RewriteRecordItem, RewriteSingleCreateInput } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewriteFormOptions, RewriteSingleGateway } from '../../lib/rewrites';
import type { ShellAction } from '../../lib/tab-stack';
import { RewriteSingleScreen } from './rewrite-single-screen';

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

function makeRecord(overrides: Partial<RewriteRecordItem> = {}): RewriteRecordItem {
  return {
    id: 'rw_rec_001',
    batchId: null,
    url: 'https://mp.weixin.qq.com/s/sensor-guide',
    urlHash: 'hash_001',
    pastedText: false,
    sourceTitle: '工业传感器选型实务',
    newTitle: '围绕工业传感器选型的落地评估与执行核对指南',
    categoryId: 'cat_rw_001',
    categoryName: '爆文复刻-20261117-0900',
    mediaCategoryId: 'mcat_001',
    mediaCategoryName: '产线实拍图库',
    templateId: 'sys_rewrite_01',
    templateName: '系统·参考重写',
    status: 'SUCCESS',
    error: null,
    similarity: 0.14,
    highSimilarity: false,
    articleId: 'art_rw_001',
    articleStatus: 'PENDING',
    rewrittenAt: '2026-11-17T09:00:00.000Z',
    createdAt: '2026-11-17T08:59:55.000Z',
    ...overrides,
  };
}

function makeOptions(): RewriteFormOptions {
  return {
    unitPoints: 5,
    categories: [
      {
        id: 'cat_rw_001',
        name: '爆文复刻-20261117-0900',
        total: 2,
        remaining: 1,
        createdAt: '2026-11-17T08:00:00.000Z',
      },
    ],
    mediaCategories: [
      {
        id: 'mcat_001',
        name: '产线实拍图库',
        type: 1,
        assetCount: 4,
        previewAssets: [],
        createdAt: '2026-11-17T08:00:00.000Z',
      },
    ],
    rewriteTemplates: [
      {
        id: 'sys_rewrite_01',
        tenantId: null,
        kind: 'REWRITE',
        isSystem: true,
        name: '系统·参考重写',
        content: '参考重写指令',
        randomPool: true,
        hasManualSlot: false,
        sort: 1,
        clonedFrom: null,
        warnings: [],
        createdAt: '2026-11-17T00:00:00.000Z',
        updatedAt: '2026-11-17T00:00:00.000Z',
      },
    ],
  };
}

function makeGateway(records: RewriteRecordItem[]): {
  gateway: RewriteSingleGateway;
  submitted: RewriteSingleCreateInput[];
} {
  const submitted: RewriteSingleCreateInput[] = [];
  const gateway: RewriteSingleGateway = {
    list: vi.fn(async (query) => ({
      page: query.page,
      pageSize: query.pageSize,
      total: records.length,
      unitPoints: 5,
      items: records,
    })),
    detail: vi.fn(async (id) => records.find((r) => r.id === id) ?? makeRecord({ id })),
    checkUrl: vi.fn(async (url) => ({
      canonicalUrl: url,
      urlHash: 'dup_hash',
      duplicateRecent: url.includes('dup-recent'),
      recentRecordId: url.includes('dup-recent') ? 'rw_rec_001' : null,
      recentCreatedAt: url.includes('dup-recent') ? '2026-11-17T08:30:00.000Z' : null,
      warning: url.includes('dup-recent') ? '该链接在 24 小时内已成功复刻过' : null,
    })),
    createSingle: vi.fn(async (payload) => {
      submitted.push(payload);
      const created = makeRecord({
        id: `rw_new_${submitted.length}`,
        url: payload.url || 'paste://manual',
        pastedText: payload.pastedText,
        newTitle: '复刻生成的新文章标题测试稿',
        articleStatus: payload.resultStatus,
        categoryName: payload.categoryId
          ? '爆文复刻-20261117-0900'
          : payload.autoCategoryName || '爆文复刻-自动分类',
      });
      records.unshift(created);
      return {
        record: created,
        duplicateRecentWarning: null,
        settledPoints: 5,
      };
    }),
    bulkStatus: vi.fn(async ({ ids }) => ({ affected: ids.length })),
    bulkDelete: vi.fn(async (ids) => ({ affected: ids.length })),
    deleteOne: vi.fn(async () => ({ affected: 1 })),
    downloadTable: vi.fn(async () => ({
      filename: 'geomix-rewrites.csv',
      mime: 'text/csv',
      body: new Uint8Array([1, 2, 3]),
    })),
    loadFormOptions: vi.fn(async () => makeOptions()),
  };
  return { gateway, submitted };
}

describe('RewriteSingleScreen', () => {
  afterEach(() => {
    cleanup();
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
  });

  it('renders status & high-similarity tags, checks 24h duplicate URL, and submits URL mode with editable timestamped category', async () => {
    const dispatched: ShellAction[] = [];
    const { gateway, submitted } = makeGateway([
      makeRecord({ highSimilarity: true, similarity: 0.42 }),
      makeRecord({
        id: 'rw_failed_002',
        url: 'https://zhuanlan.zhihu.com/p/blocked',
        sourceTitle: '反爬受限文章',
        newTitle: null,
        status: 'FAILED',
        error: '目标页面需登录验证或不允许直接抓取（本次未扣点数）',
        articleId: null,
        articleStatus: null,
      }),
    ]);

    render(
      <RewriteSingleScreen
        title="单篇爆文复刻"
        tabId="tab_rw_single"
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('围绕工业传感器选型的落地评估与执行核对指南')).toBeTruthy();
    });
    expect(screen.getByText(/重合度偏高/)).toBeTruthy();
    expect(screen.getByText('文章·待审核')).toBeTruthy();
    expect(screen.getByText(/目标页面需登录验证/)).toBeTruthy();

    // Clicking 查看文章 dispatches navigation to /writing/articles?categoryId=...
    fireEvent.click(findButton('查看文章'));
    expect(dispatched[0]).toEqual({
      type: 'open',
      href: '/writing/articles?categoryId=cat_rw_001',
      sourceId: 'tab_rw_single',
    });

    // Open create modal
    fireEvent.click(findButton('新建单篇复刻'));
    await waitFor(() => {
      expect(screen.getByLabelText('文章链接')).toBeTruthy();
    });

    // Both gallery and rewrite prompt dropdowns default to empty ("不选择") (#95)
    const gallerySelect = screen.getByLabelText('文章配图图库') as HTMLSelectElement;
    const templateSelect = screen.getByLabelText('爆文改写指令') as HTMLSelectElement;
    expect(gallerySelect.value).toBe('');
    expect(gallerySelect.options[0]?.textContent).toBe('不选择');
    expect(templateSelect.value).toBe('');
    expect(templateSelect.options[0]?.textContent).toBe('不选择');

    // Editable auto-category input defaults to "爆文复刻" and is editable
    const autoCatInput = screen.getByLabelText('新建分类名称') as HTMLInputElement;
    expect(autoCatInput.value).toBe('爆文复刻');
    fireEvent.change(autoCatInput, { target: { value: '爆文复刻-20261117-传感器专题' } });

    // Enter URL and trigger blur duplicate check
    const urlInput = screen.getByLabelText('文章链接');
    fireEvent.change(urlInput, {
      target: { value: 'https://news.example.org/dup-recent-article' },
    });
    fireEvent.blur(urlInput);
    await waitFor(() => {
      expect(screen.getByText(/24 小时内已成功复刻过/)).toBeTruthy();
    });

    // Submitting without choosing gallery/template validates cleanly
    fireEvent.click(findButton('复刻文章（5点数/篇）'));
    await waitFor(() => {
      expect(screen.getByText('请选择文章配图的企业画像图库分类')).toBeTruthy();
    });
    fireEvent.change(gallerySelect, { target: { value: 'mcat_001' } });

    fireEvent.click(findButton('复刻文章（5点数/篇）'));
    await waitFor(() => {
      expect(screen.getByText('请选择爆文改写指令')).toBeTruthy();
    });
    fireEvent.change(templateSelect, { target: { value: 'sys_rewrite_01' } });

    fireEvent.change(screen.getByLabelText('融入品牌词'), { target: { value: '精测工控' } });
    fireEvent.click(findButton('复刻文章（5点数/篇）'));

    await waitFor(() => {
      expect(submitted.length).toBe(1);
    });
    expect(submitted[0]).toMatchObject({
      pastedText: false,
      url: 'https://news.example.org/dup-recent-article',
      mediaCategoryId: 'mcat_001',
      imageCount: 2,
      templateId: 'sys_rewrite_01',
      categoryId: null,
      autoCategoryName: '爆文复刻-20261117-传感器专题',
      resultStatus: 'PENDING',
      brand: '精测工控',
    });
  });

  it('opens pastedText fallback from failed row action and enforces >= 200 char minimum before submitting', async () => {
    const { gateway, submitted } = makeGateway([
      makeRecord({
        id: 'rw_failed_002',
        url: 'https://zhuanlan.zhihu.com/p/blocked',
        sourceTitle: '反爬受限文章',
        newTitle: null,
        status: 'FAILED',
        error: '无法公开访问',
        articleId: null,
        articleStatus: null,
      }),
    ]);

    render(<RewriteSingleScreen title="单篇爆文复刻" gateway={gateway} />);

    await waitFor(() => {
      expect(findButton('粘贴原文重试')).toBeTruthy();
    });
    fireEvent.click(findButton('粘贴原文重试'));

    const pasteArea = await screen.findByLabelText('粘贴原文正文');
    fireEvent.change(pasteArea, { target: { value: '太短的正文内容不足两百字' } });
    fireEvent.click(findButton('复刻文章（5点数/篇）'));

    await waitFor(() => {
      expect(screen.getByText(/粘贴原文有效正文不足 200 字/)).toBeTruthy();
    });
    expect(submitted.length).toBe(0);

    fireEvent.change(pasteArea, {
      target: {
        value:
          '这是一段用于验证粘贴原文兜底通道的完整技术文章正文，涵盖现场工况评估、接口选型对比、周期巡检标准与异常处理闭环流程。'.repeat(
            5,
          ),
      },
    });
    fireEvent.click(findButton('复刻文章（5点数/篇）'));

    await waitFor(() => {
      expect(submitted.length).toBe(1);
    });
    expect(submitted[0]?.pastedText).toBe(true);
    expect(submitted[0]?.url).toBe('https://zhuanlan.zhihu.com/p/blocked');
  });

  it('allows 0-image submission without gallery, navigates cleanly from 前往上传配图 / 管理指令 / 管理分类, and refreshes existing categories', async () => {
    const dispatched: ShellAction[] = [];
    const { gateway, submitted } = makeGateway([]);
    let optionsCall = 0;
    gateway.loadFormOptions = vi.fn(async () => {
      optionsCall += 1;
      return {
        ...makeOptions(),
        categories:
          optionsCall >= 2
            ? [
                {
                  id: 'cat_existing_01',
                  name: '已有客户案例分类',
                  total: 3,
                  remaining: 3,
                  createdAt: '2026-11-17T08:00:00.000Z',
                },
              ]
            : [],
        mediaCategories: [],
      };
    });

    const { rerender } = render(
      <RewriteSingleScreen
        title="单篇爆文复刻"
        tabId="/rewrite/single"
        active
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );

    await waitFor(() => {
      expect(findButton('新建单篇复刻')).toBeTruthy();
    });

    // Simulate switching away and back -> refreshes form options
    rerender(
      <RewriteSingleScreen
        title="单篇爆文复刻"
        tabId="/rewrite/single"
        active={false}
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );
    rerender(
      <RewriteSingleScreen
        title="单篇爆文复刻"
        tabId="/rewrite/single"
        active
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );

    fireEvent.click(findButton('新建单篇复刻'));
    await waitFor(() => {
      expect(screen.getByLabelText('文章链接')).toBeTruthy();
    });

    // Submit button is NOT disabled when no usable gallery exists, and existing category appears
    const submitBtn = findButton('复刻文章（5点数/篇）');
    expect(submitBtn.disabled).toBe(false);
    const categorySelect = screen.getByLabelText('归属文章分类') as HTMLSelectElement;
    expect(
      Array.from(categorySelect.options).some((o) => o.textContent === '已有客户案例分类'),
    ).toBe(true);

    // Submit directly with 0 images
    fireEvent.change(screen.getByLabelText('文章链接'), {
      target: { value: 'https://news.example.org/no-image-article' },
    });
    fireEvent.change(screen.getByLabelText('爆文改写指令'), {
      target: { value: 'sys_rewrite_01' },
    });
    fireEvent.change(categorySelect, { target: { value: 'cat_existing_01' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(submitted.length).toBe(1);
    });
    expect(submitted[0]).toMatchObject({
      mediaCategoryId: null,
      imageCount: 0,
      categoryId: 'cat_existing_01',
    });

    // Re-open modal and verify 前往上传配图, 管理指令, and 管理分类 dispatch without blocking
    fireEvent.click(findButton('新建单篇复刻'));
    await waitFor(() => {
      expect(findButton('前往上传配图')).toBeTruthy();
    });
    fireEvent.click(findButton('前往上传配图'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/material/gallery',
      sourceId: '/rewrite/single',
    });

    fireEvent.click(findButton('新建单篇复刻'));
    await waitFor(() => {
      expect(findButton('管理指令')).toBeTruthy();
    });
    expect(screen.getByText('生成后文章状态')).toBeTruthy();
    expect(screen.getByText('自然融入品牌词（选填）')).toBeTruthy();
    expect(screen.getByPlaceholderText('选填：重组时自然提及，不替换原文推荐品牌')).toBeTruthy();

    fireEvent.click(findButton('管理指令'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/writing/prompts',
      sourceId: '/rewrite/single',
    });
  });

  it('syncs browser URL to /rewrite/single immediately when tab becomes active (#176)', async () => {
    window.history.replaceState(null, '', '/rewrite/batch');
    const { gateway } = makeGateway([]);

    const { rerender } = render(
      <RewriteSingleScreen
        title="全网爆文复刻"
        tabId="/rewrite/single"
        active={false}
        gateway={gateway}
      />,
    );
    expect(window.location.pathname).toBe('/rewrite/batch');

    rerender(
      <RewriteSingleScreen title="全网爆文复刻" tabId="/rewrite/single" active gateway={gateway} />,
    );
    await waitFor(() => {
      expect(window.location.pathname).toBe('/rewrite/single');
    });
  });
});
