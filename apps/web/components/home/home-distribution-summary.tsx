'use client';

import {
  RETEST_SCHEDULE_STATUS_LABELS,
  formatShanghaiDate,
  type ActionHomeResponse,
  type ConfidenceLevel,
  type DidDirection,
  type DistributionChannelAttributionItem,
  type DistributionSummaryDto,
  type VisibilitySentiment,
  type WilsonInterval,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { SentimentDot } from '../geo/primitives';
import { EmptyState, Section, StatusBadge, type StatusTone } from '../ui';
import { HomeCrawlAlertBanner } from './home-crawl-alert-banner';

export type HomeDistributionSummaryProps = {
  summary?: DistributionSummaryDto | null;
  recentArticles?: readonly ActionHomeResponse['recentArticles'][number][];
  hideCrawlAlerts?: boolean;
  onOpenArticle: (articleId: string) => void;
  onOpenPoints?: () => void;
  onOpenStudio?: () => void;
  onOpenRoiReportModal?: () => void;
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
  POSITIVE: '正向净增益',
  NEGATIVE: '负向变化',
  NEUTRAL: '无显著净差',
};

const DID_DIRECTION_TONE: Record<DidDirection, StatusTone> = {
  POSITIVE: 'success',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
};

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

const KNOWN_SENTIMENTS = new Set<string>(['positive', 'neutral', 'mixed', 'negative']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

export function HomeDistributionSummary({
  summary,
  recentArticles,
  hideCrawlAlerts = false,
  onOpenArticle,
  onOpenPoints,
  onOpenStudio,
  onOpenRoiReportModal,
}: HomeDistributionSummaryProps): JSX.Element {
  const crawlAlerts = summary?.crawlAlerts ?? [];
  const visibleCrawlAlerts = hideCrawlAlerts ? [] : crawlAlerts;
  const upcomingRetests = summary?.upcomingRetests ?? [];
  const channelAttribution = summary?.channelAttribution ?? [];

  // Derive Statistical Confidence & DiD Net Lift summary from completed retestSchedules
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

  const isEmpty =
    visibleCrawlAlerts.length === 0 &&
    upcomingRetests.length === 0 &&
    channelAttribution.length === 0 &&
    !didSummary &&
    !latestCompletedWilson;

  const hasDegradedCitation = channelAttribution.some(
    (item) =>
      isFiniteNumber(item.completedRetestCount) &&
      item.completedRetestCount > 0 &&
      !isFiniteNumber(item.citationHitRate),
  );

  const headerActions =
    onOpenRoiReportModal || onOpenStudio ? (
      <div className="gm-home-dist-head-actions">
        {onOpenRoiReportModal ? (
          <Button
            size="small"
            className="gm-home-nowrap-btn"
            data-testid="home-summary-roi-report-btn"
            onClick={onOpenRoiReportModal}
          >
            生成月度 GEO ROI 报告
          </Button>
        ) : null}
        {onOpenStudio ? (
          <Button size="small" type="link" className="gm-home-nowrap-btn" onClick={onOpenStudio}>
            进入写作与分发台
          </Button>
        ) : null}
      </div>
    ) : undefined;

  return (
    <Section
      variant="plain"
      aria-label="分发追踪与渠道归因"
      data-testid="home-distribution-summary"
      title="分发追踪与渠道归因"
      description="汇总已发布链接的 T+1 抓取体检告警、近 7 天阶梯自动复测计划与各渠道 AI 归因表现。"
      actions={headerActions}
    >
      {isEmpty ? (
        <EmptyState
          size="compact"
          title="暂无分发追踪与渠道归因数据"
          description="在 GEO 写作台完成推送或登记已发布文章链接后，这里将自动汇总抓取异常告警、T+7/T+14/T+30 自动复测提醒与各渠道表现。"
        />
      ) : (
        <div className="gm-home-dist-stack">
          {/* 0. Statistical Confidence (Wilson 95% CI) & DiD Net Lift Indicator Strip */}
          {didSummary || latestCompletedWilson ? (
            <div className="gm-home-did-strip" data-testid="home-did-confidence-strip">
              <div className="gm-home-did-main">
                <span className="gm-home-did-title">统计置信与对照组 DiD 归因</span>
                {didSummary ? (
                  <>
                    <StatusBadge
                      tone={DID_DIRECTION_TONE[didSummary.direction]}
                      label={DID_DIRECTION_LABELS[didSummary.direction]}
                    />
                    <span
                      data-testid="home-did-net-lift"
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
                  <span className="gm-home-did-wilson" data-testid="home-wilson-summary">
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
              </div>

              {hasLowSampleWarning ? (
                <span className="gm-home-did-warning" data-testid="home-low-sample-hint">
                  当前样本量较少（n&lt;5），建议在复测中开启 3× 采样以收窄置信区间
                </span>
              ) : null}
            </div>
          ) : null}

          {/* 1. Crawl Alert Banner (shown here only when NOT hoisted to top of /home) */}
          {visibleCrawlAlerts.length > 0 ? (
            <HomeCrawlAlertBanner alerts={visibleCrawlAlerts} onOpenArticle={onOpenArticle} />
          ) : null}

          {/* 2. Upcoming / Skipped Auto-Retest Reminders */}
          {upcomingRetests.length > 0 ? (
            <div className="gm-home-retest-box" data-testid="home-upcoming-retests">
              <div className="gm-home-retest-head">
                <span className="gm-home-retest-title">
                  自动复测提醒（{upcomingRetests.length} 项）
                </span>
                <span className="gm-home-retest-sub">近 7 天到期复测节点与余额不足跳过提醒</span>
              </div>

              <div className="gm-home-retest-list">
                {upcomingRetests.map((item) => {
                  const isSkippedPoints = item.status === 'SKIPPED_INSUFFICIENT_POINTS';
                  return (
                    <div
                      key={item.scheduleId}
                      className="gm-home-retest-row"
                      data-testid={`home-upcoming-retest-${item.scheduleId}`}
                    >
                      <div className="gm-home-retest-main">
                        <div className="gm-home-retest-top">
                          <StatusBadge
                            status={item.status}
                            label={RETEST_SCHEDULE_STATUS_LABELS[item.status] ?? item.status}
                          />
                          <span className="gm-home-chip gm-num">T+{item.milestoneDay}</span>
                          <span className="gm-home-chip">
                            {item.sampleCount === 3 ? '3 次高置信' : '1 次采样'}
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
                          <Button
                            size="small"
                            className="gm-home-nowrap-btn"
                            onClick={onOpenPoints}
                          >
                            查看点数
                          </Button>
                        ) : null}
                        {item.articleId ? (
                          <Button
                            size="small"
                            className="gm-home-nowrap-btn"
                            onClick={() => onOpenArticle(item.articleId)}
                          >
                            查看追踪
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 3. Channel Attribution Mini-Table */}
          {channelAttribution.length > 0 ? (
            <div className="gm-home-attr-section" data-testid="home-channel-attribution">
              <div className="gm-home-retest-head">
                <span className="gm-home-retest-title">各渠道归因对比</span>
                <span className="gm-home-retest-sub">按已发布条数与复测结果汇总</span>
              </div>

              <div className="gm-home-attr-wrap">
                <table className="gm-home-attr-table">
                  <thead>
                    <tr>
                      <th>渠道</th>
                      <th>已发布 / 可抓取</th>
                      <th>已完成复测</th>
                      <th>引文命中率</th>
                      <th>提及率变化</th>
                      <th>平均顺位</th>
                      <th>情感归因</th>
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

              {hasDegradedCitation ? (
                <div className="gm-home-attr-note" data-testid="home-citation-degraded-note">
                  部分复测暂未返回上游引文链接，当前已自动降级展示品牌提及率变化、平均顺位与情感归因；引文就绪后将自动点亮引文命中率。
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}
