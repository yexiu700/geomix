'use client';

import { SITE_NAME, replaceUxJargon } from '@geomix/shared';
import { Button } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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
  const [announcement, setAnnouncement] = useState(SHELL_ANNOUNCEMENT);
  const [offline, setOffline] = useState(false);
  const [booting, setBooting] = useState(true);
  const persistEnabled = useRef(true);

  function applyLoadedAccount(nextAccount: AccountProfile) {
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
    if (nextAccount.uiPrefs) {
      useShellStore.getState().dispatch({ type: 'prefs', patch: nextAccount.uiPrefs });
    }
    setAccount(nextAccount);
    setOffline(false);
    setBooting(false);
  }

  useEffect(() => {
    const storage = window.localStorage;
    const loaded = loadShell(storage);
    useShellStore.getState().markHydrated(loaded);
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
        applyLoadedAccount(result.account);
        return;
      }
      if (result.status === 'offline') {
        setOffline(true);
        setBooting(false);
        return;
      }
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

  useEffect(() => {
    if (!account) return;
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
  }, [account]);

  useEffect(() => {
    if (!state.hydrated || !account) return;
    const match = tabFromHref(href);
    if (!match || !isConsoleRouteAccessible(match.href, account.role)) return;
    if (match.href !== href) router.replace(match.href);
    if (useShellStore.getState().activeId === match.href) return;
    useShellStore.getState().dispatch({ type: 'open', href: match.href });
  }, [account, href, router, state.hydrated]);

  useEffect(() => {
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    if (!active) return;
    document.title = `${active.title} · ${SITE_NAME}`;
  }, [state.activeId, state.tabs, href]);

  function onDispatch(action: ShellAction) {
    useShellStore.getState().dispatch(action);
    if (action.type === 'prefs') {
      const nextPrefs = useShellStore.getState().prefs;
      setAccount((curr) => (curr ? { ...curr, uiPrefs: nextPrefs } : curr));
      void saveAccountUiPrefs(window.sessionStorage, nextPrefs);
    }
    if (!NAVIGATING.has(action.type)) return;
    const next = useShellStore.getState();
    const active = next.tabs.find((tab) => tab.id === next.activeId);
    if (active && active.href !== hrefRef.current) router.push(active.href);
  }

  async function onLogout() {
    persistEnabled.current = false;
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
      onLogout={() => void onLogout()}
      onChangePassword={async (values) => {
        const result = await changePassword(window.sessionStorage, values);
        return result.ok ? null : result.message;
      }}
    />
  );
}
