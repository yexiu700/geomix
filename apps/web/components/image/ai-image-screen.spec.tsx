// @vitest-environment jsdom

import { AI_IMAGE_RATIOS, type AiImageCreateInput, type AiImageJobItem } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metadata as imagePageMetadata } from '../../app/(console)/image/page';
import type { AiImageGateway } from '../../lib/ai-images';
import type { AccountProfile } from '../../lib/api';
import { initialSnapshot } from '../../lib/tab-stack';
import { ShellFrame } from '../shell/shell-frame';
import { AiImageScreen } from './ai-image-screen';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createSampleJob(): AiImageJobItem {
  return {
    id: 'img_demo_001',
    orderNo: 'IMG20261117-001ABC',
    prompt: '现代极简商业办公空间全景，自然柔和窗光，清晰产品陈列质感',
    style: '商务科技',
    ratio: '16:9',
    count: 2,
    successCount: 2,
    refAssetId: null,
    saveCategoryId: null,
    saveCategoryName: null,
    status: 'COMPLETED',
    error: null,
    model: 'fake-image',
    unitPoints: 5,
    reservedPoints: 10,
    settledPoints: 10,
    releasedPoints: 0,
    createdAt: '2026-11-17T08:30:00.000Z',
    assets: [
      {
        id: 'med_ai_001_1',
        categoryId: null,
        categoryName: null,
        url: '/api/v1/media-assets/med_ai_001_1/file?tid=t1&sig=aaaa',
        thumbUrl: '/api/v1/media-assets/med_ai_001_1/thumb?tid=t1&sig=bbbb',
        width: 1280,
        height: 720,
        bytes: 42000,
        usedCount: 0,
        createdAt: '2026-11-17T08:30:02.000Z',
      },
      {
        id: 'med_ai_001_2',
        categoryId: null,
        categoryName: null,
        url: '/api/v1/media-assets/med_ai_001_2/file?tid=t1&sig=cccc',
        thumbUrl: '/api/v1/media-assets/med_ai_001_2/thumb?tid=t1&sig=dddd',
        width: 1280,
        height: 720,
        bytes: 41500,
        usedCount: 0,
        createdAt: '2026-11-17T08:30:02.000Z',
      },
    ],
  };
}

function buildMockGateway(initialJobs: AiImageJobItem[] = [createSampleJob()]) {
  const jobs: AiImageJobItem[] = [...initialJobs];
  const createdPayloads: AiImageCreateInput[] = [];
  const savedCalls: Array<{ id: string; categoryId: string }> = [];

  const gateway: AiImageGateway = {
    async list(query) {
      return {
        page: query.page,
        pageSize: query.pageSize,
        total: jobs.length,
        unitPoints: 5,
        featureEnabled: true,
        items: [...jobs],
      };
    },
    async detail(id) {
      return jobs.find((j) => j.id === id) ?? jobs[0]!;
    },
    async optimizePrompt(input) {
      return {
        optimizedPrompt: `商务科技风格，${input.prompt}，柔和自然工业照明与整洁空间层次构图`,
      };
    },
    async create(input) {
      createdPayloads.push(input);
      const next: AiImageJobItem = {
        ...createSampleJob(),
        id: 'img_demo_002',
        orderNo: 'IMG20261117-002DEF',
        prompt: input.prompt,
        ratio: input.ratio ?? '16:9',
        style: input.style ?? '写实摄影',
        count: input.count ?? 2,
        reservedPoints: (input.count ?? 2) * 5,
        settledPoints: 0,
        status: 'QUEUED',
        assets: [],
      };
      jobs.unshift(next);
      return next;
    },
    async saveToGallery(id, input) {
      savedCalls.push({ id, categoryId: input.categoryId });
      const target = jobs.find((j) => j.id === id)!;
      target.saveCategoryId = input.categoryId;
      target.saveCategoryName = '产品实景图库';
      return {
        savedCount: target.assets.length,
        categoryId: input.categoryId,
        categoryName: '产品实景图库',
        job: { ...target },
      };
    },
    async deleteOne() {
      return { deletedCount: 1 };
    },
    async bulkDelete(ids) {
      return { deletedCount: ids.length };
    },
    async downloadTable() {
      return {
        filename: 'geomix-ai-images.csv',
        mime: 'text/csv',
        body: new Uint8Array([1, 2, 3]),
      };
    },
    async loadFormOptions() {
      return {
        mediaCategories: [
          {
            id: 'mcat_01',
            name: '产品实景图库',
            type: 1,
            assetCount: 4,
            previewAssets: [],
            createdAt: '2026-11-17T00:00:00.000Z',
          },
        ],
        galleryAssets: [],
        keywords: [
          {
            id: 'kw_01',
            main: '企业数字化展厅',
            brands: ['智造品牌'],
            optStatus: 'NONE',
            questionCount: 5,
            createdAt: '2026-11-17T00:00:00.000Z',
          },
        ],
        knowledgeBases: [],
        unitPoints: 5,
      };
    },
  };

  return { gateway, createdPayloads, savedCalls };
}

