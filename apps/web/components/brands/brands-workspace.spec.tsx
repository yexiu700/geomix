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

const listBrandProductLinesMock = vi.fn();
const fetchActionHomeMock = vi.fn();

vi.mock('../../lib/brands', () => ({
  listBrands: vi.fn(),
  getBrand: vi.fn(),
  createBrand: vi.fn(),
  updateBrand: (...args: unknown[]) => updateBrandMock(...args),
  deleteBrand: (...args: unknown[]) => deleteBrandMock(...args),
  enableBrandMarket: vi.fn(),
  updateBrandMarket: (...args: unknown[]) => updateBrandMarketMock(...args),
  suggestBrandMarketConfig: vi.fn(),
  listBrandProductLines: (...args: unknown[]) => listBrandProductLinesMock(...args),
  createBrandProductLine: vi.fn(),
  updateBrandProductLine: vi.fn(),
  deleteBrandProductLine: vi.fn(),
  getBrandFacts: (...args: unknown[]) => getBrandFactsMock(...args),
  saveBrandFacts: (...args: unknown[]) => saveBrandFactsMock(...args),
  extractBrandFacts: (...args: unknown[]) => extractBrandFactsMock(...args),
  listBrandMedia: (...args: unknown[]) => listBrandMediaMock(...args),
  uploadBrandMedia: (...args: unknown[]) => uploadBrandMediaMock(...args),
  updateBrandMediaAlt: (...args: unknown[]) => updateBrandMediaAltMock(...args),
  deleteBrandMedia: (...args: unknown[]) => deleteBrandMediaMock(...args),
  resolveMediaUrl: (u: string | null | undefined) => u ?? '',
}));

vi.mock('../../lib/home', () => ({
  fetchActionHome: (...args: unknown[]) => fetchActionHomeMock(...args),
}));

const listChannelConnectionsMock = vi.fn();
const listExtensionTokensMock = vi.fn();

vi.mock('../../lib/distribution', () => ({
  listChannelConnections: (...args: unknown[]) => listChannelConnectionsMock(...args),
  createChannelConnection: vi.fn(),
  updateChannelConnection: vi.fn(),
  deleteChannelConnection: vi.fn(),
  testChannelConnection: vi.fn(),
  startShopifyOAuth: vi.fn(),
}));

