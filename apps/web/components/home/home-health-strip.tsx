'use client';

import type { ActionHomeResponse, GeoMarket } from '@geomix/shared';
import type { JSX } from 'react';
import { formatPct } from '../../lib/design-tokens';
import { Explain, KpiStrip, StatusBadge, type KpiStripItem } from '../ui';

export type HomeHealthStripProps = {
  activeMarket: GeoMarket;
  health: ActionHomeResponse['health'];
  readOnly?: boolean;
  onStartMonitor?: () => void;
  onWriteArticle?: () => void;
};

function formatAvgPositionCaption(avgPosition: number | null): string {
  if (avgPosition === null || !Number.isFinite(avgPosition)) {
    return '暂无排名观测，完成监测后显示';
  }
  if (avgPosition <= 1.5) {
    return '多数回答将品牌排在第 1 位';
  }
  const roundedRank = Math.max(1, Math.round(avgPosition));
  if (avgPosition <= 3.0) {
    return `多数回答将品牌排在第 ${roundedRank} 位（前 3 位）`;
  }
  return `多数回答将品牌排在第 ${roundedRank} 位`;
}

export function HomeHealthStrip({ activeMarket, health }: HomeHealthStripProps): JSX.Element {
  const engineScopeLabel =
    activeMarket === 'GLOBAL' ? '海外 5 引擎隔离统计' : '国内 4 引擎隔离统计';

  const mentionPct = Number.isFinite(health.mentionRatePct) ? health.mentionRatePct : 0;
  const sovPct = Number.isFinite(health.shareOfVoicePct) ? health.shareOfVoicePct : 0;
  const ownedPct = Number.isFinite(health.ownedCitationRatePct) ? health.ownedCitationRatePct : 0;
  const hasAvgPosition = health.avgPosition !== null && Number.isFinite(health.avgPosition);

  const items: KpiStripItem[] = [
    {
      key: 'mention',
      testId: 'home-kpi-mention',
      label: '提及率',
      value: formatPct(mentionPct),
      progressPct: mentionPct,
      tone: 'accent',
      caption: `近 ${health.days} 天 · ${engineScopeLabel}`,
    },
    {
      key: 'sov',
      testId: 'home-kpi-sov',
      label: '声量',
      value: formatPct(sovPct),
      progressPct: sovPct,
      tone: 'active',
      caption: '本品牌 vs 竞品总声量',
    },
    {
      key: 'position',
      testId: 'home-kpi-position',
      label: '平均顺位',
      value: hasAvgPosition ? `#${health.avgPosition!.toFixed(1)}` : '—',
      tone: hasAvgPosition ? 'warning' : 'neutral',
      caption: formatAvgPositionCaption(health.avgPosition),
    },
    {
      key: 'owned',
      testId: 'home-kpi-owned',
      label: '自有引用',
      value: formatPct(ownedPct),
      progressPct: ownedPct,
      tone: 'success',
      caption: '官网与自有域名被引用占比',
    },
  ];

  return (
    <>
      {health.hasSimulatedObservations ? (
        <div className="gm-home-simulated-notice" data-testid="home-simulated-badge">
          <StatusBadge tone="warning" label="模拟数据" />
          <Explain
            text="当前监测统计包含模拟采集观测，仅用于演示参考，不代表真实 AI 引擎线上表现"
            label="模拟数据说明"
          />
        </div>
      ) : null}
      <KpiStrip items={items} aria-label="品牌健康信号条" data-testid="home-health-strip" />
    </>
  );
}
