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
import { Button, Skeleton, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrandFacts, listBrandMedia } from '../../lib/brands';
import { useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { SignalEmpty, SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { BrandFactsSection } from './brand-facts-section';
import { BrandIdentitySection } from './brand-identity-section';
import { BrandMediaSection } from './brand-media-section';

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
          <nav className="gm-brand-jump-links" aria-label="页面区块跳转">
            <a href="#brand-section-identity">基础身份</a>
            <a href="#brand-section-facts">事实卡</a>
            <a href="#brand-section-media">实拍图库</a>
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
    </section>
  );
}
