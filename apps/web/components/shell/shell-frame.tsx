'use client';

import { SITE_NAME } from '@geomix/shared';
import { Alert, Button, Dropdown, Layout } from 'antd';
import { useEffect, useState } from 'react';
import { PasswordForm } from '../password-form';
import { SHELL_ANNOUNCEMENT, displayName, formatExpiry } from '../../lib/shell-copy';
import type { AccountProfile } from '../../lib/api';
import type { ShellAction, ShellSnapshot } from '../../lib/tab-stack';
import { CommandPalette } from './command-palette';
import { LayoutPanel } from './layout-panel';
import { ModuleScreen } from './module-screen';
import { SideMenu } from './side-menu';
import { TabBar } from './tab-bar';

const { Header, Sider, Content } = Layout;
const MOBILE_BREAKPOINT = 768;

export function ShellFrame({
  account,
  state,
  onDispatch,
  onLogout,
  onChangePassword,
  announcement = SHELL_ANNOUNCEMENT,
}: {
  account: AccountProfile;
  state: ShellSnapshot;
  onDispatch: (action: ShellAction) => void;
  onLogout: () => void;
  onChangePassword: (values: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<string | null>;
  announcement?: string;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [isWindows, setIsWindows] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform)) {
      setIsWindows(true);
    }
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) {
        setMobileMenuOpen(false);
      }
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!passwordOpen) return undefined;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setPasswordOpen(false);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [passwordOpen]);

  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
  const panes = state.prefs.multiTab
    ? state.tabs
    : state.tabs.filter((tab) => tab.id === state.activeId);
  const name = displayName(account);
  const aiImageEnabled = account.features?.aiImage !== false;
  const visibilityEnabled = account.features?.visibility !== false;
  const siderCollapsed = isMobile ? !mobileMenuOpen : state.prefs.menuCollapsed;
  const menuToggleLabel = siderCollapsed ? '展开菜单' : '收起菜单';

  const toggleMenu = () => {
    if (isMobile) {
      setMobileMenuOpen((open) => !open);
      return;
    }
    onDispatch({
      type: 'prefs',
      patch: { menuCollapsed: !state.prefs.menuCollapsed },
    });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <style>{`
        .gm-sider .ant-menu-item-selected {
          position: relative;
        }
        .gm-sider .ant-menu-item-selected::before {
          content: '';
          position: absolute;
          left: -8px;
          top: 8px;
          bottom: 8px;
          width: 2px;
          border-radius: 2px;
          background: var(--gm-phosphor);
        }
        .gm-sider .ant-menu-item-disabled {
          color: var(--gm-fg-4) !important;
          cursor: not-allowed !important;
        }
        .gm-draft-note,
        .gm-draft-note.ant-input {
          background: var(--gm-bg-surface);
          border: 1px dashed var(--gm-line-2);
          border-radius: 8px;
          min-height: 56px;
          padding: 10px 12px;
          color: var(--gm-fg-2);
          font-size: 12px;
        }
        .gm-cmd-trigger:hover {
          border-color: var(--gm-line-strong) !important;
          color: var(--gm-fg-1) !important;
        }
        @media (max-width: 768px) {
          .gm-cmd-trigger {
            padding: 0 8px !important;
            gap: 0 !important;
          }
          .gm-cmd-trigger-text,
          .gm-cmd-trigger-kbd {
            display: none !important;
          }
        }
      `}</style>
      {isMobile && mobileMenuOpen ? (
        <div
          className="gm-sider-mask"
          aria-hidden="true"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}
      <Sider
        className="gm-sider"
        width={232}
        collapsed={siderCollapsed}
        collapsedWidth={0}
        trigger={null}
        theme="dark"
        style={{
          background: 'var(--gm-bg-base)',
          borderRight: '1px solid var(--gm-line-1)',
        }}
      >
        <SideMenu
          activeHref={active?.href ?? '/dashboard'}
          prefs={state.prefs}
          aiImageEnabled={aiImageEnabled}
          visibilityEnabled={visibilityEnabled}
          onDispatch={(action) => {
            if (isMobile && action.type === 'open') {
              setMobileMenuOpen(false);
            }
            onDispatch(action);
          }}
        />
      </Sider>
      <Layout>
        <Header
          className="gm-header"
          style={{
            height: isMobile ? undefined : 48,
            gap: 12,
          }}
        >
          <div
            className="gm-brand"
            style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}
          >
            <BrandMark />
            <span>{SITE_NAME}</span>
          </div>
          <div
            className="gm-marquee"
            aria-label="公告"
            style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}
          >
            <div className="gm-marquee-track">{announcement}</div>
          </div>
          <button
            type="button"
            className="gm-cmd-trigger"
            aria-label="打开指令面板"
            onClick={() => setPaletteOpen(true)}
            style={{
              height: 28,
              padding: '0 8px 0 10px',
              border: '1px solid var(--gm-line-2)',
              borderRadius: 6,
              background: 'var(--gm-bg-surface)',
              color: 'var(--gm-fg-3)',
              fontSize: 12,
              gap: 16,
              display: 'inline-flex',
              alignItems: 'center',
              cursor: 'pointer',
              flexShrink: 0,
              transition:
                'background-color var(--gm-dur-fast) var(--gm-ease-out), border-color var(--gm-dur-fast) var(--gm-ease-out), color var(--gm-dur-fast) var(--gm-ease-out)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <SearchIcon />
              <span className="gm-cmd-trigger-text">搜索</span>
            </span>
            <kbd
              className="gm-cmd-trigger-kbd"
              style={{
                fontFamily: 'var(--gm-font-mono)',
                fontSize: 10,
                padding: '1px 4px',
                border: '1px solid var(--gm-line-2)',
                borderRadius: 4,
              }}
            >
              {isWindows ? 'Ctrl K' : '⌘K'}
            </kbd>
          </button>
          {account.role === 'ADMIN' ? (
            <a className="gm-admin-link" href="/admin/tenants">
              管理后台
            </a>
          ) : null}
          <span
            className={account.tenant.readOnly ? 'gm-expiry warn' : 'gm-expiry'}
            style={{
              height: 20,
              padding: '0 8px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              lineHeight: '18px',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: account.tenant.readOnly ? 'var(--gm-danger)' : 'var(--gm-warning)',
              }}
            />
            {formatExpiry(account.tenant.expiresAt, account.tenant.readOnly)}
          </span>
          <span className="gm-mode" data-multi-tab={state.prefs.multiTab ? 'on' : 'off'}>
            {state.prefs.multiTab ? '多标签' : '单页'}
          </span>
          <Button aria-label="布局" onClick={() => setPanelOpen(true)}>
            布局
          </Button>
          <Button aria-label={menuToggleLabel} onClick={toggleMenu}>
            {menuToggleLabel}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'password', label: '修改密码' },
                { key: 'logout', label: '退出' },
              ],
              onClick: ({ key }) => {
                if (key === 'password') setPasswordOpen(true);
                if (key === 'logout') onLogout();
              },
            }}
          >
            <Button type="text" aria-label="账号菜单">
              <span className="gm-avatar" aria-hidden="true">
                {name.slice(0, 1)}
              </span>
              {name}
            </Button>
          </Dropdown>
        </Header>
        {state.prefs.multiTab ? (
          <TabBar tabs={state.tabs} activeId={state.activeId} onDispatch={onDispatch} />
        ) : null}
        <Content className="gm-content" style={{ padding: isMobile ? 12 : 20 }}>
          {account.tenant.readOnly ? (
            <Alert
              type="warning"
              showIcon
              message="账号已到期，当前只读"
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <p className="gm-tenant">{account.tenant.name}</p>
          {panes.map((tab) => {
            const inactive = state.prefs.multiTab && tab.id !== state.activeId;
            return (
              <div
                key={`${tab.id}:${state.reloadNonce[tab.id] ?? 0}`}
                className="gm-page"
                data-tab-id={tab.id}
                hidden={inactive}
                style={{
                  background: 'transparent',
                  padding: 0,
                  borderRadius: 0,
                  ...(inactive ? { display: 'none' } : undefined),
                }}
              >
                <ModuleScreen
                  tab={tab}
                  draft={state.drafts[tab.id] ?? ''}
                  active={!inactive}
                  readOnly={account.tenant.readOnly}
                  aiImageEnabled={aiImageEnabled}
                  visibilityEnabled={visibilityEnabled}
                  onDispatch={onDispatch}
                />
              </div>
            );
          })}
        </Content>
      </Layout>
      <LayoutPanel
        open={panelOpen}
        prefs={state.prefs}
        onClose={() => setPanelOpen(false)}
        onDispatch={onDispatch}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        role={account.role}
        tabs={state.tabs}
        activeId={state.activeId}
        onDispatch={onDispatch}
        onOpenLayout={() => setPanelOpen(true)}
        onToggleMenu={toggleMenu}
        onChangePassword={() => setPasswordOpen(true)}
        onLogout={onLogout}
      />
      {passwordOpen ? (
        <div
          className="gm-modal"
          role="dialog"
          aria-modal="true"
          aria-label="修改密码"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setPasswordOpen(false);
            }
          }}
        >
          <div className="gm-modal-card">
            <div className="gm-modal-head">
              <strong>修改密码</strong>
              <Button aria-label="关闭修改密码" onClick={() => setPasswordOpen(false)}>
                关闭
              </Button>
            </div>
            <PasswordForm onSubmit={onChangePassword} />
          </div>
        </div>
      ) : null}
    </Layout>
  );
}

function BrandMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="none" stroke="var(--gm-fg-3)" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="6" fill="none" stroke="var(--gm-fg-3)" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="3" fill="var(--gm-phosphor)" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
