'use client';

import type {
  GeoMarket,
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
import { formatPct, GM } from '../../lib/design-tokens';
import {
  EngineChipList,
  SignalEmpty,
  SignalError,
  SignalKpiCard,
  SignalPill,
  SignalSkeleton,
  TruncText,
} from '../geo/primitives';
import { SonarDial } from '../geo/sonar-dial';
import { VisibilityTrendChart } from './visibility-trend-chart';

export type VisibilityOverviewTabProps = {
  activeMarket: GeoMarket;
  overview: VisibilityOverviewResponse | null;
  opportunities: VisibilityOpportunitiesResponse | null;
  loading: boolean;
  error: string | null;
  selectedEngine?: VisibilityEngineKey;
  onSelectEngine: (engine: VisibilityEngineKey | undefined) => void;
  onRetry: () => void;
  onSwitchToRuns: () => void;
  readOnly: boolean;
  /** Optional M3 slot for full GeoBrief list & 2-20 batch launch toolbar. */
  briefsSlot?: ReactNode;
};

export function VisibilityOverviewTab({
  activeMarket,
  overview,
  opportunities,
  loading,
  error,
  selectedEngine,
  onSelectEngine,
  onRetry,
  onSwitchToRuns,
  readOnly,
  briefsSlot,
}: VisibilityOverviewTabProps): JSX.Element {
  if (error && !overview) {
    return (
      <div className="gm-panel">
        <SignalError message={error} onRetry={onRetry} />
      </div>
    );
  }

  const metrics = overview?.metrics;
  const completedChecks = metrics?.completedChecks ?? 0;
  const sovEntries = metrics?.shareOfVoice.entries ?? [];
  const sentiment = metrics?.sentimentSummary;
  const sentimentTotal = sentiment?.total ?? 0;
  const gaps = opportunities?.gaps ?? [];

  return (
    <div className="gm-vis-tab-stack">
      {/* 4 KPI Cards */}
      <div className="gm-overview-kpi-grid">
        {loading && !overview ? (
          <>
            <SignalSkeleton variant="kpi" />
            <SignalSkeleton variant="kpi" />
            <SignalSkeleton variant="kpi" />
            <SignalSkeleton variant="kpi" />
          </>
        ) : (
          <>
            <SignalKpiCard
              label="品牌提及率"
              value={completedChecks > 0 ? formatPct(metrics?.visibilityPct) : '—'}
              numerator={completedChecks > 0 ? (metrics?.mentionedChecks ?? 0) : undefined}
              denominator={completedChecks > 0 ? completedChecks : undefined}
              caption={completedChecks > 0 ? '有效观测' : '暂无有效观测'}
              tone="cited"
            />
            <SignalKpiCard
              label="声量占比（SoV）"
              value={
                (metrics?.shareOfVoice.totalMentions ?? 0) > 0
                  ? formatPct(metrics?.shareOfVoice.brandSharePct)
                  : '—'
              }
              numerator={
                (metrics?.shareOfVoice.totalMentions ?? 0) > 0
                  ? (metrics?.shareOfVoice.brandMentions ?? 0)
                  : undefined
              }
              denominator={
                (metrics?.shareOfVoice.totalMentions ?? 0) > 0
                  ? (metrics?.shareOfVoice.totalMentions ?? 0)
                  : undefined
              }
              caption={(metrics?.shareOfVoice.totalMentions ?? 0) > 0 ? '总提及' : '等待监测数据'}
              tone="info"
            />
            <SignalKpiCard
              label="平均推荐顺位"
              value={
                metrics?.avgPosition !== null && metrics?.avgPosition !== undefined
                  ? `#${metrics.avgPosition.toFixed(1)}`
                  : '—'
              }
              caption="结构化推荐清单平均位次"
              tone="warning"
            />
            <SignalKpiCard
              label="自有阵地引用率"
              value={
                (metrics?.totalCitations ?? 0) > 0 ? formatPct(metrics?.ownedCitationRatePct) : '—'
              }
              numerator={
                (metrics?.totalCitations ?? 0) > 0 ? (metrics?.ownedCitations ?? 0) : undefined
              }
              denominator={
                (metrics?.totalCitations ?? 0) > 0 ? (metrics?.totalCitations ?? 0) : undefined
              }
              caption={(metrics?.totalCitations ?? 0) > 0 ? '总引用' : '暂无引用信源'}
              tone="cited"
            />
          </>
        )}
      </div>

      {/* Main Diagnostic Grid: Left SonarDial + Right Trend & SoV/Sentiment */}
      <div className="gm-overview-main-grid">
        <div className="gm-panel gm-vis-dial-panel">
          <div className="gm-vis-panel-head">
            <div>
              <div className="gm-vis-panel-title">AI 引擎覆盖声呐盘</div>
              <div className="gm-vis-panel-sub">
                当前市场引擎组：{activeMarket === 'CN' ? '国内 8 引擎' : '海外 5 引擎'}
              </div>
            </div>
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
        </div>

        <div className="gm-overview-right-stack">
          <div className="gm-panel">
            <div className="gm-vis-panel-head">
              <div>
                <div className="gm-vis-panel-title">品牌提及率趋势</div>
                <div className="gm-vis-panel-sub">
                  按上海自然日聚合有效观测提及率
                  {selectedEngine ? ` · ${VISIBILITY_ENGINE_LABELS[selectedEngine]}` : ''}
                </div>
              </div>
            </div>
            <VisibilityTrendChart
              points={overview?.trend ?? []}
              selectedEngine={selectedEngine}
              loading={loading && !overview}
            />
          </div>

          <div className="gm-overview-subgrid">
            {/* Brand vs Competitor SoV */}
            <div className="gm-panel">
              <div className="gm-vis-panel-head">
                <div className="gm-vis-panel-title">品牌 vs 竞品声量对比</div>
              </div>
              {loading && !overview ? (
                <SignalSkeleton variant="row" rows={4} />
              ) : sovEntries.length === 0 || (metrics?.shareOfVoice.totalMentions ?? 0) === 0 ? (
                <SignalEmpty
                  title="暂无声量对比数据"
                  description="完成监测后展示本品牌与竞品提及占比"
                />
              ) : (
                <div className="gm-vis-sov-list">
                  {sovEntries.slice(0, 8).map((entry) => (
                    <div key={`${entry.isBrand ? 'b' : 'c'}-${entry.name}`} className="gm-sov-row">
                      <div className="gm-sov-row-head">
                        <span className="gm-vis-sov-name">
                          <TruncText text={entry.name} lines={1} />
                          {entry.isBrand ? <SignalPill tone="cited">本品牌</SignalPill> : null}
                        </span>
                        <span className="gm-num gm-vis-sov-val">
                          {formatPct(entry.sharePct)}（{entry.mentions} 次）
                        </span>
                      </div>
                      <div className="gm-sov-track">
                        <div
                          className="gm-sov-fill"
                          style={{
                            width: `${Math.max(2, Math.min(100, entry.sharePct))}%`,
                            background: entry.isBrand ? GM.sig.cited : GM.sig.competitor,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Sentiment Distribution */}
            <div className="gm-panel">
              <div className="gm-vis-panel-head">
                <div className="gm-vis-panel-title">品牌情感分布</div>
              </div>
              {loading && !overview ? (
                <SignalSkeleton variant="row" rows={4} />
              ) : sentimentTotal === 0 || !sentiment ? (
                <SignalEmpty
                  title="暂无情感样本"
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
                          style={{
                            width: `${pct}%`,
                            background: GM.sentiment[sKey],
                          }}
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
                          <span
                            className="gm-vis-sentiment-dot"
                            style={{ background: GM.sentiment[sKey] }}
                          />
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
            </div>
          </div>
        </div>
      </div>

      {/* GEO Writing Briefs Slot (M3 Ready) */}
      <div className="gm-panel" data-testid="visibility-briefs-slot">
        <div className="gm-vis-panel-head">
          <div>
            <div className="gm-vis-panel-title">GEO 优先写作建议</div>
            <div className="gm-vis-panel-sub">
              基于当前市场可见度诊断自动识别竞品霸榜缺口、顺位落后与口碑风险
            </div>
          </div>
          {!readOnly ? (
            <Button size="small" onClick={onSwitchToRuns}>
              发起新一轮监测
            </Button>
          ) : null}
        </div>

        {briefsSlot ? (
          briefsSlot
        ) : completedChecks === 0 ? (
          <SignalEmpty
            title="完成首次监测后将自动生成优化建议"
            description="发起当前市场的 AI 引擎监测，系统将自动识别竞品霸榜缺口、顺位落后与负面情感问题。"
            actionText={readOnly ? undefined : '去发起监测任务'}
            onAction={readOnly ? undefined : onSwitchToRuns}
          />
        ) : gaps.length === 0 ? (
          <SignalEmpty
            title="当前窗口暂未发现竞品霸榜缺口"
            description="可前往「监测任务与问答透视」查看各引擎完整回答，或补充更多高意图选购问句。"
            actionText="查看监测任务"
            onAction={onSwitchToRuns}
          />
        ) : (
          <div className="gm-vis-gap-list">
            {gaps.slice(0, 5).map((gap) => (
              <div key={gap.promptText} className="gm-vis-gap-row">
                <div className="gm-vis-gap-main">
                  <div className="gm-vis-gap-prompt">
                    <SignalPill tone="danger">竞品霸榜缺口</SignalPill>
                    <TruncText text={gap.promptText} lines={1} />
                  </div>
                  <div className="gm-vis-gap-meta">
                    <span>命中竞品：{gap.competitors.join('、')}</span>
                    <EngineChipList engines={gap.engines} max={3} />
                  </div>
                </div>
                <Button size="small" onClick={onSwitchToRuns}>
                  透视问答
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
