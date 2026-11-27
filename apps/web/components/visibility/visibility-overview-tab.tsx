'use client';

import type {
  GeoMarket,
  VisibilityEngineAvailabilityItem,
  VisibilityEngineKey,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewResponse,
  VisibilitySentiment,
} from '@geomix/shared';
import {
  VISIBILITY_ENGINE_LABELS,
  VISIBILITY_SENTIMENT_LABELS,
  VISIBILITY_SENTIMENTS,
} from '@geomix/shared';
import { Button, Tag } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { formatPct } from '../../lib/design-tokens';
import { GEO_BRIEF_SOURCE_SHORT } from '../../lib/short-labels';
import { EngineChipList, SignalError, SignalSkeleton, TruncText } from '../geo/primitives';
import { SonarDial } from '../geo/sonar-dial';
import { EmptyState, Explain, KpiStrip, Section, StatusBadge, type KpiStripItem } from '../ui';
import { VisibilityTrendChart } from './visibility-trend-chart';

export type VisibilityOverviewTabProps = {
  activeMarket: GeoMarket;
  days: number;
  overview: VisibilityOverviewResponse | null;
  opportunities: VisibilityOpportunitiesResponse | null;
  loading: boolean;
  error: string | null;
  selectedEngine?: VisibilityEngineKey;
  marketEngines?: readonly VisibilityEngineAvailabilityItem[];
  onSelectEngine: (engine: VisibilityEngineKey | undefined) => void;
  onInspectRuns?: (engine?: VisibilityEngineKey) => void;
  onRetry: () => void;
  onSwitchToRuns: () => void;
  readOnly: boolean;
  /** Optional M3 slot for full GeoBrief list & 2-20 batch launch toolbar. */
  briefsSlot?: ReactNode;
  /** Optional v2.2 slot for 4-tier Near-Miss panel rendered on Overview when active. */
  nearMissSlot?: ReactNode;
};

