'use client';

import {
  RETEST_SCHEDULE_STATUS_LABELS,
  formatShanghaiDate,
  type ActionHomeResponse,
  type ConfidenceLevel,
  type DidDirection,
  type DistributionChannelAttributionItem,
  type DistributionSummaryDto,
  type RetestBudgetSummaryDto,
  type VisibilitySentiment,
  type WilsonInterval,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { SentimentDot } from '../geo/primitives';
import { Explain, Section, StatusBadge, type StatusTone } from '../ui';

export type PublishAttributionSummaryProps = {
  summary?: DistributionSummaryDto | null;
  retestBudget?: RetestBudgetSummaryDto | null;
  recentArticles?: readonly ActionHomeResponse['recentArticles'][number][];
  onSelectArticle: (articleId: string) => void;
  onOpenPoints?: () => void;
  onOpenBudgetSettings?: () => void;
};

const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  HIGH: '高置信',
  MEDIUM: '中置信',
  LOW: '低置信',
  INSUFFICIENT: '样本不足',
};

const CONFIDENCE_TONE: Record<ConfidenceLevel, StatusTone> = {
  HIGH: 'success',
  MEDIUM: 'active',
  LOW: 'warning',
  INSUFFICIENT: 'neutral',
};

const DID_DIRECTION_LABELS: Record<DidDirection, string> = {
  POSITIVE: '正增益',
  NEGATIVE: '负向变化',
  NEUTRAL: '无差异',
};

const DID_DIRECTION_TONE: Record<DidDirection, StatusTone> = {
  POSITIVE: 'success',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
};

