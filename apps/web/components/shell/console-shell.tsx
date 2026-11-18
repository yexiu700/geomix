'use client';

import { SITE_NAME, replaceUxJargon } from '@geomix/shared';
import { Button } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clearCachedAccount,
  patchCachedAccountUiPrefs,
  readCachedAccount,
  writeCachedAccount,
} from '../../lib/account-cache';
import { httpAnnouncements } from '../../lib/account-client';
import {
  changePassword,
  loadAccount,
  logoutSession,
  saveAccountUiPrefs,
  type AccountProfile,
} from '../../lib/api';
import { SHELL_ANNOUNCEMENT } from '../../lib/shell-copy';
import { safeConsoleHref } from '../../lib/route-map';
import { isConsoleRouteAccessible } from '../../lib/routes';
import { useShellStore } from '../../lib/shell-store';
import { clearSession, readAccessToken } from '../../lib/session';
import {
  SHELL_STORAGE_KEY,
  initialSnapshot,
  loadShell,
  serializeShell,
  tabFromHref,
  type ShellAction,
} from '../../lib/tab-stack';
import { ShellFrame } from './shell-frame';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const SHELL_USER_KEY = 'geomix.shell.user';

const NAVIGATING = new Set([
  'open',
  'activate',
  'close',
  'close-others',
  'close-right',
  'close-all',
  'navigate',
  'back',
]);

