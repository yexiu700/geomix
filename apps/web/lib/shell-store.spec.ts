import { beforeEach, describe, expect, it } from 'vitest';
import { initialSnapshot, reduceShell, serializeShell } from './tab-stack';
import { useShellStore } from './shell-store';

describe('shell store', () => {
  beforeEach(() => {
    useShellStore.getState().markHydrated(initialSnapshot());
  });

  it('switches tabs without clearing drafts and leaves drafts out of persistence', () => {
    const { dispatch } = useShellStore.getState();
    dispatch({ type: 'open', href: '/material/keywords' });
    dispatch({ type: 'draft', id: '/material/keywords', value: '未完成' });
    dispatch({ type: 'activate', id: '/dashboard' });
    dispatch({ type: 'draft', id: '/dashboard', value: '首页' });
    const state = useShellStore.getState();
    expect(state.drafts).toEqual({
      '/dashboard': '首页',
      '/material/keywords': '未完成',
    });
    const saved = JSON.parse(serializeShell(state)) as { drafts?: unknown };
    expect(saved.drafts).toBeUndefined();
    expect(reduceShell(initialSnapshot(), { type: 'open', href: '/nope' }).tabs).toHaveLength(1);
  });
});
