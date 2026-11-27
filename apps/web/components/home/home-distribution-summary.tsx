'use client';

import type {
  ActionHomeResponse,
  DistributionSummaryDto,
  RetestBudgetSummaryDto,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { Explain, StatusBadge } from '../ui';

export type HomeDistributionSummaryProps = {
  summary?: DistributionSummaryDto | null;
  retestBudget?: RetestBudgetSummaryDto | null;
  recentArticles?: readonly ActionHomeResponse['recentArticles'][number][];
  onOpenStudio?: () => void;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 首页一行式分发追踪汇总条（Y33）：完整 DiD / Wilson / 预算进度条与渠道归因表已迁至 /publish?tab=tracking。
 */
export function HomeDistributionSummary({
  summary,
  retestBudget,
  recentArticles = [],
  onOpenStudio,
}: HomeDistributionSummaryProps): JSX.Element | null {
  const crawlAlerts = summary?.crawlAlerts ?? [];
  const upcomingRetests = summary?.upcomingRetests ?? [];
  const channelAttribution = summary?.channelAttribution ?? [];

  const publishedCountFromAttr = channelAttribution.reduce(
    (sum, item) => sum + (isFiniteNumber(item.publishedCount) ? item.publishedCount : 0),
    0,
  );
  const publishedCountFallback = recentArticles.filter((art) => Boolean(art.publishRecord)).length;
  const publishedCount =
    publishedCountFromAttr > 0 ? publishedCountFromAttr : publishedCountFallback;

  const pendingRetestCount = upcomingRetests.length;
  const alertCount = crawlAlerts.length;

  const budgetUsed = isFiniteNumber(retestBudget?.usedPoints)
    ? Math.max(0, Math.trunc(retestBudget.usedPoints))
    : 0;
  const rawCap = isFiniteNumber(retestBudget?.capPoints)
    ? Math.trunc(retestBudget.capPoints)
    : null;
  const budgetCap = rawCap !== null && rawCap > 0 ? rawCap : null;
  const skippedCapCount = isFiniteNumber(retestBudget?.skippedCount)
    ? Math.max(0, Math.trunc(retestBudget.skippedCount))
    : 0;
  const hasBudgetSignal =
    Boolean(retestBudget) && (budgetCap !== null || budgetUsed > 0 || skippedCapCount > 0);

  const didValues: number[] = [];
  for (const art of recentArticles) {
    for (const sched of art.publishRecord?.retestSchedules ?? []) {
      if (sched.status === 'COMPLETED' && isFiniteNumber(sched.controlMetricsJson?.did?.netLift)) {
        didValues.push(sched.controlMetricsJson!.did!.netLift);
      }
    }
  }
  const avgDidLift =
    didValues.length > 0 ? didValues.reduce((sum, v) => sum + v, 0) / didValues.length : null;
  const didLabel =
    avgDidLift !== null && Number.isFinite(avgDidLift)
      ? `DiD ${avgDidLift > 0 ? '+' : ''}${(avgDidLift * 100).toFixed(1)}pp`
      : null;

  if (
    publishedCount === 0 &&
    pendingRetestCount === 0 &&
    alertCount === 0 &&
    !hasBudgetSignal &&
    !didLabel
  ) {
    return null;
  }

  return (
    <section
      className="gm-home-did-strip"
      aria-label="分发追踪"
      data-testid="home-distribution-summary"
    >
      <div className="gm-home-did-main">
        <span className="gm-home-did-title">分发追踪</span>
        <Explain
          text="完整 DiD 归因、月度复测预算、待执行复测计划与渠道归因表已收纳至发布中心追踪页。"
          label="分发追踪说明"
        />
        <div className="gm-home-did-meta">
          {publishedCount > 0 ? (
            <span className="gm-home-chip gm-num">已发 {publishedCount} 篇</span>
          ) : null}
          {pendingRetestCount > 0 ? (
            <span className="gm-home-chip gm-num">待复测 {pendingRetestCount} 项</span>
          ) : null}
          {alertCount > 0 ? <StatusBadge tone="danger" label={`异常 ${alertCount}`} /> : null}
          {budgetCap !== null ? (
            <span className="gm-home-chip gm-num" data-testid="home-retest-budget-summary">
              预算 {budgetUsed}/{budgetCap} 点
            </span>
          ) : budgetUsed > 0 ? (
            <span className="gm-home-chip gm-num" data-testid="home-retest-budget-summary">
              已用 {budgetUsed} 点
            </span>
          ) : null}
          {skippedCapCount > 0 ? (
            <StatusBadge tone="warning" label={`达上限 (${skippedCapCount})`} />
          ) : null}
          {didLabel ? (
            <span className="gm-home-chip gm-num" data-testid="home-did-compact">
              {didLabel}
            </span>
          ) : null}
        </div>
      </div>

      {onOpenStudio ? (
        <Button size="small" type="link" autoInsertSpace={false} onClick={onOpenStudio}>
          去发布
        </Button>
      ) : null}
    </section>
  );
}
