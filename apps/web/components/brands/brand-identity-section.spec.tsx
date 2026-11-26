// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandIdentitySection } from './brand-identity-section';

const updateBrandMock = vi.fn();
const updateBrandMarketMock = vi.fn();
const suggestBrandMarketConfigMock = vi.fn();

vi.mock('../../lib/brands', () => ({
  updateBrand: (...args: unknown[]) => updateBrandMock(...args),
  updateBrandMarket: (...args: unknown[]) => updateBrandMarketMock(...args),
  suggestBrandMarketConfig: (...args: unknown[]) => suggestBrandMarketConfigMock(...args),
}));

const notifySuccessMock = vi.fn();
const notifyWarningMock = vi.fn();
const notifyErrorMock = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: vi.fn(),
    notifySuccess: notifySuccessMock,
    notifyWarning: notifyWarningMock,
    notifyError: notifyErrorMock,
  }),
}));

function makeDualMarketBrand(): BrandRecord {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id: 'b-id-1',
    name: '青松存储',
    category: '家用 NAS',
    truthAgreementSignedAt: null,
    createdAt: now,
    updatedAt: now,
    markets: [
      {
        id: 'bm-cn-1',
        brandId: 'b-id-1',
        market: 'CN',
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: '青松存储',
        localCategory: '家用 NAS',
        aliases: ['DXP4800'],
        ownedDomains: ['qingsong.cn'],
        competitors: [{ name: '群晖', aliases: ['Synology'], domains: ['synology.com'] }],
        seedPrompts: ['2026年家用 NAS哪个品牌好？'],
        controlPrompts: ['2026年家用路由器推荐'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'bm-gl-1',
        brandId: 'b-id-1',
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        localBrandName: 'PineVault',
        localCategory: 'Home NAS',
        aliases: ['PV-400'],
        ownedDomains: ['pinevault.example.com'],
        competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
        seedPrompts: ['Best quiet 4-bay NAS 2026'],
        supportedLocales: ['en-US', 'de-DE'],
        controlPrompts: ['Best cloud backup service 2026'],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('BrandIdentitySection (Sonar Ink 2.0 dirty bar & hover-delete)', () => {
  it('hides sticky dirty bar at rest, uses hover-reveal icon buttons, and has zero ant-btn-dangerous 移除 or direct 删除品牌 buttons', () => {
    const brand = makeDualMarketBrand();
    const onDirtyChange = vi.fn();

    const { container } = render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={vi.fn()}
        onOpenEnableMarket={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );

    // Sticky dirty bar hidden at rest
    expect(screen.queryByTestId('brand-dirty-save-bar')).toBeNull();
    expect(onDirtyChange).toHaveBeenCalledWith(false);

    // Zero direct 删除品牌 button, zero red-bordered 移除 buttons, and zero primary CTA at rest
    // (+ 新建品牌 in BrandsWorkspace is the sole primary CTA on /brands at rest)
    expect(screen.queryByRole('button', { name: '删除品牌' })).toBeNull();
    expect(container.querySelectorAll('button.ant-btn-dangerous')).toHaveLength(0);
    expect(container.querySelectorAll('button.ant-btn-primary')).toHaveLength(0);

    // Heading has no numbered prefix
    const heading = container.querySelector('#brand-section-identity h2');
    expect(heading?.textContent?.trim()).toBe('基础身份与竞品雷达');

    // Hover-reveal icon remove buttons exist with SVG & aria-label
    const compRemoveBtn = screen.getByRole('button', { name: '移除竞品 群晖' });
    expect(compRemoveBtn.querySelector('svg')).toBeTruthy();
    const seedRemoveBtn = screen.getByRole('button', {
      name: '移除问句 2026年家用 NAS哪个品牌好？',
    });
    expect(seedRemoveBtn.querySelector('svg')).toBeTruthy();
    const controlRemoveBtn = screen.getByRole('button', {
      name: '移除对照组问句 2026年家用路由器推荐',
    });
    expect(controlRemoveBtn.querySelector('svg')).toBeTruthy();
  });

  it('tracks base-field dirty state, reverts cleanly on 放弃, and saves base-only via updateBrand without calling updateBrandMarket', async () => {
    const brand = makeDualMarketBrand();
    const updatedBrand: BrandRecord = { ...brand, name: '青松存储 Pro' };
    updateBrandMock.mockResolvedValueOnce(updatedBrand);
    const onBrandUpdated = vi.fn();
    const onDirtyChange = vi.fn();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );

    const nameInput = screen.getByLabelText('编辑品牌名称') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '青松存储-临时改动' } });

    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();
    expect(screen.getByText('有未保存更改')).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // Discard reverts value and hides bar
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    expect(nameInput.value).toBe('青松存储');
    expect(screen.queryByTestId('brand-dirty-save-bar')).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    // Edit again and save base-only
    fireEvent.change(nameInput, { target: { value: '青松存储 Pro' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(updateBrandMock).toHaveBeenCalledWith(
        'b-id-1',
        { name: '青松存储 Pro', category: '家用 NAS' },
        expect.anything(),
      );
    });
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
    expect(onBrandUpdated).toHaveBeenCalledWith(updatedBrand);
    expect(notifySuccessMock).toHaveBeenCalledWith('已保存品牌基础信息');
  });

  it('tracks competitor removal & GLOBAL controlPrompts/supportedLocales, reverts on 放弃, and saves market-only via updateBrandMarket', async () => {
    const brand = makeDualMarketBrand();
    const globalMarket = brand.markets[1]!;
    updateBrandMarketMock.mockResolvedValueOnce(brand);
    const onBrandUpdated = vi.fn();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="GLOBAL"
        activeBrandMarket={globalMarket}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    // Remove competitor row -> triggers dirty bar -> discard restores competitor
    fireEvent.click(screen.getByRole('button', { name: '移除竞品 Synology' }));
    expect(screen.queryByDisplayValue('Synology')).toBeNull();
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    expect(screen.getByDisplayValue('Synology')).toBeTruthy();
    expect(screen.queryByTestId('brand-dirty-save-bar')).toBeNull();

    // Add a control prompt and save market-only
    fireEvent.change(screen.getByTestId('control-prompt-input'), {
      target: { value: 'Best NVMe enclosure 2026' },
    });
    fireEvent.click(screen.getByTestId('add-control-prompt-btn'));
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(updateBrandMarketMock).toHaveBeenCalledWith(
        'b-id-1',
        'GLOBAL',
        expect.objectContaining({
          localBrandName: 'PineVault',
          supportedLocales: ['en-US', 'de-DE'],
          controlPrompts: ['Best cloud backup service 2026', 'Best NVMe enclosure 2026'],
        }),
        expect.anything(),
      );
    });
    expect(updateBrandMock).not.toHaveBeenCalled();
    expect(onBrandUpdated).toHaveBeenCalledWith(brand, 'GLOBAL');
  });

  it('handles combined base + market save and commits base cleanly when market save fails', async () => {
    const brand = makeDualMarketBrand();
    const updatedBase: BrandRecord = { ...brand, name: '青松科技' };
    updateBrandMock.mockResolvedValueOnce(updatedBase);
    updateBrandMarketMock.mockRejectedValueOnce(new Error('市场配置校验失败'));
    const onBrandUpdated = vi.fn();

    const { rerender } = render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    // Modify both base brand name and market localBrandName
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), { target: { value: '青松科技' } });
    fireEvent.change(screen.getByLabelText('当地品牌名'), { target: { value: '青松存储 CN' } });

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(updateBrandMock).toHaveBeenCalledTimes(1);
      expect(updateBrandMarketMock).toHaveBeenCalledTimes(1);
    });
    // Step A committed base via onBrandUpdated (without stale market), Step B surfaced marketError
    expect(onBrandUpdated).toHaveBeenCalledWith(updatedBase);
    expect(await screen.findByTestId('brand-market-error')).toBeTruthy();
    expect(screen.getByTestId('brand-market-error').textContent).toContain('市场配置校验失败');

    // Rerender with updatedBase prop as parent store would -> market stays dirty while base is clean
    rerender(
      <BrandIdentitySection
        brand={updatedBase}
        activeMarket="CN"
        activeBrandMarket={updatedBase.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    // Retry save -> only updateBrandMarket fires (base is already clean!)
    updateBrandMarketMock.mockResolvedValueOnce(updatedBase);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(updateBrandMarketMock).toHaveBeenCalledTimes(2);
    });
    expect(updateBrandMock).toHaveBeenCalledTimes(1);
  });

  it('validates both base and market before firing any request so zero partial writes occur', () => {
    const brand = makeDualMarketBrand();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={vi.fn()}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    // Valid base change + invalid empty localBrandName -> neither API should fire
    fireEvent.change(screen.getByLabelText('编辑品牌名称'), { target: { value: '合法品牌名' } });
    fireEvent.change(screen.getByLabelText('当地品牌名'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(screen.getByTestId('brand-market-error').textContent).toContain('请填写当地品牌名称');
    expect(updateBrandMock).not.toHaveBeenCalled();
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
  });

  it('skips Step B updateBrandMarket and omits targetMarket when user switches CN -> GLOBAL during Step A of combined save', async () => {
    const brand = makeDualMarketBrand();
    const updatedBase: BrandRecord = { ...brand, name: '青松科技-切换测试' };
    let resolveBase!: (value: BrandRecord) => void;
    updateBrandMock.mockImplementationOnce(
      () =>
        new Promise<BrandRecord>((resolve) => {
          resolveBase = resolve;
        }),
    );
    const onBrandUpdated = vi.fn();

    const { rerender } = render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '青松科技-切换测试' },
    });
    fireEvent.change(screen.getByLabelText('当地品牌名'), { target: { value: '青松 CN 改动' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(1));

    // Switch market CN -> GLOBAL while Step A is still in-flight
    rerender(
      <BrandIdentitySection
        brand={brand}
        activeMarket="GLOBAL"
        activeBrandMarket={brand.markets[1]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    await act(async () => {
      resolveBase(updatedBase);
      await Promise.resolve();
    });

    expect(onBrandUpdated).toHaveBeenCalledTimes(1);
    expect(onBrandUpdated).toHaveBeenCalledWith(updatedBase);
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
    expect(notifySuccessMock).toHaveBeenCalledWith('已保存品牌基础信息');
  });

  it('commits Step A base update but skips Step B updateBrandMarket when unmounted during Step A of combined save (W-07)', async () => {
    const brand = makeDualMarketBrand();
    const updatedBase: BrandRecord = { ...brand, name: '青松科技-卸载测试' };
    let resolveBase!: (value: BrandRecord) => void;
    updateBrandMock.mockImplementationOnce(
      () =>
        new Promise<BrandRecord>((resolve) => {
          resolveBase = resolve;
        }),
    );
    const onBrandUpdated = vi.fn();

    const { unmount } = render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('编辑品牌名称'), {
      target: { value: '青松科技-卸载测试' },
    });
    fireEvent.change(screen.getByLabelText('当地品牌名'), { target: { value: '青松 CN 未提交' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateBrandMock).toHaveBeenCalledTimes(1));

    // Unmount (e.g. brand switch) while Step A is still in-flight
    unmount();

    await act(async () => {
      resolveBase(updatedBase);
      await Promise.resolve();
    });

    expect(onBrandUpdated).toHaveBeenCalledTimes(1);
    expect(onBrandUpdated).toHaveBeenCalledWith(updatedBase);
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('clears sticky dirty bar immediately when saving whitespace-padded brandName that trims back to unchanged value', async () => {
    const brand = makeDualMarketBrand();
    updateBrandMock.mockResolvedValueOnce({ ...brand });
    const onBrandUpdated = vi.fn();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    const nameInput = screen.getByLabelText('编辑品牌名称') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '  青松存储  ' } });
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(screen.queryByTestId('brand-dirty-save-bar')).toBeNull();
    });
    expect(nameInput.value).toBe('青松存储');
    expect(notifySuccessMock).toHaveBeenCalledWith('已保存品牌基础信息');
  });

  it('clears sticky dirty bar immediately when saving whitespace-padded localBrandName and blank added competitor row', async () => {
    const brand = makeDualMarketBrand();
    updateBrandMarketMock.mockResolvedValueOnce({ ...brand });
    const onBrandUpdated = vi.fn();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    const localInput = screen.getByLabelText('当地品牌名') as HTMLInputElement;
    fireEvent.change(localInput, { target: { value: '  青松存储  ' } });
    fireEvent.click(screen.getByRole('button', { name: '+ 添加竞品' }));
    expect(screen.getByLabelText('市场竞品名称 2')).toBeTruthy();
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(screen.queryByTestId('brand-dirty-save-bar')).toBeNull();
    });
    expect(localInput.value).toBe('青松存储');
    expect(screen.queryByLabelText('市场竞品名称 2')).toBeNull();
    expect(notifySuccessMock).toHaveBeenCalledWith('已保存国内市场配置');
  });

  it('#385: blocks GLOBAL CJK identity save until explicit override checkbox is checked', async () => {
    const brand = makeDualMarketBrand();
    const globalMarket = brand.markets.find((m) => m.market === 'GLOBAL')!;
    const updatedBrand = {
      ...brand,
      markets: brand.markets.map((m) =>
        m.market === 'GLOBAL' ? { ...m, localBrandName: '青松海外拦截测试' } : m,
      ),
    };
    updateBrandMarketMock.mockResolvedValueOnce(updatedBrand);
    const onBrandUpdated = vi.fn();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="GLOBAL"
        activeBrandMarket={globalMarket}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    const localInput = screen.getByLabelText('当地品牌名') as HTMLInputElement;
    fireEvent.change(localInput, { target: { value: '青松海外拦截测试' } });

    // Guard checkbox appears inside global-guard-slot; 保存修改 remains clickable
    const overrideCheckbox = await screen.findByTestId('allow-cjk-global-identity-checkbox');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByTestId('brand-market-error')).toBeTruthy();
    expect(updateBrandMarketMock).not.toHaveBeenCalled();

    // Check override and save again -> passes allowCjkGlobalIdentity: true
    fireEvent.click(overrideCheckbox);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(updateBrandMarketMock).toHaveBeenCalledWith(
        brand.id,
        'GLOBAL',
        expect.objectContaining({
          localBrandName: '青松海外拦截测试',
          allowCjkGlobalIdentity: true,
        }),
        expect.anything(),
      );
    });
  });

  it('tracks monthlyRetestPointCap input, previews current month consumption, and saves via updateBrandMarket (#387)', async () => {
    const brand = makeDualMarketBrand();
    const globalMarket = brand.markets[1]!;
    const updatedBrand: BrandRecord = {
      ...brand,
      markets: brand.markets.map((m) =>
        m.market === 'GLOBAL' ? { ...m, monthlyRetestPointCap: 120 } : m,
      ),
    };
    updateBrandMarketMock.mockResolvedValueOnce(updatedBrand);
    const onBrandUpdated = vi.fn();

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="GLOBAL"
        activeBrandMarket={globalMarket}
        retestBudget={{
          monthKey: '2026-11',
          capPoints: 200,
          usedPoints: 40,
          remainingPoints: 160,
          skippedCount: 0,
        }}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    expect(screen.getByTestId('brand-retest-cap-field').textContent).toContain('2026-11');
    expect(screen.getByTestId('brand-retest-cap-field').textContent).toContain('已消耗 40 点');

    const capInput = screen.getByLabelText('本月自动复测点数上限') as HTMLInputElement;
    expect(capInput.value).toBe('');

    fireEvent.change(capInput, { target: { value: '120' } });
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(updateBrandMarketMock).toHaveBeenCalledWith(
        brand.id,
        'GLOBAL',
        expect.objectContaining({
          monthlyRetestPointCap: 120,
        }),
        expect.anything(),
      );
    });
    expect(onBrandUpdated).toHaveBeenCalledWith(updatedBrand, 'GLOBAL');
  });

  it('Tier 5 #3: allows saving unrelated GLOBAL market fields on existing CJK-confirmed brands without re-triggering CJK validation', async () => {
    const baseBrand = makeDualMarketBrand();
    const cjkGlobalBrand: BrandRecord = {
      ...baseBrand,
      markets: baseBrand.markets.map((m) =>
        m.market === 'GLOBAL'
          ? { ...m, localBrandName: '茶颜悦色', localCategory: 'Tea Beverage' }
          : m,
      ),
    };
    const globalMarket = cjkGlobalBrand.markets.find((m) => m.market === 'GLOBAL')!;
    const updatedBrand: BrandRecord = {
      ...cjkGlobalBrand,
      markets: cjkGlobalBrand.markets.map((m) =>
        m.market === 'GLOBAL' ? { ...m, monthlyRetestPointCap: 120 } : m,
      ),
    };
    updateBrandMarketMock.mockResolvedValueOnce(updatedBrand);
    const onBrandUpdated = vi.fn();

    render(
      <BrandIdentitySection
        brand={cjkGlobalBrand}
        activeMarket="GLOBAL"
        activeBrandMarket={globalMarket}
        readOnly={false}
        onBrandUpdated={onBrandUpdated}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    // Override checkbox should not block or appear when unchanged CJK identity is untouched
    expect(screen.queryByTestId('allow-cjk-global-identity-checkbox')).toBeNull();

    const capInput = screen.getByLabelText('本月自动复测点数上限') as HTMLInputElement;
    fireEvent.change(capInput, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(updateBrandMarketMock).toHaveBeenCalledTimes(1);
    });
    const sentPayload = updateBrandMarketMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sentPayload.monthlyRetestPointCap).toBe(120);
    expect(sentPayload).not.toHaveProperty('localBrandName');
    expect(screen.queryByTestId('brand-market-error')).toBeNull();
    expect(onBrandUpdated).toHaveBeenCalledWith(updatedBrand, 'GLOBAL');
  });

  it('opens grouped AI prefill modal with optional URL regenerate, supports uncheck & inline edit, appends without overwriting, and never silently saves (#405)', async () => {
    const brand = makeDualMarketBrand();
    suggestBrandMarketConfigMock
      .mockResolvedValueOnce({
        market: 'CN',
        aliases: ['DXP4800', 'PV-600', 'PV-800'],
        competitors: [
          { name: '群晖', aliases: [], domains: ['synology.com'] },
          { name: '极光盘盒', aliases: ['AuroraBox'], domains: ['aurorabox.example.com'] },
        ],
        seedPrompts: [
          { prompt: '2026年家用 NAS哪个品牌好？', intent: 'BUYING_GUIDE' },
          { prompt: '四盘位静音家用 NAS 避坑指南', intent: 'BUYING_GUIDE' },
          { prompt: '青松存储 PV-600 功耗与噪音实测', intent: 'SKU_REVIEW' },
        ],
        controlPrompts: ['家用路由器如何选择？', 'NAS 硬盘 RAID1 与 RAID5 差异'],
        fallbackUsed: false,
      })
      .mockResolvedValueOnce({
        market: 'CN',
        aliases: ['PV-900'],
        competitors: [],
        seedPrompts: [{ prompt: '青松存储 PV-900 六盘位评测', intent: 'SKU_REVIEW' }],
        controlPrompts: [],
        fallbackUsed: false,
      });

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={vi.fn()}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    // Manually add a custom alias before opening AI prefill to verify zero overwrite
    fireEvent.change(screen.getByLabelText('添加市场别名'), { target: { value: '手工保留词' } });
    fireEvent.click(screen.getAllByRole('button', { name: '+ 添加' })[0]!);
    expect(screen.getByText('手工保留词')).toBeTruthy();

    fireEvent.click(screen.getByTestId('brand-ai-prefill-btn'));

    await waitFor(() => {
      expect(suggestBrandMarketConfigMock).toHaveBeenCalledWith(
        'b-id-1',
        'CN',
        {},
        expect.anything(),
      );
    });

    // All groups render and default checked
    expect(await screen.findByTestId('ai-suggest-group-aliases')).toBeTruthy();
    expect(screen.getByTestId('ai-suggest-group-competitors')).toBeTruthy();
    expect(screen.getByTestId('ai-suggest-group-seedPrompts')).toBeTruthy();
    expect(screen.getByTestId('ai-suggest-group-controlPrompts')).toBeTruthy();

    // Uncheck PV-800 (3rd alias) and inline-edit PV-600 -> PV-600 Pro
    fireEvent.click(screen.getByLabelText('勾选别名建议 3'));
    fireEvent.change(screen.getByLabelText('编辑别名建议 2'), {
      target: { value: 'PV-600 Pro' },
    });

    // Adopt selected items
    fireEvent.click(screen.getByTestId('brand-ai-suggest-confirm-btn'));

    // Never silently writes to DB
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
    expect(updateBrandMock).not.toHaveBeenCalled();

    // Preserved user items + appended edited items + excluded unchecked item
    expect(screen.getByText('手工保留词')).toBeTruthy();
    expect(screen.getByText('DXP4800')).toBeTruthy();
    expect(screen.getByText('PV-600 Pro')).toBeTruthy();
    expect(screen.queryByText('PV-800')).toBeNull();
    expect(screen.getByDisplayValue('极光盘盒')).toBeTruthy();
    expect(screen.getByDisplayValue('群晖')).toBeTruthy();
    expect(screen.getByText('四盘位静音家用 NAS 避坑指南')).toBeTruthy();
    expect(screen.getByText('青松存储 PV-600 功耗与噪音实测')).toBeTruthy();
    expect(screen.getByText('NAS 硬盘 RAID1 与 RAID5 差异')).toBeTruthy();
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();

    // Re-open and test optional product page URL regenerate
    fireEvent.click(screen.getByTestId('brand-ai-prefill-btn'));
    await screen.findByTestId('brand-ai-suggest-modal');
    fireEvent.change(screen.getByLabelText('补充商品页链接（选填）'), {
      target: { value: 'https://pinevault.example.com/pv-900' },
    });
    suggestBrandMarketConfigMock.mockResolvedValueOnce({
      market: 'CN',
      aliases: ['PV-900'],
      competitors: [],
      seedPrompts: [{ prompt: '青松存储 PV-900 六盘位评测', intent: 'SKU_REVIEW' }],
      controlPrompts: [],
      fallbackUsed: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '结合链接重新生成' }));
    await waitFor(() => {
      expect(suggestBrandMarketConfigMock).toHaveBeenLastCalledWith(
        'b-id-1',
        'CN',
        { sourceUrl: 'https://pinevault.example.com/pv-900' },
        expect.anything(),
      );
    });
  });

  it('enforces field caps (5 control prompts) with truncation warning when adopting AI suggestions', async () => {
    const brand = makeDualMarketBrand();
    brand.markets[0]!.controlPrompts = ['已有对照 1', '已有对照 2', '已有对照 3', '已有对照 4'];
    suggestBrandMarketConfigMock.mockResolvedValueOnce({
      market: 'CN',
      aliases: [],
      competitors: [],
      seedPrompts: [],
      controlPrompts: ['新增对照 A', '新增对照 B', '新增对照 C'],
      fallbackUsed: false,
    });

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={vi.fn()}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('brand-ai-prefill-btn'));
    await screen.findByTestId('ai-suggest-group-controlPrompts');
    fireEvent.click(screen.getByTestId('brand-ai-suggest-confirm-btn'));

    // Only 1 slot remaining out of 5 -> 2 truncated with warning
    expect(screen.getByText('新增对照 A')).toBeTruthy();
    expect(screen.queryByText('新增对照 B')).toBeNull();
    expect(notifyWarningMock).toHaveBeenCalledWith(expect.stringContaining('对照组截断 2 条'));
  });

  it('upgrades 按当前品类重新生成种子问句 to AI suggest and falls back to static templates on error without overwriting existing seeds', async () => {
    const brand = makeDualMarketBrand();
    suggestBrandMarketConfigMock.mockRejectedValueOnce(new Error('网络超时'));

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="CN"
        activeBrandMarket={brand.markets[0]!}
        readOnly={false}
        onBrandUpdated={vi.fn()}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '按当前品类重新生成种子问句' }));

    await waitFor(() => {
      expect(suggestBrandMarketConfigMock).toHaveBeenCalledWith(
        'b-id-1',
        'CN',
        { fields: ['seedPrompts'] },
        expect.anything(),
      );
    });

    // Fallback notice shown inside preview modal with static template prompts
    expect(await screen.findByTestId('brand-ai-suggest-fallback-notice')).toBeTruthy();
    expect(screen.getByTestId('ai-suggest-group-seedPrompts')).toBeTruthy();

    fireEvent.click(screen.getByTestId('brand-ai-suggest-confirm-btn'));

    // Existing seed prompt preserved (append-only, never overwritten)
    expect(screen.getByText('2026年家用 NAS哪个品牌好？')).toBeTruthy();
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();
  });

  it('provides AI 一键英文本地化 inside GLOBAL localization warning banner and updates English identity on adopt', async () => {
    const brand = makeDualMarketBrand();
    // Simulate CJK localBrandName & empty localCategory on GLOBAL market
    brand.markets[1]!.localBrandName = '青松存储';
    brand.markets[1]!.localCategory = null;

    suggestBrandMarketConfigMock.mockResolvedValueOnce({
      market: 'GLOBAL',
      localBrandName: 'PineVault',
      localCategory: 'Home NAS',
      aliases: [],
      competitors: [],
      seedPrompts: [],
      controlPrompts: [],
      fallbackUsed: false,
    });

    render(
      <BrandIdentitySection
        brand={brand}
        activeMarket="GLOBAL"
        activeBrandMarket={brand.markets[1]!}
        readOnly={false}
        onBrandUpdated={vi.fn()}
        onOpenEnableMarket={vi.fn()}
      />,
    );

    expect(screen.getByTestId('global-localization-guide')).toBeTruthy();
    fireEvent.click(screen.getByTestId('global-ai-localize-btn'));

    await waitFor(() => {
      expect(suggestBrandMarketConfigMock).toHaveBeenCalledWith(
        'b-id-1',
        'GLOBAL',
        { fields: ['localIdentity'] },
        expect.anything(),
      );
    });

    expect(await screen.findByTestId('ai-suggest-group-localIdentity')).toBeTruthy();
    fireEvent.click(screen.getByTestId('brand-ai-suggest-confirm-btn'));

    expect((screen.getByLabelText('当地品牌名') as HTMLInputElement).value).toBe('PineVault');
    expect((screen.getByLabelText('当地品类名称') as HTMLInputElement).value).toBe('Home NAS');
    expect(updateBrandMarketMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('brand-dirty-save-bar')).toBeTruthy();
  });
});
