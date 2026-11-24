'use client';

import {
  GEO_MARKET_LABELS,
  formatShanghaiDateTime,
  type BrandFactRecord,
  type BrandFactsResponse,
  type BrandMediaAssetRecord,
  type GeoMarket,
  type MediaStorageSummary,
} from '@geomix/shared';
import { Alert, Button, Skeleton, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrandFacts, listBrandMedia } from '../../lib/brands';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { SignalEmpty, SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { BrandChannelConnections } from './brand-channel-connections';
import { BrandFactsSection } from './brand-facts-section';
import { BrandIdentitySection } from './brand-identity-section';
import { BrandMediaSection } from './brand-media-section';
import { ExtensionPairingPanel } from './extension-pairing-panel';

type ShopifyOAuthBannerState = {
  status: 'connected' | 'error';
  connectionId?: string;
  reason?: string;
};

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
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);
  const activeBrandId = activeBrand?.id ?? null;
  const readOnly = Boolean(consoleCtx?.readOnly);

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

  const loadSeqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const activeBrandIdRef = useRef<string | null>(activeBrandId);
  activeBrandIdRef.current = activeBrandId;

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
    return () => {
      controllerRef.current?.abort();
    };
  }, [activeBrandId, fetchBrandAssets]);

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
    if (state.activeMarket !== 'CN') return;
    const rawSearch = urlSearch || window.location.search;
    const params = new URLSearchParams(rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch);
    const section = params.get('section');
    if (section === 'extension' || window.location.hash === '#brand-section-extension') {
      const target = document.getElementById('brand-section-extension');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [urlSearch, state.activeMarket, activeBrandId]);

  // Cold-load skeleton state (zero 0-count or empty-state flash)
  if (state.brandsLoading) {
    return (
      <section
        className="gm-brands-page"
        aria-label="品牌资产"
        aria-busy="true"
        data-testid="brands-loading"
      >
        <div className="gm-brand-section">
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
        <div className="gm-brand-section">
          <SignalEmpty
            title="还没有创建任何品牌"
            description="完成 60 秒极速建档，AI 自动提炼 4 块品牌事实卡，立即开启双市场 AI 可见度监测与 GEO 写作闭环。"
            actionText={readOnly ? undefined : '60 秒创建首个品牌'}
            onAction={readOnly ? undefined : () => consoleCtx?.openCreateBrandModal()}
          />
        </div>
      </section>
    );
  }

  if (!activeBrand) return null;

  const hasCN = activeBrand.markets.some((m) => m.market === 'CN');
  const hasGlobal = activeBrand.markets.some((m) => m.market === 'GLOBAL');
  const missingMarket: GeoMarket | null = hasCN && hasGlobal ? null : hasCN ? 'GLOBAL' : 'CN';

  const callbackBrandId = activeBrand.id;

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
      <div className="gm-workspace-context-bar gm-brand-context-bar">
        <div className="gm-brand-context-left">
          <Typography.Title level={3} style={{ margin: 0, color: 'var(--gm-fg-1)' }}>
            品牌资产
          </Typography.Title>
          <Tag color="geekblue">{activeBrand.name}</Tag>
          <Tag>{activeBrand.category}</Tag>
          <Tag color="cyan">
            {state.activeMarket === 'CN' ? '🇨🇳' : '🌐'} {GEO_MARKET_LABELS[state.activeMarket]}
            {activeBrandMarket ? ` · ${activeBrandMarket.locale}` : ''}
          </Tag>
          <span className="gm-brand-updated-at">
            更新于 {formatShanghaiDateTime(activeBrand.updatedAt)}
          </span>
        </div>

        <div className="gm-brand-context-actions">
          <nav
            className="gm-brand-jump-links"
            aria-label="页面区块跳转"
            style={{ flexWrap: 'wrap' }}
          >
            <a href="#brand-section-identity">基础身份</a>
            <a href="#brand-section-facts">事实卡</a>
            <a href="#brand-section-media">实拍图库</a>
            <a href="#brand-section-connections">发布渠道</a>
            {state.activeMarket === 'CN' ? <a href="#brand-section-extension">扩展配对</a> : null}
          </nav>
          {missingMarket ? (
            <Button
              size="small"
              disabled={readOnly}
              onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}
            >
              {missingMarket === 'GLOBAL' ? '+ 开启海外市场' : '+ 开启国内市场'}
            </Button>
          ) : null}
          <Button
            type="primary"
            size="small"
            disabled={readOnly}
            onClick={() => consoleCtx?.openCreateBrandModal()}
          >
            + 新建品牌
          </Button>
        </div>
      </div>

      {shopifyOAuthBanner ? (
        <Alert
          type={shopifyOAuthBanner.status === 'connected' ? 'success' : 'error'}
          showIcon
          closable
          data-testid="shopify-oauth-callback-banner"
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
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        />
      ) : null}

      <BrandIdentitySection
        key={`identity-${activeBrand.id}`}
        brand={activeBrand}
        activeMarket={state.activeMarket}
        activeBrandMarket={activeBrandMarket}
        readOnly={readOnly}
        onBrandUpdated={(updated, market) => {
          const isStillActive = useWorkspaceStore.getState().activeBrandId === updated.id;
          useWorkspaceStore.getState().upsertBrand(updated, {
            activate: isStillActive,
            market: isStillActive ? market : undefined,
            persistStorage: window.localStorage,
          });
        }}
        onBrandDeleted={(deletedId) => {
          useWorkspaceStore.getState().removeBrand(deletedId, window.localStorage);
        }}
        onOpenEnableMarket={(market) => consoleCtx?.openEnableMarketModal(market)}
      />

      <BrandFactsSection
        key={`facts-${activeBrand.id}`}
        brand={activeBrand}
        activeBrandMarket={activeBrandMarket}
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
    </section>
  );
}
