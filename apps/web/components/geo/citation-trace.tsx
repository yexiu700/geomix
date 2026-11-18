'use client';

import { CITATION_SOURCE_KINDS, type VisibilityObservationRecord } from '@geomix/shared';
import type { CSSProperties, JSX, KeyboardEvent } from 'react';
import { useMemo, useState } from 'react';
import { GM, truncateMiddle } from '../../lib/design-tokens';
import { buildTraceGraph, type TraceEdgeTone, type TraceGraph } from './citation-trace-graph';
import { SignalEmpty, SignalError, SignalSkeleton, SourceKindChip } from './primitives';

export { buildTraceGraph, type TraceEdgeTone, type TraceGraph };

export interface CitationTraceProps {
  observations: readonly VisibilityObservationRecord[];
  loading?: boolean;
  onSelectObservation: (id: string) => void;
}
type HoverNode = { kind: 'prompt' | 'engine' | 'domain'; id: string } | null;

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const EASE = '120ms var(--gm-ease-out)';
const LEGEND: Array<[string, string, boolean]> = [
  [GM.sig.cited, '回答提及我方', false],
  [GM.sig.competitor, '竞品抢占', false],
  [GM.sig.absent, '未出现', true],
];

function getActive(hover: HoverNode, g: TraceGraph | null) {
  if (!hover || !g) return null;
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>([`${hover.kind}:${hover.id}`]);
  const obsIds = new Set<string>();
  const link = (k: string, id: string, eid: string) => {
    edgeIds.add(eid);
    nodeIds.add(`${k}:${id}`);
  };
  if (hover.kind === 'prompt') {
    for (const e of g.edgesPE) {
      if (e.promptId === hover.id) {
        link('engine', e.engine, e.id);
        e.observationIds.forEach((id) => obsIds.add(id));
      }
    }
    for (const e of g.edgesED) {
      if (e.observationIds.some((id) => obsIds.has(id))) link('domain', e.domainId, e.id);
    }
  } else if (hover.kind === 'engine') {
    for (const e of g.edgesPE) if (e.engine === hover.id) link('prompt', e.promptId, e.id);
    for (const e of g.edgesED) if (e.engine === hover.id) link('domain', e.domainId, e.id);
  } else {
    for (const e of g.edgesED) {
      if (e.domainId === hover.id) {
        link('engine', e.engine, e.id);
        e.observationIds.forEach((id) => obsIds.add(id));
      }
    }
    for (const e of g.edgesPE) {
      if (e.observationIds.some((id) => obsIds.has(id))) link('prompt', e.promptId, e.id);
    }
  }
  return { edgeIds, nodeIds };
}

