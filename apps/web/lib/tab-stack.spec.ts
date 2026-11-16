import { describe, expect, it } from 'vitest';
import { STATIC_ROUTES } from './routes';
import {
  SHELL_STORAGE_KEY,
  initialSnapshot,
  loadShell,
  reduceShell,
  saveShell,
  type KeyValueStorage,
  type ShellSnapshot,
} from './tab-stack';

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

const FIVE = [
  '/dashboard',
  '/material/keywords',
  '/material/questions',
  '/material/knowledge',
  '/writing/prompts',
];

function openAll(hrefs: string[], state = initialSnapshot()): ShellSnapshot {
  return hrefs.reduce((current, href) => reduceShell(current, { type: 'open', href }), state);
}

describe('tab stack', () => {
  it('keeps a separate draft for each of five tabs', () => {
    let state = openAll(FIVE);
    const drafts = ['首页', '关键词', '标题', '知识库', '指令'];
    FIVE.forEach((href, index) => {
      state = reduceShell(state, { type: 'draft', id: href, value: drafts[index] ?? '' });
    });
    state = reduceShell(state, { type: 'activate', id: '/material/keywords' });
    state = reduceShell(state, { type: 'activate', id: '/writing/prompts' });
    state = reduceShell(state, { type: 'activate', id: '/dashboard' });
    expect(state.tabs).toHaveLength(5);
    expect(state.activeId).toBe('/dashboard');
    expect(state.drafts).toEqual({
      '/dashboard': '首页',
      '/material/keywords': '关键词',
      '/material/questions': '标题',
      '/material/knowledge': '知识库',
      '/writing/prompts': '指令',
    });
  });

  it('restores the tab stack from storage and drops in-memory drafts', () => {
    let state = openAll(FIVE);
    state = reduceShell(state, { type: 'activate', id: '/writing/prompts' });
    state = reduceShell(state, { type: 'draft', id: '/writing/prompts', value: '未保存' });
    const storage = memoryStorage();
    saveShell(storage, state);
    const restored = loadShell(storage);
    expect(JSON.parse(storage.getItem(SHELL_STORAGE_KEY) ?? '{}')).toMatchObject({
      activeId: '/writing/prompts',
    });
    expect(restored.tabs.map((tab) => tab.href)).toEqual(FIVE);
    expect(restored.activeId).toBe('/writing/prompts');
    expect(restored.drafts).toEqual({});
    expect(restored.tabs[0]?.pinned).toBe(true);
  });

  it('falls back when storage is corrupt and ignores unknown hrefs', () => {
    const storage = memoryStorage();
    storage.setItem(SHELL_STORAGE_KEY, '{');
    expect(loadShell(storage).activeId).toBe('/dashboard');
    storage.setItem(
      SHELL_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { href: '/not-a-page' },
          { href: '/writing/prompts', sourceId: '/material/keywords' },
        ],
        activeId: '/missing',
        prefs: { multiTab: false, menuCollapsed: 'yes' },
      }),
    );
    const restored = loadShell(storage);
    expect(restored.tabs.map((tab) => tab.href)).toEqual(['/dashboard', '/writing/prompts']);
    expect(restored.tabs[1]?.sourceId).toBe('/material/keywords');
    expect(restored.activeId).toBe('/dashboard');
    expect(restored.prefs.multiTab).toBe(false);
    expect(restored.prefs.menuCollapsed).toBe(false);
  });

  it('degrades to a single page and replaces that page on the next navigation', () => {
    let state = openAll(FIVE);
    state = reduceShell(state, { type: 'draft', id: '/writing/prompts', value: '留下' });
    state = reduceShell(state, { type: 'draft', id: '/dashboard', value: '首页草稿' });
    state = reduceShell(state, { type: 'prefs', patch: { multiTab: false } });
    expect(state.prefs.multiTab).toBe(false);
    expect(state.tabs.map((tab) => tab.href)).toEqual(['/writing/prompts']);
    expect(state.drafts).toEqual({ '/writing/prompts': '留下' });
    state = reduceShell(state, { type: 'open', href: '/material/keywords' });
    expect(state.tabs.map((tab) => tab.href)).toEqual(['/material/keywords']);
    expect(state.drafts).toEqual({});
  });

  it('keeps the home tab pinned and caps the stack at 15', () => {
    const state = openAll(Object.keys(STATIC_ROUTES));
    expect(state.tabs).toHaveLength(15);
    expect(state.tabs.some((tab) => tab.pinned && tab.href === '/dashboard')).toBe(true);
    expect(state.tabs.some((tab) => tab.href === '/material/keywords')).toBe(false);
    expect(state.activeId).toBe('/me/verify');
    const closed = reduceShell(state, { type: 'close', id: '/dashboard' });
    expect(closed.tabs.some((tab) => tab.href === '/dashboard')).toBe(true);
    const others = reduceShell(state, { type: 'close-others', id: '/image' });
    expect(others.tabs.map((tab) => tab.href).sort()).toEqual(['/dashboard', '/image']);
    const right = reduceShell(openAll(FIVE), { type: 'close-right', id: '/material/questions' });
    expect(right.tabs.map((tab) => tab.href)).toEqual([
      '/dashboard',
      '/material/keywords',
      '/material/questions',
    ]);
    const all = reduceShell(state, { type: 'close-all' });
    expect(all.tabs.map((tab) => tab.href)).toEqual(['/dashboard']);
  });

  it('returns to the source tab and refreshes only the current draft', () => {
    let state = openAll(['/dashboard', '/material/keywords']);
    state = reduceShell(state, { type: 'draft', id: '/material/keywords', value: '主词' });
    state = reduceShell(state, {
      type: 'open',
      href: '/material/questions?keywordId=demo',
      sourceId: '/material/keywords',
    });
    state = reduceShell(state, {
      type: 'draft',
      id: '/material/questions?keywordId=demo',
      value: '标题草稿',
    });
    state = reduceShell(state, { type: 'back', id: '/material/questions?keywordId=demo' });
    expect(state.activeId).toBe('/material/keywords');
    expect(state.drafts['/material/keywords']).toBe('主词');
    expect(state.tabs.some((tab) => tab.href.startsWith('/material/questions'))).toBe(false);
    state = reduceShell(state, { type: 'refresh', id: '/material/keywords' });
    expect(state.drafts['/material/keywords']).toBeUndefined();
    expect(state.reloadNonce['/material/keywords']).toBe(1);
  });
});
