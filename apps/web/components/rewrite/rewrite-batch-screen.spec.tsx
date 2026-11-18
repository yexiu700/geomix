// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  type RewriteBatchCreateInput,
  type RewriteBatchDetailResponse,
  type RewriteBatchItem,
  type RewriteRecordItem,
} from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewriteBatchFormOptions, RewriteBatchGateway } from '../../lib/rewrite-batches';
import type { ShellAction } from '../../lib/tab-stack';
import { RewriteBatchScreen } from './rewrite-batch-screen';

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

function makeBatch(overrides: Partial<RewriteBatchItem> = {}): RewriteBatchItem {
  return {
    id: 'rwb_001',
    name: '五链一败批量复刻验收',
    keyword: '数控激光切割机',
    sourceType: 'link_list',
    maxCount: 5,
    doneCount: 4,
    candidateCount: 5,
    failedOrSkippedCount: 1,
    categoryId: 'cat_rwb_001',
    categoryName: '批量复刻-20261117-1000',
    mediaCategoryId: 'mcat_001',
    mediaCategoryName: '产线实拍图库',
    templateId: 'sys_rewrite_01',
    templateName: '系统·参考重写',
    status: 'PARTIAL',
    note: '完成 4/5 篇（实结 20 点，差额退还 5 点；1 条候选跳过或抓取失败未计费）',
    unitPoints: 5,
    reservedPoints: 25,
    settledPoints: 20,
    releasedPoints: 5,
    createdAt: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RewriteRecordItem> = {}): RewriteRecordItem {
  return {
    id: 'rw_rec_b1',
    batchId: 'rwb_001',
    url: 'https://news.example.org/laser-guide-1',
    urlHash: 'hash_b1',
    pastedText: false,
    sourceTitle: '激光切割头维护工艺实务',
    newTitle: '围绕激光切割头维护工艺的现场评估与执行核对指南',
    categoryId: 'cat_rwb_001',
    categoryName: '批量复刻-20261117-1000',
    mediaCategoryId: 'mcat_001',
    mediaCategoryName: '产线实拍图库',
    templateId: 'sys_rewrite_01',
    templateName: '系统·参考重写',
    status: 'SUCCESS',
    error: null,
    similarity: 0.12,
    highSimilarity: false,
    articleId: 'art_rwb_1',
    articleStatus: 'PENDING',
    rewrittenAt: '2026-11-17T10:00:12.000Z',
    createdAt: '2026-11-17T10:00:01.000Z',
    ...overrides,
  };
}

function makeOptions(): RewriteBatchFormOptions {
  return {
    unitPoints: 5,
    remoteSearchEnabled: false,
    categories: [
      {
        id: 'cat_rwb_001',
        name: '批量复刻-20261117-1000',
        total: 4,
        remaining: 4,
        createdAt: '2026-11-17T09:00:00.000Z',
      },
    ],
    mediaCategories: [
      {
        id: 'mcat_001',
        name: '产线实拍图库',
        type: 1,
        assetCount: 6,
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

function makeGateway(
  batches: RewriteBatchItem[],
  recordsByBatch: Record<string, RewriteRecordItem[]> = {},
): {
  gateway: RewriteBatchGateway;
  submitted: RewriteBatchCreateInput[];
} {
  const submitted: RewriteBatchCreateInput[] = [];
  const gateway: RewriteBatchGateway = {
    list: vi.fn(async (query) => ({
      page: query.page,
      pageSize: query.pageSize,
      total: batches.length,
      unitPoints: 5,
      remoteSearchEnabled: false,
      items: batches,
    })),
    detail: vi.fn(async (id): Promise<RewriteBatchDetailResponse> => {
      const batch = batches.find((b) => b.id === id) ?? makeBatch({ id });
      return {
        batch,
        records: recordsByBatch[id] ?? [
          makeRecord({ id: 'rw_rec_b1', batchId: id }),
          makeRecord({
            id: 'rw_rec_b2',
            batchId: id,
            url: 'https://news.example.org/blocked-page',
            sourceTitle: null,
            newTitle: null,
            articleId: null,
            articleStatus: null,
            similarity: null,
            status: 'SKIPPED',
            error: '目标站点拒绝访问（HTTP 403）',
          }),
        ],
      };
    }),
    create: vi.fn(async (payload) => {
      submitted.push(payload);
      const created = makeBatch({
        id: `rwb_new_${submitted.length}`,
        name: payload.name,
        maxCount: payload.maxCount,
        doneCount: 0,
        candidateCount: 3,
        status: 'QUEUED',
        reservedPoints: payload.maxCount * 5,
        settledPoints: 0,
        releasedPoints: 0,
        note: `任务已入队，预冻结 ${payload.maxCount * 5} 点数（5 点/篇）`,
      });
      batches.unshift(created);
      return { batch: created, records: [] };
    }),
    pause: vi.fn(async (id) => makeBatch({ id, status: 'PAUSED' })),
    resume: vi.fn(async (id) => makeBatch({ id, status: 'QUEUED' })),
    cancel: vi.fn(async (id) => makeBatch({ id, status: 'CANCELLED', releasedPoints: 15 })),
    deleteOne: vi.fn(async () => ({ affected: 1 })),
    bulkDelete: vi.fn(async (ids) => ({ affected: ids.length })),
    downloadTable: vi.fn(async (_q, format) => ({
      filename: `geomix-rewrite-batches.${format}`,
      mime: 'text/csv',
      body: new Uint8Array([1, 2, 3]),
    })),
    loadFormOptions: vi.fn(async () => makeOptions()),
  };
  return { gateway, submitted };
}

describe('RewriteBatchScreen', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders batch list with point settlement/refund summary and opens the 查看任务 drawer with candidate details', async () => {
    const dispatched: ShellAction[] = [];
    const { gateway } = makeGateway([makeBatch()]);

    render(
      <RewriteBatchScreen
        title="批量爆文复刻"
        tabId="tab_rwb"
        pollIntervalMs={0}
        gateway={gateway}
        onDispatch={(act) => dispatched.push(act)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('五链一败批量复刻验收')).toBeTruthy();
    });
    expect(screen.getByText(/预冻 25 · 已结 20 · 已退 5/)).toBeTruthy();

    fireEvent.click(findButton('查看任务 (5)'));

    await waitFor(() => {
      expect(screen.getByText(/查看任务明细 · 五链一败批量复刻验收/)).toBeTruthy();
      expect(screen.getByText('围绕激光切割头维护工艺的现场评估与执行核对指南')).toBeTruthy();
      expect(screen.getByText('目标站点拒绝访问（HTTP 403）')).toBeTruthy();
    });

    fireEvent.click(findButton('查看文章'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/writing/articles?categoryId=cat_rwb_001',
      sourceId: 'tab_rwb',
    });
  });

  it('displays upfront reserve pricing, rejects URLs typed into keyword search mode, validates SSRF/bad URLs, and submits valid link_list', async () => {
    const { gateway, submitted } = makeGateway([]);

    render(<RewriteBatchScreen title="批量爆文复刻" pollIntervalMs={0} gateway={gateway} />);

    await waitFor(() => {
      expect(findButton('新建批量复刻')).toBeTruthy();
    });

    fireEvent.click(findButton('新建批量复刻'));

    await waitFor(() => {
      expect(screen.getByText('新建批量爆文复刻任务')).toBeTruthy();
      expect(findButton('开始批量复刻（5点数/篇，预冻5点）')).toBeTruthy();
    });

    // Baseline defaults (#76): maxCount = 1, gallery & rewrite prompt unselected ('不选择')
    expect((screen.getByLabelText('最大改写量') as HTMLInputElement).value).toBe('1');
    const gallerySelect = screen.getByLabelText('文章配图图库分类') as HTMLSelectElement;
    const promptSelect = screen.getByLabelText('爆文改写指令') as HTMLSelectElement;
    expect(gallerySelect.value).toBe('');
    expect(promptSelect.value).toBe('');

    // Switch to keyword search mode and enter a URL -> immediately warns that it's a link, not a keyword!
    const remoteRadio = screen.getByDisplayValue('remote');
    fireEvent.click(remoteRadio);

    const kwInput = screen.getByLabelText('流量关键词');
    fireEvent.change(kwInput, {
      target: { value: 'https://mp.weixin.qq.com/s/mistaken-as-keyword' },
    });

    await waitFor(() => {
      expect(screen.getByText(REWRITE_BATCH_URL_AS_KEYWORD_MSG)).toBeTruthy();
    });

    const nameInput = screen.getByLabelText('任务名称');
    fireEvent.change(nameInput, { target: { value: '激光技术干货复刻批次' } });

    fireEvent.click(findButton('开始批量复刻（5点数/篇，预冻5点）'));
    expect(submitted).toHaveLength(0);

    // Switch back to link_list mode and submit 3 valid public URLs with maxCount = 3 (预冻 15 点)
    const linkListRadio = screen.getByDisplayValue('link_list');
    fireEvent.click(linkListRadio);

    fireEvent.change(screen.getByLabelText('主题标签'), {
      target: { value: '激光焊接工艺' },
    });

    const maxCountInput = screen.getByLabelText('最大改写量');
    fireEvent.change(maxCountInput, { target: { value: '3' } });

    await waitFor(() => {
      expect(findButton('开始批量复刻（5点数/篇，预冻15点）')).toBeTruthy();
    });

    const linksArea = screen.getByLabelText('公开文章链接清单');
    fireEvent.change(linksArea, {
      target: {
        value: [
          'https://news.example.org/post-1',
          'https://news.example.org/post-2',
          'https://news.example.org/post-3',
        ].join('\n'),
      },
    });

    // Submitting before selecting gallery/template is blocked
    fireEvent.click(findButton('开始批量复刻（5点数/篇，预冻15点）'));
    expect(submitted).toHaveLength(0);

    fireEvent.change(gallerySelect, { target: { value: 'mcat_001' } });
    fireEvent.change(promptSelect, { target: { value: 'sys_rewrite_01' } });

    fireEvent.click(findButton('开始批量复刻（5点数/篇，预冻15点）'));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toMatchObject({
      name: '激光技术干货复刻批次',
      maxCount: 3,
      sourceType: 'link_list',
      keyword: '激光焊接工艺',
      mediaCategoryId: 'mcat_001',
      templateId: 'sys_rewrite_01',
    });
  });

  it('navigates cleanly on 管理图库 / 管理指令 / 管理分类 without unsaved confirm, loads existing categories, and supports 0-image submission when gallery is empty', async () => {
    const dispatched: ShellAction[] = [];
    const { gateway, submitted } = makeGateway([]);
    gateway.loadFormOptions = vi.fn(async () => ({
      ...makeOptions(),
      categories: [
        {
          id: 'cat_existing_b1',
          name: '已有批量专栏分类',
          total: 5,
          remaining: 2,
          createdAt: '2026-11-17T08:00:00.000Z',
        },
      ],
      mediaCategories: [],
    }));

    render(
      <RewriteBatchScreen
        title="批量爆文复刻"
        tabId="/rewrite/batch"
        pollIntervalMs={0}
        gateway={gateway}
        onDispatch={(act) => dispatched.push(act)}
      />,
    );

    await waitFor(() => {
      expect(findButton('新建批量复刻')).toBeTruthy();
    });

    fireEvent.click(findButton('新建批量复刻'));
    await waitFor(() => {
      expect(screen.getByText('新建批量爆文复刻任务')).toBeTruthy();
    });

    // Make draft dirty, then click 管理指令 -> navigates directly without triggering unsaved confirm
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '草稿测试' } });
    fireEvent.click(findButton('管理指令'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/writing/prompts',
      sourceId: '/rewrite/batch',
    });
    expect(screen.queryByText('放弃未提交的批量复刻草稿？')).toBeNull();

    // Reopen and verify 管理图库 & 管理分类 & 0-image submission with existing category
    fireEvent.click(findButton('新建批量复刻'));
    await waitFor(() => {
      expect(findButton('管理图库')).toBeTruthy();
    });
    fireEvent.click(findButton('管理图库'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/material/gallery',
      sourceId: '/rewrite/batch',
    });

    fireEvent.click(findButton('新建批量复刻'));
    await waitFor(() => {
      expect(findButton('管理分类')).toBeTruthy();
    });
    fireEvent.click(findButton('管理分类'));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/writing/categories',
      sourceId: '/rewrite/batch',
    });

    fireEvent.click(findButton('新建批量复刻'));
    await waitFor(() => {
      expect(screen.getByLabelText('归档文章分类')).toBeTruthy();
    });

    // Empty submit triggers unified synchronous validation in ONE place (CrudModal footer only, no duplicate top alert)
    fireEvent.click(findButton('开始批量复刻（5点数/篇，预冻5点）'));
    await waitFor(() => {
      const errNodes = screen.getAllByText(/请填写任务名称/);
      expect(errNodes).toHaveLength(1);
      expect(errNodes[0]?.textContent).toContain('请至少粘贴 1 条公开文章链接');
      expect(errNodes[0]?.textContent).toContain('请选择爆文改写指令');
    });

    // Malformed URL shows Chinese message instead of raw JS TypeError
    fireEvent.change(screen.getByLabelText('公开文章链接清单'), {
      target: { value: 'not-a-valid-url' },
    });
    await waitFor(() => {
      expect(screen.getByText(/第 1 行：链接格式不正确/)).toBeTruthy();
      expect(screen.queryByText(/Failed to construct/)).toBeNull();
    });

    const catSelect = screen.getByLabelText('归档文章分类') as HTMLSelectElement;
    expect(Array.from(catSelect.options).some((o) => o.textContent === '已有批量专栏分类')).toBe(
      true,
    );
    fireEvent.change(catSelect, { target: { value: 'cat_existing_b1' } });
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '无图批量复刻测试' } });
    fireEvent.change(screen.getByLabelText('公开文章链接清单'), {
      target: { value: 'https://news.example.org/no-img-1' },
    });
    fireEvent.change(screen.getByLabelText('爆文改写指令'), {
      target: { value: 'sys_rewrite_01' },
    });

    fireEvent.click(findButton('开始批量复刻（5点数/篇，预冻5点）'));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toMatchObject({
      name: '无图批量复刻测试',
      mediaCategoryId: null,
      categoryId: 'cat_existing_b1',
      templateId: 'sys_rewrite_01',
    });
  });
});