export function CitationTrace({
  observations,
  loading = false,
  onSelectObservation,
}: CitationTraceProps): JSX.Element {
  const [hoverNode, setHoverNode] = useState<HoverNode>(null);
  const { graph, error } = useMemo(() => {
    try {
      return { graph: buildTraceGraph(observations), error: null };
    } catch {
      return { graph: null, error: '链路图生成失败' };
    }
  }, [observations]);
  const active = useMemo(() => getActive(hoverNode, graph), [hoverNode, graph]);

  if (loading) return <SignalSkeleton variant="block" height={320} />;
  if (error || !graph) return <SignalError message={error ?? '链路图生成失败'} />;
  if (graph.prompts.length === 0) {
    return (
      <SignalEmpty title="暂无可绘制的引用链路" description="至少需要一条采集成功的 AI 回答" />
    );
  }

  const H = Math.max(
    240,
    Math.max(graph.prompts.length, graph.engines.length, graph.domains.length) * 32 + 48,
  );
  const yAt = (i: number, n: number) => 48 + i * 32 + (H - 48 - n * 32) / 2;
  const pY = new Map(graph.prompts.map((p, i) => [p.id, yAt(i, graph.prompts.length)]));
  const eY = new Map(graph.engines.map((e, i) => [e.id, yAt(i, graph.engines.length)]));
  const dY = new Map(graph.domains.map((d, i) => [d.id, yAt(i, graph.domains.length)]));
  const edges = [
    ...graph.edgesPE.map((e) => ({
      id: e.id,
      x1: 316,
      y1: pY.get(e.promptId)!,
      x2: 412,
      y2: eY.get(e.engine)!,
      color: GM.sig[e.tone],
      count: e.count,
      absent: e.tone === 'absent',
    })),
    ...graph.edgesED.map((e) => ({
      id: e.id,
      x1: 548,
      y1: eY.get(e.engine)!,
      x2: 644,
      y2: dY.get(e.domainId)!,
      color: GM.sourceKind[e.sourceKind],
      count: e.count,
      absent: false,
    })),
  ];

  const edgeStyle = (idx: number, conn: boolean, absent: boolean): CSSProperties => {
    const tr = `stroke-opacity ${EASE}, opacity ${EASE}`;
    if (active) {
      return conn
        ? {
            transition: tr,
            strokeOpacity: 1,
            strokeDasharray: '4 4',
            animation: 'gm-flow 900ms linear infinite',
          }
        : { transition: tr, strokeOpacity: 0.08, strokeDasharray: absent ? '3 3' : undefined };
    }
    if (absent) return { transition: tr, strokeOpacity: 0.55, strokeDasharray: '3 3' };
    return {
      transition: tr,
      strokeOpacity: 0.55,
      strokeDasharray: '1',
      strokeDashoffset: 1,
      animation: 'gm-draw 600ms var(--gm-ease-out) forwards',
      animationDelay: `${Math.min(idx, 30) * 20}ms`,
    };
  };

  const np = (
    kind: 'prompt' | 'engine' | 'domain',
    id: string,
    label: string,
    onClick?: () => void,
  ) => ({
    tabIndex: 0,
    role: 'button' as const,
    'aria-label': `链路节点-${label}`,
    style: {
      cursor: onClick ? 'pointer' : 'default',
      opacity: active ? (active.nodeIds.has(`${kind}:${id}`) ? 1 : 0.3) : 1,
      transition: `opacity ${EASE}`,
    },
    onMouseEnter: () => setHoverNode({ kind, id }),
    onMouseLeave: () => setHoverNode(null),
    onFocus: () => setHoverNode({ kind, id }),
    onBlur: () => setHoverNode(null),
    onClick,
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (onClick && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onClick();
      }
    },
  });

  return (
    <div className="gm-panel">
      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 960 ${H}`}
          width="100%"
          style={{ minWidth: 720, display: 'block' }}
          preserveAspectRatio="xMinYMin meet"
        >
          {(
            [
              [24, '监测问题'],
              [412, 'AI 引擎'],
              [648, '信源域名'],
            ] as const
          ).map(([x, t]) => (
            <text key={t} x={x} y={16} fontSize={11} fill={GM.fg.f3} letterSpacing="0.06em">
              {t}
            </text>
          ))}
          {edges.map((e, i) => {
            const mx = (e.x1 + e.x2) / 2;
            const d = `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
            return (
              <path
                key={e.id}
                d={d}
                fill="none"
                pathLength={1}
                stroke={e.color}
                strokeWidth={Math.min(1 + e.count * 0.5, 3.5)}
                style={edgeStyle(i, Boolean(active?.edgeIds.has(e.id)), e.absent)}
              />
            );
          })}
          {graph.prompts.map((p) => {
            const y = pY.get(p.id)!;
            const click = p.isMore ? undefined : () => onSelectObservation(p.firstObservationId);
            return (
              <g key={p.id} {...np('prompt', p.id, p.label, click)}>
                <title>{p.label}</title>
                <text x={300} y={y + 4} textAnchor="end" fontSize={12} fill={GM.fg.f2}>
                  {p.isMore ? p.label : trunc(p.label, 22)}
                </text>
                <circle cx={312} cy={y} r={4} fill={GM.bg.elevated} stroke={GM.line.strong} />
              </g>
            );
          })}
          {graph.engines.map((eng) => {
            const y = eY.get(eng.id)!;
            return (
              <g key={eng.id} {...np('engine', eng.id, eng.label)}>
                <title>{eng.label}</title>
                <rect
                  x={412}
                  y={y - 10}
                  width={136}
                  height={20}
                  rx={4}
                  fill={GM.bg.elevated}
                  stroke={GM.line.l2}
                />
                <text x={480} y={y + 4} textAnchor="middle" fontSize={11} fill={GM.fg.f2}>
                  {eng.label}
                </text>
              </g>
            );
          })}
          {graph.domains.length === 0 ? (
            <text x={648} y={Math.round(H / 2)} fontSize={12} fill={GM.fg.f3}>
              本批回答未附带信源链接
            </text>
          ) : (
            graph.domains.map((d) => {
              const y = dY.get(d.id)!;
              return (
                <g key={d.id} {...np('domain', d.id, d.label)}>
                  <title>{d.label}</title>
                  <circle cx={648} cy={y} r={4} fill={GM.sourceKind[d.sourceKind]} />
                  <text x={660} y={y + 4} className="gm-mono" fontSize={11} fill={GM.fg.f2}>
                    {d.isMore ? d.label : truncateMiddle(d.label, 32)}
                  </text>
                  <text
                    x={940}
                    y={y + 4}
                    textAnchor="end"
                    className="gm-num"
                    fontSize={11}
                    fill={GM.fg.f3}
                  >
                    {d.count}
                  </text>
                </g>
              );
            })
          )}
        </svg>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 16,
          fontSize: 11,
          color: GM.fg.f2,
          marginTop: 12,
        }}
      >
        {LEGEND.map(([c, label, dashed]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={
                dashed
                  ? { width: 18, borderTop: `2px dashed ${c}` }
                  : { width: 18, height: 2, background: c }
              }
            />
            {label}
          </span>
        ))}
        {CITATION_SOURCE_KINDS.map((k) => (
          <SourceKindChip key={k} kind={k} />
        ))}
      </div>
    </div>
  );
}
