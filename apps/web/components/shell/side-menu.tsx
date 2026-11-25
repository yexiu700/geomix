'use client';

import { SITE_NAME } from '@geomix/shared';
import { Dropdown, Menu, type MenuProps } from 'antd';
import { useMemo } from 'react';
import type { AccountProfile } from '../../lib/api';
import { HOME_ROUTE, buildMenu, menuSelection } from '../../lib/routes';
import { displayName } from '../../lib/shell-copy';
import { GeoMixIcon, GeoMixLockup } from '../brand/geomix-logo';

export type SideMenuProps = {
  activePath: string;
  collapsed: boolean;
  account: AccountProfile;
  visibilityEnabled?: boolean;
  onNavigate: (href: string) => void;
  onChangePassword: () => void;
  onLogout: () => void;
};

export function SideMenu({
  activePath,
  collapsed,
  account,
  visibilityEnabled = true,
  onNavigate,
  onChangePassword,
  onLogout,
}: SideMenuProps) {
  const navItems = useMemo(() => buildMenu({ visibilityEnabled }), [visibilityEnabled]);
  const selection = menuSelection(activePath);

  if (collapsed) return null;

  const name = displayName(account);
  const isAccountActive = selection.selected === '/account';
  const menuItems: MenuProps['items'] = navItems.map((item) => ({
    key: item.href,
    label: item.title,
  }));

  return (
    <div className="gm-sider-wrap" data-testid="side-menu-root">
      <div className="gm-sider-brand">
        <button
          type="button"
          className="gm-sider-brand-btn"
          aria-label={`返回${SITE_NAME}行动首页`}
          onClick={() => onNavigate(HOME_ROUTE)}
        >
          <GeoMixLockup height={22} className="gm-brand-lockup" />
          <span className="gm-sr-only">{SITE_NAME}</span>
        </button>
      </div>
      <nav className="gm-sider-nav" aria-label="主导航">
        <Menu
          mode="inline"
          inlineCollapsed={false}
          theme="dark"
          selectedKeys={[selection.selected]}
          items={menuItems}
          onClick={({ key }) => {
            if (key.startsWith('/')) {
              onNavigate(key);
            }
          }}
          style={{ borderInlineEnd: 0, background: 'transparent' }}
        />
      </nav>
      <div className="gm-sider-account">
        <button
          type="button"
          data-testid="sider-account-entry"
          aria-label="点数与权益"
          aria-current={isAccountActive ? 'page' : undefined}
          className={isAccountActive ? 'gm-sider-account-btn active' : 'gm-sider-account-btn'}
          onClick={() => onNavigate('/account')}
        >
          <span className="gm-avatar" aria-hidden="true">
            {name.slice(0, 1)}
          </span>
          <span className="gm-sider-account-meta">
            <span className="gm-sider-account-name gm-clamp-1">{name}</span>
            <span className="gm-sider-account-sub gm-clamp-1">
              {account.tenant.readOnly ? '已到期 · 只读' : '点数与权益'}
            </span>
          </span>
        </button>
        <Dropdown
          trigger={['click']}
          placement="topRight"
          menu={{
            items: [
              { key: 'account', label: '点数与权益' },
              { key: 'password', label: '修改密码' },
              { type: 'divider' },
              { key: 'logout', label: '退出登录', danger: true },
            ],
            onClick: ({ key }) => {
              if (key === 'account') onNavigate('/account');
              if (key === 'password') onChangePassword();
              if (key === 'logout') onLogout();
            },
          }}
        >
          <button
            type="button"
            className="gm-sider-account-more"
            aria-label="账号菜单"
            title="账号菜单"
          >
            ⋯
          </button>
        </Dropdown>
      </div>
    </div>
  );
}

export function BrandMark() {
  return <GeoMixIcon size={20} className="gm-brand-mark" />;
}