describe('AiImageScreen', () => {
  it('renders upfront pricing, all 9 aspect ratios (default 16:9), clean copy/placeholder, free prompt optimization, and create flow (#183)', async () => {
    const { gateway, createdPayloads } = buildMockGateway();

    render(<AiImageScreen title="AI生图" gateway={gateway} pollIntervalMs={0} />);

    await screen.findByText('IMG20261117-001ABC');
    expect(screen.getByText('实结 10 点')).toBeTruthy();

    // No internal engineering jargon anywhere on screen
    expect(document.body.textContent).not.toMatch(/零拷贝|抽用|影子计费/);

    // Unified toolbar & filter labels (#182)
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '列' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清空' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出' })).toBeTruthy();
    expect(screen.queryByText('收起搜索')).toBeNull();
    expect(screen.queryByText('列显示 ▾')).toBeNull();
    expect(screen.queryByText('重置筛选')).toBeNull();

    // Open create modal
    fireEvent.click(screen.getByLabelText('添加'));
    await screen.findByText('添加 AI 生图任务');

    // Has cancel button and closes on Escape (#182)
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('添加 AI 生图任务')).toBeNull();

    // Reopen modal for full creation check
    fireEvent.click(screen.getByLabelText('添加'));
    await screen.findByText('添加 AI 生图任务');

    // No jargon or laser placeholder inside create modal (#183)
    expect(document.body.textContent).not.toMatch(/零拷贝|抽用|影子计费/);
    const promptBox = screen.getByLabelText('画面提示词') as HTMLTextAreaElement;
    expect(promptBox.placeholder).not.toContain('激光切割');

    // Upfront price banner + dynamic submit button default to 1张 / 5点 (#93)
    expect(screen.getByTestId('ai-image-price-banner').textContent).toContain(
      '单价 5 点数/张 × 生成 1 张 ＝ 合计预冻结 5 点数',
    );
    expect(screen.getByText('生成图片（5点数/张，合计预冻 5 点）')).toBeTruthy();
    const defaultCountBtn = screen.getByText('1 张（5 点）').closest('button')!;
    expect(defaultCountBtn.getAttribute('aria-checked')).toBe('true');

    // Verify all 9 aspect ratios exist and 16:9 is selected by default (#183)
    expect(screen.getByText(/^图片比例（默认 16:9）/)).toBeTruthy();
    for (const ratio of AI_IMAGE_RATIOS) {
      expect(screen.getByText(new RegExp(`^${ratio}\\s`))).toBeTruthy();
    }
    const defaultRatioBtn = screen.getByText(/^16:9\s/).closest('button')!;
    expect(defaultRatioBtn.getAttribute('aria-checked')).toBe('true');

    // Switch count to 4 -> button updates to 20 points
    fireEvent.click(screen.getByText('4 张（20 点）'));
    expect(screen.getByText('生成图片（5点数/张，合计预冻 20 点）')).toBeTruthy();

    // Enter base prompt and click free AI optimize
    fireEvent.change(promptBox, { target: { value: '极简现代办公桌面产品陈列' } });
    fireEvent.click(screen.getByText('AI 优化提示词（免费）'));

    await waitFor(() => {
      expect(promptBox.value).toContain('极简现代办公桌面产品陈列');
      expect(promptBox.value).toContain('工业照明');
    });

    // Submit form
    fireEvent.click(screen.getByText('生成图片（5点数/张，合计预冻 20 点）'));

    await waitFor(() => {
      expect(createdPayloads).toHaveLength(1);
    });
    expect(createdPayloads[0]).toMatchObject({
      ratio: '16:9',
      count: 4,
    });
  });

  it('supports Save to Gallery flow without duplicating storage (#183)', async () => {
    const { gateway, savedCalls } = buildMockGateway();

    render(<AiImageScreen title="AI生图" gateway={gateway} pollIntervalMs={0} />);

    await screen.findByText('IMG20261117-001ABC');

    fireEvent.click(screen.getByText('存入图库'));
    await screen.findByText('存入企业画像图库');
    fireEvent.click(screen.getByText('确认存入'));

    await waitFor(() => {
      expect(savedCalls).toEqual([{ id: 'img_demo_001', categoryId: 'mcat_01' }]);
    });
  });

  it('provides explicit export feedback on empty/success/error states and shows preview loading skeleton until image loads (#181)', async () => {
    const warnSpy = vi
      .spyOn(message, 'warning')
      .mockImplementation(() => (() => undefined) as never);
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation(() => (() => undefined) as never);
    const successSpy = vi
      .spyOn(message, 'success')
      .mockImplementation(() => (() => undefined) as never);

    // 1. Empty table -> clicking 导出 warns explicitly instead of failing silently
    const emptyGw = buildMockGateway([]);
    const { unmount } = render(
      <AiImageScreen title="AI生图" gateway={emptyGw.gateway} pollIntervalMs={0} />,
    );
    await screen.findByText('没有找到匹配的记录');
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    expect(warnSpy).toHaveBeenCalledWith('当前列表暂无可导出数据');
    unmount();

    // 2. Non-empty table -> export error does NOT falsely notify success, and export success calls onDownload
    const { gateway } = buildMockGateway();
    const downloadSpy = vi.fn();
    vi.spyOn(gateway, 'downloadTable')
      .mockRejectedValueOnce(new Error('导出服务暂不可用'))
      .mockResolvedValueOnce({
        filename: 'geomix-ai-images.csv',
        mime: 'text/csv',
        body: new Uint8Array([1, 2, 3]),
      });

    render(
      <AiImageScreen
        title="AI生图"
        gateway={gateway}
        pollIntervalMs={0}
        onDownload={downloadSpy}
      />,
    );

    await screen.findByText('IMG20261117-001ABC');

    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    fireEvent.click(await screen.findByText('CSV'));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('导出服务暂不可用');
    });
    expect(successSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    fireEvent.click(await screen.findByText('CSV'));

    await waitFor(() => {
      expect(downloadSpy).toHaveBeenCalledTimes(1);
    });
    expect(successSpy).toHaveBeenCalledWith('已开始导出 CSV 文件');

    // 3. Preview modal shows loading skeleton/spinner before image loads, hides on load, shows error fallback on failure, and closes on Escape
    fireEvent.click(screen.getByRole('button', { name: '预览图片 IMG20261117-001ABC-1' }));
    await screen.findByTestId('ai-image-preview-loading');
    expect(screen.getByText('正在加载原图…')).toBeTruthy();

    const previewImg = document.querySelector(
      '.ant-modal img[alt="IMG20261117-001ABC"]',
    ) as HTMLImageElement | null;
    expect(previewImg).not.toBeNull();
    fireEvent.load(previewImg!);

    await waitFor(() => {
      expect(screen.queryByTestId('ai-image-preview-loading')).toBeNull();
    });

    fireEvent.error(previewImg!);
    await screen.findByTestId('ai-image-preview-error');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();

    const previewDialog = screen.getByRole('dialog');
    fireEvent.keyDown(previewDialog, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('converges sidebar menu to AI生图, exposes route metadata title, and hides menu when account.features.aiImage is false (#182)', () => {
    expect(imagePageMetadata.title).toBe('AI生图 · GeoMix');

    const baseAccount: AccountProfile = {
      id: 'u_1',
      username: 'merchant1',
      nickname: '商户一',
      role: 'MERCHANT',
      features: { aiImage: true },
      tenant: {
        id: 't_1',
        name: '测试企业',
        expiresAt: '2027-12-31T00:00:00.000Z',
        isActive: true,
        readOnly: false,
      },
    };

    const { rerender } = render(
      <ShellFrame
        account={baseAccount}
        state={initialSnapshot()}
        onDispatch={() => undefined}
        onLogout={() => undefined}
        onChangePassword={async () => null}
      />,
    );
    const sider = document.querySelector<HTMLElement>('.gm-sider')!;
    expect(within(sider).queryByText(/\/视频/)).toBeNull();
    expect(within(sider).getByText('AI生图')).toBeTruthy();

    rerender(
      <ShellFrame
        account={{ ...baseAccount, features: { aiImage: false } }}
        state={initialSnapshot()}
        onDispatch={() => undefined}
        onLogout={() => undefined}
        onChangePassword={async () => null}
      />,
    );
    expect(within(sider).queryByText('AI生图')).toBeNull();
  });
});