export function ConsoleShell() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const href = search ? `${pathname}?${search}` : pathname;
  const hrefRef = useRef(href);
  hrefRef.current = href;
  const state = useShellStore();
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const accountRef = useRef<AccountProfile | null>(null);
  accountRef.current = account;
  const [announcement, setAnnouncement] = useState(SHELL_ANNOUNCEMENT);
  const [offline, setOffline] = useState(false);
  const [booting, setBooting] = useState(true);
  const persistEnabled = useRef(true);
  const localPrefsDirtyRef = useRef(false);

  function applyLoadedAccount(nextAccount: AccountProfile, options?: { fromCache?: boolean }) {
    const prevUserId = window.localStorage.getItem(SHELL_USER_KEY);
    if (prevUserId && prevUserId !== nextAccount.id) {
      window.localStorage.removeItem(SHELL_STORAGE_KEY);
      useShellStore.setState({ ...initialSnapshot(), hydrated: true });
    }
    window.localStorage.setItem(SHELL_USER_KEY, nextAccount.id);

    if (nextAccount.role !== 'ADMIN') {
      const store = useShellStore.getState();
      if (store.tabs.some((tab) => !isConsoleRouteAccessible(tab.href, nextAccount.role))) {
        store.dispatch({ type: 'close', id: '/workbench/samples' });
      }
    }
    if (!options?.fromCache && !localPrefsDirtyRef.current && nextAccount.uiPrefs) {
      useShellStore.getState().dispatch({ type: 'prefs', patch: nextAccount.uiPrefs });
    }
    accountRef.current = nextAccount;
    setAccount(nextAccount);
    setOffline(false);
    setBooting(false);
  }

  useIsomorphicLayoutEffect(() => {
    const storage = window.localStorage;
    const loaded = loadShell(storage);
    useShellStore.getState().markHydrated(loaded);
    const cached = readCachedAccount(window.sessionStorage);
    if (cached) {
      applyLoadedAccount(cached, { fromCache: true });
    }
    let last = serializeShell(useShellStore.getState());
    const unsub = useShellStore.subscribe((next) => {
      if (!persistEnabled.current || !next.hydrated) return;
      const serialized = serializeShell(next);
      if (serialized === last) return;
      last = serialized;
      storage.setItem(SHELL_STORAGE_KEY, serialized);
    });
    return unsub;
  }, []);

  useEffect(() => {
    let live = true;
    void loadAccount(window.sessionStorage).then((result) => {
      if (!live) return;
      if (result.status === 'ok') {
        writeCachedAccount(window.sessionStorage, result.account);
        applyLoadedAccount(result.account);
        return;
      }
      if (result.status === 'offline') {
        if (!accountRef.current) {
          setOffline(true);
          setBooting(false);
        }
        return;
      }
      clearCachedAccount();
      const hadToken = readAccessToken(window.sessionStorage) !== null;
      if (hadToken || result.status === 'disabled') clearSession(window.sessionStorage);
      const next = safeConsoleHref(hrefRef.current) ?? '/dashboard';
      const notice = result.status === 'disabled' ? 'disabled' : hadToken ? 'session' : '';
      const query = new URLSearchParams({ next });
      if (notice) query.set('notice', notice);
      router.replace(`/login?${query.toString()}`);
    });
    return () => {
      live = false;
    };
  }, [router]);

  const accountId = account?.id ?? null;
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void httpAnnouncements(window.sessionStorage).then(
      (items) => {
        if (!live || items.length === 0) return;
        setAnnouncement(items.map(replaceUxJargon).join('    '));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [accountId]);

  const accountReady = account !== null;
  useEffect(() => {
    const activeAccount = accountRef.current;
    if (!state.hydrated || !accountReady || !activeAccount) return;
    const match = tabFromHref(href);
    if (!match || !isConsoleRouteAccessible(match.href, activeAccount.role)) return;
    if (match.href !== href) router.replace(match.href);
    if (useShellStore.getState().activeId === match.href) return;
    useShellStore.getState().dispatch({ type: 'open', href: match.href });
  }, [accountReady, href, router, state.hydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      const activeAccount = accountRef.current;
      if (!useShellStore.getState().hydrated || !activeAccount) return;
      const browserHref = `${window.location.pathname}${window.location.search}`;
      const match = tabFromHref(browserHref);
      if (!match || !isConsoleRouteAccessible(match.href, activeAccount.role)) return;
      if (useShellStore.getState().activeId === match.href) return;
      useShellStore.getState().dispatch({ type: 'open', href: match.href });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const activeTab = state.tabs.find((tab) => tab.id === state.activeId);
  const expectedTitle = activeTab ? `${activeTab.title} · ${SITE_NAME}` : null;

  useEffect(() => {
    if (!expectedTitle || typeof document === 'undefined') return undefined;
    if (document.title !== expectedTitle) {
      document.title = expectedTitle;
    }
    const titleEl = document.querySelector('title');
    if (!titleEl) return undefined;
    const observer = new MutationObserver(() => {
      if (document.title !== expectedTitle) {
        document.title = expectedTitle;
      }
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [expectedTitle, href]);

  function onDispatch(action: ShellAction) {
    useShellStore.getState().dispatch(action);
    if (action.type === 'prefs') {
      localPrefsDirtyRef.current = true;
      const nextPrefs = useShellStore.getState().prefs;
      patchCachedAccountUiPrefs(window.sessionStorage, nextPrefs);
      void saveAccountUiPrefs(window.sessionStorage, nextPrefs);
    }
    if (!NAVIGATING.has(action.type)) return;
    const next = useShellStore.getState();
    const active = next.tabs.find((tab) => tab.id === next.activeId);
    if (!active) return;
    if (typeof window !== 'undefined') {
      const currentHref = `${window.location.pathname}${window.location.search}`;
      if (active.href !== currentHref) {
        if (action.type === 'navigate') {
          window.history.replaceState(null, '', active.href);
        } else {
          window.history.pushState(null, '', active.href);
        }
      }
      return;
    }
    if (active.href !== hrefRef.current) router.push(active.href);
  }

  function onToggleMenu() {
    const nextCollapsed = !useShellStore.getState().prefs.menuCollapsed;
    onDispatch({
      type: 'prefs',
      patch: { menuCollapsed: nextCollapsed },
    });
  }

  async function onLogout() {
    persistEnabled.current = false;
    clearCachedAccount();
    window.localStorage.removeItem(SHELL_STORAGE_KEY);
    window.localStorage.removeItem('geomix.shell.v1');
    window.localStorage.removeItem(SHELL_USER_KEY);
    useShellStore.setState({ ...initialSnapshot(), hydrated: true });
    await logoutSession(window.sessionStorage);
    router.replace('/login');
  }

  if (offline) {
    return (
      <main className="gm-boot">
        <p>无法连接接口</p>
        <Button
          type="primary"
          onClick={() => {
            setOffline(false);
            setBooting(true);
            void loadAccount(window.sessionStorage).then((result) => {
              if (result.status === 'ok') {
                writeCachedAccount(window.sessionStorage, result.account);
                applyLoadedAccount(result.account);
                return;
              }
              if (result.status === 'offline') {
                setOffline(true);
                setBooting(false);
              }
            });
          }}
        >
          重试
        </Button>
      </main>
    );
  }

  if (booting || !account || !state.hydrated) {
    return <main className="gm-boot">正在确认登录</main>;
  }

  if (!tabFromHref(href) || !isConsoleRouteAccessible(href, account.role)) {
    return (
      <main className="gm-boot">
        <p>没有这个页面</p>
        <Button type="primary" onClick={() => router.push('/dashboard')}>
          回首页
        </Button>
      </main>
    );
  }

  return (
    <ShellFrame
      account={account}
      state={state}
      announcement={announcement}
      onDispatch={onDispatch}
      onToggleMenu={onToggleMenu}
      onLogout={() => void onLogout()}
      onChangePassword={async (values) => {
        const result = await changePassword(window.sessionStorage, values);
        return result.ok ? null : result.message;
      }}
    />
  );
}
