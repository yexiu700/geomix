// @vitest-environment jsdom

import type { BrandFactsResponse, BrandMediaListResponse, BrandRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../../lib/api';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider, type ConsoleContextValue } from '../shell/console-context';
import { BrandsWorkspace } from './brands-workspace';

const getBrandFactsMock = vi.fn();
const saveBrandFactsMock = vi.fn();
const extractBrandFactsMock = vi.fn();
const listBrandMediaMock = vi.fn();
const uploadBrandMediaMock = vi.fn();
const updateBrandMediaAltMock = vi.fn();
const deleteBrandMediaMock = vi.fn();
const updateBrandMock = vi.fn();
const updateBrandMarketMock = vi.fn();
const deleteBrandMock = vi.fn();

vi.mock('../../lib/brands', () => ({
  listBrands: vi.fn(),
  getBrand: vi.fn(),
  createBrand: vi.fn(),
  updateBrand: (...args: unknown[]) => updateBrandMock(...args),
  deleteBrand: (...args: unknown[]) => deleteBrandMock(...args),
  enableBrandMarket: vi.fn(),
  updateBrandMarket: (...args: unknown[]) => updateBrandMarketMock(...args),
  getBrandFacts: (...args: unknown[]) => getBrandFactsMock(...args),
  saveBrandFacts: (...args: unknown[]) => saveBrandFactsMock(...args),
  extractBrandFacts: (...args: unknown[]) => extractBrandFactsMock(...args),
  listBrandMedia: (...args: unknown[]) => listBrandMediaMock(...args),
  uploadBrandMedia: (...args: unknown[]) => uploadBrandMediaMock(...args),
  updateBrandMediaAlt: (...args: unknown[]) => updateBrandMediaAltMock(...args),
  deleteBrandMedia: (...args: unknown[]) => deleteBrandMediaMock(...args),
  resolveMediaUrl: (u: string | null | undefined) => u ?? '',
}));

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

const sampleAccount: AccountProfile = {
  id: 'u-1',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-1',
    name: '演示租户',
    expiresAt: '2027-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

function makeBrand(id: string, name: string): BrandRecord {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id,
    name,
    category: '家用 NAS',
    truthAgreementSignedAt: null,
    createdAt: now,
    updatedAt: now,
    markets: [
      {
        id: `${id}-CN`,
        brandId: id,
        market: 'CN',
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: name,
        aliases: ['DXP4800'],
        ownedDomains: ['qingsong.cn'],
        competitors: [{ name: '群晖', aliases: [], domains: ['synology.com'] }],
        seedPrompts: ['2026年家用 NAS哪个品牌好？'],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function makeFactsResponse(brandId: string, content = '28dB 静音四盘位 NAS'): BrandFactsResponse {
  const now = '2026-11-20T02:30:00.000Z';
  return {
    brandId,
    truthAgreementSignedAt: null,
    totalChars: content.length,
    vectorIndexRequired: false,
    vectorIndexed: false,
    items: [
      {
        id: `fact-${brandId}`,
        brandId,
        slot: 'PRODUCT_SPECS',
        title: '核心产品与参数',
        content,
        sourceType: 'MANUAL',
        sourceUrl: null,
        indexStatus: 'NONE',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function makeMediaResponse(brandId: string): BrandMediaListResponse {
  return {
    items: [
      {
        id: `media-${brandId}`,
        brandId,
        origin: 'PRODUCT_UPLOAD',
        title: '正面实拍图',
        objectKey: 'tenants/t1/a.jpg',
        thumbKey: 'tenants/t1/a-thumb.jpg',
        url: '/api/v2/brands/b1/media/m1/file?tid=t1&sig=abc',
        thumbUrl: '/api/v2/brands/b1/media/m1/thumb?tid=t1&sig=def',
        mime: 'image/jpeg',
        bytes: 4096,
        width: 800,
        height: 600,
        aiPrompt: null,
        aiModel: null,
        usedCount: 2,
        createdAt: '2026-11-20T02:30:00.000Z',
      },
    ],
    storage: {
      used: '4096',
      limit: '104857600',
      usedText: '4 KB',
      limitText: '100 MB',
    },
  };
}

function renderWorkspace(overrides?: Partial<ConsoleContextValue>) {
  const ctx: ConsoleContextValue = {
    account: sampleAccount,
    readOnly: false,
    wallet: {
      points: 1000,
      pointsReserved: 0,
      available: 1000,
      money: '0.00',
      billingMode: 'SHADOW',
      billingModeSource: 'global',
      tenantBillingMode: null,
    },
    walletLoading: false,
    openCreateBrandModal: vi.fn(),
    openEnableMarketModal: vi.fn(),
    refreshWallet: vi.fn(async () => undefined),
    navigateWorkspace: vi.fn(),
    ...overrides,
  };
  return render(
    <ConsoleProvider value={ctx}>
      <BrandsWorkspace />
    </ConsoleProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useWorkspaceStore.getState().reset(window.localStorage);
  vi.clearAllMocks();
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe('BrandsWorkspace (/brands full 3-section UI)', () => {
  it('renders cold-load skeleton without flashing empty state or fake 0 points', () => {
    renderWorkspace();
    expect(screen.getByTestId('brands-loading')).toBeTruthy();
    expect(document.body.textContent).not.toContain('还没有创建任何品牌');
    expect(document.body.textContent).not.toMatch(/\b0\s*点\b/);
  });

  it('renders 3 sections, guards brand-switch anti-race, saves facts with compliance checkbox, extracts facts, and edits/deletes media', async () => {
    const b1 = makeBrand('b-1', '青松存储');
    const b2 = makeBrand('b-2', '北极光存储');

    getBrandFactsMock.mockImplementation(async (brandId: string) =>
      makeFactsResponse(brandId, brandId === 'b-1' ? '品牌一参数' : '品牌二专属参数'),
    );
    listBrandMediaMock.mockImplementation(async (brandId: string) => makeMediaResponse(brandId));
    saveBrandFactsMock.mockResolvedValue({
      ...makeFactsResponse('b-1', '更新后的实测参数 28dB'),
      truthAgreementSignedAt: '2026-11-20T03:00:00.000Z',
    });
    extractBrandFactsMock.mockResolvedValue({
      sourceType: 'MANUAL',
      sourceUrl: null,
      fileName: null,
      extractedChars: 60,
      fake: true,
      facts: [
        { slot: 'PRODUCT_SPECS', title: '核心参数', content: 'AI 提炼的四盘位参数 28dB' },
        { slot: 'DIFFERENTIATORS', title: '差异卖点', content: '免工具静音风道' },
        { slot: 'CREDENTIALS', title: '权威资质', content: 'ISO9001 认证' },
        { slot: 'CASE_STUDIES', title: '客户案例', content: '12,000+ 工作室案例' },
      ],
    });
    updateBrandMediaAltMock.mockResolvedValue({
      ...makeMediaResponse('b-1').items[0]!,
      title: 'DXP4800 前面板细节图',
    });
    deleteBrandMediaMock.mockResolvedValue({
      deleted: 1,
      id: 'media-b-1',
      releasedBytes: 4096,
      storage: { used: '0', limit: '104857600', usedText: '0 B', limitText: '100 MB' },
    });

    useWorkspaceStore
      .getState()
      .upsertBrand(b2, { activate: false, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });

    renderWorkspace();

    // All 4 core fact slots and dropzone render cleanly
    await waitFor(() => {
      expect(screen.getByTestId('fact-slot-PRODUCT_SPECS')).toBeTruthy();
      expect(screen.getByTestId('fact-slot-DIFFERENTIATORS')).toBeTruthy();
      expect(screen.getByTestId('fact-slot-CREDENTIALS')).toBeTruthy();
      expect(screen.getByTestId('fact-slot-CASE_STUDIES')).toBeTruthy();
      expect(screen.getByTestId('brand-media-dropzone')).toBeTruthy();
    });

    // AI extract modal: switch to 粘贴资料, run extract, apply to cards
    fireEvent.click(screen.getByTestId('fact-ai-extract-btn'));
    const extractDialog = await screen.findByRole('dialog', {
      name: 'AI 自动提炼 4 块品牌事实卡（免费）',
    });
    fireEvent.click(within(extractDialog).getByRole('tab', { name: '粘贴资料' }));
    fireEvent.change(within(extractDialog).getByLabelText('粘贴产品资料'), {
      target: { value: '这是一段超过十个字的真实产品参数和资质背书说明文档。' },
    });
    fireEvent.click(within(extractDialog).getByRole('button', { name: '开始 AI 提炼（免费）' }));

    const applyBtn = await within(extractDialog).findByRole('button', { name: '应用到事实卡' });
    fireEvent.click(applyBtn);

    // Check single lightweight compliance checkbox & save facts
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '保存品牌事实卡' }));
    await waitFor(() => {
      expect(saveBrandFactsMock).toHaveBeenCalledTimes(1);
    });

    // Inline Alt text edit on product photo
    fireEvent.click(screen.getByRole('button', { name: '编辑说明' }));
    const altInput = screen.getByLabelText('图片说明');
    fireEvent.change(altInput, { target: { value: 'DXP4800 前面板细节图' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(updateBrandMediaAltMock).toHaveBeenCalledWith(
        'b-1',
        'media-b-1',
        { title: 'DXP4800 前面板细节图' },
        expect.anything(),
      );
    });

    // Confirm delete via useUxFeedback().confirm (never Modal.confirm)
    const mediaSection = screen.getByLabelText('真实产品实拍图库');
    fireEvent.click(within(mediaSection).getByRole('button', { name: '删除' }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await confirmMock.mock.calls[0]?.[0]?.onOk?.();
    });
    expect(deleteBrandMediaMock).toHaveBeenCalledWith('b-1', 'media-b-1', expect.anything());

    // Brand switch reloads assets cleanly via AbortController anti-race
    act(() => {
      useWorkspaceStore.getState().setActiveBrand('b-2', 'CN', window.localStorage);
    });
    await waitFor(() => {
      expect((screen.getByLabelText('核心产品与参数') as HTMLTextAreaElement).value).toBe(
        '品牌二专属参数',
      );
    });
  });

  it('disables write actions in readOnly (expired tenant) mode', async () => {
    const b1 = makeBrand('b-1', '到期只读品牌');
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-1'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-1'));
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });

    renderWorkspace({ readOnly: true });

    await waitFor(() => {
      expect(screen.getByTestId('fact-slot-PRODUCT_SPECS')).toBeTruthy();
    });

    expect(
      (screen.getByRole('button', { name: '保存基础信息' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: '删除品牌' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: '保存市场配置' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '保存品牌事实卡' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByTestId('fact-ai-extract-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});
