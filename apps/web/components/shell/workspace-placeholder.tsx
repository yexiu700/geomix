'use client';

import { Button, Skeleton, Tag, Typography } from 'antd';
import { useConsoleContext } from './console-context';
import { SignalError } from '../geo/primitives';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';

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
        <div className="gm-workspace-grid" style={{ marginTop: 16 }}>
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
        <div className="gm-workspace-card" style={{ padding: 24 }}>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 8 }}>
            {workspaceTitle}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            {subtitle}
          </Typography.Paragraph>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <Button
              type="primary"
              disabled={consoleCtx?.readOnly}
              onClick={() => consoleCtx?.openCreateBrandModal()}
            >
              60 秒创建首个品牌
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const hasCN = Boolean(activeBrand?.markets.some((item) => item.market === 'CN'));
  const hasGlobal = Boolean(activeBrand?.markets.some((item) => item.market === 'GLOBAL'));
  const missingMarket = hasCN && !hasGlobal ? 'GLOBAL' : !hasCN && hasGlobal ? 'CN' : null;

  return (
    <section aria-label={workspaceTitle}>
      <div className="gm-workspace-context-bar" data-testid="workspace-context-bar">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {workspaceTitle}
            </Typography.Title>
            {activeBrand ? (
              <Tag
                color="lime"
                style={{
                  marginInlineEnd: 0,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {activeBrand.name} · {activeBrand.category}
              </Tag>
            ) : null}
            <Tag
              color={state.activeMarket === 'GLOBAL' ? 'blue' : 'cyan'}
              style={{ marginInlineEnd: 0 }}
            >
              {state.activeMarket === 'GLOBAL'
                ? `🌐 海外市场 · ${activeBrandMarket?.locale ?? 'en-US'}`
                : `🇨🇳 国内市场 · ${activeBrandMarket?.locale ?? 'zh-CN'}`}
            </Tag>
          </div>
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            {subtitle}
          </Typography.Paragraph>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {activeBrandMarket ? (
            <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
              当地品牌名：{activeBrandMarket.localBrandName} · 官网域名{' '}
              <span className="gm-num">{activeBrandMarket.ownedDomains.length}</span> 个 · 竞品{' '}
              <span className="gm-num">{activeBrandMarket.competitors.length}</span> 家
            </span>
          ) : null}
          {missingMarket ? (
            <Button
              size="small"
              disabled={consoleCtx?.readOnly}
              onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}
            >
              {missingMarket === 'GLOBAL' ? '+ 开启海外市场' : '+ 开启国内市场'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="gm-workspace-grid">
        {highlights.map((card) => (
          <article key={card.title} className="gm-workspace-card">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <strong style={{ color: 'var(--gm-fg-1)', fontSize: 14 }}>{card.title}</strong>
              {card.badge ? <Tag style={{ marginInlineEnd: 0 }}>{card.badge}</Tag> : null}
            </div>
            <p style={{ margin: 0, color: 'var(--gm-fg-2)', fontSize: 12, lineHeight: '20px' }}>
              {card.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
