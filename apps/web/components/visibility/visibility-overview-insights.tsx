'use client';

import {
  VISIBILITY_ENGINE_LABELS,
  computeVisibilityPct,
  type RecomputedRunMetrics,
  type VisibilityBrandShareOfVoiceGroup,
  type VisibilityEngineBreakdownItem,
  type VisibilityEngineKey,
} from '@geomix/shared';
import { Button, Tooltip } from 'antd';
import type { CSSProperties } from 'react';
import { GM, formatPct } from '../../lib/design-tokens';
import { SignalEmpty, SignalKpiCard, SignalPill } from '../geo/primitives';
import { SonarDial } from '../geo/sonar-dial';

type SovEntry = RecomputedRunMetrics['shareOfVoice']['entries'][number];

const INLINE_FLEX_CENTER: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };

/** 4 张核心 KPI 卡：提及率 / 声量占比 / 平均顺位 / 自有域名引用率。 */
export function VisibilityOverviewKpiGrid({
  metrics,
  loading,
}: {
  metrics: RecomputedRunMetrics;
  loading: boolean;
}) {
  return (
    <div className="gm-overview-kpi-grid">
      <SignalKpiCard
        testId="kpi-visibility"
        label="品牌提及率（Visibility %）"
        value={formatPct(metrics.visibilityPct)}
        tone="cited"
        numerator={metrics.mentionedChecks}
        denominator={metrics.completedChecks}
        caption="提及 / 有效观测"
        loading={loading}
      />
      <SignalKpiCard
        testId="kpi-sov"
        label="品牌声量占比（Share of Voice %）"
        value={formatPct(metrics.shareOfVoice.brandSharePct)}
        tone="cited"
        numerator={metrics.shareOfVoice.brandMentions}
        denominator={metrics.shareOfVoice.totalMentions}
        caption="本品牌 / 赛道总声量"
        loading={loading}
      />
      <SignalKpiCard
        testId="kpi-position"
        label="平均推荐顺位（Avg Position）"
        value={metrics.avgPosition !== null ? `#${metrics.avgPosition.toFixed(1)}` : '—'}
        tone="info"
        caption={
          metrics.avgPosition !== null
            ? '顺位越靠前代表 AI 首推权重越高'
            : '当前筛选周期内暂无命中顺位'
        }
        loading={loading}
      />
      <SignalKpiCard
        testId="kpi-owned-citation"
        label="自有域名引用率（Owned Citation %）"
        value={formatPct(metrics.ownedCitationRatePct)}
        tone="cited"
        numerator={metrics.ownedCitations}
        denominator={metrics.totalCitations}
        caption={`自有引用 · 正面情感 ${metrics.sentimentSummary.positivePct.toFixed(1)}%`}
        loading={loading}
      />
    </div>
  );
}

