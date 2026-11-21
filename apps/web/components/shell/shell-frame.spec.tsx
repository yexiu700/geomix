// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletSummary } from '../../lib/account-client';
import type { AccountProfile } from '../../lib/api';
import { ShellFrame } from './shell-frame';

const merchantAccount: AccountProfile = {
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

const walletStub: WalletSummary = {
  points: 1000,
  pointsReserved: 0,
  available: 1000,
  money: '0.00',
  billingMode: 'SHADOW',
  billingModeSource: 'global',
  tenantBillingMode: null,
};

function makeBrand(id: string, name: string, markets: Array<'CN' | 'GLOBAL'>): BrandRecord {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id,
    name,
    category: '家用 NAS',
    truthAgreementSignedAt: null,
    createdAt: now,
    updatedAt: now,
    markets: markets.map((market) => ({
      id: `${id}-${market}`,
      brandId: id,
      market,
      locale: market === 'CN' ? 'zh-CN' : 'en-US',
      region: market === 'CN' ? 'CN' : 'US',
      localBrandName: name,
      aliases: [],
      ownedDomains: [],
      competitors: [],
      seedPrompts: [],
      createdAt: now,
      updatedAt: now,
    })),
  };
}

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

describe('ShellFrame (GeoMix 2.0 minimalist 5-workspace shell)', () => {
  it('renders cold-load skeletons for brand switcher and points pill with zero 0 点 / 免费体验期 / ¥0.00 flash', () => {
    render(
      <ShellFrame
        account={merchantAccount}
        activePath="/home"
        brands={[]}
        brandsLoading={true}
        brandsLoaded={false}
        brandsError={null}
        activeBrandId={null}
        activeMarket="CN"
        menuCollapsed={false}
        wallet={null}
        walletLoading={true}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>工作区内容</div>
      </ShellFrame>,
    );

    expect(screen.getByTestId('global-brand-switcher-loading')).toBeTruthy();
    expect(screen.getByTestId('header-points-loading')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b0\s*点\b/);
    expect(document.body.textContent).not.toContain('免费体验期');
    expect(document.body.textContent).not.toContain('¥0.00');
    // Zero legacy TabBar / TabDraftNote / LayoutPanel
    expect(document.querySelector('.gm-tabs')).toBeNull();
    expect(document.querySelector('.gm-mode')).toBeNull();
    expect(screen.queryByRole('button', { name: '布局' })).toBeNull();
  });

  it('shows 0-brand 60s onboarding banner and submits quick-create modal', async () => {
    const createdBrand = makeBrand('b-new', '智造激光', ['CN']);
    const onCreateBrand = vi.fn(async () => createdBrand);

    render(
      <ShellFrame
        account={merchantAccount}
        activePath="/home"
        brands={[]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId={null}
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={onCreateBrand}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>行动首页占位</div>
      </ShellFrame>,
    );

    expect(screen.getByTestId('header-points-pill').textContent).toContain('1000');
    fireEvent.click(screen.getByRole('button', { name: '60 秒创建首个品牌' }));

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    expect(within(dialog).getByTestId('brand-quick-create')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), {
      target: { value: '智造激光' },
    });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), {
      target: { value: '工业激光设备' },
    });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'https://zhizao.example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    await waitFor(() => {
      expect(onCreateBrand).toHaveBeenCalledWith({
        name: '智造激光',
        category: '工业激光设备',
        markets: ['CN'],
        ownedDomains: ['zhizao.example.com'],
        competitors: [],
      });
    });
  });

  it('renders single-market + 开启另一市场 button, opens modal, and switches CN <-> GLOBAL when dual-market', async () => {
    const cnOnly = makeBrand('b-1', '绿联', ['CN']);
    const dual = makeBrand('b-1', '绿联', ['CN', 'GLOBAL']);
    const onEnableMarket = vi.fn(async () => dual);
    const onSelectMarket = vi.fn();

    const { rerender } = render(
      <ShellFrame
        account={merchantAccount}
        activePath="/visibility"
        brands={[cnOnly]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId="b-1"
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={onSelectMarket}
        onCreateBrand={vi.fn()}
        onEnableMarket={onEnableMarket}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>可见度诊断</div>
      </ShellFrame>,
    );

    expect(screen.getByTestId('global-brand-switcher')).toBeTruthy();
    expect(screen.getByTestId('global-market-switcher')).toBeTruthy();
    fireEvent.click(screen.getByTestId('enable-other-market-btn'));

    const dialog = await screen.findByRole('dialog', { name: '开启海外市场' });
    fireEvent.change(within(dialog).getByLabelText('当地品牌名称'), {
      target: { value: 'UGREEN' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认开启' }));

    await waitFor(() => {
      expect(onEnableMarket).toHaveBeenCalledWith('b-1', 'GLOBAL', {
        localBrandName: 'UGREEN',
        ownedDomains: [],
        competitors: [],
      });
    });

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/visibility"
        brands={[dual]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId="b-1"
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={onSelectMarket}
        onCreateBrand={vi.fn()}
        onEnableMarket={onEnableMarket}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>可见度诊断</div>
      </ShellFrame>,
    );

    expect(screen.queryByTestId('enable-other-market-btn')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /海外/ }));
    expect(onSelectMarket).toHaveBeenCalledWith('GLOBAL');
  });

  it('never leaks raw brand CUIDs into document.body textContent even if activeBrandId is transiently unmatched', () => {
    const cuid1 = 'cmwqk6gel009syolb3wq0a756';
    const cuid2 = 'cmwqk6gel009syolb3wq0a999';
    const brandWithCuid: BrandRecord = makeBrand(cuid1, '极光智储', ['CN']);

    const { rerender } = render(
      <ShellFrame
        account={merchantAccount}
        activePath="/brands"
        brands={[brandWithCuid]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId={cuid1}
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>品牌资产</div>
      </ShellFrame>,
    );

    expect(document.body.textContent ?? '').toContain('极光智储');
    expect(document.body.textContent ?? '').not.toContain(cuid1);

    // Transiently unmatched activeBrandId must not fall back to displaying raw CUID
    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/brands"
        brands={[brandWithCuid]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId={cuid2}
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>品牌资产</div>
      </ShellFrame>,
    );

    expect(document.body.textContent ?? '').not.toContain(cuid1);
    expect(document.body.textContent ?? '').not.toContain(cuid2);
  });
});