const KNOWN_SENTIMENTS = new Set<string>(['positive', 'neutral', 'mixed', 'negative']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidWilson(wilson: WilsonInterval | null | undefined): wilson is WilsonInterval {
  return Boolean(
    wilson &&
    isFiniteNumber(wilson.lower) &&
    isFiniteNumber(wilson.upper) &&
    isFiniteNumber(wilson.trials) &&
    wilson.trials > 0,
  );
}

function formatDidPp(fraction: number): string {
  const pp = fraction * 100;
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function renderCitationCell(row: DistributionChannelAttributionItem): JSX.Element {
  if (isFiniteNumber(row.citationHitRate)) {
    const pct = (row.citationHitRate * 100).toFixed(1);
    const hasCount =
      isFiniteNumber(row.citationHitCount) &&
      isFiniteNumber(row.completedRetestCount) &&
      row.completedRetestCount > 0;
    const wilson = isValidWilson(row.citationHitWilson) ? row.citationHitWilson : null;
    const isLowSample = wilson ? wilson.confidenceLevel === 'LOW' || wilson.trials < 5 : false;
    return (
      <div className="gm-home-dist-cite-cell">
        <span
          className={`gm-num gm-home-dist-rate${row.citationHitRate > 0 ? ' gm-home-dist-rate--positive' : ''}`}
        >
          {pct}%
          {hasCount ? (
            <span className="gm-home-dist-count">
              ({row.citationHitCount}/{row.completedRetestCount})
            </span>
          ) : null}
        </span>
        {wilson ? (
          <div className="gm-home-dist-wilson" data-testid={`channel-wilson-ci-${row.channel}`}>
            <span className="gm-num gm-home-nowrap">
              95% CI [{(wilson.lower * 100).toFixed(1)}%, {(wilson.upper * 100).toFixed(1)}%]
            </span>
            <StatusBadge
              tone={CONFIDENCE_TONE[wilson.confidenceLevel]}
              label={CONFIDENCE_LABELS[wilson.confidenceLevel]}
            />
            {isLowSample ? (
              <span
                className="gm-home-dist-low-sample"
                data-testid={`channel-low-sample-hint-${row.channel}`}
              >
                样本较少，建议开启 3× 采样
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (isFiniteNumber(row.completedRetestCount) && row.completedRetestCount > 0) {
    return (
      <span
        className="gm-home-dist-degraded"
        title="上游引擎暂未返回引文链接，当前已降级展示提及率、顺位与情感归因"
      >
        待引文就绪
      </span>
    );
  }

  return <span className="gm-home-dist-muted">—</span>;
}

function renderMentionDeltaCell(delta: number | null): JSX.Element {
  if (!isFiniteNumber(delta)) {
    return <span className="gm-home-dist-muted">—</span>;
  }
  const formatted = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
  const toneClass =
    delta > 0
      ? 'gm-home-dist-delta--pos'
      : delta < 0
        ? 'gm-home-dist-delta--neg'
        : 'gm-home-dist-delta--flat';
  return <span className={`gm-num gm-home-dist-delta ${toneClass}`}>{formatted}</span>;
}

function renderPositionCell(
  avgPosition: number | null,
  avgPositionDelta: number | null,
): JSX.Element {
  if (!isFiniteNumber(avgPosition)) {
    return <span className="gm-home-dist-muted">—</span>;
  }
  const deltaNode = isFiniteNumber(avgPositionDelta) ? (
    avgPositionDelta < 0 ? (
      <span className="gm-home-dist-pos-delta gm-home-dist-pos-delta--up">
        (↑{Math.abs(avgPositionDelta).toFixed(1)})
      </span>
    ) : avgPositionDelta > 0 ? (
      <span className="gm-home-dist-pos-delta gm-home-dist-pos-delta--down">
        (↓{avgPositionDelta.toFixed(1)})
      </span>
    ) : (
      <span className="gm-home-dist-pos-delta gm-home-dist-pos-delta--flat">(持平)</span>
    )
  ) : null;

  return (
    <span className="gm-num gm-home-dist-pos">
      #{avgPosition.toFixed(1)}
      {deltaNode}
    </span>
  );
}

function renderSentimentCell(
  sentimentSummary: string | null,
  positiveSentimentRate: number | null,
): JSX.Element {
  const validSentiment =
    sentimentSummary && KNOWN_SENTIMENTS.has(sentimentSummary)
      ? (sentimentSummary as VisibilitySentiment)
      : null;
  const hasPositivePct = isFiniteNumber(positiveSentimentRate);

  if (!validSentiment && !hasPositivePct) {
    return <span className="gm-home-dist-muted">—</span>;
  }

  return (
    <span className="gm-home-dist-sent">
      {validSentiment ? <SentimentDot sentiment={validSentiment} /> : null}
      {hasPositivePct ? (
        <span className="gm-num gm-home-dist-sent-pct">
          {Math.round(positiveSentimentRate * 100)}% 正向
        </span>
      ) : null}
    </span>
  );
}

export function PublishAttributionSummary({
  summary,
  retestBudget,
  recentArticles,
  onSelectArticle,
  onOpenPoints,
  onOpenBudgetSettings,
}: PublishAttributionSummaryProps): JSX.Element | null {
  const upcomingRetests = summary?.upcomingRetests ?? [];
  const channelAttribution = summary?.channelAttribution ?? [];

  const completedRetests = (recentArticles ?? []).flatMap((article) =>
    (article.publishRecord?.retestSchedules ?? [])
      .filter((sched) => sched.status === 'COMPLETED')
      .map((sched) => ({ articleTitle: article.title, sched })),
  );

  const didSamples = completedRetests.filter((entry) => {
    const did = entry.sched.controlMetricsJson?.did;
    return (
      did &&
      isFiniteNumber(did.netLift) &&
      isFiniteNumber(did.treatmentDelta) &&
      isFiniteNumber(did.controlDelta)
    );
  });

  const didSummary =
    didSamples.length > 0
      ? (() => {
          const avgTreatment =
            didSamples.reduce(
              (sum, e) => sum + (e.sched.controlMetricsJson?.did?.treatmentDelta ?? 0),
              0,
            ) / didSamples.length;
          const avgControl =
            didSamples.reduce(
              (sum, e) => sum + (e.sched.controlMetricsJson?.did?.controlDelta ?? 0),
              0,
            ) / didSamples.length;
          const avgNetLift =
            didSamples.reduce(
              (sum, e) => sum + (e.sched.controlMetricsJson?.did?.netLift ?? 0),
              0,
            ) / didSamples.length;
          const direction: DidDirection =
            avgNetLift > 1e-6 ? 'POSITIVE' : avgNetLift < -1e-6 ? 'NEGATIVE' : 'NEUTRAL';
          const latestWilson =
            didSamples.find((e) => isValidWilson(e.sched.metricsSnapshot?.wilson))?.sched
              .metricsSnapshot?.wilson ?? null;
          return {
            count: didSamples.length,
            treatmentDelta: avgTreatment,
            controlDelta: avgControl,
            netLift: avgNetLift,
            direction,
            wilson: latestWilson,
          };
        })()
      : null;

  const latestCompletedWilson =
    didSummary?.wilson ??
    completedRetests.find((e) => isValidWilson(e.sched.metricsSnapshot?.wilson))?.sched
      .metricsSnapshot?.wilson ??
    channelAttribution.find((row) => isValidWilson(row.citationHitWilson))?.citationHitWilson ??
    null;

  const hasLowSampleWarning =
    (latestCompletedWilson !== null &&
      (latestCompletedWilson.confidenceLevel === 'LOW' || latestCompletedWilson.trials < 5)) ||
    channelAttribution.some(
      (row) =>
        isValidWilson(row.citationHitWilson) &&
        (row.citationHitWilson.confidenceLevel === 'LOW' || row.citationHitWilson.trials < 5),
    );

  const budgetUsedPoints = isFiniteNumber(retestBudget?.usedPoints)
    ? Math.max(0, Math.trunc(retestBudget.usedPoints))
    : 0;
  const truncatedCapPoints = isFiniteNumber(retestBudget?.capPoints)
    ? Math.trunc(retestBudget.capPoints)
    : null;
  const budgetCapPoints =
    truncatedCapPoints !== null && truncatedCapPoints > 0 ? truncatedCapPoints : null;
  const budgetSkippedCount = isFiniteNumber(retestBudget?.skippedCount)
    ? Math.max(0, Math.trunc(retestBudget.skippedCount))
    : 0;

  const showBudgetBoard = Boolean(
    retestBudget && (budgetCapPoints !== null || budgetUsedPoints > 0 || budgetSkippedCount > 0),
  );

  const budgetRemainingPoints =
    budgetCapPoints !== null
      ? isFiniteNumber(retestBudget?.remainingPoints)
        ? Math.max(0, Math.trunc(retestBudget.remainingPoints))
        : Math.max(0, budgetCapPoints - budgetUsedPoints)
      : null;
  const rawBudgetPct =
    budgetCapPoints !== null ? Math.round((budgetUsedPoints / budgetCapPoints) * 100) : 0;
  const budgetRawPct = Number.isFinite(rawBudgetPct) ? rawBudgetPct : 100;
  const budgetClampedPct = Math.max(0, Math.min(100, budgetRawPct));
  const budgetAtOrOverCap = budgetCapPoints !== null && budgetUsedPoints >= budgetCapPoints;
  const budgetNearCap = budgetCapPoints !== null && !budgetAtOrOverCap && budgetClampedPct >= 80;

  const isEmpty =
    upcomingRetests.length === 0 &&
    channelAttribution.length === 0 &&
    !didSummary &&
    !latestCompletedWilson &&
    !showBudgetBoard;

  if (isEmpty) {
    return null;
  }

  const hasDegradedCitation = channelAttribution.some(
    (item) =>
      isFiniteNumber(item.completedRetestCount) &&
      item.completedRetestCount > 0 &&
      !isFiniteNumber(item.citationHitRate),
  );

  return (
    <Section
      variant="card"
      aria-label="分发追踪与渠道归因"
      data-testid="publish-brand-attribution-summary"
      title="归因总览"
      actions={
        <Explain text="汇总已发布链接的阶梯自动复测计划、月度预算上限与各渠道 AI 归因表现。" />
      }
    >
      <div className="gm-home-dist-stack">
        {didSummary || latestCompletedWilson ? (
          <div className="gm-home-did-strip" data-testid="publish-did-confidence-strip">
            <div className="gm-home-did-main">
              <span className="gm-home-did-title">置信归因</span>
              {didSummary ? (
                <>
                  <StatusBadge
                    tone={DID_DIRECTION_TONE[didSummary.direction]}
                    label={DID_DIRECTION_LABELS[didSummary.direction]}
                  />
                  <span
                    data-testid="publish-did-net-lift"
                    className={`gm-num gm-home-did-lift gm-home-did-lift--${didSummary.direction.toLowerCase()}`}
                  >
                    DiD 净增益 {formatDidPp(didSummary.netLift)}
                  </span>
                  <span className="gm-num gm-home-did-meta">
                    处理组 Δ {formatDidPp(didSummary.treatmentDelta)} · 对照组 Δ{' '}
                    {formatDidPp(didSummary.controlDelta)}（{didSummary.count} 次对照复测）
                  </span>
                </>
              ) : null}
              {latestCompletedWilson ? (
                <span className="gm-home-did-wilson" data-testid="publish-wilson-summary">
                  <span className="gm-num gm-home-did-meta">
                    Wilson 95% CI [{(latestCompletedWilson.lower * 100).toFixed(1)}%,{' '}
                    {(latestCompletedWilson.upper * 100).toFixed(1)}%]（n=
                    {latestCompletedWilson.trials}）
                  </span>
                  <StatusBadge
                    tone={CONFIDENCE_TONE[latestCompletedWilson.confidenceLevel]}
                    label={CONFIDENCE_LABELS[latestCompletedWilson.confidenceLevel]}
                  />
                </span>
              ) : null}
              {hasLowSampleWarning ? (
                <Explain text="当前样本量较少（n<5），建议在复测中开启 3× 采样以收窄置信区间。" />
              ) : null}
            </div>
          </div>
        ) : null}

        {showBudgetBoard && retestBudget ? (
          <div className="gm-home-budget-box" data-testid="publish-retest-budget-board">
            <div className="gm-home-budget-head">
              <div className="gm-home-budget-title-wrap">
                <span className="gm-home-retest-title">月度预算</span>
                <span className="gm-home-chip gm-num">{retestBudget.monthKey}</span>
              </div>
              {onOpenBudgetSettings ? (
                <Button
                  size="small"
                  type="link"
                  className="gm-home-nowrap-btn"
                  data-testid="publish-retest-budget-settings-btn"
                  onClick={onOpenBudgetSettings}
                >
                  调整上限
                </Button>
              ) : null}
            </div>

            <div className="gm-home-budget-stats">
              {budgetCapPoints !== null ? (
                <>
                  <span className="gm-num gm-home-budget-stat-primary">
                    已消耗 {budgetUsedPoints} 点 / 上限 {budgetCapPoints} 点
                  </span>
                  <span className="gm-num gm-home-budget-stat-meta">
                    剩余 {budgetRemainingPoints ?? 0} 点（{budgetRawPct}%）
                  </span>
                </>
              ) : (
                <>
                  <span className="gm-num gm-home-budget-stat-primary">
                    本月已消耗 {budgetUsedPoints} 点
                  </span>
                  <span className="gm-home-budget-stat-meta">未设上限</span>
                </>
              )}
            </div>

            <div
              className="gm-home-budget-track"
              role="progressbar"
              data-testid="publish-retest-budget-bar"
              aria-label="月度自动复测预算使用进度"
              aria-valuenow={budgetCapPoints !== null ? budgetClampedPct : 0}
              aria-valuemin={0}
              aria-valuemax={100}
              data-empty={budgetUsedPoints === 0 || budgetCapPoints === null ? 'true' : 'false'}
            >
              <svg
                className="gm-home-budget-track-svg"
                viewBox="0 0 100 4"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {budgetCapPoints !== null && budgetUsedPoints > 0 && budgetClampedPct > 0 ? (
                  <rect
                    className={
                      budgetAtOrOverCap
                        ? 'gm-home-budget-fill gm-home-budget-fill--warning'
                        : budgetNearCap
                          ? 'gm-home-budget-fill gm-home-budget-fill--caution'
                          : 'gm-home-budget-fill'
                    }
                    x="0"
                    y="0"
                    width={budgetClampedPct}
                    height="4"
                    rx="2"
                  />
                ) : null}
              </svg>
            </div>

            {budgetSkippedCount > 0 ? (
              <div
                className="gm-home-budget-alert"
                data-testid="publish-retest-budget-skipped-alert"
              >
                <StatusBadge
                  tone="warning"
                  label={`预算达上限 · 已跳过 ${budgetSkippedCount} 次`}
                />
                <Explain text="已达月度预算上限，跳过自动复测；手动写作、可见度监测与手动复测不受此上限影响。" />
              </div>
            ) : null}
          </div>
        ) : null}

        {upcomingRetests.length > 0 ? (
          <div className="gm-home-retest-box" data-testid="publish-upcoming-retests">
            <div className="gm-home-retest-head">
              <span className="gm-home-retest-title">复测提醒（{upcomingRetests.length} 项）</span>
              <Explain text="近 7 天到期复测节点、预算上限与余额不足跳过提醒。" />
            </div>

            <div className="gm-home-retest-list">
              {upcomingRetests.map((item) => {
                const isSkippedPoints = item.status === 'SKIPPED_INSUFFICIENT_POINTS';
                const isSkippedBudgetCap = item.status === 'SKIPPED_BUDGET_CAP';
                return (
                  <div
                    key={item.scheduleId}
                    className="gm-home-retest-row"
                    data-testid={`publish-upcoming-retest-${item.scheduleId}`}
                  >
                    <div className="gm-home-retest-main">
                      <div className="gm-home-retest-top">
                        <StatusBadge
                          status={item.status}
                          label={RETEST_SCHEDULE_STATUS_LABELS[item.status] ?? item.status}
                        />
                        <span className="gm-home-chip gm-num">T+{item.milestoneDay}</span>
                        <span className="gm-home-chip">
                          {item.sampleCount === 3 ? '3次采样' : '1次采样'}
                        </span>
                        <span className="gm-home-retest-article">
                          {item.articleTitle || item.channel}
                        </span>
                      </div>

                      <div className="gm-home-retest-meta">
                        <span>渠道：{item.channel}</span>
                        <span className="gm-num">计划日期：{formatShanghaiDate(item.dueAt)}</span>
                        {item.skipReason ? (
                          <span className="gm-home-retest-skip">{item.skipReason}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="gm-home-retest-actions">
                      {isSkippedPoints && onOpenPoints ? (
                        <Button size="small" className="gm-home-nowrap-btn" onClick={onOpenPoints}>
                          查看点数
                        </Button>
                      ) : null}
                      {isSkippedBudgetCap && onOpenBudgetSettings ? (
                        <Button
                          size="small"
                          className="gm-home-nowrap-btn"
                          onClick={onOpenBudgetSettings}
                        >
                          调整上限
                        </Button>
                      ) : null}
                      {item.articleId ? (
                        <Button
                          size="small"
                          autoInsertSpace={false}
                          className="gm-home-nowrap-btn"
                          onClick={() => onSelectArticle(item.articleId)}
                        >
                          查看
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {channelAttribution.length > 0 ? (
          <div className="gm-home-attr-section" data-testid="publish-channel-attribution">
            <div className="gm-home-retest-head">
              <span className="gm-home-retest-title">渠道归因</span>
              {hasDegradedCitation ? (
                <Explain text="部分复测暂未返回上游引文链接，当前已自动降级展示品牌提及率变化、平均顺位与情感归因；引文就绪后将自动点亮引文命中率。" />
              ) : (
                <Explain text="按已发布条数与复测结果汇总。" />
              )}
            </div>

            <div className="gm-home-attr-wrap">
              <table className="gm-home-attr-table">
                <thead>
                  <tr>
                    <th>渠道</th>
                    <th>发布/可抓</th>
                    <th>已复测</th>
                    <th>引文命中</th>
                    <th>提及变化</th>
                    <th>平均顺位</th>
                    <th>情感</th>
                  </tr>
                </thead>
                <tbody>
                  {channelAttribution.map((row) => (
                    <tr key={row.channel}>
                      <td className="gm-home-attr-channel">{row.channel}</td>
                      <td className="gm-num gm-home-attr-num">
                        {isFiniteNumber(row.publishedCount) ? row.publishedCount : 0} /{' '}
                        <span className="gm-home-attr-cited">
                          {isFiniteNumber(row.crawlOkCount) ? row.crawlOkCount : 0}
                        </span>
                      </td>
                      <td className="gm-num gm-home-attr-num">
                        {isFiniteNumber(row.completedRetestCount) ? row.completedRetestCount : 0}
                      </td>
                      <td>{renderCitationCell(row)}</td>
                      <td>{renderMentionDeltaCell(row.avgMentionRateDelta)}</td>
                      <td>{renderPositionCell(row.avgPosition, row.avgPositionDelta)}</td>
                      <td>
                        {renderSentimentCell(row.sentimentSummary, row.positiveSentimentRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
