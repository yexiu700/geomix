'use client';

import {
  GEO_MARKET_LABELS,
  formatShanghaiDateTime,
  type BrandFactRecord,
  type BrandFactsResponse,
  type BrandMediaAssetRecord,
  type GeoMarket,
  type MediaStorageSummary,
  type RetestBudgetSummaryDto,
} from '@geomix/shared';
import { Alert, Button, Skeleton, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteBrand, getBrandFacts, listBrandMedia } from '../../lib/brands';
import { fetchActionHome } from '../../lib/home';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { EmptyState, PageHeader, RowActions, StatusBadge, type RowActionItem } from '../ui';
import { BrandChannelConnections } from './brand-channel-connections';
import { BrandFactsSection } from './brand-facts-section';
import { BrandIdentitySection } from './brand-identity-section';
import { BrandMediaSection } from './brand-media-section';
import { BrandProductLinesSection } from './brand-product-lines-section';
import { ExtensionPairingPanel } from './extension-pairing-panel';

type ShopifyOAuthBannerState = {
  status: 'connected' | 'error';
  connectionId?: string;
  reason?: string;
};

type BrandSectionAnchor = {
  id: string;
  label: string;
  cnOnly?: boolean;
};

const BRAND_SECTION_ANCHORS: readonly BrandSectionAnchor[] = [
  { id: 'brand-section-identity', label: '基础身份' },
  { id: 'brand-section-product-lines', label: '产品线' },
  { id: 'brand-section-facts', label: '事实卡' },
  { id: 'brand-section-media', label: '实拍图库' },
  { id: 'brand-section-connections', label: '发布渠道' },
  { id: 'brand-section-extension', label: '扩展配对', cnOnly: true },
];

const KNOWN_OAUTH_ERROR_REASONS: Record<string, string> = {
  access_denied: '您已取消 Shopify 店铺授权。',
  invalid_hmac: 'Shopify 回调签名校验未通过，请重新发起授权。',
  invalid_state: '授权会话已过期或无效，请重新发起 OAuth 授权。',
  state_expired: '授权会话已超过 10 分钟有效期，请重新发起授权。',
  token_exchange_failed: 'Shopify 换取访问令牌失败，请稍后重试或改用 Custom App Token。',
  shop_mismatch: '回调店铺域名与发起授权的店铺不一致，已安全拦截。',
  oauth_unconfigured: '服务端尚未配置 Shopify OAuth 凭据，请改用 Custom App Token 接入。',
};

const DEFAULT_OAUTH_ERROR_MESSAGE =
  'Shopify OAuth 授权未完成，请重试或改用 Custom App Token 接入。';

function formatSafeOAuthReason(raw: string | null): string {
  if (!raw) return DEFAULT_OAUTH_ERROR_MESSAGE;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 160);
  if (!cleaned) return DEFAULT_OAUTH_ERROR_MESSAGE;
  const key = cleaned.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_OAUTH_ERROR_REASONS, key)) {
    return KNOWN_OAUTH_ERROR_REASONS[key] ?? DEFAULT_OAUTH_ERROR_MESSAGE;
  }
  return DEFAULT_OAUTH_ERROR_MESSAGE;
}

