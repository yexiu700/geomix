// @vitest-environment jsdom

import { AI_IMAGE_RATIOS, type AiImageCreateInput, type AiImageJobItem } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiImageGateway } from '../../lib/ai-images';
import type { AccountProfile } from '../../lib/api';
import { initialSnapshot } from '../../lib/tab-stack';
import { ShellFrame } from '../shell/shell-frame';
import { AiImageScreen } from './ai-image-screen';

beforeAll(() => {
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
});

function createSampleJob(): AiImageJobItem {
  return {
    id: 'img_demo_001',
    orderNo: 'IMG20261117-001ABC',
    prompt: '现代自动化激光加工车间全景，自然柔和光线，工业科技质感',
    style: '商务科技',
    ratio: '21:9',
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
        width: 1260,
        height: 540,
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
        width: 1260,
        height: 540,
        bytes: 41500,
        usedCount: 0,
        createdAt: '2026-11-17T08:30:02.000Z',
      },
    ],
  };
}

function buildMockGateway() {
  const jobs: AiImageJobItem[] = [createSampleJob()];
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
        ratio: input.ratio ?? '21:9',
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
      target.saveCategoryName = '车间实景图库';
      return {
        savedCount: target.assets.length,
        categoryId: input.categoryId,
        categoryName: '车间实景图库',
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
            name: '车间实景图库',
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
            main: '数控激光切割机',
            brands: ['智造激光'],
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
  it('renders upfront freeze pricing, all 9 aspect ratios (default 21:9), free prompt optimization, and create flow', async () => {
    const { gateway, createdPayloads } = buildMockGateway();

    render(<AiImageScreen title="AI生图" gateway={gateway} pollIntervalMs={0} />);

    await screen.findByText('IMG20261117-001ABC');
    expect(screen.getByText('实结 10 点')).toBeTruthy();

    // Open create modal
    fireEvent.click(screen.getByLabelText('添加'));
    await screen.findByText('添加 AI 生图任务');

    // Upfront price banner + dynamic submit button visible before submission
    expect(screen.getByTestId('ai-image-price-banner').textContent).toContain(
      '单价 5 点数/张 × 生成 2 张 ＝ 合计预冻结 10 点数',
    );
    expect(screen.getByText('生成图片（5点数/张，合计预冻 10 点）')).toBeTruthy();

    // Verify all 9 aspect ratios exist and 21:9 is selected by default
    for (const ratio of AI_IMAGE_RATIOS) {
      expect(screen.getByText(new RegExp(`^${ratio}\\s`))).toBeTruthy();
    }
    const defaultRatioBtn = screen.getByText(/^21:9\s/).closest('button')!;
    expect(defaultRatioBtn.getAttribute('aria-checked')).toBe('true');

    // Switch count to 4 -> button updates to 20 points
    fireEvent.click(screen.getByText('4 张（20 点）'));
    expect(screen.getByText('生成图片（5点数/张，合计预冻 20 点）')).toBeTruthy();

    // Enter base prompt and click free AI optimize
    const promptBox = screen.getByLabelText('画面提示词');
    fireEvent.change(promptBox, { target: { value: '现代化数控折弯加工中心' } });
    fireEvent.click(screen.getByText('AI 优化提示词（免费）'));

    await waitFor(() => {
      expect((promptBox as HTMLTextAreaElement).value).toContain('现代化数控折弯加工中心');
      expect((promptBox as HTMLTextAreaElement).value).toContain('工业照明');
    });

    // Submit form
    fireEvent.click(screen.getByText('生成图片（5点数/张，合计预冻 20 点）'));

    await waitFor(() => {
      expect(createdPayloads).toHaveLength(1);
    });
    expect(createdPayloads[0]).toMatchObject({
      ratio: '21:9',
      count: 4,
    });
  });

  it('supports zero-copy Save to Gallery flow without duplicating storage', async () => {
    const { gateway, savedCalls } = buildMockGateway();

    render(<AiImageScreen title="AI生图" gateway={gateway} pollIntervalMs={0} />);

    await screen.findByText('IMG20261117-001ABC');

    fireEvent.click(screen.getByText('存入图库'));
    await screen.findByText('存入企业画像图库');
    fireEvent.click(screen.getByText('确认转存'));

    await waitFor(() => {
      expect(savedCalls).toEqual([{ id: 'img_demo_001', categoryId: 'mcat_01' }]);
    });
  });

  it('hides the AI生图/视频 menu in SideMenu when account.features.aiImage is false', () => {
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
    expect(screen.queryByText('AI生图/视频')).toBeTruthy();

    rerender(
      <ShellFrame
        account={{ ...baseAccount, features: { aiImage: false } }}
        state={initialSnapshot()}
        onDispatch={() => undefined}
        onLogout={() => undefined}
        onChangePassword={async () => null}
      />,
    );
    expect(screen.queryByText('AI生图/视频')).toBeNull();
  });
});
