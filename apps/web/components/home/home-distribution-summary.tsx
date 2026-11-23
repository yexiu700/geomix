'use client';

import {
  CRAWL_PROBE_STATUS_LABELS,
  RETEST_SCHEDULE_STATUS_LABELS,
  formatShanghaiDate,
  formatShanghaiDateTime,
  type CrawlProbeStatus,
  type DistributionChannelAttributionItem,
  type DistributionSummaryDto,
  type RetestScheduleStatus,
  type VisibilitySentiment,
} from '@geomix/shared';
import { Button, Tag } from 'antd';
import type { JSX } from 'react';
import { GM } from '../../lib/design-tokens';
import { SentimentDot, SignalEmpty, SignalPill } from '../geo/primitives';

export type HomeDistributionSummaryProps = {
  summary?: DistributionSummaryDto | null;
  onOpenArticle: (articleId: string) => void;
  onOpenPoints?: () => void;
  onOpenStudio?: () => void;
};

const KNOWN_SENTIMENTS = new Set<string>(['positive', 'neutral', 'mixed', 'negative']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function crawlAlertTone(status: CrawlProbeStatus): 'danger' | 'warning' | 'neutral' {
  if (status === 'BLOCKED' || status === 'FAILED') return 'danger';
  if (status === 'WARNING') return 'warning';
  return 'neutral';
}

function retestStatusTagColor(status: RetestScheduleStatus): string {
  switch (status) {
    case 'RUNNING':
      return 'blue';
    case 'PENDING':
      return 'cyan';
    case 'SKIPPED_INSUFFICIENT_POINTS':
    case 'SKIPPED_NO_ENGINE':
      return 'gold';
    case 'FAILED':
      return 'red';
    case 'COMPLETED':
      return 'green';
    default:
      return 'default';
  }
}

function renderCitationCell(row: DistributionChannelAttributionItem): JSX.Element {
  if (isFiniteNumber(row.citationHitRate)) {
    const pct = (row.citationHitRate * 100).toFixed(1);
    const hasCount =
      isFiniteNumber(row.citationHitCount) &&
      isFiniteNumber(row.completedRetestCount) &&
      row.completedRetestCount > 0;
    return (
      <span
        className="gm-num"
        style={{
          color: row.citationHitRate > 0 ? GM.sig.cited : GM.fg.f2,
          fontWeight: row.citationHitRate > 0 ? 600 : 400,
          whiteSpace: 'nowrap',
        }}
      >
        {pct}%
        {hasCount ? (
          <span style={{ color: GM.fg.f3, marginLeft: 4 }}>
            ({row.citationHitCount}/{row.completedRetestCount})
          </span>
        ) : null}
      </span>
    );
  }

  if (isFiniteNumber(row.completedRetestCount) && row.completedRetestCount > 0) {
    return (
      <span
        style={{
          fontSize: 12,
          color: GM.fg.f3,
          whiteSpace: 'nowrap',
        }}
        title="上游引擎暂未返回引文链接，当前已降级展示提及率、顺位与情感归因"
      >
        待引文就绪
      </span>
    );
  }

  return <span style={{ color: GM.fg.f4 }}>—</span>;
}

function renderMentionDeltaCell(delta: number | null): JSX.Element {
  if (!isFiniteNumber(delta)) {
    return <span style={{ color: GM.fg.f4 }}>—</span>;
  }
  const formatted = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
  const color = delta > 0 ? GM.sig.cited : delta < 0 ? GM.status.danger : GM.fg.f2;
  return (
    <span
      className="gm-num"
      style={{ color, fontWeight: delta !== 0 ? 600 : 400, whiteSpace: 'nowrap' }}
    >
      {formatted}
    </span>
  );
}

function renderPositionCell(
  avgPosition: number | null,
  avgPositionDelta: number | null,
): JSX.Element {
  if (!isFiniteNumber(avgPosition)) {
    return <span style={{ color: GM.fg.f4 }}>—</span>;
  }
  const deltaNode = isFiniteNumber(avgPositionDelta) ? (
    avgPositionDelta < 0 ? (
      <span style={{ color: GM.sig.cited, marginLeft: 4 }}>
        (↑{Math.abs(avgPositionDelta).toFixed(1)})
      </span>
    ) : avgPositionDelta > 0 ? (
      <span style={{ color: GM.status.danger, marginLeft: 4 }}>
        (↓{avgPositionDelta.toFixed(1)})
      </span>
    ) : (
      <span style={{ color: GM.fg.f3, marginLeft: 4 }}>(持平)</span>
    )
  ) : null;

  return (
    <span className="gm-num" style={{ color: GM.fg.f1, whiteSpace: 'nowrap' }}>
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
    return <span style={{ color: GM.fg.f4 }}>—</span>;
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      {validSentiment ? <SentimentDot sentiment={validSentiment} /> : null}
      {hasPositivePct ? (
        <span className="gm-num" style={{ fontSize: 12, color: GM.fg.f3 }}>
          {Math.round(positiveSentimentRate * 100)}% 正向
        </span>
      ) : null}
    </span>
  );
}

export function HomeDistributionSummary({
  summary,
  onOpenArticle,
  onOpenPoints,
  onOpenStudio,
}: HomeDistributionSummaryProps): JSX.Element {
  const crawlAlerts = summary?.crawlAlerts ?? [];
  const upcomingRetests = summary?.upcomingRetests ?? [];
  const channelAttribution = summary?.channelAttribution ?? [];

  const isEmpty =
    crawlAlerts.length === 0 && upcomingRetests.length === 0 && channelAttribution.length === 0;

  const hasDegradedCitation = channelAttribution.some(
    (item) =>
      isFiniteNumber(item.completedRetestCount) &&
      item.completedRetestCount > 0 &&
      !isFiniteNumber(item.citationHitRate),
  );

  return (
    <section
      className="gm-panel gm-home-block"
      aria-label="分发追踪与渠道归因"
      data-testid="home-distribution-summary"
      style={{ minWidth: 0 }}
    >
      <div className="gm-home-block-head">
        <div className="gm-home-block-heading">
          <h2 className="gm-home-block-title">分发追踪与渠道归因</h2>
          <p className="gm-home-block-desc">
            汇总已发布链接的 T+1 抓取体检告警、近 7 天阶梯自动复测计划与各渠道 AI 归因表现。
          </p>
        </div>

        {onOpenStudio ? (
          <Button size="small" type="link" onClick={onOpenStudio} style={{ whiteSpace: 'nowrap' }}>
            进入写作与分发台
          </Button>
        ) : null}
      </div>

      {isEmpty ? (
        <SignalEmpty
          title="暂无分发追踪与渠道归因数据"
          description="在 GEO 写作台完成推送或登记已发布文章链接后，这里将自动汇总抓取异常告警、T+7/T+14/T+30 自动复测提醒与各渠道表现。"
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* 1. Crawl Alert Banner */}
          {crawlAlerts.length > 0 ? (
            <div
              data-testid="home-crawl-alerts"
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'rgba(240, 96, 93, 0.08)',
                border: '1px solid rgba(240, 96, 93, 0.28)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: GM.status.danger }}>
                  抓取与 Schema 异常告警（{crawlAlerts.length} 条）
                </span>
                <span style={{ fontSize: 12, color: GM.fg.f3 }}>
                  robots.txt 拦截、HTTP 异常、noindex 或结构化数据缺失将影响 AI 爬虫抓取
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                {crawlAlerts.map((alert) => (
                  <div
                    key={alert.publishRecordId}
                    data-testid={`home-crawl-alert-${alert.publishRecordId}`}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'var(--gm-bg-surface, #111413)',
                      border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        flex: '1 1 260px',
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <SignalPill tone={crawlAlertTone(alert.crawlStatus)}>
                          {CRAWL_PROBE_STATUS_LABELS[alert.crawlStatus] ?? alert.crawlStatus}
                        </SignalPill>
                        <Tag style={{ margin: 0, whiteSpace: 'nowrap' }}>{alert.channel}</Tag>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: GM.fg.f1,
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {alert.articleTitle || alert.publishedUrl}
                        </span>
                      </div>

                      <div
                        style={{
                          fontSize: 12,
                          color: GM.fg.f2,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '2px 10px',
                          minWidth: 0,
                        }}
                      >
                        {alert.issues.length > 0 ? (
                          <span style={{ color: GM.status.danger, overflowWrap: 'anywhere' }}>
                            {alert.issues.slice(0, 2).join('；')}
                          </span>
                        ) : null}
                        {alert.crawlCheckedAt ? (
                          <span style={{ color: GM.fg.f3, whiteSpace: 'nowrap' }}>
                            体检于 {formatShanghaiDateTime(alert.crawlCheckedAt)}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {alert.articleId ? (
                      <Button
                        size="small"
                        danger
                        onClick={() => onOpenArticle(alert.articleId)}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        前往排查
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 2. Upcoming / Skipped Auto-Retest Reminders */}
          {upcomingRetests.length > 0 ? (
            <div
              data-testid="home-upcoming-retests"
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'var(--gm-bg-elevated, #171B1A)',
                border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: GM.fg.f1 }}>
                  自动复测提醒（{upcomingRetests.length} 项）
                </span>
                <span style={{ fontSize: 12, color: GM.fg.f3 }}>
                  近 7 天到期复测节点与余额不足跳过提醒
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                {upcomingRetests.map((item) => {
                  const isSkippedPoints = item.status === 'SKIPPED_INSUFFICIENT_POINTS';
                  return (
                    <div
                      key={item.scheduleId}
                      data-testid={`home-upcoming-retest-${item.scheduleId}`}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'var(--gm-bg-surface, #111413)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          flex: '1 1 260px',
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 0,
                          }}
                        >
                          <Tag
                            color={retestStatusTagColor(item.status)}
                            style={{ margin: 0, whiteSpace: 'nowrap' }}
                          >
                            {RETEST_SCHEDULE_STATUS_LABELS[item.status] ?? item.status}
                          </Tag>
                          <Tag color="geekblue" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                            T+{item.milestoneDay}
                          </Tag>
                          <Tag style={{ margin: 0, whiteSpace: 'nowrap' }}>
                            {item.sampleCount === 3 ? '3 次高置信' : '1 次采样'}
                          </Tag>
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: GM.fg.f1,
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {item.articleTitle || item.channel}
                          </span>
                        </div>

                        <div
                          style={{
                            fontSize: 12,
                            color: GM.fg.f3,
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '2px 10px',
                          }}
                        >
                          <span>渠道：{item.channel}</span>
                          <span className="gm-num">计划日期：{formatShanghaiDate(item.dueAt)}</span>
                          {item.skipReason ? (
                            <span style={{ color: GM.status.warning, overflowWrap: 'anywhere' }}>
                              {item.skipReason}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                        {isSkippedPoints && onOpenPoints ? (
                          <Button
                            size="small"
                            type="primary"
                            onClick={onOpenPoints}
                            style={{ whiteSpace: 'nowrap' }}
                          >
                            查看点数
                          </Button>
                        ) : null}
                        {item.articleId ? (
                          <Button
                            size="small"
                            onClick={() => onOpenArticle(item.articleId)}
                            style={{ whiteSpace: 'nowrap' }}
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
            <div
              data-testid="home-channel-attribution"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: GM.fg.f1 }}>
                  各渠道归因对比
                </span>
                <span style={{ fontSize: 12, color: GM.fg.f3 }}>按已发布条数与复测结果汇总</span>
              </div>

              <div
                style={{
                  width: '100%',
                  overflowX: 'auto',
                  minWidth: 0,
                  borderRadius: 8,
                  border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                }}
              >
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12.5,
                    textAlign: 'left',
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        borderBottom: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      }}
                    >
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        渠道
                      </th>
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        已发布 / 可抓取
                      </th>
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        已完成复测
                      </th>
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        引文命中率
                      </th>
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        提及率变化
                      </th>
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        平均顺位
                      </th>
                      <th
                        style={{
                          padding: '9px 12px',
                          fontWeight: 600,
                          color: GM.fg.f2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        情感归因
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelAttribution.map((row, idx) => (
                      <tr
                        key={row.channel}
                        style={{
                          borderBottom:
                            idx < channelAttribution.length - 1
                              ? '1px solid var(--gm-line-1, rgba(255,255,255,0.06))'
                              : undefined,
                        }}
                      >
                        <td
                          style={{
                            padding: '9px 12px',
                            fontWeight: 500,
                            color: GM.fg.f1,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {row.channel}
                        </td>
                        <td
                          className="gm-num"
                          style={{
                            padding: '9px 12px',
                            color: GM.fg.f2,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {isFiniteNumber(row.publishedCount) ? row.publishedCount : 0} /{' '}
                          <span style={{ color: GM.sig.cited }}>
                            {isFiniteNumber(row.crawlOkCount) ? row.crawlOkCount : 0}
                          </span>
                        </td>
                        <td
                          className="gm-num"
                          style={{
                            padding: '9px 12px',
                            color: GM.fg.f2,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {isFiniteNumber(row.completedRetestCount) ? row.completedRetestCount : 0}
                        </td>
                        <td style={{ padding: '9px 12px' }}>{renderCitationCell(row)}</td>
                        <td style={{ padding: '9px 12px' }}>
                          {renderMentionDeltaCell(row.avgMentionRateDelta)}
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          {renderPositionCell(row.avgPosition, row.avgPositionDelta)}
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          {renderSentimentCell(row.sentimentSummary, row.positiveSentimentRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {hasDegradedCitation ? (
                <div
                  data-testid="home-citation-degraded-note"
                  style={{ fontSize: 12, color: GM.fg.f3, lineHeight: 1.5 }}
                >
                  部分复测暂未返回上游引文链接，当前已自动降级展示品牌提及率变化、平均顺位与情感归因；引文就绪后将自动点亮引文命中率。
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
