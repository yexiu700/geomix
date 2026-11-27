// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../../lib/api';
import { SideMenu } from './side-menu';

const account: AccountProfile = {
  id: 'u-1',
  username: 'demo',
  nickname: '演示品牌主',
  role: 'MERCHANT',
  tenant: {
    id: 't-1',
    name: '演示租户',
    expiresAt: '2027-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

describe('SideMenu (GeoMix flat 5+1 sidebar)', () => {
  it('renders flat 5 business workspaces and bottom-left sider-account-entry with zero submenus or legacy hints', () => {
    const onNavigate = vi.fn();
    render(
      <SideMenu
        activePath="/home"
        collapsed={false}
        account={account}
        onNavigate={onNavigate}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      '首页',
      '品牌',
      '诊断',
      '写作',
      '发布',
    ]);
    const navIcons = Array.from(document.querySelectorAll('.ant-menu-item svg'));
    expect(navIcons).toHaveLength(5);
    for (const icon of navIcons) {
      expect(icon.classList.contains('gm-sider-nav-icon')).toBe(true);
      expect(icon.classList.contains('ant-menu-item-icon')).toBe(true);
    }
    expect(document.querySelectorAll('.ant-menu-submenu')).toHaveLength(0);
    expect(screen.queryByText(/敬请期待|更多规划功能|余额明细/)).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: '品牌' }));
    expect(onNavigate).toHaveBeenCalledWith('/brands');

    const accountEntry = screen.getByTestId('sider-account-entry');
    expect(accountEntry.textContent).toContain('演示品牌主');
    expect(accountEntry.textContent).toContain('账户');
    fireEvent.click(accountEntry);
    expect(onNavigate).toHaveBeenCalledWith('/account');

    // Y2: duplicate account item removed from ⋯ dropdown menu
    fireEvent.click(screen.getByRole('button', { name: '账号菜单' }));
    expect(screen.queryByRole('menuitem', { name: '点数与权益' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '修改密码' })).toBeTruthy();
  });

  it('hides /visibility when visibilityEnabled=false and returns null only when mobileClosed=true', () => {
    const { rerender, container } = render(
      <SideMenu
        activePath="/home"
        collapsed={false}
        account={account}
        visibilityEnabled={false}
        onNavigate={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.queryByRole('menuitem', { name: '诊断' })).toBeNull();
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);

    rerender(
      <SideMenu
        activePath="/home"
        collapsed={true}
        mobileClosed={true}
        account={account}
        onNavigate={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders 72px icon rail with full accessible names, 2-char visible short labels, and 180-deg bottom toggle', () => {
    const onToggleCollapse = vi.fn();
    render(
      <SideMenu
        activePath="/studio"
        collapsed={true}
        showCollapseToggle={true}
        onToggleCollapse={onToggleCollapse}
        account={account}
        onNavigate={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    const root = screen.getByTestId('side-menu-root');
    expect(root.className).toContain('gm-sider-wrap-rail');
    expect(root.textContent).toContain('GeoMix');

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      '首页',
      '品牌',
      '诊断',
      '写作',
      '发布',
    ]);
    expect(screen.getByRole('menuitem', { name: '首页' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '品牌' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '诊断' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '写作' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '发布' })).toBeTruthy();

    const shortLabels = Array.from(document.querySelectorAll('.gm-sider-rail-short')).map((el) =>
      el.textContent?.trim(),
    );
    expect(shortLabels).toEqual(['首页', '品牌', '诊断', '写作', '发布']);

    expect(screen.getByTestId('sider-account-entry')).toBeTruthy();
    const toggleBtn = screen.getByTestId('sider-collapse-toggle');
    expect(toggleBtn.getAttribute('aria-controls')).toBe('gm-sider-nav');
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(toggleBtn.getAttribute('aria-label')).toBe('展开菜单');
    expect(toggleBtn.querySelector('.gm-sider-collapse-icon.is-collapsed')).toBeTruthy();

    fireEvent.click(toggleBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('renders quiet 运营后台 link for ADMIN outside <Menu> above account entry and omits it for MERCHANT', () => {
    const adminAccount: AccountProfile = { ...account, role: 'ADMIN' };
    const { rerender } = render(
      <SideMenu
        activePath="/home"
        collapsed={false}
        account={adminAccount}
        onNavigate={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    const adminLink = screen.getByRole('link', { name: '运营后台' });
    expect(adminLink.getAttribute('href')).toBe('/admin/tenants');
    expect(adminLink.closest('.ant-menu')).toBeNull();
    const accountEntry = screen.getByTestId('sider-account-entry');
    expect(
      adminLink.compareDocumentPosition(accountEntry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    rerender(
      <SideMenu
        activePath="/home"
        collapsed={false}
        account={account}
        onNavigate={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.queryByRole('link', { name: '运营后台' })).toBeNull();
  });
});
