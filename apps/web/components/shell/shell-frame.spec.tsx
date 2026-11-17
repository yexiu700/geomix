// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