export function VisibilityOverviewTab({
  activeMarket,
  days,
  overview,
  opportunities,
  loading,
  error,
  selectedEngine,
  marketEngines,
  onSelectEngine,
  onInspectRuns,
  onRetry,
  onSwitchToRuns,
  readOnly,
  briefsSlot,
  nearMissSlot,
}: VisibilityOverviewTabProps): JSX.Element {
  const [showSentiment, setShowSentiment] = useState(false);

  if (error && !overview) {
    return (
      <Section variant="card">
        <SignalError message={error} onRetry={onRetry} />
      </Section>
    );
  }

  const metrics = overview?.metrics;
  const completedChecks = metrics?.completedChecks ?? 0;
  const totalMentions = metrics?.shareOfVoice.totalMentions ?? 0;
  const totalCitations = metrics?.totalCitations ?? 0;
  const sovEntries = metrics?.shareOfVoice.entries ?? [];
  const sentiment = metrics?.sentimentSummary;
  const sentimentTotal = sentiment?.total ?? 0;
  const gaps = opportunities?.gaps ?? [];
  const totalMarketEngines = marketEngines?.length ?? 0;
  const availableMarketEngines = marketEngines
    ? marketEngines.filter((item) => item.available).length
    : 0;
  const showEngineCoverageBadge =
    totalMarketEngines > 0 && availableMarketEngines < totalMarketEngines;
  const hasSimulatedObservations = Boolean(metrics?.hasSimulatedObservations);

  const kpiItems: KpiStripItem[] = [
    {
      key: 'mention',
      testId: 'visibility-kpi-mention',
      label: '提及率',
      value: completedChecks > 0 ? formatPct(metrics?.visibilityPct) : '—',
      progressPct: completedChecks > 0 ? (metrics?.visibilityPct ?? 0) : undefined,
      tone: 'success',
      caption:
        completedChecks > 0
          ? `${metrics?.mentionedChecks ?? 0} / ${completedChecks} · 有效观测`
          : '暂无有效观测',
    },
    {
      key: 'sov',
      testId: 'visibility-kpi-sov',
      label: '声量',
      value: totalMentions > 0 ? formatPct(metrics?.shareOfVoice.brandSharePct) : '—',
      progressPct: totalMentions > 0 ? (metrics?.shareOfVoice.brandSharePct ?? 0) : undefined,
      tone: 'active',
      caption:
        totalMentions > 0
          ? `${metrics?.shareOfVoice.brandMentions ?? 0} / ${totalMentions} · 总提及`
          : '等待监测数据',
    },
    {
      key: 'position',
      testId: 'visibility-kpi-position',
      label: '平均顺位',
      value:
        metrics?.avgPosition !== null && metrics?.avgPosition !== undefined
          ? `#${metrics.avgPosition.toFixed(1)}`
          : '—',
      tone: metrics?.avgPosition != null ? 'warning' : 'neutral',
      caption: '结构化推荐清单平均位次',
    },
    {
      key: 'owned',
      testId: 'visibility-kpi-owned',
      label: '自有引用',
      value: totalCitations > 0 ? formatPct(metrics?.ownedCitationRatePct) : '—',
      progressPct: totalCitations > 0 ? (metrics?.ownedCitationRatePct ?? 0) : undefined,
      tone: 'success',
      caption:
        totalCitations > 0
          ? `${metrics?.ownedCitations ?? 0} / ${totalCitations} · 总引用`
          : '暂无引用信源',
    },
  ];

  return (
    <div className="gm-vis-tab-stack">
      {/* 4 KPI Strip (No colored top border stripes) */}
      <KpiStrip
        items={kpiItems}
        loading={loading && !overview}
        skeletonCount={4}
        aria-label="可见度核心指标"
        data-testid="visibility-kpi-strip"
      />

      {/* 12-Column Unified Chart Grid */}
      <div className="gm-vis-chart-grid">
        <Section
          variant="card"
          className="gm-vis-chart-card gm-vis-chart-span-5"
          title="声呐盘"
          actions={
            <div className="gm-vis-chart-meta">
              <span className="gm-vis-chart-unit">单位：%</span>
              <span className="gm-vis-chart-range gm-num">近 {days} 天</span>
              <Explain
                text={`当前市场引擎组：${activeMarket === 'CN' ? '国内 4 引擎' : '海外 5 引擎'}`}
              />
              {selectedEngine ? (
                <Tag
                  closable
                  onClose={(e) => {
                    e.preventDefault();
                    onSelectEngine(undefined);
                  }}
                >
                  当前筛选：{VISIBILITY_ENGINE_LABELS[selectedEngine]}
                </Tag>
              ) : null}
            </div>
          }
        >
          {showEngineCoverageBadge ||
          hasSimulatedObservations ||
          (completedChecks > 0 && onInspectRuns) ? (
            <div className="gm-vis-dial-meta-bar">
              {showEngineCoverageBadge ? (
                <StatusBadge
                  tone="warning"
                  data-testid="visibility-engine-coverage-badge"
                  label={`当前在线 ${availableMarketEngines}/${totalMarketEngines} 引擎`}
                />
              ) : null}
              {hasSimulatedObservations ? (
                <StatusBadge
                  tone="warning"
                  data-testid="visibility-simulated-badge"
                  label="含模拟采集数据"
                />
              ) : null}
              {completedChecks > 0 && onInspectRuns ? (
                <Button
                  size="small"
                  data-testid="visibility-reconcile-btn"
                  onClick={() => onInspectRuns(selectedEngine)}
                >
                  核对观测
                </Button>
              ) : null}
            </div>
          ) : null}
          <SonarDial
            market={activeMarket}
            byEngine={overview?.byEngine}
            overallPct={metrics?.visibilityPct ?? 0}
            selectedEngine={selectedEngine}
            onSelectEngine={onSelectEngine}
            loading={loading && !overview}
            error={error}
            onRetry={onRetry}
          />
        </Section>

        <Section
          variant="card"
          className="gm-vis-chart-card gm-vis-chart-span-7"
          title="提及趋势"
          actions={
            <div className="gm-vis-chart-meta">
              <span className="gm-vis-chart-unit">单位：%</span>
              <span className="gm-vis-chart-range gm-num">近 {days} 天</span>
              <Explain
                text={`按上海自然日聚合有效观测提及率${selectedEngine ? ` · ${VISIBILITY_ENGINE_LABELS[selectedEngine]}` : ''}`}
              />
            </div>
          }
        >
          <VisibilityTrendChart
            points={overview?.trend ?? []}
            selectedEngine={selectedEngine}
            loading={loading && !overview}
          />
        </Section>

        <Section
          variant="card"
          className={`gm-vis-chart-card ${showSentiment ? 'gm-vis-chart-span-6' : 'gm-vis-chart-span-12'}`}
          title="竞品声量"
          actions={
            <div className="gm-vis-chart-meta">
              <span className="gm-vis-chart-unit">单位：占比 %</span>
              <span className="gm-vis-chart-range gm-num">近 {days} 天</span>
              <Explain text="本品牌高亮显示，竞品以中性灰阶对照。" />
              <Button
                size="small"
                type="text"
                autoInsertSpace={false}
                data-testid="visibility-sentiment-toggle"
                aria-expanded={showSentiment}
                onClick={() => setShowSentiment((v) => !v)}
              >
                {showSentiment ? '收起情感' : '情感分布'}
              </Button>
            </div>
          }
        >
          {loading && !overview ? (
            <SignalSkeleton variant="row" rows={4} />
          ) : sovEntries.length === 0 || totalMentions === 0 ? (
            <EmptyState
              size="compact"
              title="暂无声量"
              description="完成监测后展示本品牌与竞品提及占比"
            />
          ) : (
            <div className="gm-vis-sov-list">
              {sovEntries.slice(0, 8).map((entry) => (
                <div
                  key={`${entry.isBrand ? 'b' : 'c'}-${entry.name}`}
                  className="gm-sov-row"
                  data-sov-role={entry.isBrand ? 'brand' : 'competitor'}
                >
                  <div className="gm-sov-row-head">
                    <span
                      className={`gm-vis-sov-name${entry.isBrand ? ' gm-vis-sov-name--brand' : ''}`}
                    >
                      <TruncText text={entry.name} lines={1} />
                      {entry.isBrand ? <StatusBadge tone="success" label="本品牌" /> : null}
                    </span>
                    <span className="gm-num gm-vis-sov-val">
                      {formatPct(entry.sharePct)}（{entry.mentions} 次）
                    </span>
                  </div>
                  <div className="gm-sov-track">
                    <div
                      className={`gm-sov-fill ${entry.isBrand ? 'gm-sov-fill--brand' : 'gm-sov-fill--competitor'}`}
                      style={{
                        width: `${Math.max(2, Math.min(100, entry.sharePct))}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {showSentiment ? (
          <Section
            variant="card"
            className="gm-vis-chart-card gm-vis-chart-span-6"
            title="情感分布"
            actions={
              <div className="gm-vis-chart-meta">
                <span className="gm-vis-chart-unit">单位：次数 / %</span>
                <span className="gm-vis-chart-range gm-num">近 {days} 天</span>
                <Explain text="已提及回答的正负面情感构成。" />
              </div>
            }
          >
            {loading && !overview ? (
              <SignalSkeleton variant="row" rows={4} />
            ) : sentimentTotal === 0 || !sentiment ? (
              <EmptyState
                size="compact"
                title="暂无样本"
                description="品牌被 AI 提及后将展示正负面情感分布"
              />
            ) : (
              <div className="gm-vis-sentiment-box">
                <div className="gm-sentiment-bar" role="img" aria-label="品牌情感占比条">
                  {VISIBILITY_SENTIMENTS.map((sKey: VisibilitySentiment) => {
                    const count = sentiment[sKey];
                    const pct = sentimentTotal > 0 ? (count / sentimentTotal) * 100 : 0;
                    if (pct <= 0) return null;
                    return (
                      <div
                        key={sKey}
                        className={`gm-vis-sentiment-seg--${sKey}`}
                        style={{ width: `${pct}%` }}
                        title={`${VISIBILITY_SENTIMENT_LABELS[sKey]} ${count} 次 (${pct.toFixed(1)}%)`}
                      />
                    );
                  })}
                </div>
                <div className="gm-sentiment-legend">
                  {VISIBILITY_SENTIMENTS.map((sKey: VisibilitySentiment) => {
                    const count = sentiment[sKey];
                    const pct = sentimentTotal > 0 ? (count / sentimentTotal) * 100 : 0;
                    return (
                      <div key={sKey} className="gm-vis-sentiment-item">
                        <span className={`gm-vis-sentiment-dot gm-vis-sentiment-dot--${sKey}`} />
                        <span>{VISIBILITY_SENTIMENT_LABELS[sKey]}</span>
                        <span className="gm-num gm-vis-sentiment-num">
                          {count}（{pct.toFixed(0)}%）
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>
        ) : null}
      </div>

      {/* GEO Writing Briefs Slot (M3 Ready) */}
      <Section
        variant="card"
        data-testid="visibility-briefs-slot"
        title="写作建议"
        actions={
          <div className="gm-vis-chart-meta">
            <Explain text="基于当前市场可见度诊断自动识别竞品霸榜缺口、顺位落后与口碑风险。" />
            {!readOnly ? (
              <Button size="small" onClick={onSwitchToRuns}>
                发起监测
              </Button>
            ) : null}
          </div>
        }
      >
        {briefsSlot ? (
          briefsSlot
        ) : completedChecks === 0 ? (
          <EmptyState
            size="compact"
            title="暂无建议"
            description="发起当前市场的 AI 引擎监测，系统将自动识别竞品霸榜缺口、顺位落后与负面情感问题。"
            action={
              readOnly ? undefined : (
                <Button size="small" onClick={onSwitchToRuns}>
                  发起监测
                </Button>
              )
            }
          />
        ) : gaps.length === 0 ? (
          <EmptyState
            size="compact"
            title="暂无缺口"
            description="可前往「监测」查看各引擎完整回答，或补充更多高意图选购问句。"
            action={
              <Button size="small" onClick={onSwitchToRuns}>
                查看监测
              </Button>
            }
          />
        ) : (
          <div className="gm-vis-gap-list">
            {gaps.slice(0, 5).map((gap) => (
              <div key={gap.promptText} className="gm-vis-gap-row">
                <div className="gm-vis-gap-main">
                  <div className="gm-vis-gap-prompt">
                    <StatusBadge tone="danger" label={GEO_BRIEF_SOURCE_SHORT.AUTO_GAP} />
                    <TruncText text={gap.promptText} lines={1} />
                  </div>
                  <div className="gm-vis-gap-meta">
                    <span>命中竞品：{gap.competitors.join('、')}</span>
                    <EngineChipList engines={gap.engines} max={3} />
                  </div>
                </div>
                <Button size="small" autoInsertSpace={false} onClick={onSwitchToRuns}>
                  透视
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* v2.2 Near-Miss 4-Tier Opportunities Panel */}
      {nearMissSlot ?? null}
    </div>
  );
}
