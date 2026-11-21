'use client';

import {
  SITE_NAME,
  replaceUxJargon,
  type CreateBrandInput,
  type GeoMarket,
  type UpsertBrandFactsInput,
  type UpsertBrandMarketInput,
} from '@geomix/shared';
import { Button } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  clearCachedAccount,
  patchCachedAccountUiPrefs,
  readCachedAccount,
  writeCachedAccount,
} from '../../lib/account-cache';
import { httpAnnouncements, httpWallet, type WalletSummary } from '../../lib/account-client';
import {
  changePassword,
  loadAccount,
  logoutSession,
  saveAccountUiPrefs,
  type AccountProfile,
} from '../../lib/api';
import {
  createBrand,
  enableBrandMarket,
  extractBrandFacts,
  saveBrandFacts,
  type ExtractBrandFactsRequest,
} from '../../lib/brands';
import { safeConsoleHref } from '../../lib/route-map';
import {
  HOME_ROUTE,
  buildWorkspaceHref,
  isConsoleRouteAccessible,
  matchRoute,
} from '../../lib/routes';
import { clearSession, readAccessToken } from '../../lib/session';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { WORKSPACE_USER_KEY, parseGeoMarket, useWorkspaceStore } from '../../lib/workspace-store';
import { ConsoleProvider } from './console-context';
import { ShellFrame } from './shell-frame';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function ConsoleShell({ children }: { children?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || HOME_ROUTE;
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const href = search ? `${pathname}?${search}` : pathname;
  const hrefRef = useRef(href);
  hrefRef.current = href;

  const workspace = useWorkspaceStore();
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const accountRef = useRef<AccountProfile | null>(null);
  accountRef.current = account;
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [booting, setBooting] = useState(true);
  const [createBrandModalOpen, setCreateBrandModalOpen] = useState(false);
  const [enableMarketModalTarget, setEnableMarketModalTarget] = useState<GeoMarket | null>(null);

  const localPrefsDirtyRef = useRef(false);
  const walletSeqRef = useRef(0);

  const applyLoadedAccount = useCallback(
    (nextAccount: AccountProfile, options?: { fromCache?: boolean }) => {
      const prevUserId = window.localStorage.getItem(WORKSPACE_USER_KEY);
      if (prevUserId && prevUserId !== nextAccount.id) {
        useWorkspaceStore.getState().reset(window.localStorage);
        useWorkspaceStore.getState().hydrate(window.location.search, window.localStorage);
      }
      window.localStorage.setItem(WORKSPACE_USER_KEY, nextAccount.id);

      if (
        !options?.fromCache &&
        !localPrefsDirtyRef.current &&
        typeof nextAccount.uiPrefs?.menuCollapsed === 'boolean'
      ) {
        useWorkspaceStore
          .getState()
          .setMenuCollapsed(nextAccount.uiPrefs.menuCollapsed, window.localStorage);
      }
      accountRef.current = nextAccount;
      setAccount(nextAccount);
      setOffline(false);
      setBooting(false);
    },
    [],
  );

  useIsomorphicLayoutEffect(() => {
    useWorkspaceStore.getState().hydrate(window.location.search, window.localStorage);
    const cached = readCachedAccount(window.sessionStorage);
    if (cached) {
      applyLoadedAccount(cached, { fromCache: true });
    }
  }, [applyLoadedAccount]);

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
      const next = safeConsoleHref(hrefRef.current) ?? HOME_ROUTE;
      const notice = result.status === 'disabled' ? 'disabled' : hadToken ? 'session' : '';
      const query = new URLSearchParams({ next });
      if (notice) query.set('notice', notice);
      router.replace(`/login?${query.toString()}`);
    });
    return () => {
      live = false;
    };
  }, [applyLoadedAccount, router]);

  const refreshWallet = useCallback(async () => {
    const seq = ++walletSeqRef.current;
    try {
      const next = await httpWallet(window.sessionStorage);
      if (seq !== walletSeqRef.current) return;
      setWallet(next);
    } catch {
      // Keep previous wallet or null on transient error without flashing fake 0
    } finally {
      if (seq === walletSeqRef.current) {
        setWalletLoading(false);
      }
    }
  }, []);

  const accountId = account?.id ?? null;

  useEffect(() => {
    if (!accountId) return;
    const params = new URLSearchParams(window.location.search);
    const urlBrandId = params.get('brandId')?.trim() || undefined;
    const urlMarket = parseGeoMarket(params.get('market')) ?? undefined;

    void useWorkspaceStore.getState().loadBrands({
      storage: window.sessionStorage,
      persistStorage: window.localStorage,
      preferredBrandId: urlBrandId,
      preferredMarket: urlMarket,
    });

    setWalletLoading(true);
    void refreshWallet();

    let live = true;
    void httpAnnouncements(window.sessionStorage).then(
      (items) => {
        if (!live) return;
        if (items.length === 0) {
          setAnnouncement(null);
          return;
        }
        setAnnouncement(items.map(replaceUxJargon).join('  ·  '));
      },
      () => undefined,
    );

    return () => {
      live = false;
    };
  }, [accountId, refreshWallet]);

  useTabFreshness({
    active: Boolean(accountId),
    domains: ['points'],
    refreshOnActivate: false,
    onRefresh: () => {
      void refreshWallet();
    },
  });

  useEffect(() => {
    if (!workspace.hydrated) return;
    useWorkspaceStore.getState().syncFromUrl(search, window.localStorage);
  }, [search, workspace.hydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      useWorkspaceStore.getState().syncFromUrl(window.location.search, window.localStorage);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const routeMatch = matchRoute(href);
  const expectedTitle = routeMatch ? `${routeMatch.title} · ${SITE_NAME}` : null;

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

  const navigateWorkspace = useCallback(
    (targetHref: string) => {
      if (targetHref.startsWith('/admin')) {
        router.push(targetHref);
        return;
      }
      const { activeBrandId, activeMarket } = useWorkspaceStore.getState();
      const nextHref = buildWorkspaceHref(targetHref, activeBrandId, activeMarket);
      router.push(nextHref);
    },
    [router],
  );

  const handleToggleMenu = useCallback(() => {
    const nextCollapsed = !useWorkspaceStore.getState().menuCollapsed;
    localPrefsDirtyRef.current = true;
    useWorkspaceStore.getState().setMenuCollapsed(nextCollapsed, window.localStorage);
    patchCachedAccountUiPrefs(window.sessionStorage, { menuCollapsed: nextCollapsed });
    void saveAccountUiPrefs(window.sessionStorage, { menuCollapsed: nextCollapsed });
  }, []);

  const handleCreateBrand = useCallback(async (input: CreateBrandInput) => {
    const created = await createBrand(input, { storage: window.sessionStorage });
    useWorkspaceStore.getState().upsertBrand(created, {
      activate: true,
      persistStorage: window.localStorage,
    });
    return created;
  }, []);

  const handleEnableMarket = useCallback(
    async (brandId: string, market: GeoMarket, input: UpsertBrandMarketInput) => {
      const updated = await enableBrandMarket(brandId, market, input, {
        storage: window.sessionStorage,
      });
      useWorkspaceStore.getState().upsertBrand(updated, {
        activate: true,
        market,
        persistStorage: window.localStorage,
      });
      return updated;
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    clearCachedAccount();
    walletSeqRef.current += 1;
    setWallet(null);
    setWalletLoading(true);
    useWorkspaceStore.getState().reset(window.localStorage);
    await logoutSession(window.sessionStorage);
    router.replace('/login');
  }, [router]);

  const contextValue = useMemo(
    () =>
      account
        ? {
            account,
            readOnly: account.tenant.readOnly,
            wallet,
            walletLoading,
            openCreateBrandModal: () => setCreateBrandModalOpen(true),
            openEnableMarketModal: (market: GeoMarket) => setEnableMarketModalTarget(market),
            refreshWallet,
            navigateWorkspace,
          }
        : null,
    [account, navigateWorkspace, refreshWallet, wallet, walletLoading],
  );

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

  if (booting || !account || !workspace.hydrated || !contextValue) {
    return <main className="gm-boot">正在确认登录</main>;
  }

  if (!isConsoleRouteAccessible(href)) {
    return (
      <main className="gm-boot">
        <p>没有这个页面</p>
        <Button type="primary" onClick={() => router.push(HOME_ROUTE)}>
          回首页
        </Button>
      </main>
    );
  }

  return (
    <ConsoleProvider value={contextValue}>
      <ShellFrame
        account={account}
        activePath={pathname}
        brands={workspace.brands}
        brandsLoading={workspace.brandsLoading}
        brandsLoaded={workspace.brandsLoaded}
        brandsError={workspace.brandsError}
        activeBrandId={workspace.activeBrandId}
        activeMarket={workspace.activeMarket}
        menuCollapsed={workspace.menuCollapsed}
        wallet={wallet}
        walletLoading={walletLoading}
        announcement={announcement}
        createBrandModalOpen={createBrandModalOpen}
        enableMarketModalTarget={enableMarketModalTarget}
        onOpenCreateBrandModal={() => setCreateBrandModalOpen(true)}
        onCloseCreateBrandModal={() => setCreateBrandModalOpen(false)}
        onOpenEnableMarketModal={(market) => setEnableMarketModalTarget(market)}
        onCloseEnableMarketModal={() => setEnableMarketModalTarget(null)}
        onNavigate={navigateWorkspace}
        onSelectBrand={(brandId) =>
          useWorkspaceStore.getState().setActiveBrand(brandId, undefined, window.localStorage)
        }
        onSelectMarket={(market) =>
          useWorkspaceStore.getState().setActiveMarket(market, window.localStorage)
        }
        onCreateBrand={handleCreateBrand}
        onExtractBrandFacts={(brandId: string, input: ExtractBrandFactsRequest) =>
          extractBrandFacts(brandId, input, { storage: window.sessionStorage })
        }
        onSaveBrandFacts={(brandId: string, input: UpsertBrandFactsInput) =>
          saveBrandFacts(brandId, input, { storage: window.sessionStorage })
        }
        onBrandFactsSaved={(brandId, signedAt) => {
          if (signedAt) {
            useWorkspaceStore.getState().markBrandTruthSigned(brandId, signedAt);
          }
          invalidateFreshness('brand-facts');
        }}
        onEnableMarket={handleEnableMarket}
        onToggleMenu={handleToggleMenu}
        onLogout={() => void handleLogout()}
        onChangePassword={async (values) => {
          const result = await changePassword(window.sessionStorage, values);
          return result.ok ? null : result.message;
        }}
      >
        {children}
      </ShellFrame>
    </ConsoleProvider>
  );
}
