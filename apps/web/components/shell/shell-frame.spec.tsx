// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
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

  it('shows 0-brand banner only on split workspaces (/studio, /publish) and submits quick-create modal', async () => {
    const createdBrand = makeBrand('b-new', '智造激光', ['CN']);
    const onCreateBrand = vi.fn(async () => createdBrand);

    const { rerender } = render(
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
        <div>首页占位</div>
      </ShellFrame>,
    );

    // /home has its own EmptyState CTA so shell onboarding banner must stay hidden
    expect(screen.queryByRole('region', { name: '首次建档引导' })).toBeNull();

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/studio"
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
        <div>写作占位</div>
      </ShellFrame>,
    );

    expect(screen.getByTestId('header-points-pill').textContent).toContain('1000');
    const banner = screen.getByRole('region', { name: '首次建档引导' });
    fireEvent.click(within(banner).getByRole('button', { name: '建品牌' }));

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

    const dialog = await screen.findByRole('dialog', { name: '开启海外' });
    fireEvent.change(within(dialog).getByLabelText('当地品牌名称'), {
      target: { value: 'UGREEN' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /开\s*启/ }));

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

  it('renders a compact retry button instead of Create First Brand when brandsError is set (W-04)', () => {
    const onRetryBrands = vi.fn();
    render(
      <ShellFrame
        account={merchantAccount}
        activePath="/visibility"
        brands={[]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError="服务暂时不可用"
        activeBrandId={null}
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onRetryBrands={onRetryBrands}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>内容</div>
      </ShellFrame>,
    );

    const retryBtn = screen.getByTestId('global-brand-switcher-retry');
    expect(retryBtn.textContent?.replace(/\s+/g, '')).toContain('重试');
    expect(screen.queryByRole('button', { name: '建品牌' })).toBeNull();
    fireEvent.click(retryBtn);
    expect(onRetryBrands).toHaveBeenCalledTimes(1);
  });

  it('converges desktop topbar to <= 5 elements with zero breadcrumb/header admin/header collapse and bell modal', async () => {
    const dual = makeBrand('b-1', 'NordicAudio', ['CN', 'GLOBAL']);
    const adminAccount: AccountProfile = { ...merchantAccount, role: 'ADMIN' };

    const { rerender } = render(
      <ShellFrame
        account={adminAccount}
        activePath="/home"
        brands={[dual]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId="b-1"
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        announcement="  本周三 02:00 进行引擎升级  "
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>行动首页</div>
      </ShellFrame>,
    );

    const header = document.querySelector('header.gm-header');
    expect(header).toBeTruthy();
    const leftChildren = header!.querySelectorAll(':scope > .gm-header-left > *');
    const rightChildren = header!.querySelectorAll(':scope > .gm-header-right > *');
    expect(leftChildren.length + rightChildren.length).toBeLessThanOrEqual(5);
    expect(leftChildren.length).toBe(2);
    expect(rightChildren.length).toBe(3);

    expect(header!.querySelector('nav[aria-label="面包屑"]')).toBeNull();
    expect(within(header as HTMLElement).queryByRole('link', { name: '运营后台' })).toBeNull();
    expect(
      within(header as HTMLElement).queryByRole('button', { name: /收起菜单|展开菜单/ }),
    ).toBeNull();
    expect(header!.querySelector('.gm-avatar')).toBeNull();

    const sider = document.querySelector('aside.ant-layout-sider');
    expect(sider).toBeTruthy();
    expect(within(sider as HTMLElement).getByRole('link', { name: '运营后台' })).toBeTruthy();

    const bellBtn = screen.getByTestId('header-announcement-bell');
    expect(bellBtn.querySelector('.gm-announce-bell-dot')).toBeTruthy();
    fireEvent.click(bellBtn);
    const dialog = await screen.findByRole('dialog', { name: '系统公告' });
    expect(dialog.textContent).toContain('本周三 02:00 进行引擎升级');
    fireEvent.click(within(dialog).getByRole('button', { name: '知道了' }));

    rerender(
      <ShellFrame
        account={adminAccount}
        activePath="/home"
        brands={[dual]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId="b-1"
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        announcement={null}
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>行动首页</div>
      </ShellFrame>,
    );

    expect(screen.queryByTestId('header-announcement-bell')).toBeNull();
  });

  it('auto-collapses /studio to 72px rail, expands locally without calling onToggleMenu, and applies route-typed containers', () => {
    const dual = makeBrand('b-1', 'NordicAudio', ['CN', 'GLOBAL']);
    const onToggleMenu = vi.fn();

    const { rerender } = render(
      <ShellFrame
        account={merchantAccount}
        activePath="/home"
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
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={onToggleMenu}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>内容</div>
      </ShellFrame>,
    );

    expect(document.querySelector('.gm-workspace-main--wide')).toBeTruthy();
    expect(document.querySelector('aside.gm-sider-rail')).toBeNull();

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/brands"
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
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={onToggleMenu}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>品牌资产</div>
      </ShellFrame>,
    );
    expect(document.querySelector('.gm-workspace-main--form')).toBeTruthy();

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/studio"
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
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={onToggleMenu}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>GEO 写作台</div>
      </ShellFrame>,
    );
    expect(document.querySelector('.gm-workspace-main--studio')).toBeTruthy();
    expect(document.querySelector('.gm-content--studio')).toBeTruthy();
    expect(document.querySelector('aside.gm-sider-rail')).toBeTruthy();

    const toggleBtn = screen.getByTestId('sider-collapse-toggle');
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggleBtn);
    expect(onToggleMenu).not.toHaveBeenCalled();
    expect(document.querySelector('aside.gm-sider-rail')).toBeNull();
    expect(screen.getByTestId('sider-collapse-toggle').getAttribute('aria-expanded')).toBe('true');

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/home"
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
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={onToggleMenu}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>行动首页</div>
      </ShellFrame>,
    );
    expect(document.querySelector('aside.gm-sider-rail')).toBeNull();
    expect(document.querySelector('.gm-workspace-main--wide')).toBeTruthy();

    // Re-entering /studio after previously expanding locally must render gm-sider-rail on Commit 1 (no 1-frame flash)
    const commit1Classes: string[] = [];
    function LayoutCommitSpy({ marker }: { marker: string }) {
      useLayoutEffect(() => {
        const aside = document.querySelector('aside.ant-layout-sider');
        commit1Classes.push(`${marker}:${aside?.className ?? ''}`);
      }, [marker]);
      return <div>GEO 写作台再进入</div>;
    }

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/studio"
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
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={onToggleMenu}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <LayoutCommitSpy marker="reenter-studio" />
      </ShellFrame>,
    );
    expect(commit1Classes[0]).toContain('gm-sider-rail');
    expect(document.querySelector('aside.gm-sider-rail')).toBeTruthy();

    rerender(
      <ShellFrame
        account={merchantAccount}
        activePath="/publish"
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
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={onToggleMenu}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>发布中心</div>
      </ShellFrame>,
    );
    expect(document.querySelector('.gm-workspace-main--studio')).toBeTruthy();
    expect(document.querySelector('.gm-content--studio')).toBeTruthy();
    expect(document.querySelector('aside.gm-sider-rail')).toBeTruthy();
  });

  it('Tier 5 #5: resets enableAllowCjkGlobal checkbox in Enable-Market modal when CJK is cleared and later re-entered', async () => {
    const cnOnlyBrand = makeBrand('b-cn-only', '绿联', ['CN']);

    render(
      <ShellFrame
        account={merchantAccount}
        activePath="/home"
        brands={[cnOnlyBrand]}
        brandsLoading={false}
        brandsLoaded={true}
        brandsError={null}
        activeBrandId="b-cn-only"
        activeMarket="CN"
        menuCollapsed={false}
        wallet={walletStub}
        walletLoading={false}
        enableMarketModalTarget="GLOBAL"
        onNavigate={vi.fn()}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onCreateBrand={vi.fn()}
        onEnableMarket={vi.fn()}
        onToggleMenu={vi.fn()}
        onLogout={vi.fn()}
        onChangePassword={vi.fn()}
      >
        <div>首页</div>
      </ShellFrame>,
    );

    const dialog = await screen.findByRole('dialog');
    const cjkCheckbox = (await within(dialog).findByTestId(
      'enable-market-allow-cjk-global-checkbox',
    )) as HTMLInputElement;
    fireEvent.click(cjkCheckbox);
    expect(cjkCheckbox.checked).toBe(true);

    // Replace Chinese localBrandName with English -> checkbox unmounts and resets
    fireEvent.change(within(dialog).getByLabelText('当地品牌名称'), {
      target: { value: 'UGREEN' },
    });
    await waitFor(() => {
      expect(within(dialog).queryByTestId('enable-market-allow-cjk-global-checkbox')).toBeNull();
    });

    // Enter CJK in localCategory -> checkbox MUST reappear UNCHECKED
    fireEvent.change(within(dialog).getByLabelText('当地品类名称'), {
      target: { value: '氮化镓快充' },
    });
    const reappeared = (await within(dialog).findByTestId(
      'enable-market-allow-cjk-global-checkbox',
    )) as HTMLInputElement;
    expect(reappeared.checked).toBe(false);
  });
});
