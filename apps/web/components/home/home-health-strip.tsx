'use client';

import type { ActionHomeResponse, GeoMarket } from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { SignalKpiCard } from '../geo/primitives';

export type HomeHealthStripProps = {
  activeMarket: GeoMarket;
  health: ActionHomeResponse['health'];
  readOnly: boolean;
  onStartMonitor: () => void;
  onWriteArticle: () => void;
};

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

export function HomeHealthStrip({
  activeMarket,
  health,
  readOnly,
  onStartMonitor,
  onWriteArticle,
}: HomeHealthStripProps): JSX.Element {
  const engineScopeLabel =
    activeMarket === 'GLOBAL' ? '海外 5 引擎隔离统计' : '国内 8 引擎隔离统计';

  return (
    <section
      className="gm-panel gm-home-block"
      aria-label="品牌健康信号条"
      data-testid="home-health-strip"
    >
      <div className="gm-home-block-head">
        <div className="gm-home-block-heading">
          <h2 className="gm-home-block-title">品牌健康信号条</h2>
          <p className="gm-home-block-desc">
            近 {health.days} 天 · {engineScopeLabel}（已完成{' '}
            <span className="gm-num">{health.completedChecks}</span> 次有效检测）
          </p>
        </div>

        <div className="gm-home-cta-group">
          <Button
            type="primary"
            data-testid="home-cta-monitor"
            disabled={readOnly}
            onClick={onStartMonitor}
          >
            发起新一轮监测
          </Button>
          <Button data-testid="home-cta-write" disabled={readOnly} onClick={onWriteArticle}>
            直接写 GEO 文章
          </Button>
        </div>
      </div>

      <div className="gm-home-kpi-grid">
        <SignalKpiCard
          label="AI 提及率"
          value={formatPct(health.mentionRatePct)}
          tone="cited"
          caption={`近 ${health.days} 天监测提及占比`}
          testId="home-kpi-mention"
        />
        <SignalKpiCard
          label="声量占比 SoV"
          value={formatPct(health.shareOfVoicePct)}
          tone="info"
          caption="本品牌 vs 竞品总声量"
          testId="home-kpi-sov"
        />
        <SignalKpiCard
          label="平均顺位"
          value={
            health.avgPosition !== null && Number.isFinite(health.avgPosition)
              ? `#${health.avgPosition.toFixed(1)}`
              : '—'
          }
          tone="warning"
          caption="AI 推荐清单平均排名"
          testId="home-kpi-position"
        />
        <SignalKpiCard
          label="自有阵地引用率"
          value={formatPct(health.ownedCitationRatePct)}
          tone="cited"
          caption="官网与自有域名被引用占比"
          testId="home-kpi-owned"
        />
      </div>
    </section>
  );
}
