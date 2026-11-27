'use client';

import { SITE_NAME } from '@geomix/shared';
import { Dropdown, Menu, type MenuProps } from 'antd';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import type { AccountProfile } from '../../lib/api';
import { HOME_ROUTE, buildMenu, menuSelection } from '../../lib/routes';
import { displayName } from '../../lib/shell-copy';
import { GeoMixIcon, GeoMixLockup } from '../brand/geomix-logo';

export type SideMenuProps = {
  activePath: string;
  collapsed: boolean;
  mobileClosed?: boolean;
  showCollapseToggle?: boolean;
  onToggleCollapse?: () => void;
  account: AccountProfile;
  visibilityEnabled?: boolean;
  onNavigate: (href: string) => void;
  onChangePassword: () => void;
  onLogout: () => void;
};

type RailLabelParts = {
  prefix: string;
  short: string;
  suffix: string;
};

const RAIL_LABEL_PARTS: Readonly<Record<string, RailLabelParts>> = {
  '/home': { prefix: '', short: '首页', suffix: '' },
  '/brands': { prefix: '', short: '品牌', suffix: '' },
  '/visibility': { prefix: '', short: '诊断', suffix: '' },
  '/studio': { prefix: '', short: '写作', suffix: '' },
  '/publish': { prefix: '', short: '发布', suffix: '' },
};

function renderRailSplitLabel(parts: RailLabelParts): ReactNode {
  return (
    <span className="gm-sider-rail-label">
      {parts.prefix ? <span className="gm-sider-rail-hidden">{parts.prefix}</span> : null}
      <span className="gm-sider-rail-short">{parts.short}</span>
      {parts.suffix ? <span className="gm-sider-rail-hidden">{parts.suffix}</span> : null}
    </span>
  );
}

type AccessibleMenuItem = NonNullable<MenuProps['items']>[number] & {
  'aria-label'?: string;
};

export function SideMenu({
  activePath,
  collapsed,
  mobileClosed = false,
  showCollapseToggle,
  onToggleCollapse,
  account,
  visibilityEnabled = true,
  onNavigate,
  onChangePassword,
  onLogout,
}: SideMenuProps) {
  const navItems = useMemo(() => buildMenu({ visibilityEnabled }), [visibilityEnabled]);
  const selection = menuSelection(activePath);

  if (mobileClosed) return null;

  const name = displayName(account);
  const isAccountActive = selection.selected === '/account';
  const showToggle = showCollapseToggle ?? Boolean(onToggleCollapse);
  const collapseToggleLabel = collapsed ? '展开菜单' : '收起菜单';

  const menuItems: AccessibleMenuItem[] = navItems.map((item) => {
    const railParts = RAIL_LABEL_PARTS[item.href];
    return {
      key: item.href,
      icon: <WorkspaceNavIcon href={item.href} />,
      title: item.title,
      'aria-label': item.title,
      label: collapsed && railParts ? renderRailSplitLabel(railParts) : item.title,
    };
  });

  return (
    <div
      className={collapsed ? 'gm-sider-wrap gm-sider-wrap-rail' : 'gm-sider-wrap'}
      data-testid="side-menu-root"
    >
      <div className="gm-sider-brand">
        <button
          type="button"
          className="gm-sider-brand-btn"
          aria-label={`返回${SITE_NAME}首页`}
          title={SITE_NAME}
          onClick={() => onNavigate(HOME_ROUTE)}
        >
          {collapsed ? <BrandMark /> : <GeoMixLockup height={22} className="gm-brand-lockup" />}
          <span className="gm-sr-only">{SITE_NAME}</span>
        </button>
      </div>
      <nav className="gm-sider-nav" aria-label="主导航">
        <Menu
          className="gm-sider-menu"
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
        />
      </nav>
      <div className="gm-sider-footer">
        {account.role === 'ADMIN' ? (
          <div className="gm-sider-admin-wrap">
            <Link
              href="/admin/tenants"
              className="gm-sider-admin-link"
              aria-label="运营后台"
              title="运营后台"
            >
              <AdminEntryIcon />
              {collapsed ? (
                renderRailSplitLabel({ prefix: '运营', short: '后台', suffix: '' })
              ) : (
                <span>运营后台</span>
              )}
            </Link>
          </div>
        ) : null}

        <div className="gm-sider-account">
          <button
            type="button"
            data-testid="sider-account-entry"
            aria-label="账户"
            title={`${name} · 账户`}
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
                {account.tenant.readOnly ? '只读' : '账户'}
              </span>
            </span>
          </button>
          <Dropdown
            trigger={['click']}
            placement="topRight"
            menu={{
              items: [
                { key: 'password', label: '修改密码' },
                { type: 'divider' },
                { key: 'logout', label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
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

        {showToggle && onToggleCollapse ? (
          <div className="gm-sider-toggle-bar">
            <button
              type="button"
              className="gm-sider-collapse-btn"
              data-testid="sider-collapse-toggle"
              aria-controls="gm-sider-nav"
              aria-expanded={!collapsed}
              aria-label={collapseToggleLabel}
              title={collapseToggleLabel}
              onClick={onToggleCollapse}
            >
              <CollapseArrowIcon collapsed={collapsed} />
              {!collapsed ? <span className="gm-sider-collapse-label">收起</span> : null}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceNavIcon({ href, className }: { href: string; className?: string }) {
  const svgClassName = className ? `gm-sider-nav-icon ${className}` : 'gm-sider-nav-icon';
  if (href === '/home') {
    return (
      <svg
        className={svgClassName}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M2.5 7.4L8 2.8L13.5 7.4V13.2H9.8V9.6H6.2V13.2H2.5V7.4Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (href === '/brands') {
    return (
      <svg
        className={svgClassName}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M8 2.4L13.5 5.4L8 8.4L2.5 5.4L8 2.4Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="M2.5 8.2L8 11.2L13.5 8.2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2.5 11L8 14L13.5 11"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (href === '/visibility') {
    return (
      <svg
        className={svgClassName}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8 2.5V4.2M13.5 8H11.8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (href === '/publish') {
    return (
      <svg
        className={svgClassName}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M13.6 2.6L6.6 9.6M13.6 2.6L9.6 13.6L6.6 9.6L2.4 6.4L13.6 2.6Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg
      className={svgClassName}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M11.6 2.8L13.2 4.4L5.6 12L3 13L4 10.4L11.6 2.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9.5 13H13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AdminEntryIcon() {
  return (
    <svg
      className="gm-sider-nav-icon"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 2.2L13 4.2V7.8C13 10.9 10.9 13.1 8 14C5.1 13.1 3 10.9 3 7.8V4.2L8 2.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M6.2 8L7.4 9.2L10 6.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CollapseArrowIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={collapsed ? 'gm-sider-collapse-icon is-collapsed' : 'gm-sider-collapse-icon'}
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9.8 3.6L5.4 8L9.8 12.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandMark() {
  return <GeoMixIcon size={20} className="gm-brand-mark" />;
}
