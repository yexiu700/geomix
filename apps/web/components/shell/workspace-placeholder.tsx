'use client';

import { Button, Skeleton } from 'antd';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { SignalError } from '../geo/primitives';
import { EmptyState, PageHeader, Section, StatusBadge } from '../ui';
import { useConsoleContext } from './console-context';

export type WorkspaceHighlightCard = {
  title: string;
  description: string;
  badge?: string;
};

export function WorkspacePlaceholder({
  workspaceTitle,
  subtitle,
  highlights,
}: {
  workspaceTitle: string;
  subtitle: string;
  highlights: readonly WorkspaceHighlightCard[];
}) {
  const consoleCtx = useConsoleContext();
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);

  if (state.brandsLoading) {
    return (
      <section aria-label={workspaceTitle} aria-busy="true" data-testid="workspace-loading">
        <Skeleton active title={{ width: '28%' }} paragraph={{ rows: 2 }} />
        <div className="gm-workspace-grid gm-workspace-placeholder-grid">
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="gm-workspace-card">
              <Skeleton active title={{ width: '50%' }} paragraph={{ rows: 3 }} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (state.brandsError) {
    return (
      <section aria-label={workspaceTitle}>
        <SignalError
          message={state.brandsError}
          onRetry={() => {
            void useWorkspaceStore.getState().loadBrands({
              storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
              persistStorage: typeof window !== 'undefined' ? window.localStorage : undefined,
            });
          }}
        />
      </section>
    );
  }

  if (state.brandsLoaded && state.brands.length === 0) {
    return (
      <section aria-label={workspaceTitle}>
        <Section variant="card">
          <EmptyState
            size="full"
            title={workspaceTitle}
            description={subtitle}
            action={
              <Button
                type="primary"
                disabled={consoleCtx?.readOnly}
                onClick={() => consoleCtx?.openCreateBrandModal()}
              >
                60 秒创建首个品牌
              </Button>
            }
          />
        </Section>
      </section>
    );
  }

  const hasCN = Boolean(activeBrand?.markets.some((item) => item.market === 'CN'));
  const hasGlobal = Boolean(activeBrand?.markets.some((item) => item.market === 'GLOBAL'));
  const missingMarket = hasCN && !hasGlobal ? 'GLOBAL' : !hasCN && hasGlobal ? 'CN' : null;

  return (
    <section aria-label={workspaceTitle} className="gm-workspace-placeholder">
      <PageHeader
        data-testid="workspace-context-bar"
        title={workspaceTitle}
        description={subtitle}
        tags={
          <>
            {activeBrand ? (
              <StatusBadge tone="neutral" label={`${activeBrand.name} · ${activeBrand.category}`} />
            ) : null}
            <StatusBadge
              tone="active"
              label={
                state.activeMarket === 'GLOBAL'
                  ? `海外 GLOBAL · ${activeBrandMarket?.locale ?? 'en-US'}`
                  : `CN 国内 · ${activeBrandMarket?.locale ?? 'zh-CN'}`
              }
            />
          </>
        }
        meta={
          activeBrandMarket ? (
            <>
              当地品牌名：{activeBrandMarket.localBrandName} · 官网域名{' '}
              <span className="gm-num">{activeBrandMarket.ownedDomains.length}</span> 个 · 竞品{' '}
              <span className="gm-num">{activeBrandMarket.competitors.length}</span> 家
            </>
          ) : undefined
        }
        action={
          missingMarket ? (
            <Button
              size="small"
              disabled={consoleCtx?.readOnly}
              onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}
            >
              {missingMarket === 'GLOBAL' ? '+ 开启海外市场' : '+ 开启国内市场'}
            </Button>
          ) : undefined
        }
      />

      <div className="gm-workspace-grid">
        {highlights.map((card) => (
          <Section
            key={card.title}
            variant="card"
            title={card.title}
            actions={card.badge ? <StatusBadge tone="neutral" label={card.badge} /> : undefined}
          >
            <p className="gm-workspace-card-desc">{card.description}</p>
          </Section>
        ))}
      </div>
    </section>
  );
}