vi.mock('../../lib/extension', () => ({
  listExtensionTokens: (...args: unknown[]) => listExtensionTokensMock(...args),
  createExtensionToken: vi.fn(),
  revokeExtensionToken: vi.fn(),
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
  listChannelConnectionsMock.mockResolvedValue({ items: [] });
  listExtensionTokensMock.mockResolvedValue({ items: [] });
  listBrandProductLinesMock.mockResolvedValue({ items: [] });
  fetchActionHomeMock.mockResolvedValue({
    brandId: 'b-1',
    brandMarketId: 'b-1-CN',
    market: 'CN',
    health: {
      days: 14,
      mentionRatePct: 0,
      shareOfVoicePct: 0,
      avgPosition: null,
      ownedCitationRatePct: 0,
      completedChecks: 0,
    },
    topBriefs: [],
    recentArticles: [],
    retestBudget: null,
  });
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

    // All 4 core fact slots, dropzone, and Section 4 channel connections render cleanly
    await waitFor(() => {
      expect(screen.getByTestId('fact-slot-PRODUCT_SPECS')).toBeTruthy();
      expect(screen.getByTestId('fact-slot-DIFFERENTIATORS')).toBeTruthy();
      expect(screen.getByTestId('fact-slot-CREDENTIALS')).toBeTruthy();
      expect(screen.getByTestId('fact-slot-CASE_STUDIES')).toBeTruthy();
      expect(screen.getByTestId('brand-media-dropzone')).toBeTruthy();
      expect(screen.getByTestId('brand-channel-connections')).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: '发布渠道' }).getAttribute('href')).toBe(
      '#brand-section-connections',
    );

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

    expect((screen.getByLabelText('编辑品牌名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('当地品牌名') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('brand-dirty-save-bar')).toBeNull();
    fireEvent.click(screen.getByTestId('brand-actions-trigger'));
    const deleteMenuItem = await screen.findByText('删除品牌');
    fireEvent.click(deleteMenuItem);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: '保存品牌事实卡' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByTestId('fact-ai-extract-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('add-channel-connection-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('renders competitor name, aliases, and normalized domain tags as visible text and isolates them on brand switch', async () => {
    const b1: BrandRecord = {
      ...makeBrand('b-comp-1', '青松存储'),
      markets: [
        {
          ...makeBrand('b-comp-1', '青松存储').markets[0]!,
          competitors: [
            {
              name: 'Synology',
              aliases: ['群晖', '群晖科技'],
              domains: ['synology.example', 'synology-cn.example'],
            },
          ],
        },
      ],
    };
    const b2: BrandRecord = {
      ...makeBrand('b-comp-2', '凌云电源'),
      markets: [
        {
          ...makeBrand('b-comp-2', '凌云电源').markets[0]!,
          ownedDomains: ['lingyun.example'],
          competitors: [
            {
              name: 'EcoFlow',
              aliases: ['正浩'],
              domains: ['ecoflow.example'],
            },
          ],
        },
      ],
    };

    getBrandFactsMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeFactsResponse(brandId)),
    );
    listBrandMediaMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeMediaResponse(brandId)),
    );

    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertBrand(b2, { activate: false, persistStorage: window.localStorage });

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByText('synology.example')).toBeTruthy();
    });
    expect(screen.getByText('Synology')).toBeTruthy();
    expect(screen.getByText('群晖')).toBeTruthy();
    expect(screen.getByText('群晖科技')).toBeTruthy();
    expect(screen.getByText('synology-cn.example')).toBeTruthy();

    // Live editing domain input normalizes and reflects immediately as visible tags
    fireEvent.change(screen.getByLabelText('市场竞品域名 1'), {
      target: { value: 'https://WWW.JIKONG.EXAMPLE/path, forum.jikong.example' },
    });
    expect(screen.getByText('jikong.example')).toBeTruthy();
    expect(screen.getByText('forum.jikong.example')).toBeTruthy();

    // Brand switch cleanly isolates competitor tags to brand 2
    act(() => {
      useWorkspaceStore.getState().setActiveBrand('b-comp-2', 'CN', window.localStorage);
    });
    await waitFor(() => {
      expect(screen.getByText('ecoflow.example')).toBeTruthy();
    });
    expect(screen.getByText('EcoFlow')).toBeTruthy();
    expect(screen.getByText('正浩')).toBeTruthy();
    expect(screen.queryByText('forum.jikong.example')).toBeNull();
  });

  it('notifies error when deleteBrand fails inside confirm modal and avoids snapping back on stale brand save (W-07)', async () => {
    const b1 = makeBrand('b-w7-1', '品牌甲');
    const b2 = makeBrand('b-w7-2', '品牌乙');
    getBrandFactsMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeFactsResponse(brandId)),
    );
    listBrandMediaMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeMediaResponse(brandId)),
    );

    deleteBrandMock.mockRejectedValueOnce(new Error('该品牌存在进行中的监测任务'));
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      void onOk?.();
    });

    let resolveUpdate!: (value: BrandRecord) => void;
    updateBrandMock.mockImplementationOnce(
      () =>
        new Promise<BrandRecord>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertBrand(b2, { activate: false, persistStorage: window.localStorage });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId('brand-actions-trigger')).toBeTruthy();
    });

    // Trigger delete brand via PageHeader overflow menu -> RowActions confirm
    fireEvent.click(screen.getByTestId('brand-actions-trigger'));
    fireEvent.click(await screen.findByText('删除品牌'));
    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledWith('该品牌存在进行中的监测任务');
    });
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-w7-1');

    // Edit brand name so sticky dirty bar appears, start saving Brand 1, switch to Brand 2 mid-flight
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), { target: { value: '品牌甲-新名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    act(() => {
      useWorkspaceStore.getState().setActiveBrand('b-w7-2', 'CN', window.localStorage);
    });
    await act(async () => {
      resolveUpdate({ ...b1, name: '品牌甲-新名' });
      await Promise.resolve();
    });

    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-w7-2');
    expect(useWorkspaceStore.getState().brands.find((b) => b.id === 'b-w7-1')?.name).toBe(
      '品牌甲-新名',
    );
  });

  it('mounts CN ExtensionPairingPanel on CN market and hides it on GLOBAL while showing GLOBAL supportedLocales & controlPrompts editors', async () => {
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-v22'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-v22'));
    const dualBrand = makeBrand('b-v22', '星辰存储');
    dualBrand.markets.push({
      id: 'bm-gl-v22',
      brandId: 'b-v22',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AstraVault',
      localCategory: 'Home NAS',
      aliases: [],
      ownedDomains: ['astravault.example.com'],
      competitors: [],
      seedPrompts: ['Best quiet 4-bay NAS 2026'],
      supportedLocales: ['en-US', 'ja-JP'],
      controlPrompts: ['Best cloud backup service 2026'],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    updateBrandMarketMock.mockResolvedValueOnce(dualBrand);

    useWorkspaceStore.getState().upsertBrand(dualBrand, {
      activate: true,
      market: 'CN',
      persistStorage: window.localStorage,
    });

    renderWorkspace();
    expect(await screen.findByTestId('extension-pairing-panel')).toBeTruthy();
    expect(screen.getByRole('link', { name: '扩展配对' }).getAttribute('href')).toBe(
      '#brand-section-extension',
    );
    expect(screen.queryByTestId('brand-supported-locales-field')).toBeNull();

    // Switch to GLOBAL: ExtensionPairingPanel hides, supportedLocales & controlPrompts appear
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('extension-pairing-panel')).toBeNull();
      expect(screen.getByTestId('brand-supported-locales-field')).toBeTruthy();
      expect(screen.getByTestId('brand-control-prompts-field')).toBeTruthy();
    });

    // Reject control prompt overlapping seedPrompts
    fireEvent.change(screen.getByTestId('control-prompt-input'), {
      target: { value: '  best quiet 4-bay nas 2026  ' },
    });
    fireEvent.click(screen.getByTestId('add-control-prompt-btn'));
    expect(await screen.findByTestId('brand-market-error')).toBeTruthy();
    expect(screen.getByTestId('brand-market-error').textContent).toContain(
      '不能与种子监控问句重复',
    );

    // Add valid control prompt and save market config
    fireEvent.change(screen.getByTestId('control-prompt-input'), {
      target: { value: 'Best external SSD 2026' },
    });
    fireEvent.click(screen.getByTestId('add-control-prompt-btn'));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(updateBrandMarketMock).toHaveBeenCalledWith(
        'b-v22',
        'GLOBAL',
        expect.objectContaining({
          supportedLocales: ['en-US', 'ja-JP'],
          controlPrompts: ['Best cloud backup service 2026', 'Best external SSD 2026'],
        }),
        expect.anything(),
      );
    });
  });

  it('renders XSS-safe Shopify OAuth callback banner and cleans transient query params via replaceState', async () => {
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-oauth'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-oauth'));
    const brand = makeBrand('b-oauth', 'OAuth Brand');
    useWorkspaceStore
      .getState()
      .upsertBrand(brand, { activate: true, market: 'CN', persistStorage: window.localStorage });

    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    window.history.pushState(
      {},
      '',
      '/brands?brandId=b-oauth&market=GLOBAL&shopifyOAuth=error&reason=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    );

    renderWorkspace({
      urlSearch:
        'brandId=b-oauth&market=GLOBAL&shopifyOAuth=error&reason=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    });

    const banner = await screen.findByTestId('shopify-oauth-callback-banner');
    expect(banner.textContent).toContain('Shopify OAuth 2.0 授权未完成');
    expect(banner.querySelector('img')).toBeNull();
    expect(replaceStateSpy).toHaveBeenCalled();
    const cleanedUrl = String(replaceStateSpy.mock.calls.at(-1)?.[2] ?? '');
    expect(cleanedUrl).toContain('brandId=b-oauth');
    expect(cleanedUrl).not.toContain('shopifyOAuth');
    expect(cleanedUrl).not.toContain('reason=');
  });

  it('BUG-3 regression: maps unknown ?reason= to fixed safe generic message and never resurrects dismissed OAuth banner on market switch', async () => {
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-oauth-safe'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-oauth-safe'));
    const dualBrand = makeBrand('b-oauth-safe', 'OAuth Safe Brand');
    dualBrand.markets.push({
      id: 'bm-gl-oauth-safe',
      brandId: 'b-oauth-safe',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'OAuth Safe Global',
      localCategory: 'NAS',
      aliases: [],
      ownedDomains: ['oauth-safe.example.com'],
      competitors: [],
      seedPrompts: ['Best NAS 2026'],
      supportedLocales: ['en-US'],
      controlPrompts: [],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    useWorkspaceStore.getState().upsertBrand(dualBrand, {
      activate: true,
      market: 'GLOBAL',
      persistStorage: window.localStorage,
    });

    const staleSearch =
      'brandId=b-oauth-safe&market=GLOBAL&shopifyOAuth=error&reason=Account+suspended+visit+evil.com';
    window.history.pushState({}, '', `/brands?${staleSearch}`);

    renderWorkspace({ urlSearch: staleSearch });

    const banner = await screen.findByTestId('shopify-oauth-callback-banner');
    expect(banner.textContent).toContain(
      'Shopify OAuth 授权未完成，请重试或改用 Custom App Token 接入。',
    );
    expect(banner.textContent).not.toContain('Account suspended visit evil.com');

    // Dismiss the banner
    const closeBtn = within(banner).getByRole('button', { name: /close/i });
    fireEvent.click(closeBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('shopify-oauth-callback-banner')).toBeNull();
    });

    // Switch market GLOBAL -> CN while stale urlSearch prop remains unchanged -> banner MUST NOT resurrect
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('CN', window.localStorage);
    });
    await waitFor(() => {
      expect(screen.getByTestId('extension-pairing-panel')).toBeTruthy();
    });
    expect(screen.queryByTestId('shopify-oauth-callback-banner')).toBeNull();
  });

  it('BUG-5 regression: aborts in-flight market save on CN <-> GLOBAL switch so stale responses never yank activeMarket or leak errors', async () => {
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-race'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-race'));
    const dualBrand = makeBrand('b-race', '竞态测试品牌');
    dualBrand.markets.push({
      id: 'bm-gl-race',
      brandId: 'b-race',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'Race Global',
      localCategory: 'NAS',
      aliases: [],
      ownedDomains: ['race.example.com'],
      competitors: [],
      seedPrompts: ['Best NAS 2026'],
      supportedLocales: ['en-US'],
      controlPrompts: [],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    useWorkspaceStore.getState().upsertBrand(dualBrand, {
      activate: true,
      market: 'CN',
      persistStorage: window.localStorage,
    });

    let cnSignal: AbortSignal | undefined;
    let resolveCnSave!: (brand: BrandRecord) => void;
    let rejectGlobalSave!: (err: Error) => void;

    updateBrandMarketMock
      .mockImplementationOnce(
        (_bid: string, _mkt: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
          cnSignal = opts?.signal;
          return new Promise<BrandRecord>((resolve) => {
            resolveCnSave = resolve;
          });
        },
      )
      .mockImplementationOnce(
        () =>
          new Promise<BrandRecord>((_resolve, reject) => {
            rejectGlobalSave = reject;
          }),
      );

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByLabelText('当地品牌名')).toBeTruthy();
    });

    // 1. Edit CN market field to trigger sticky dirty bar, start CN save, switch to GLOBAL before it settles -> aborted & resolving it MUST NOT yank activeMarket back to CN
    fireEvent.change(screen.getByLabelText('当地品牌名'), {
      target: { value: '竞态测试品牌-CN改动' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMarketMock).toHaveBeenCalledTimes(1));
    expect(cnSignal?.aborted).toBe(false);

    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    });
    expect(cnSignal?.aborted).toBe(true);

    await act(async () => {
      resolveCnSave(dualBrand);
      await Promise.resolve();
    });
    expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');

    // 2. Edit GLOBAL market field, start GLOBAL save, switch back to CN before it rejects -> stale GLOBAL error MUST NOT leak onto CN
    fireEvent.change(screen.getByLabelText('当地品牌名'), {
      target: { value: 'Race Global Edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMarketMock).toHaveBeenCalledTimes(2));

    act(() => {
      useWorkspaceStore.getState().setActiveMarket('CN', window.localStorage);
    });
    await act(async () => {
      rejectGlobalSave(new Error('STALE GLOBAL SAVE ERROR'));
      await Promise.resolve();
    });
    expect(screen.queryByText('STALE GLOBAL SAVE ERROR')).toBeNull();
  });

  it('0-brand empty state renders non-primary 60 秒创建首个品牌 button so ShellFrame banner remains the sole primary CTA', () => {
    const openCreateBrandModal = vi.fn();
    useWorkspaceStore.setState({
      brands: [],
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: null,
    });

    const { container } = renderWorkspace({ openCreateBrandModal });

    const cta = screen.getByRole('button', { name: '60 秒创建首个品牌' });
    expect(cta.classList.contains('ant-btn-primary')).toBe(false);
    expect(container.querySelectorAll('.ant-btn-primary')).toHaveLength(0);

    fireEvent.click(cta);
    expect(openCreateBrandModal).toHaveBeenCalledTimes(1);
  });

  it('preserves activeMarket GLOBAL and skips zombie Step B when switching market or brand during in-flight updateBrand', async () => {
    getBrandFactsMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeFactsResponse(brandId)),
    );
    listBrandMediaMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeMediaResponse(brandId)),
    );
    const dualBrand = makeBrand('b-dual-race', '双市场竞态品牌');
    dualBrand.markets.push({
      id: 'bm-gl-dual-race',
      brandId: 'b-dual-race',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'DualRace Global',
      localCategory: 'NAS',
      aliases: [],
      ownedDomains: ['dualrace.example.com'],
      competitors: [],
      seedPrompts: ['Best NAS 2026'],
      supportedLocales: ['en-US'],
      controlPrompts: [],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    const otherBrand = makeBrand('b-other-race', '第二品牌');

    let resolveBaseOnly!: (brand: BrandRecord) => void;
    let resolveCombinedMarketSwitch!: (brand: BrandRecord) => void;
    let resolveCombinedBrandSwitch!: (brand: BrandRecord) => void;
    updateBrandMock
      .mockImplementationOnce(
        () =>
          new Promise<BrandRecord>((resolve) => {
            resolveBaseOnly = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BrandRecord>((resolve) => {
            resolveCombinedMarketSwitch = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BrandRecord>((resolve) => {
            resolveCombinedBrandSwitch = resolve;
          }),
      );

    useWorkspaceStore.getState().upsertBrand(otherBrand, {
      activate: false,
      market: 'CN',
      persistStorage: window.localStorage,
    });
    useWorkspaceStore.getState().upsertBrand(dualBrand, {
      activate: true,
      market: 'CN',
      persistStorage: window.localStorage,
    });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByLabelText('编辑品牌名称')).toBeTruthy();
    });

    // 1. Base-only updateBrand in-flight + CN -> GLOBAL switch: must NOT yank activeMarket back to CN
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '双市场竞态品牌-改1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(1));

    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    });
    const afterBase1: BrandRecord = { ...dualBrand, name: '双市场竞态品牌-改1' };
    await act(async () => {
      resolveBaseOnly(afterBase1);
      await Promise.resolve();
    });
    expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');
    expect(updateBrandMarketMock).not.toHaveBeenCalled();

    // 2. Switch back to CN, edit both base + market, switch CN -> GLOBAL during Step A -> activeMarket stays GLOBAL & updateBrandMarket NOT called
    act(() => {
      useWorkspaceStore.getState().setActiveMarket('CN', window.localStorage);
    });
    await waitFor(() => {
      expect((screen.getByLabelText('当地品牌名') as HTMLInputElement).value).toBe(
        '双市场竞态品牌',
      );
    });
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '双市场竞态品牌-改2' },
    });
    fireEvent.change(screen.getByLabelText('当地品牌名'), {
      target: { value: '双市场竞态品牌-CN改' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(2));

    act(() => {
      useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    });
    const afterBase2: BrandRecord = { ...afterBase1, name: '双市场竞态品牌-改2' };
    await act(async () => {
      resolveCombinedMarketSwitch(afterBase2);
      await Promise.resolve();
    });
    expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');
    expect(updateBrandMarketMock).not.toHaveBeenCalled();

    // 3. Edit both base + GLOBAL market, switch Brand 1 -> Brand 2 during Step A -> Brand 1 base commits, activeBrandId stays b-other-race, updateBrandMarket NOT called
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '双市场竞态品牌-改3' },
    });
    fireEvent.change(screen.getByLabelText('当地品牌名'), {
      target: { value: 'DualRace Global Edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(3));

    act(() => {
      useWorkspaceStore.getState().setActiveBrand('b-other-race', 'CN', window.localStorage);
    });
    const afterBase3: BrandRecord = { ...afterBase2, name: '双市场竞态品牌-改3' };
    await act(async () => {
      resolveCombinedBrandSwitch(afterBase3);
      await Promise.resolve();
    });
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-other-race');
    expect(useWorkspaceStore.getState().brands.find((b) => b.id === 'b-dual-race')?.name).toBe(
      '双市场竞态品牌-改3',
    );
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
  });

  it('DEFECT-4 regression (2 brands): does not resurrect a deleted brand when an in-flight updateBrand resolves late', async () => {
    const b1 = makeBrand('b-1', '青松存储');
    const b2 = makeBrand('b-2', '北极光存储');
    getBrandFactsMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeFactsResponse(brandId)),
    );
    listBrandMediaMock.mockImplementation((brandId: string) =>
      Promise.resolve(makeMediaResponse(brandId)),
    );

    let resolveUpdate!: (brand: BrandRecord) => void;
    updateBrandMock.mockImplementationOnce(
      () =>
        new Promise<BrandRecord>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    deleteBrandMock.mockResolvedValueOnce({ deleted: true, id: 'b-1' });
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      void onOk?.();
    });

    useWorkspaceStore
      .getState()
      .upsertBrand(b2, { activate: false, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByLabelText('编辑品牌名称')).toBeTruthy();
    });

    // Edit Brand 1 and start in-flight updateBrand('b-1')
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '青松存储-已改名' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(1));

    // Delete Brand 1 via PageHeader overflow menu while save is still in-flight
    fireEvent.click(screen.getByTestId('brand-actions-trigger'));
    fireEvent.click(await screen.findByText('删除品牌'));
    await waitFor(() => {
      expect(deleteBrandMock).toHaveBeenCalledWith('b-1', expect.anything());
      expect(useWorkspaceStore.getState().brands.map((b) => b.id)).toEqual(['b-2']);
      expect(useWorkspaceStore.getState().activeBrandId).toBe('b-2');
    });

    // Late resolution of updateBrand('b-1') MUST NOT resurrect deleted b-1
    await act(async () => {
      resolveUpdate({ ...b1, name: '青松存储-已改名' });
      await Promise.resolve();
    });

    expect(useWorkspaceStore.getState().brands.map((b) => b.id)).toEqual(['b-2']);
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-2');
  });

  it('DEFECT-4 regression (1 brand): stays in 0-brand empty state when an in-flight updateBrand resolves after deleting the only brand', async () => {
    const b1 = makeBrand('b-1', '唯一品牌');
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-1'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-1'));

    let resolveUpdate!: (brand: BrandRecord) => void;
    updateBrandMock.mockImplementationOnce(
      () =>
        new Promise<BrandRecord>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    deleteBrandMock.mockResolvedValueOnce({ deleted: true, id: 'b-1' });
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      void onOk?.();
    });

    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByLabelText('编辑品牌名称')).toBeTruthy();
    });

    // Edit the only brand and start in-flight updateBrand('b-1')
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '唯一品牌-已改名' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(1));

    // Delete the only brand while save is still in-flight -> enters 0-brand empty state
    fireEvent.click(screen.getByTestId('brand-actions-trigger'));
    fireEvent.click(await screen.findByText('删除品牌'));
    await waitFor(() => {
      expect(deleteBrandMock).toHaveBeenCalledWith('b-1', expect.anything());
      expect(useWorkspaceStore.getState().brands).toEqual([]);
      expect(useWorkspaceStore.getState().activeBrandId).toBeNull();
      expect(screen.getByText('还没有创建任何品牌')).toBeTruthy();
    });

    // Late resolution of updateBrand('b-1') MUST NOT resurrect b-1 or exit empty state
    await act(async () => {
      resolveUpdate({ ...b1, name: '唯一品牌-已改名' });
      await Promise.resolve();
    });

    expect(useWorkspaceStore.getState().brands).toEqual([]);
    expect(useWorkspaceStore.getState().activeBrandId).toBeNull();
    expect(screen.getByText('还没有创建任何品牌')).toBeTruthy();
    expect(screen.getByRole('button', { name: '60 秒创建首个品牌' })).toBeTruthy();
  });

  it('shows zero product-line scope UI when brand has 0 lines, and renders scoped fact tabs when >= 1 line (#387)', async () => {
    const b1 = makeBrand('b-scope-1', '多线品牌');
    const now = '2026-11-20T02:30:00.000Z';
    listBrandProductLinesMock.mockResolvedValueOnce({
      items: [
        {
          id: 'pl-power',
          brandId: 'b-scope-1',
          name: 'Power Station Series',
          localNamesJson: {},
          category: 'Portable Power Station',
          localCategoriesJson: {},
          seedPromptsJson: {},
          competitorsJson: {},
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'pl-nas',
          brandId: 'b-scope-1',
          name: 'Home NAS Series',
          localNamesJson: {},
          category: 'Home NAS',
          localCategoriesJson: {},
          seedPromptsJson: {},
          competitorsJson: {},
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    getBrandFactsMock.mockResolvedValueOnce({
      brandId: 'b-scope-1',
      truthAgreementSignedAt: now,
      totalChars: 60,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [
        {
          id: 'f-gen',
          brandId: 'b-scope-1',
          productLineId: null,
          slot: 'CREDENTIALS',
          title: 'Brand Master ISO',
          content: 'Global ISO-9001 certified.',
          sourceType: 'MANUAL',
          sourceUrl: null,
          indexStatus: 'NONE',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'f-power',
          brandId: 'b-scope-1',
          productLineId: 'pl-power',
          slot: 'PRODUCT_SPECS',
          title: 'Power Station Specs',
          content: '3600W pure sine wave.',
          sourceType: 'MANUAL',
          sourceUrl: null,
          indexStatus: 'NONE',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'f-nas',
          brandId: 'b-scope-1',
          productLineId: 'pl-nas',
          slot: 'PRODUCT_SPECS',
          title: 'Home NAS Specs',
          content: '8-bay 10GbE RAID.',
          sourceType: 'MANUAL',
          sourceUrl: null,
          indexStatus: 'NONE',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    listBrandMediaMock.mockResolvedValueOnce(makeMediaResponse('b-scope-1'));

    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });

    renderWorkspace();

    const factsSection = await waitFor(() => {
      const el = document.getElementById('brand-section-facts');
      expect(el).toBeTruthy();
      expect(el!.textContent).toContain('Power Station Series');
      expect(el!.textContent).toContain('Home NAS Series');
      return el!;
    });

    // Switch to Power Station Series tab -> shows its PRODUCT_SPECS fact without dropping Home NAS Specs
    fireEvent.click(within(factsSection).getByTestId('fact-scope-tab-pl-power'));
    const specsCard = within(factsSection).getByTestId('fact-slot-PRODUCT_SPECS');
    expect((within(specsCard).getByLabelText('核心产品与参数') as HTMLTextAreaElement).value).toBe(
      '3600W pure sine wave.',
    );

    // Save in Power Station scope submits productLineId: 'pl-power'
    saveBrandFactsMock.mockResolvedValueOnce({
      brandId: 'b-scope-1',
      truthAgreementSignedAt: now,
      totalChars: 60,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    });
    fireEvent.click(within(factsSection).getByRole('button', { name: '保存品牌事实卡' }));
    await waitFor(() => {
      expect(saveBrandFactsMock).toHaveBeenCalledWith(
        'b-scope-1',
        expect.objectContaining({
          facts: expect.arrayContaining([
            expect.objectContaining({
              id: 'f-power',
              slot: 'PRODUCT_SPECS',
              productLineId: 'pl-power',
            }),
          ]),
        }),
        expect.anything(),
      );
    });
  });

  it('Tier 5 #10: skips redundant loadProductLines call when mounted inside ConsoleShell (managesProductLines: true)', async () => {
    const b1 = makeBrand('b-dup-1', '品牌甲');
    const b2 = makeBrand('b-dup-2', '品牌乙');
    getBrandFactsMock.mockResolvedValue(makeFactsResponse('b-dup-1'));
    listBrandMediaMock.mockResolvedValue(makeMediaResponse('b-dup-1'));
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertBrand(b2, { activate: false, persistStorage: window.localStorage });

    renderWorkspace({ managesProductLines: true });
    await waitFor(() => {
      expect(getBrandFactsMock).toHaveBeenCalledWith('b-dup-1', expect.anything());
    });
    expect(listBrandProductLinesMock).not.toHaveBeenCalled();

    // Switch brand while on /brands -> BrandsWorkspace still leaves product-line loading to ConsoleShell
    act(() => {
      useWorkspaceStore.getState().setActiveBrand('b-dup-2', undefined, window.localStorage);
    });
    await waitFor(() => {
      expect(getBrandFactsMock).toHaveBeenCalledWith('b-dup-2', expect.anything());
    });
    expect(listBrandProductLinesMock).not.toHaveBeenCalled();
  });
});
