'use client';

import { SITE_NAME } from '@geomix/shared';
import { Alert, Button, Dropdown, Layout } from 'antd';
import { useState } from 'react';
import { PasswordForm } from '../password-form';
import { SHELL_ANNOUNCEMENT, displayName, formatExpiry } from '../../lib/shell-copy';
import type { AccountProfile } from '../../lib/api';
import type { ShellAction, ShellSnapshot } from '../../lib/tab-stack';
import { LayoutPanel } from './layout-panel';
import { ModuleScreen } from './module-screen';
import { SideMenu } from './side-menu';
import { TabBar } from './tab-bar';

const { Header, Sider, Content } = Layout;

export function ShellFrame({
  account,
  state,
  onDispatch,
  onLogout,
  onChangePassword,
}: {
  account: AccountProfile;
  state: ShellSnapshot;
  onDispatch: (action: ShellAction) => void;
  onLogout: () => void;
  onChangePassword: (values: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<string | null>;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
  const panes = state.prefs.multiTab
    ? state.tabs
    : state.tabs.filter((tab) => tab.id === state.activeId);
  const name = displayName(account);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={248}
        collapsed={state.prefs.menuCollapsed}
        collapsedWidth={0}
        trigger={null}
        theme="dark"
      >
        <SideMenu
          activeHref={active?.href ?? '/dashboard'}
          prefs={state.prefs}
          onDispatch={onDispatch}
        />
      </Sider>
      <Layout>
        <Header className="gm-header">
          <div className="gm-brand">
            <BrandMark />
            <span>{SITE_NAME}</span>
          </div>
          <div className="gm-marquee" aria-label="公告">
            <div className="gm-marquee-track">{SHELL_ANNOUNCEMENT}</div>
          </div>
          <span className={account.tenant.readOnly ? 'gm-expiry warn' : 'gm-expiry'}>
            {formatExpiry(account.tenant.expiresAt, account.tenant.readOnly)}
          </span>
          <span className="gm-mode" data-multi-tab={state.prefs.multiTab ? 'on' : 'off'}>
            {state.prefs.multiTab ? '多标签' : '单页'}
          </span>
          <Button aria-label="布局" onClick={() => setPanelOpen(true)}>
            布局
          </Button>
          <Button
            aria-label={state.prefs.menuCollapsed ? '展开菜单' : '收起菜单'}
            onClick={() =>
              onDispatch({
                type: 'prefs',
                patch: { menuCollapsed: !state.prefs.menuCollapsed },
              })
            }
          >
            {state.prefs.menuCollapsed ? '展开菜单' : '收起菜单'}
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
        <Content className="gm-content">
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
                style={inactive ? { display: 'none' } : undefined}
              >
                <ModuleScreen
                  tab={tab}
                  draft={state.drafts[tab.id] ?? ''}
                  readOnly={account.tenant.readOnly}
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
      {passwordOpen ? (
        <div className="gm-modal" role="dialog" aria-label="修改密码">
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
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="#1677ff" />
      <path d="M8 19V9h7.2a4.4 4.4 0 0 1 0 8.8H11" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}