export function BrandsWorkspace() {
  const consoleCtx = useConsoleContext();
  const feedback = useUxFeedback();
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);
  const activeBrandId = activeBrand?.id ?? null;
  const readOnly = Boolean(consoleCtx?.readOnly);
  const shellManagesProductLines = Boolean(consoleCtx?.managesProductLines);

  const [factsLoading, setFactsLoading] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [facts, setFacts] = useState<BrandFactRecord[]>([]);
  const [truthSignedAt, setTruthSignedAt] = useState<string | null>(null);

  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaItems, setMediaItems] = useState<BrandMediaAssetRecord[]>([]);
  const [mediaStorage, setMediaStorage] = useState<MediaStorageSummary | null>(null);
  const [shopifyOAuthBanner, setShopifyOAuthBanner] = useState<ShopifyOAuthBannerState | null>(
    null,
  );
  const [activeAnchorId, setActiveAnchorId] = useState<string>('brand-section-identity');
  const [identityDirty, setIdentityDirty] = useState(false);
  const [retestBudget, setRetestBudget] = useState<RetestBudgetSummaryDto | null>(null);

  const loadSeqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const activeBrandIdRef = useRef<string | null>(activeBrandId);
  activeBrandIdRef.current = activeBrandId;

  const visibleAnchors = useMemo(
    () => BRAND_SECTION_ANCHORS.filter((anchor) => !anchor.cnOnly || state.activeMarket === 'CN'),
    [state.activeMarket],
  );

  const fetchBrandAssets = useCallback((brandId: string, options?: { silent?: boolean }) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const seq = ++loadSeqRef.current;

    if (!options?.silent) {
      setFactsLoading(true);
      setMediaLoading(true);
      setFactsError(null);
      setMediaError(null);
      setFacts([]);
      setTruthSignedAt(null);
      setMediaItems([]);
      setMediaStorage(null);
    }

    const reqOpts = { storage: window.sessionStorage, signal: controller.signal };
    void Promise.allSettled([
      getBrandFacts(brandId, reqOpts),
      listBrandMedia(brandId, reqOpts),
    ]).then(([factsRes, mediaRes]) => {
      if (controller.signal.aborted || seq !== loadSeqRef.current) return;

      if (factsRes.status === 'fulfilled') {
        setFacts(factsRes.value.items);
        setTruthSignedAt(factsRes.value.truthAgreementSignedAt);
        setFactsError(null);
      } else {
        const msg =
          factsRes.reason instanceof Error && factsRes.reason.message
            ? factsRes.reason.message
            : '无法加载品牌事实卡';
        setFactsError(msg);
      }
      setFactsLoading(false);

      if (mediaRes.status === 'fulfilled') {
        setMediaItems(mediaRes.value.items);
        setMediaStorage(mediaRes.value.storage ?? null);
        setMediaError(null);
      } else {
        const msg =
          mediaRes.reason instanceof Error && mediaRes.reason.message
            ? mediaRes.reason.message
            : '无法加载产品实拍图库';
        setMediaError(msg);
      }
      setMediaLoading(false);
    });
  }, []);

  useEffect(() => {
    setIdentityDirty(false);
    if (!activeBrandId) {
      controllerRef.current?.abort();
      loadSeqRef.current += 1;
      setFacts([]);
      setTruthSignedAt(null);
      setFactsError(null);
      setFactsLoading(false);
      setMediaItems([]);
      setMediaStorage(null);
      setMediaError(null);
      setMediaLoading(false);
      return undefined;
    }
    fetchBrandAssets(activeBrandId);
    if (!shellManagesProductLines) {
      const storeState = useWorkspaceStore.getState();
      if (!storeState.productLinesLoading && storeState.productLinesBrandId !== activeBrandId) {
        void storeState.loadProductLines(activeBrandId, { storage: window.sessionStorage });
      }
    }
    return () => {
      controllerRef.current?.abort();
    };
  }, [activeBrandId, fetchBrandAssets, shellManagesProductLines]);

  useEffect(() => {
    setRetestBudget(null);
    if (!activeBrandId || !activeBrandMarket) return undefined;
    const ctrl = new AbortController();
    void fetchActionHome(activeBrandId, state.activeMarket, {
      storage: window.sessionStorage,
      signal: ctrl.signal,
    })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setRetestBudget(res.retestBudget ?? null);
      })
      .catch(() => undefined);
    return () => {
      ctrl.abort();
    };
  }, [activeBrandId, activeBrandMarket, state.activeMarket]);

  useTabFreshness({
    active: Boolean(activeBrandId),
    domains: ['brand-facts', 'brand-media'],
    refreshOnActivate: false,
    onRefresh: () => {
      if (activeBrandId) {
        fetchBrandAssets(activeBrandId, { silent: true });
      }
    },
  });

  const hasIndexingFacts = facts.some((item) => item.indexStatus === 'INDEXING');

  useTaskPolling({
    enabled: Boolean(activeBrandId) && hasIndexingFacts,
    active: true,
    intervalMs: 3_000,
    onPoll: async () => {
      if (!activeBrandId) return;
      const pollBrandId = activeBrandId;
      const pollSeq = loadSeqRef.current;
      try {
        const latest = await getBrandFacts(pollBrandId, { storage: window.sessionStorage });
        if (pollSeq !== loadSeqRef.current) return;
        setFacts(latest.items);
        setTruthSignedAt(latest.truthAgreementSignedAt);
      } catch {
        // Ignore transient poll errors
      }
    },
  });

  // Parse Shopify OAuth callback query params safely (without useSearchParams) & clean transient URL params
  const urlSearch = consoleCtx?.urlSearch ?? '';
  const consumedOAuthSearchRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rawSearch = urlSearch || window.location.search;
    const normalizedSearch = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
    const params = new URLSearchParams(normalizedSearch);
    const oauthStatus = params.get('shopifyOAuth');
    if (oauthStatus !== 'connected' && oauthStatus !== 'error') {
      consumedOAuthSearchRef.current = null;
      return;
    }
    if (consumedOAuthSearchRef.current === normalizedSearch) return;
    consumedOAuthSearchRef.current = normalizedSearch;

    const connectionId = params.get('connectionId')?.trim() || undefined;
    const rawReason =
      params.get('reason') ?? params.get('error_description') ?? params.get('error');
    setShopifyOAuthBanner({
      status: oauthStatus,
      connectionId,
      reason: oauthStatus === 'error' ? formatSafeOAuthReason(rawReason) : undefined,
    });
    if (oauthStatus === 'connected') {
      invalidateFreshness('channel-connections');
    }
    // Clean transient OAuth params from URL while preserving brandId & market
    const currentUrl = new URL(window.location.href);
    for (const transientKey of [
      'shopifyOAuth',
      'connectionId',
      'reason',
      'error',
      'error_description',
    ]) {
      currentUrl.searchParams.delete(transientKey);
    }
    const nextRelative = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    window.history.replaceState(window.history.state, '', nextRelative);
  }, [urlSearch]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (state.activeMarket !== 'CN') {
      setActiveAnchorId((prev) =>
        prev === 'brand-section-extension' ? 'brand-section-identity' : prev,
      );
      return;
    }
    const rawSearch = urlSearch || window.location.search;
    const params = new URLSearchParams(rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch);
    const section = params.get('section');
    if (section === 'extension' || window.location.hash === '#brand-section-extension') {
      setActiveAnchorId('brand-section-extension');
      const target = document.getElementById('brand-section-extension');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [urlSearch, state.activeMarket, activeBrandId]);

  useEffect(() => {
    if (
      !activeBrandId ||
      typeof window === 'undefined' ||
      typeof window.IntersectionObserver !== 'function'
    ) {
      return undefined;
    }
    const elements = visibleAnchors
      .map((anchor) => document.getElementById(anchor.id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (elements.length === 0) return undefined;

    const observer = new window.IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const topEntry = visible[0];
        if (topEntry?.target.id) {
          setActiveAnchorId(topEntry.target.id);
        }
      },
      { rootMargin: '-12% 0px -65% 0px', threshold: 0 },
    );
    for (const el of elements) {
      observer.observe(el);
    }
    return () => {
      observer.disconnect();
    };
  }, [activeBrandId, visibleAnchors]);

  // Cold-load skeleton state (zero 0-count or empty-state flash)
  if (state.brandsLoading) {
    return (
      <section
        className="gm-brands-page"
        aria-label="品牌资产"
        aria-busy="true"
        data-testid="brands-loading"
      >
        <div className="gm-brand-loading-header">
          <Skeleton active paragraph={{ rows: 1 }} />
        </div>
        <SignalSkeleton variant="block" height={180} />
        <SignalSkeleton variant="block" height={220} />
        <SignalSkeleton variant="block" height={160} />
      </section>
    );
  }

  if (state.brandsError) {
    return (
      <section className="gm-brands-page" aria-label="品牌资产">
        <SignalError
          message={state.brandsError}
          onRetry={() =>
            void useWorkspaceStore.getState().loadBrands({
              storage: window.sessionStorage,
              persistStorage: window.localStorage,
            })
          }
        />
      </section>
    );
  }

  if (state.brandsLoaded && (!activeBrand || state.brands.length === 0)) {
    return (
      <section className="gm-brands-page" aria-label="品牌资产">
        <EmptyState
          size="full"
          title="还没有创建任何品牌"
          description="完成 60 秒极速建档，AI 自动提炼 4 块品牌事实卡，立即开启双市场 AI 可见度监测与 GEO 写作闭环。"
          action={
            readOnly ? undefined : (
              <Button type="default" onClick={() => consoleCtx?.openCreateBrandModal()}>
                60 秒创建首个品牌
              </Button>
            )
          }
        />
      </section>
    );
  }

  if (!activeBrand) return null;

  const hasCN = activeBrand.markets.some((m) => m.market === 'CN');
  const hasGlobal = activeBrand.markets.some((m) => m.market === 'GLOBAL');
  const missingMarket: GeoMarket | null = hasCN && hasGlobal ? null : hasCN ? 'GLOBAL' : 'CN';

  const callbackBrandId = activeBrand.id;
  const callbackBrandName = activeBrand.name;

  const brandOverflowItems: readonly RowActionItem[] = [
    {
      key: 'delete-brand',
      label: '删除品牌',
      danger: true,
      disabled: readOnly,
      confirm: {
        title: `确认删除品牌「${callbackBrandName}」？`,
        content: '删除后将同步清除该品牌的市场配置、事实卡与产品实拍图，无法恢复。',
        okText: '确认删除',
        cancelText: '取消',
        danger: true,
      },
      onClick: async () => {
        try {
          await deleteBrand(callbackBrandId, { storage: window.sessionStorage });
          useWorkspaceStore.getState().removeBrand(callbackBrandId, window.localStorage);
          feedback.notifySuccess(`已删除品牌「${callbackBrandName}」`);
        } catch (reason: unknown) {
          feedback.notifyError(
            reason instanceof Error && reason.message ? reason.message : '删除品牌失败',
          );
        }
      },
    },
  ];

  const handleFactsSaved = (res: BrandFactsResponse) => {
    if (res.truthAgreementSignedAt) {
      useWorkspaceStore
        .getState()
        .markBrandTruthSigned(callbackBrandId, res.truthAgreementSignedAt);
    }
    if (activeBrandIdRef.current !== callbackBrandId) return;
    setFacts(res.items);
    setTruthSignedAt(res.truthAgreementSignedAt);
  };

  return (
    <section className="gm-brands-page" aria-label="品牌资产">
      <PageHeader
        title="品牌资产"
        tags={
          <>
            <Tag className="gm-brand-header-tag">{activeBrand.name}</Tag>
            <Tag className="gm-brand-header-tag">{activeBrand.category}</Tag>
            <StatusBadge
              tone="neutral"
              label={`${state.activeMarket === 'CN' ? '🇨🇳' : '🌐'} ${GEO_MARKET_LABELS[state.activeMarket]}${activeBrandMarket ? ` · ${activeBrandMarket.locale}` : ''}`}
            />
          </>
        }
        meta={`更新于 ${formatShanghaiDateTime(activeBrand.updatedAt)}`}
        extra={
          <div className="gm-brand-header-extra">
            {missingMarket ? (
              <Button
                size="small"
                disabled={readOnly}
                className="gm-brand-btn-nowrap"
                onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}
              >
                {missingMarket === 'GLOBAL' ? '+ 开启海外市场' : '+ 开启国内市场'}
              </Button>
            ) : null}
            <RowActions
              moreTestId="brand-actions-trigger"
              moreAriaLabel="更多品牌操作"
              menuItems={brandOverflowItems}
            />
          </div>
        }
        action={
          <Button
            type={identityDirty ? 'default' : 'primary'}
            size="small"
            disabled={readOnly}
            className="gm-brand-btn-nowrap"
            onClick={() => consoleCtx?.openCreateBrandModal()}
          >
            + 新建品牌
          </Button>
        }
      />

      {shopifyOAuthBanner ? (
        <Alert
          type={shopifyOAuthBanner.status === 'connected' ? 'success' : 'error'}
          showIcon
          closable
          data-testid="shopify-oauth-callback-banner"
          className="gm-brand-oauth-banner"
          onClose={() => setShopifyOAuthBanner(null)}
          message={
            shopifyOAuthBanner.status === 'connected'
              ? 'Shopify OAuth 2.0 授权成功，店铺发布渠道已连接'
              : 'Shopify OAuth 2.0 授权未完成'
          }
          description={
            shopifyOAuthBanner.status === 'connected'
              ? '已加密保存店铺访问凭据并自动注册卸载同步 Webhook；可在下方「发布渠道」卡片测试连接或选择目标 Blog。'
              : shopifyOAuthBanner.reason
          }
        />
      ) : null}

      <div className="gm-brands-settings-layout">
        <nav className="gm-brand-anchor-nav" aria-label="页面区块跳转">
          {visibleAnchors.map((anchor) => (
            <a
              key={anchor.id}
              href={`#${anchor.id}`}
              className={
                activeAnchorId === anchor.id
                  ? 'gm-brand-anchor-link is-active'
                  : 'gm-brand-anchor-link'
              }
              aria-current={activeAnchorId === anchor.id ? 'location' : undefined}
              onClick={() => setActiveAnchorId(anchor.id)}
            >
              {anchor.label}
            </a>
          ))}
        </nav>

        <div className="gm-brands-settings-content">
          <BrandIdentitySection
            key={`identity-${activeBrand.id}`}
            brand={activeBrand}
            activeMarket={state.activeMarket}
            activeBrandMarket={activeBrandMarket}
            retestBudget={retestBudget}
            readOnly={readOnly}
            onDirtyChange={setIdentityDirty}
            onBrandUpdated={(updated, market) => {
              const storeState = useWorkspaceStore.getState();
              if (!storeState.brands.some((item) => item.id === updated.id)) return;
              const isStillActive = storeState.activeBrandId === updated.id;
              storeState.upsertBrand(updated, {
                activate: isStillActive,
                market:
                  isStillActive && market && storeState.activeMarket === market
                    ? market
                    : undefined,
                persistStorage: window.localStorage,
              });
            }}
            onOpenEnableMarket={(market) => consoleCtx?.openEnableMarketModal(market)}
          />

          <BrandProductLinesSection
            key={`product-lines-${activeBrand.id}`}
            brand={activeBrand}
            activeMarket={state.activeMarket}
            productLines={state.productLinesBrandId === activeBrand.id ? state.productLines : []}
            loading={state.productLinesLoading}
            error={state.productLinesError}
            readOnly={readOnly}
            onRetry={() =>
              void useWorkspaceStore
                .getState()
                .loadProductLines(activeBrand.id, { storage: window.sessionStorage })
            }
            onProductLinesChanged={() => fetchBrandAssets(activeBrand.id, { silent: true })}
          />

          <BrandFactsSection
            key={`facts-${activeBrand.id}`}
            brand={activeBrand}
            activeBrandMarket={activeBrandMarket}
            productLines={state.productLinesBrandId === activeBrand.id ? state.productLines : []}
            facts={facts}
            loading={factsLoading}
            error={factsError}
            truthSignedAt={truthSignedAt ?? activeBrand.truthAgreementSignedAt}
            readOnly={readOnly}
            onRetry={() => fetchBrandAssets(activeBrand.id)}
            onFactsSaved={handleFactsSaved}
          />

          <BrandMediaSection
            key={`media-${activeBrand.id}`}
            brand={activeBrand}
            items={mediaItems}
            storage={mediaStorage}
            loading={mediaLoading}
            error={mediaError}
            readOnly={readOnly}
            onRetry={() => fetchBrandAssets(activeBrand.id)}
            onMediaChanged={(nextItems, nextStorage) => {
              if (activeBrandIdRef.current !== callbackBrandId) return;
              setMediaItems(nextItems);
              setMediaStorage(nextStorage);
            }}
          />

          <BrandChannelConnections
            key={`connections-${activeBrand.id}-${state.activeMarket}`}
            brandId={activeBrand.id}
            activeMarket={state.activeMarket}
            marketEnabled={Boolean(activeBrandMarket)}
            supportedLocales={activeBrandMarket?.supportedLocales}
            readOnly={readOnly}
            onEnableMarket={() => consoleCtx?.openEnableMarketModal(state.activeMarket)}
          />

          {state.activeMarket === 'CN' ? (
            <ExtensionPairingPanel
              variant="brands"
              readOnly={readOnly}
              active={state.activeMarket === 'CN'}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
