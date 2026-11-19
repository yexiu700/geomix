'use client';

import { Space } from 'antd';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { GM } from '../../lib/design-tokens';
import { SignalEmpty, SignalSkeleton } from '../geo/primitives';
import {
  formatShortDate,
  getPointSovPct,
  type TrendSeriesPoint,
} from './visibility-overview-helpers';

/**
 * 每日提及率（实线）/ 声量占比（虚线，0 样本日断开）/ 检测-提及量（柱状）组合 SVG 图。
 * 纯展示组件，悬停状态由调用方以 Props 驱动。
 */
export function VisibilityTrendChartSvg({
  points,
  activeIndex,
  onHoverIndex,
}: {
  points: TrendSeriesPoint[];
  activeIndex: number | null;
  onHoverIndex: (idx: number | null) => void;
}) {
  const width = 740;
  const height = 248;
  const padLeft = 44;
  const padRight = 20;
  const padTop = 24;
  const padBottom = 38;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const pctTicks = [0, 25, 50, 75, 100];
  const maxObs = Math.max(4, ...points.map((p) => p.completedChecks));

  const colW = plotW / Math.max(1, points.length);
  const barW = Math.max(6, Math.min(22, Math.floor(colW * 0.42)));

  const yPct = (pct: number) => {
    const clamped = Math.max(0, Math.min(100, pct));
    return padTop + plotH - (clamped / 100) * plotH;
  };

  const yObs = (count: number) => {
    const ratio = Math.max(0, Math.min(1, count / maxObs));
    return padTop + plotH - ratio * plotH * 0.78;
  };

  const visPolyline = points
    .map((pt, idx) => {
      const cx = padLeft + idx * colW + colW / 2;
      return `${cx},${yPct(pt.visibilityPct)}`;
    })
    .join(' ');

  const sovSegments: string[][] = [];
  let currentSovSegment: string[] = [];
  points.forEach((pt, idx) => {
    const sov = getPointSovPct(pt);
    if (sov === null) {
      if (currentSovSegment.length > 0) {
        sovSegments.push(currentSovSegment);
        currentSovSegment = [];
      }
      return;
    }
    const cx = padLeft + idx * colW + colW / 2;
    currentSovSegment.push(`${cx},${yPct(sov)}`);
  });
  if (currentSovSegment.length > 0) {
    sovSegments.push(currentSovSegment);
  }

  const labelStep = points.length > 16 ? 4 : points.length > 9 ? 2 : 1;

  return (
    <svg
      data-testid="visibility-trend-svg"
      role="img"
      aria-label="近 N 日品牌可见度与声量趋势图"
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', maxHeight: 265, display: 'block' }}
      onMouseLeave={() => onHoverIndex(null)}
    >
      {/* Y-axis gridlines (0% - 100%) */}
      {pctTicks.map((tick) => {
        const y = yPct(tick);
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              stroke={GM.chart.grid}
              strokeDasharray={tick === 0 ? undefined : '4 4'}
            />
            <text
              x={padLeft - 8}
              y={y + 4}
              textAnchor="end"
              fontSize="11"
              className="gm-num"
              fill={GM.chart.axis}
            >
              {tick}%
            </text>
          </g>
        );
      })}

      {/* Daily observation & mention bars */}
      {points.map((pt, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const barX = cx - barW / 2;
        const totalTop = yObs(pt.completedChecks);
        const totalH = Math.max(2, padTop + plotH - totalTop);
        const mentionTop = yObs(pt.mentionedChecks);
        const mentionH = Math.max(0, padTop + plotH - mentionTop);
        const isHovered = activeIndex === idx;

        return (
          <g key={pt.date} onMouseEnter={() => onHoverIndex(idx)} style={{ cursor: 'pointer' }}>
            <rect
              x={padLeft + idx * colW}
              y={padTop}
              width={colW}
              height={plotH}
              fill={isHovered ? GM.bg.hover : 'transparent'}
            />
            <rect
              x={barX}
              y={pt.completedChecks > 0 ? totalTop : padTop + plotH - 2}
              width={barW}
              height={pt.completedChecks > 0 ? totalH : 2}
              rx={3}
              fill="rgba(255,255,255,0.08)"
            />
            {pt.mentionedChecks > 0 ? (
              <rect
                x={barX}
                y={mentionTop}
                width={barW}
                height={mentionH}
                rx={3}
                fill="rgba(61,224,200,0.32)"
              />
            ) : null}
            {idx % labelStep === 0 || idx === points.length - 1 ? (
              <text
                x={cx}
                y={height - 12}
                textAnchor="middle"
                fontSize="11"
                className="gm-num"
                fill={isHovered ? GM.fg.f1 : GM.chart.axis}
                fontWeight={isHovered ? '600' : '400'}
              >
                {formatShortDate(pt.date)}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Share of Voice % dashed polylines (gapped when sample count is 0) */}
      {sovSegments.map((seg, segIdx) =>
        seg.length > 1 ? (
          <polyline
            key={`sov-seg-${segIdx}`}
            data-testid="visibility-sov-line"
            fill="none"
            stroke={GM.chart.c1}
            strokeWidth="1.5"
            strokeDasharray="4 3"
            points={seg.join(' ')}
          />
        ) : null,
      )}

      {/* Visibility % solid polyline */}
      {points.length > 1 ? (
        <polyline fill="none" stroke={GM.sig.cited} strokeWidth="2" points={visPolyline} />
      ) : null}

      {/* Data nodes */}
      {points.map((pt, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const cy = yPct(pt.visibilityPct);
        const sov = getPointSovPct(pt);
        const isHovered = activeIndex === idx;
        return (
          <g key={`${pt.date}-nodes`} onMouseEnter={() => onHoverIndex(idx)}>
            {sov !== null ? (
              <circle
                data-testid={`visibility-sov-node-${pt.date}`}
                cx={cx}
                cy={yPct(sov)}
                r={isHovered ? 4.5 : 3}
                fill={GM.bg.surface}
                stroke={GM.chart.c1}
                strokeWidth="1.5"
                className="gm-trend-node"
              />
            ) : null}
            <circle
              cx={cx}
              cy={cy}
              r={isHovered ? 4.5 : 3}
              fill={GM.bg.surface}
              stroke={GM.sig.cited}
              strokeWidth="2"
              className="gm-trend-node"
            />
          </g>
        );
      })}
    </svg>
  );
}

function LegendSwatch({ style, label }: { style: CSSProperties; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ display: 'inline-block', ...style }} />
      {label}
    </span>
  );
}

function describeTrendPoint(pt: TrendSeriesPoint): string {
  const sov = getPointSovPct(pt);
  return `${pt.date}：检测 ${pt.completedChecks} 次 · 提及 ${pt.mentionedChecks} 次 · 提及率 ${pt.visibilityPct.toFixed(1)}% · 声量占比 ${
    sov !== null ? `${sov.toFixed(1)}%` : '—'
  }`;
}

/**
 * 「可见度与声量变化趋势」卡片：标题 / 悬停摘要 / 图例 + 加载、空态与 SVG 图。
 * 悬停索引与数据序列绑定，序列刷新后自动失效，无需额外 effect 重置。
 */
export function VisibilityTrendPanel({
  points,
  loading,
}: {
  points: TrendSeriesPoint[];
  loading: boolean;
}) {
  const [hover, setHover] = useState<{ points: TrendSeriesPoint[]; idx: number } | null>(null);
  const activeIndex = hover && hover.points === points ? hover.idx : null;
  const activeTrendPoint = activeIndex !== null ? (points[activeIndex] ?? null) : null;
  const hasTrendActivity = points.length > 0 && points.some((pt) => pt.completedChecks > 0);

  return (
    <div className="gm-panel">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div>
          <div className="gm-panel-title">可见度与声量变化趋势</div>
          <div className="gm-panel-sub gm-num">
            {activeTrendPoint
              ? describeTrendPoint(activeTrendPoint)
              : '展示周期内每日品牌提及率（实线）、声量占比（虚线）与有效检测量（柱状）'}
          </div>
        </div>
        <Space size={10} wrap style={{ fontSize: 12, color: GM.fg.f2 }}>
          <LegendSwatch
            style={{ width: 10, height: 2, background: GM.sig.cited }}
            label="提及率 %"
          />
          <LegendSwatch
            style={{ width: 10, height: 2, borderTop: `1.5px dashed ${GM.chart.c1}` }}
            label="声量占比 %"
          />
          <LegendSwatch
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: 'rgba(61,224,200,0.32)',
            }}
            label="检测/提及量"
          />
        </Space>
      </div>

      {loading ? (
        <SignalSkeleton variant="block" height={220} />
      ) : !hasTrendActivity ? (
        <div data-testid="visibility-trend-empty">
          <SignalEmpty
            title="当前筛选范围内暂无有效 AI 检测趋势记录"
            description="切换时间窗口或前往「AI可见度诊断」发起新一轮多引擎监测后即可查看趋势曲线。"
          />
        </div>
      ) : (
        <VisibilityTrendChartSvg
          points={points}
          activeIndex={activeIndex}
          onHoverIndex={(idx) => setHover(idx === null ? null : { points, idx })}
        />
      )}
    </div>
  );
}
