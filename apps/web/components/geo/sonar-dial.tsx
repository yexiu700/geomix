'use client';

import type { VisibilityEngineBreakdownItem, VisibilityEngineKey } from '@geomix/shared';
import { VISIBILITY_ENGINES } from '@geomix/shared';
import type { JSX, KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import { formatPct, GM } from '../../lib/design-tokens';
import { SignalEmpty, SignalError } from './primitives';

export type SonarDialProps = {
  byEngine: VisibilityEngineBreakdownItem[] | undefined;
  overallPct: number;
  selectedEngine?: VisibilityEngineKey;
  onSelectEngine: (engine: VisibilityEngineKey | undefined) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

const CX = 160;
const CY = 160;
const R = 120;
const SHORT_LABELS: Partial<Record<VisibilityEngineKey, string>> = { google_aio: 'Google AIO' };
const DEG = Math.PI / 180;
const STEP = 360 / VISIBILITY_ENGINES.length;
const polar = (r: number, deg: number) => ({
  x: CX + r * Math.cos(deg * DEG),
  y: CY + r * Math.sin(deg * DEG),
});
const sectorPath = (r: number, a0: number, a1: number) => {
  const s = polar(r, a0);
  const e = polar(r, a1);
  return `M ${CX} ${CY} L ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 0 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)} Z`;
};
const fmtPos = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `#${v.toFixed(1)}`);

export function SonarDial(p: SonarDialProps): JSX.Element {
  const gradId = useId();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const nodes = useMemo(() => {
    const map = new Map((p.byEngine ?? []).map((row) => [row.engine, row]));
    return VISIBILITY_ENGINES.map((eng, idx) => {
      const item = map.get(eng.key);
      const completed = item?.completedChecks ?? 0;
      const deg = -90 + idx * STEP;
      const hasData = completed > 0;
      const pct = hasData ? Math.max(0, Math.min(100, item?.visibilityPct ?? 0)) : 0;
      const cos = Math.cos(deg * DEG);
      return {
        idx,
        eng,
        completed,
        mentioned: item?.mentionedChecks ?? 0,
        visPct: item?.visibilityPct ?? 0,
        avgPos: item?.avgPosition ?? null,
        deg,
        hasData,
        spokeEnd: polar(R, deg),
        point: polar(hasData ? (R * pct) / 100 : 0, deg),
        labelPos: polar(R + 16, deg),
        anchor: (cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle') as 'start' | 'end' | 'middle',
        dialLabel: eng.label.length > 6 ? (SHORT_LABELS[eng.key] ?? eng.label) : eng.label,
        hitD: sectorPath(R + 28, deg - STEP / 2, deg + STEP / 2),
      };
    });
  }, [p.byEngine]);

  if (p.error) return <SignalError message={p.error} onRetry={p.onRetry} />;
  if (p.loading) {
    return (
      <div
        className="gm-skeleton gm-sonar-skeleton"
        aria-busy="true"
        aria-label="引擎覆盖率加载中"
      />
    );
  }

  const isEmpty = !p.byEngine?.length || p.byEngine.every((item) => item.completedChecks === 0);
  const polyPoints = nodes.map((n) => `${n.point.x.toFixed(2)},${n.point.y.toFixed(2)}`).join(' ');
  const sweepStart = polar(R, -90);
  const sweepLead = polar(R, -60);
  const hovered = hoveredIdx !== null && !isEmpty ? nodes[hoveredIdx] : null;
  const toggle = (key: VisibilityEngineKey) =>
    p.onSelectEngine(p.selectedEngine === key ? undefined : key);
  const onKey = (e: KeyboardEvent<SVGPathElement>, key: VisibilityEngineKey) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(key);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      p.onSelectEngine(undefined);
    }
  };

  return (
    <div className="gm-sonar" onKeyDown={(e) => e.key === 'Escape' && p.onSelectEngine(undefined)}>
      <svg
        viewBox="0 0 320 320"
        width="100%"
        height="100%"
        role="img"
        aria-label="AI 引擎覆盖率声呐盘"
      >
        <defs>
          <linearGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            x1={sweepLead.x}
            y1={sweepLead.y}
            x2={sweepStart.x}
            y2={sweepStart.y}
          >
            <stop offset="0%" stopColor="rgba(197,240,74,0.22)" />
            <stop offset="100%" stopColor="rgba(197,240,74,0)" />
          </linearGradient>
        </defs>
        {([30, 60, 90, 120] as const).map((r) => (
          <circle
            key={r}
            cx={CX}
            cy={CY}
            r={r}
            fill="none"
            stroke={r === 120 ? GM.line.l2 : GM.line.l1}
            strokeWidth={1}
          />
        ))}
        {([30, 60, 90] as const).map((r, i) => (
          <text key={r} x={CX + 4} y={CY - r} className="gm-sonar-ring-label gm-num">
            {`${(i + 1) * 25}%`}
          </text>
        ))}
        {nodes.map(({ idx, eng, spokeEnd, deg, labelPos, anchor, dialLabel }) => {
          const sel = p.selectedEngine === eng.key;
          return (
            <g key={eng.key}>
              <line
                x1={CX}
                y1={CY}
                x2={spokeEnd.x}
                y2={spokeEnd.y}
                stroke={sel ? GM.phosphor : GM.line.l1}
                strokeWidth={sel ? 1.5 : 1}
              />
              {idx === 0 || idx === 8 ? (
                <line
                  x1={polar(R + 2, deg).x}
                  y1={polar(R + 2, deg).y}
                  x2={polar(R + 8, deg).x}
                  y2={polar(R + 8, deg).y}
                  stroke={GM.fg.f3}
                  strokeWidth={1}
                />
              ) : null}
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor={anchor}
                dominantBaseline="middle"
                fontSize={11}
                fontWeight={sel ? 600 : 400}
                fill={sel ? GM.fg.f1 : eng.domestic ? GM.fg.f2 : GM.fg.f3}
              >
                {dialLabel}
              </text>
            </g>
          );
        })}
        {!isEmpty ? (
          <>
            <g className="gm-sonar-sweep" aria-hidden="true">
              <path d={sectorPath(R, -90, -60)} fill={`url(#${gradId})`} />
              <line
                x1={CX}
                y1={CY}
                x2={sweepLead.x}
                y2={sweepLead.y}
                stroke="rgba(197,240,74,0.6)"
                strokeWidth={1}
              />
            </g>
            <polygon
              points={polyPoints}
              fill="rgba(61,224,200,0.12)"
              stroke={GM.sig.cited}
              strokeWidth={1.5}
              strokeLinejoin="round"
              className="gm-sonar-poly"
              style={{ transform: mounted ? 'scale(1)' : 'scale(0)' }}
            />
            {nodes.map(({ eng, hasData, point }) => (
              <circle
                key={eng.key}
                cx={point.x}
                cy={point.y}
                r={3}
                fill={hasData ? GM.sig.cited : 'none'}
                stroke={hasData ? undefined : GM.sig.absent}
                strokeDasharray={hasData ? undefined : '2 2'}
              />
            ))}
          </>
        ) : null}
        <text x={CX} y={158} textAnchor="middle" className="gm-sonar-center-val gm-num">
          {isEmpty ? '—' : formatPct(p.overallPct)}
        </text>
        <text x={CX} y={176} textAnchor="middle" className="gm-sonar-center-sub">
          整体提及率
        </text>
        {nodes.map(({ idx, eng, hitD }) => {
          const sel = p.selectedEngine === eng.key;
          return (
            <path
              key={eng.key}
              d={hitD}
              className="gm-sonar-hit"
              role="button"
              tabIndex={0}
              aria-label={`筛选引擎-${eng.label}`}
              aria-pressed={sel}
              onClick={() => toggle(eng.key)}
              onKeyDown={(e) => onKey(e, eng.key)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx((prev) => (prev === idx ? null : prev))}
              onFocus={() => setHoveredIdx(idx)}
              onBlur={() => setHoveredIdx((prev) => (prev === idx ? null : prev))}
            />
          );
        })}
      </svg>
      {hovered ? (
        <div
          className="gm-sonar-tooltip"
          role="tooltip"
          style={{
            left: `calc(${((hovered.point.x / 320) * 100).toFixed(2)}% + 12px)`,
            top: `calc(${((hovered.point.y / 320) * 100).toFixed(2)}% + 12px)`,
          }}
        >
          <div className="gm-sonar-tooltip-title">{hovered.eng.label}</div>
          <div>
            提及率：
            <span className="gm-num">{hovered.hasData ? formatPct(hovered.visPct) : '—'}</span>
          </div>
          <div>
            提及 <span className="gm-num">{hovered.mentioned}</span> / 观测{' '}
            <span className="gm-num">{hovered.completed}</span>
          </div>
          <div>
            平均顺位：<span className="gm-num">{fmtPos(hovered.avgPos)}</span>
          </div>
        </div>
      ) : null}
      {isEmpty ? (
        <div className="gm-sonar-empty">
          <SignalEmpty
            title="暂无引擎覆盖数据"
            description="完成一次监测任务后，这里会显示各 AI 引擎的提及率分布"
          />
        </div>
      ) : null}
      <table className="gm-sr-only">
        <thead>
          <tr>
            <th>引擎</th>
            <th>提及率</th>
            <th>提及次数</th>
            <th>有效观测</th>
            <th>平均顺位</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map(({ eng, completed, mentioned, visPct, avgPos, hasData }) => (
            <tr key={eng.key}>
              <td>{eng.label}</td>
              <td>{hasData ? formatPct(visPct) : '—'}</td>
              <td>{mentioned}</td>
              <td>{completed}</td>
              <td>{fmtPos(avgPos)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
