// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../../lib/api';
import {
  loadShell,
  reduceShell,
  saveShell,
  type KeyValueStorage,
  type ShellSnapshot,
} from '../../lib/tab-stack';
import { initialSnapshot } from '../../lib/tab-stack';
import { ShellFrame } from './shell-frame';

vi.mock('../dashboard/dashboard-screen', () => ({
  DashboardScreen: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock('../material/keyword-screen', () => ({
  KeywordScreen: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock('../material/question-screen', () => ({
  QuestionScreen: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock('../material/knowledge-screen', () => ({
  KnowledgeScreen: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock('../writing/prompt-screen', () => ({
  PromptScreen: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

const account: AccountProfile = {
  id: 'user-1',
  username: 'demo',
  nickname: '演示',
  role: 'MERCHANT',
  tenant: {
    id: 'tenant-1',
    name: '演示租户',
    expiresAt: '2027-11-12T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

const FIVE = [
  '/dashboard',
  '/material/keywords',
  '/material/questions',
  '/material/knowledge',
  '/writing/prompts',
];

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function openAll(): ShellSnapshot {
  return FIVE.reduce(
    (state, href) => reduceShell(state, { type: 'open', href }),
    initialSnapshot(),
  );
}

function Harness({ initial }: { initial: ShellSnapshot }) {
  const [state, setState] = useState(initial);
  return (
    <ShellFrame
      account={account}
      state={state}
      onDispatch={(action) => setState((current) => reduceShell(current, action))}
      onLogout={() => undefined}
      onChangePassword={async () => null}
    />
  );
}

function labeled(name: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${name}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${name}`);
  return found;
}

afterEach(() => {
  cleanup();
});

describe('admin shell', { timeout: 60_000 }, () => {
  it('keeps drafts while switching among five tabs', () => {
    render(<Harness initial={openAll()} />);
    const drafts = [
      ['首页', '甲'],
      ['关键词', '乙'],
      ['写作标题', '丙'],
      ['企业知识库', '丁'],
      ['写作指令', '戊'],
    ] as const;

    for (const [title, value] of drafts) {
      fireEvent.click(labeled(title));
      fireEvent.change(labeled(`${title}草稿`), { target: { value } });
    }

    expect(document.querySelectorAll('[data-tab-id]')).toHaveLength(5);
    for (const [title, value] of drafts) {
      fireEvent.click(labeled(title));
      expect((labeled(`${title}草稿`) as HTMLTextAreaElement).value).toBe(value);
    }
  });

  it('renders the tab stack restored from storage without the old drafts', () => {
    let state = openAll();
    state = reduceShell(state, { type: 'draft', id: '/writing/prompts', value: '未保存' });
    const storage = memoryStorage();
    saveShell(storage, state);
    render(<Harness initial={loadShell(storage)} />);
    for (const title of ['首页', '关键词', '写作标题', '企业知识库', '写作指令']) {
      expect(screen.getByRole('tab', { name: title })).toBeTruthy();
    }
    expect(
      (screen.getByRole('textbox', { name: '写作指令草稿' }) as HTMLTextAreaElement).value,
    ).toBe('');
  });

  it('hides the tab stack and keeps only the current page when multi-tab is off', () => {
    let state = openAll();
    state = reduceShell(state, { type: 'draft', id: '/writing/prompts', value: '留下' });
    render(<Harness initial={state} />);
    fireEvent.click(screen.getByRole('button', { name: '布局' }));
    fireEvent.click(screen.getByRole('switch', { name: '多标签' }));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelectorAll('[data-tab-id]')).toHaveLength(1);
    expect(
      (screen.getByRole('textbox', { name: '写作指令草稿' }) as HTMLTextAreaElement).value,
    ).toBe('留下');

    fireEvent.click(screen.getByText('素材源力'));
    fireEvent.click(screen.getByText('关键词'));
    expect(document.querySelectorAll('[data-tab-id]')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '关键词' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '关键词草稿' }) as HTMLTextAreaElement).value).toBe(
      '',
    );
  });

  it('closes the other tabs from the context menu', () => {
    render(<Harness initial={openAll()} />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: '写作标题' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭其他' }));
    expect(screen.getByRole('tab', { name: '首页' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '写作标题' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '关键词' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '写作指令' })).toBeNull();
  });

  it('auto-collapses Sider on 375px mobile viewport and toggles overlay drawer cleanly (#67)', () => {
    const prevWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    try {
      render(<Harness initial={initialSnapshot()} />);
      expect(screen.getByRole('button', { name: '展开菜单' })).toBeTruthy();
      expect(document.querySelector('.gm-sider-mask')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '展开菜单' }));
      expect(screen.getByRole('button', { name: '收起菜单' })).toBeTruthy();
      expect(document.querySelector('.gm-sider-mask')).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '收起菜单' }));
      expect(screen.getByRole('button', { name: '展开菜单' })).toBeTruthy();
      expect(document.querySelector('.gm-sider-mask')).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: prevWidth,
      });
    }
  });

  it('opens only 首页 tab initially and lets users read full header announcement via modal (#132)', () => {
    const prevWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1440,
    });
    try {
      const longAnnouncement =
        'GeoMix验收公告_r2_rwax6：请使用自有或已授权素材并及时关注任务状态。';
      render(
        <ShellFrame
          account={account}
          state={initialSnapshot()}
          announcement={longAnnouncement}
          onDispatch={() => undefined}
          onLogout={() => undefined}
          onChangePassword={async () => null}
        />,
      );

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.textContent).toBe('首页');

      const announcementBtn = screen.getByRole('button', { name: /查看公告全文|公告/ });
      expect(announcementBtn.textContent).toContain('GeoMix验收公告_r2_rwax6');
      expect((announcementBtn as HTMLElement).style.paddingLeft).toBe('0px');

      fireEvent.click(announcementBtn);
      const dialog = screen.getByRole('dialog', { name: '系统公告' });
      expect(dialog.textContent).toContain(longAnnouncement);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: prevWidth,
      });
    }
  });

  it('expands sidebar by default on 1440px desktop and syncs top toggle with layout drawer switch (#133)', () => {
    const prevWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1440,
    });
    try {
      render(<Harness initial={initialSnapshot()} />);

      // Expanded by default on desktop
      expect(labeled('收起菜单')).toBeTruthy();
      expect(
        within(document.querySelector<HTMLElement>('.gm-sider')!).getByText('素材源力'),
      ).toBeTruthy();

      // Top toggle collapses sidebar and syncs LayoutPanel switch
      fireEvent.click(labeled('收起菜单'));
      expect(labeled('展开菜单')).toBeTruthy();
      expect(document.querySelector('.gm-sider .ant-menu')).toBeNull();

      fireEvent.click(labeled('布局'));
      const dialog = document.querySelector<HTMLElement>('.ant-drawer-content[role="dialog"]');
      expect(dialog).not.toBeNull();
      const collapseSwitch = within(dialog!).getByRole('switch', { name: '折叠菜单' });
      expect(collapseSwitch.getAttribute('aria-checked')).toBe('true');

      // Top toggle expands sidebar again and syncs LayoutPanel switch back to false
      fireEvent.click(labeled('展开菜单'));
      expect(labeled('收起菜单')).toBeTruthy();
      expect(
        within(document.querySelector<HTMLElement>('.gm-sider')!).getByText('素材源力'),
      ).toBeTruthy();
      expect(
        within(dialog!).getByRole('switch', { name: '折叠菜单' }).getAttribute('aria-checked'),
      ).toBe('false');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: prevWidth,
      });
    }
  });

  it('hides SideMenu completely when mobile Sider is collapsed and renders full menu when opened even if menuCollapsed pref was true (#131, #133)', () => {
    const prevWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    try {
      const initial = {
        ...reduceShell(initialSnapshot(), { type: 'open', href: '/material/keywords' }),
        prefs: { ...initialSnapshot().prefs, menuCollapsed: true },
      };
      render(<Harness initial={initial} />);

      // When mobile Sider is collapsed, SideMenu must not mount menus/popups
      expect(document.querySelector('.gm-sider .ant-menu')).toBeNull();
      expect(document.querySelector('.ant-menu-submenu-popup')).toBeNull();

      // Clicking 展开菜单 on mobile must render full menu items even if desktop pref was collapsed
      fireEvent.click(screen.getByRole('button', { name: '展开菜单' }));
      const sider = document.querySelector<HTMLElement>('.gm-sider');
      expect(sider).not.toBeNull();
      expect(within(sider!).getByText('素材源力')).toBeTruthy();
      expect(within(sider!).getByText('关键词')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: prevWidth,
      });
    }
  });

  it('requires matching 确认新密码 and supports 取消 and Escape close in 修改密码 modal (#198)', async () => {
    const onChangePassword = vi.fn(async () => null);
    render(
      <ShellFrame
        account={account}
        state={initialSnapshot()}
        onDispatch={() => undefined}
        onLogout={() => undefined}
        onChangePassword={onChangePassword}
      />,
    );

    // Open 修改密码 via 账号菜单 dropdown
    fireEvent.mouseEnter(screen.getByRole('button', { name: '账号菜单' }));
    fireEvent.click(await screen.findByText('修改密码'));

    const dialog = await screen.findByRole('dialog', { name: '修改密码' });
    expect(within(dialog).getByLabelText('当前密码')).toBeTruthy();
    expect(within(dialog).getByLabelText('新密码')).toBeTruthy();
    expect(within(dialog).getByLabelText('确认新密码')).toBeTruthy();

    // Mismatched confirmPassword blocks submission
    fireEvent.change(within(dialog).getByLabelText('当前密码'), {
      target: { value: 'OldPass123' },
    });
    fireEvent.change(within(dialog).getByLabelText('新密码'), {
      target: { value: 'NewPass123' },
    });
    fireEvent.change(within(dialog).getByLabelText('确认新密码'), {
      target: { value: 'Mismatch123' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '修改密码' }));

    expect(
      await within(dialog).findByText('两次输入的新密码不一致', {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(onChangePassword).not.toHaveBeenCalled();

    // Matching confirmPassword submits cleanly without leaking confirmPassword
    fireEvent.change(within(dialog).getByLabelText('确认新密码'), {
      target: { value: 'NewPass123' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '修改密码' }));
    await waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith({
        currentPassword: 'OldPass123',
        newPassword: 'NewPass123',
      });
    });

    // 取消 closes modal
    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '修改密码' })).toBeNull();
    });

    // Re-open and Escape closes modal
    fireEvent.mouseEnter(screen.getByRole('button', { name: '账号菜单' }));
    fireEvent.click(await screen.findByText('修改密码'));
    await screen.findByRole('dialog', { name: '修改密码' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '修改密码' })).toBeNull();
    });
  });
});
