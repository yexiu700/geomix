'use client';

import { SITE_NAME } from '@geomix/shared';
import { Alert, Button, Dropdown, Layout, Modal, Tooltip } from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SHELL_ANNOUNCEMENT, displayName, formatExpiry } from '../../lib/shell-copy';
import type { AccountProfile } from '../../lib/api';
import type { ShellAction, ShellSnapshot } from '../../lib/tab-stack';
import { ModuleScreen } from './module-screen';
import { SideMenu } from './side-menu';
import { TabBar } from './tab-bar';

const PasswordForm = dynamic(() => import('../password-form').then((m) => m.PasswordForm));
const CommandPalette = dynamic(() => import('./command-palette').then((m) => m.CommandPalette));
const LayoutPanel = dynamic(() => import('./layout-panel').then((m) => m.LayoutPanel));

const { Header, Sider, Content } = Layout;
const MOBILE_BREAKPOINT = 768;

export function ShellFrame({
  account,
  state,
  onDispatch,
  onToggleMenu,
  onLogout,
  onChangePassword,
  announcement = SHELL_ANNOUNCEMENT,
}: {
  account: AccountProfile;
  state: ShellSnapshot;
  onDispatch: (action: ShellAction) => void;
  onToggleMenu?: () => void;
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
  const [announcementOpen, setAnnouncementOpen] = useState(false);
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
  const desktopCollapsedRef = useRef(state.prefs.menuCollapsed);
  desktopCollapsedRef.current = state.prefs.menuCollapsed;

  const toggleMenu = () => {
    if (isMobile) {
      setMobileMenuOpen((open) => !open);
      return;
    }
    if (onToggleMenu) {
      onToggleMenu();
      return;
    }
    const nextCollapsed = !desktopCollapsedRef.current;
    desktopCollapsedRef.current = nextCollapsed;
    onDispatch({
      type: 'prefs',
      patch: { menuCollapsed: nextCollapsed },
    });
  };

  const handleDispatch = (action: ShellAction) => {
    if (action.type === 'prefs' && action.patch.menuCollapsed !== undefined) {
      desktopCollapsedRef.current = action.patch.menuCollapsed;
      if (isMobile) {
        setMobileMenuOpen(!action.patch.menuCollapsed);
      }
    }
    onDispatch(action);
  };

  return (
    <Layout style={{ minHeight: '100vh', overflowX: 'clip' }}>
      <style>{`
        .gm-sider {
          overflow: hidden !important;
          transition: none !important;
        }
        .gm-sider .ant-layout-sider-children {
          overflow: hidden !important;
        }
        .gm-sider.gm-sider-collapsed {
          width: 0 !important;
          min-width: 0 !important;
          max-width: 0 !important;
          flex: 0 0 0px !important;
          overflow: hidden !important;
        }
        .gm-sider:not(.gm-sider-collapsed) {
          width: 232px !important;
          min-width: 232px !important;
          max-width: 232px !important;
          flex: 0 0 232px !important;
        }
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
        .gm-marquee {
          flex: 1 1 200px;
          min-width: 140px;
          display: flex;
          align-items: center;
          overflow: hidden;
        }
        .gm-marquee .gm-marquee-track {
          display: block;
          width: 100%;
          max-width: 100%;
          padding-left: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          animation: none;
          background: transparent;
          border: 0;
          padding: 2px 4px;
          border-radius: 4px;
          color: var(--gm-fg-2);
          font-size: 12px;
          text-align: left;
          cursor: pointer;
          transition: color var(--gm-dur-fast) var(--gm-ease-out), background-color var(--gm-dur-fast) var(--gm-ease-out);
        }
        .gm-marquee .gm-marquee-track:hover {
          color: var(--gm-fg-1);
          background: var(--gm-bg-hover);
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
          .gm-sider:not(.gm-sider-collapsed) {
            overflow-y: auto !important;
            overflow-x: hidden !important;
          }
          .gm-sider:not(.gm-sider-collapsed) .ant-layout-sider-children {
            overflow-y: auto !important;
            overflow-x: hidden !important;
          }
          .gm-marquee {
            flex: 1 1 100%;
            min-width: 0;
          }
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
        id="gm-sider-nav"
        className={siderCollapsed ? 'gm-sider gm-sider-collapsed' : 'gm-sider'}
        width={232}
        collapsed={siderCollapsed}
        collapsedWidth={0}
        trigger={null}
        theme="dark"
        style={{
          background: 'var(--gm-bg-base)',
          borderRight: siderCollapsed ? 'none' : '1px solid var(--gm-line-1)',
          overflow: 'hidden',
        }}
      >
        <SideMenu
          activeHref={active?.href ?? '/dashboard'}
          prefs={state.prefs}
          collapsed={siderCollapsed}
          aiImageEnabled={aiImageEnabled}
          visibilityEnabled={visibilityEnabled}
          onDispatch={(action) => {
            if (isMobile && action.type === 'open') {
              setMobileMenuOpen(false);
            }
            handleDispatch(action);
          }}
        />
      </Sider>
      <Layout style={{ minWidth: 0, overflow: 'hidden' }}>
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
          <div className="gm-marquee" aria-label="公告">
            <Tooltip title={announcement}>
              <button
                type="button"
                className="gm-marquee-track"
                aria-label={`查看公告全文：${announcement}`}
                onClick={() => setAnnouncementOpen(true)}
                style={{ paddingLeft: 0, animation: 'none' }}
              >
                {announcement}
              </button>
            </Tooltip>
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
            <Link className="gm-admin-link" href="/admin/tenants">
              管理后台
            </Link>
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
          <Button
            aria-label={menuToggleLabel}
            aria-expanded={!siderCollapsed}
            aria-controls="gm-sider-nav"
            onClick={toggleMenu}
            style={{ flexShrink: 0 }}
          >
            {menuToggleLabel}
          </Button>
          <Dropdown
            trigger={['click', 'hover']}
            placement="bottomRight"
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
            <Button type="text" aria-label="账号菜单" style={{ flexShrink: 0 }}>
              <span className="gm-avatar" aria-hidden="true">
                {name.slice(0, 1)}
              </span>
              {name}
            </Button>
          </Dropdown>
        </Header>
        {state.prefs.multiTab ? (
          <TabBar tabs={state.tabs} activeId={state.activeId} onDispatch={handleDispatch} />
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
                  onDispatch={handleDispatch}
                />
              </div>
            );
          })}
        </Content>
      </Layout>
      {panelOpen ? (
        <LayoutPanel
          open={panelOpen}
          prefs={state.prefs}
          onClose={() => setPanelOpen(false)}
          onDispatch={handleDispatch}
        />
      ) : null}
      <Modal
        open={announcementOpen}
        title="系统公告"
        onCancel={() => setAnnouncementOpen(false)}
        keyboard
        maskClosable
        footer={[
          <Button key="close" type="primary" onClick={() => setAnnouncementOpen(false)}>
            知道了
          </Button>,
        ]}
      >
        <p
          style={{ margin: 0, color: 'var(--gm-fg-1)', lineHeight: '22px', whiteSpace: 'pre-wrap' }}
        >
          {announcement}
        </p>
      </Modal>
      {paletteOpen ? (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          role={account.role}
          tabs={state.tabs}
          activeId={state.activeId}
          aiImageEnabled={aiImageEnabled}
          visibilityEnabled={visibilityEnabled}
          onDispatch={onDispatch}
          onOpenLayout={() => setPanelOpen(true)}
          onToggleMenu={toggleMenu}
          onChangePassword={() => setPasswordOpen(true)}
          onLogout={onLogout}
        />
      ) : null}
      <Modal
        open={passwordOpen}
        title="修改密码"
        onCancel={() => setPasswordOpen(false)}
        keyboard
        maskClosable
        destroyOnHidden
        footer={null}
      >
        {passwordOpen ? (
          <PasswordForm onSubmit={onChangePassword} onCancel={() => setPasswordOpen(false)} />
        ) : null}
      </Modal>
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
