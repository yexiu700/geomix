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

describe('SideMenu (GeoMix 2.0 flat 4+1 sidebar)', () => {
  it('renders flat 4 business workspaces and bottom-left sider-account-entry with zero submenus or legacy hints', () => {
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
      '行动首页',
      '品牌资产',
      '可见度诊断',
      'GEO 写作台',
    ]);
    expect(document.querySelectorAll('.ant-menu-submenu')).toHaveLength(0);
    expect(screen.queryByText(/敬请期待|更多规划功能|余额明细/)).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: '品牌资产' }));
    expect(onNavigate).toHaveBeenCalledWith('/brands');

    const accountEntry = screen.getByTestId('sider-account-entry');
    expect(accountEntry.textContent).toContain('演示品牌主');
    expect(accountEntry.textContent).toContain('点数与权益');
    fireEvent.click(accountEntry);
    expect(onNavigate).toHaveBeenCalledWith('/account');
  });

  it('hides /visibility when visibilityEnabled=false and returns null when collapsed', () => {
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

    expect(screen.queryByRole('menuitem', { name: '可见度诊断' })).toBeNull();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);

    rerender(
      <SideMenu
        activePath="/home"
        collapsed={true}
        account={account}
        onNavigate={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
