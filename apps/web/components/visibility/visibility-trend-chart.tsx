'use client';

import type { VisibilityEngineKey, VisibilityTrendPoint } from '@geomix/shared';
import { VISIBILITY_ENGINE_LABELS } from '@geomix/shared';
import type { JSX } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import { formatPct, GM } from '../../lib/design-tokens';
import { SignalSkeleton } from '../geo/primitives';
import { EmptyState } from '../ui';

export type VisibilityTrendChartProps = {
  points: readonly VisibilityTrendPoint[];
  selectedEngine?: VisibilityEngineKey;
  loading?: boolean;
};

const W = 640;
const H = 200;
const PAD_L = 46;
const PAD_R = 28;
const PAD_T = 18;
const PAD_B = 30;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const Y_TICKS = [0, 25, 50, 75, 100] as const;

function shortDateLabel(dateKey: string): string {
  const parts = dateKey.split('-');
  if (parts.length === 3) {
    return `${parts[1]}-${parts[2]}`;
  }
  return dateKey;
}

export function VisibilityTrendChart({
  points,
  selectedEngine,
  loading = false,
}: VisibilityTrendChartProps): JSX.Element {
  const gradId = useId();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const seriesPoints = useMemo(() => {
    const targetEngine = selectedEngine ?? 'all';
    const exact = points.filter((pt) => pt.engine === targetEngine);
    const source = exact.length > 0 || selectedEngine ? exact : points;
    const seenDates = new Set<string>();
    const deduped: VisibilityTrendPoint[] = [];
    for (const pt of source) {
      if (seenDates.has(pt.date)) continue;
      seenDates.add(pt.date);
      deduped.push(pt);
    }
    return deduped;
  }, [points, selectedEngine]);

  useEffect(() => {
    setHoveredIdx(null);
  }, [selectedEngine, seriesPoints.length]);

  const hasData = useMemo(() => seriesPoints.some((pt) => pt.completedChecks > 0), [seriesPoints]);

  const geometry = useMemo(() => {
    const count = seriesPoints.length;
    if (count === 0) {
      return { coords: [], linePath: '', areaPath: '', xLabelIndices: new Set<number>() };
    }
    const coords = seriesPoints.map((pt, idx) => {
      const x = count === 1 ? PAD_L + PLOT_W / 2 : PAD_L + (idx / (count - 1)) * PLOT_W;
      const pct = Math.max(0, Math.min(100, pt.visibilityPct));
      const y = PAD_T + PLOT_H - (pct / 100) * PLOT_H;
      return { idx, x, y, pt };
    });

    const linePath = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const baseY = PAD_T + PLOT_H;
    const areaPath =
      coords.length > 0
        ? `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} ${baseY} L ${coords[0]!.x.toFixed(1)} ${baseY} Z`
        : '';

    const xLabelIndices = new Set<number>();
    if (count <= 7) {
      for (let i = 0; i < count; i += 1) xLabelIndices.add(i);
    } else {
      const step = Math.max(1, Math.ceil((count - 1) / 5));
      const minLastGap = Math.max(2, Math.ceil(step * 0.6));
      let lastRegular = 0;
      for (let i = 0; i < count; i += step) {
        xLabelIndices.add(i);
        lastRegular = i;
      }
      if (lastRegular !== count - 1 && count - 1 - lastRegular < minLastGap) {
        xLabelIndices.delete(lastRegular);
      }
      xLabelIndices.add(count - 1);
    }

    return { coords, linePath, areaPath, xLabelIndices };
  }, [seriesPoints]);

  if (loading) {
    return <SignalSkeleton variant="block" height={200} />;
  }

  if (!hasData || geometry.coords.length === 0) {
    return (
      <div className="gm-vis-trend-empty">
        <EmptyState
          size="compact"
          title="所选时间窗口暂无趋势数据"
          description="发起并完成监测任务后，这里会按天展示品牌 AI 提及率变化曲线"
        />
      </div>
    );
  }

  const hovered = hoveredIdx !== null ? (geometry.coords[hoveredIdx] ?? null) : null;
  const engineSuffix = selectedEngine ? `（${VISIBILITY_ENGINE_LABELS[selectedEngine]}）` : '';

  return (
    <div className="gm-vis-trend-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={`品牌提及率趋势图${engineSuffix}`}
        className="gm-vis-trend-svg"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(61,224,200,0.28)" />
            <stop offset="100%" stopColor="rgba(61,224,200,0.01)" />
          </linearGradient>
        </defs>

        {Y_TICKS.map((tick) => {
          const y = PAD_T + PLOT_H - (tick / 100) * PLOT_H;
          return (
            <g key={tick}>
              <line
                x1={PAD_L}
                y1={y}
                x2={W - PAD_R}
                y2={y}
                stroke={GM.chart.grid}
                strokeDasharray={tick === 0 ? undefined : '3 3'}
                strokeWidth={1}
              />
              <text
                x={PAD_L - 8}
                y={y + 4}
                textAnchor="end"
                fontSize={12}
                fill={GM.chart.axis}
                className="gm-num"
              >
                {`${tick}%`}
              </text>
            </g>
          );
        })}

        {geometry.areaPath ? <path d={geometry.areaPath} fill={`url(#${gradId})`} /> : null}
        {geometry.linePath ? (
          <path
            d={geometry.linePath}
            fill="none"
            stroke={GM.sig.cited}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {geometry.coords.map(({ idx, x, y, pt }) => {
          const active = hoveredIdx === idx;
          const isLastTick = geometry.coords.length > 1 && idx === geometry.coords.length - 1;
          return (
            <g key={`${pt.engine}-${pt.date}`}>
              {geometry.xLabelIndices.has(idx) ? (
                <text
                  x={x}
                  y={H - 8}
                  textAnchor={isLastTick ? 'end' : 'middle'}
                  fontSize={12}
                  fill={GM.chart.axis}
                  className="gm-num"
                >
                  {shortDateLabel(pt.date)}
                </text>
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={active ? 4.5 : pt.completedChecks > 0 ? 3 : 2}
                fill={pt.completedChecks > 0 ? GM.sig.cited : GM.bg.elevated}
                stroke={active ? GM.phosphor : GM.sig.cited}
                strokeWidth={active ? 2 : 1.5}
                className="gm-trend-node"
                tabIndex={0}
                role="button"
                aria-label={`${pt.date} 提及率 ${formatPct(pt.visibilityPct)}`}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx((prev) => (prev === idx ? null : prev))}
                onFocus={() => setHoveredIdx(idx)}
                onBlur={() => setHoveredIdx((prev) => (prev === idx ? null : prev))}
              />
            </g>
          );
        })}
      </svg>

      {hovered ? (
        <div
          className="gm-vis-trend-tooltip"
          role="tooltip"
          style={{
            left: `${((hovered.x / W) * 100).toFixed(2)}%`,
            top: `${Math.max(8, (hovered.y / H) * 100 - 8).toFixed(2)}%`,
            transform: hovered.x > W * 0.68 ? 'translate(-108%, -50%)' : 'translate(10%, -50%)',
          }}
        >
          <div className="gm-sonar-tooltip-title gm-num">{hovered.pt.date}</div>
          <div>
            提及率：<span className="gm-num">{formatPct(hovered.pt.visibilityPct)}</span>
          </div>
          <div>
            提及 <span className="gm-num">{hovered.pt.mentionedChecks}</span> / 观测{' '}
            <span className="gm-num">{hovered.pt.completedChecks}</span>
          </div>
        </div>
      ) : null}

      <table className="gm-sr-only">
        <thead>
          <tr>
            <th>日期</th>
            <th>提及率</th>
            <th>提及次数</th>
            <th>有效观测</th>
          </tr>
        </thead>
        <tbody>
          {seriesPoints.map((pt) => (
            <tr key={`${pt.engine}-${pt.date}`}>
              <td>{pt.date}</td>
              <td>{formatPct(pt.visibilityPct)}</td>
              <td>{pt.mentionedChecks}</td>
              <td>{pt.completedChecks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