/** 左侧「引擎覆盖」声呐盘卡片，点击辐条按引擎联动筛选。 */
export function VisibilityEngineCoveragePanel({
  byEngine,
  overallPct,
  selectedEngine,
  onSelectEngine,
  loading,
}: {
  byEngine: VisibilityEngineBreakdownItem[];
  overallPct: number;
  selectedEngine: VisibilityEngineKey | undefined;
  onSelectEngine: (eng: VisibilityEngineKey | undefined) => void;
  loading: boolean;
}) {
  const dot: CSSProperties = { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' };
  return (
    <div className="gm-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div>
          <div className="gm-panel-title">引擎覆盖</div>
          <div className="gm-panel-sub">
            {selectedEngine
              ? `已筛选：${VISIBILITY_ENGINE_LABELS[selectedEngine] ?? selectedEngine}（再点取消）`
              : '点击辐条可按 AI 引擎联动筛选'}
          </div>
        </div>
        {selectedEngine ? (
          <Button size="small" onClick={() => onSelectEngine(undefined)}>
            清除引擎
          </Button>
        ) : null}
      </div>

      <SonarDial
        byEngine={byEngine}
        overallPct={overallPct}
        selectedEngine={selectedEngine}
        onSelectEngine={onSelectEngine}
        loading={loading}
      />

      <div className="gm-sonar-legend">
        <span style={INLINE_FLEX_CENTER}>
          <span style={{ ...dot, background: GM.sig.cited }} />
          已提及
        </span>
        <span style={INLINE_FLEX_CENTER}>
          <span style={{ ...dot, border: `1px dashed ${GM.sig.absent}` }} />
          未观测
        </span>
        <span style={INLINE_FLEX_CENTER}>
          <span style={{ color: GM.phosphor, fontSize: 10, lineHeight: 1 }}>▲</span>
          扫描
        </span>
      </div>
    </div>
  );
}

function SovRow({ entry, denominatorChecks }: { entry: SovEntry; denominatorChecks: number }) {
  const visPct = computeVisibilityPct(entry.mentions, denominatorChecks);
  return (
    <Tooltip title={`提及 ${entry.mentions} 次 · 可见率 ${visPct.toFixed(1)}%`}>
      <div
        data-testid={entry.isBrand ? 'sov-brand-row' : `sov-comp-row-${entry.name}`}
        className="gm-sov-row"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <Tooltip title={entry.name}>
            <span className="gm-clamp-1" style={{ fontSize: 13, color: GM.fg.f1 }}>
              {entry.name}
            </span>
          </Tooltip>
          {entry.isBrand ? <SignalPill tone="cited">我方</SignalPill> : null}
        </div>
        <div className="gm-sov-track">
          <div
            className="gm-sov-fill"
            style={{
              width: `${Math.max(0, Math.min(100, entry.sharePct))}%`,
              background: entry.isBrand ? GM.sig.cited : GM.sig.competitor,
            }}
          />
        </div>
        <span
          className="gm-num"
          style={{
            fontSize: 12,
            textAlign: 'right',
            color: entry.isBrand ? GM.sig.cited : GM.fg.f2,
          }}
        >
          <span className="gm-sr-only">{`声量 ${entry.sharePct.toFixed(1)}%`}</span>
          <span aria-hidden="true">{entry.sharePct.toFixed(1)}%</span>
        </span>
      </div>
    </Tooltip>
  );
}

function sovRowKey(entry: SovEntry, idx: number): string {
  return `${entry.isBrand ? 'brand' : 'comp'}-${entry.name}-${idx}`;
}

function ShareOfVoiceBoard({
  metrics,
  brandGroups,
}: {
  metrics: RecomputedRunMetrics;
  brandGroups: VisibilityBrandShareOfVoiceGroup[];
}) {
  if (brandGroups.length > 1) {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {brandGroups.map((group) => (
          <div
            key={group.brandName}
            data-testid={`sov-group-${group.brandName}`}
            style={{
              display: 'grid',
              gap: 4,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--gm-line-1)',
              background: 'var(--gm-bg-elevated)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 2,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: GM.fg.f1 }}>
                {group.brandName}
              </span>
              <span className="gm-num" style={{ fontSize: 11, color: GM.fg.f3 }}>
                观测 {group.completedChecks} 次 · 提及率 {group.visibilityPct.toFixed(1)}%
              </span>
            </div>
            {group.shareOfVoice.entries.map((entry, idx) => (
              <SovRow
                key={sovRowKey(entry, idx)}
                entry={entry}
                denominatorChecks={group.completedChecks}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (metrics.shareOfVoice.entries.length === 0) {
    return <SignalEmpty title="暂无品牌与竞品对比数据" />;
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {metrics.shareOfVoice.entries.map((entry, idx) => (
        <SovRow
          key={sovRowKey(entry, idx)}
          entry={entry}
          denominatorChecks={metrics.completedChecks}
        />
      ))}
    </div>
  );
}

function SentimentDistribution({ metrics }: { metrics: RecomputedRunMetrics }) {
  const summary = metrics.sentimentSummary;
  const sentimentTotal = summary.total;
  const sentimentRows = [
    { key: 'positive', label: '正面', count: summary.positive, color: GM.sentiment.positive },
    { key: 'neutral', label: '中性', count: summary.neutral, color: GM.sentiment.neutral },
    { key: 'mixed', label: '褒贬参半', count: summary.mixed, color: GM.sentiment.mixed },
    { key: 'negative', label: '负面', count: summary.negative, color: GM.sentiment.negative },
  ];

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
        }}
      >
        <div className="gm-panel-title">本品牌情感倾向分布</div>
        <div className="gm-panel-sub gm-num">共 {sentimentTotal} 次情感评估</div>
      </div>

      {sentimentTotal > 0 ? (
        <div className="gm-sentiment-bar">
          {sentimentRows.map((row) =>
            row.count > 0 ? (
              <div
                key={row.key}
                style={{
                  width: `${(row.count / sentimentTotal) * 100}%`,
                  background: row.color,
                }}
              />
            ) : null,
          )}
        </div>
      ) : (
        <div className="gm-sentiment-bar" />
      )}

      <div className="gm-sentiment-legend">
        {sentimentRows.map((row) => {
          const pct = sentimentTotal > 0 ? (row.count / sentimentTotal) * 100 : 0;
          return (
            <div
              key={row.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
                color: GM.fg.f2,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: row.color,
                    flex: 'none',
                  }}
                />
                <span>{row.label}</span>
              </span>
              <span className="gm-num" style={{ color: GM.fg.f1 }}>
                {row.count} ({pct.toFixed(1)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 右下卡片：品牌 vs 竞品声量对比榜（多品牌分组，#211）+ 本品牌情感分布。 */
export function VisibilitySovSentimentPanel({
  metrics,
  brandGroups,
}: {
  metrics: RecomputedRunMetrics;
  brandGroups: VisibilityBrandShareOfVoiceGroup[];
}) {
  return (
    <div className="gm-panel">
      <div className="gm-overview-subgrid">
        <div style={{ minWidth: 0 }}>
          <div className="gm-panel-title" style={{ marginBottom: 8 }}>
            品牌 vs 竞品声量对比榜（Share of Voice）
          </div>
          <ShareOfVoiceBoard metrics={metrics} brandGroups={brandGroups} />
        </div>
        <SentimentDistribution metrics={metrics} />
      </div>
    </div>
  );
}
