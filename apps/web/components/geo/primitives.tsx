'use client';

import * as S from '@geomix/shared';
import { Button, Tooltip } from 'antd';
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { GM, truncateMiddle } from '../../lib/design-tokens';

export type SignalTone =
  'cited' | 'mention' | 'competitor' | 'absent' | 'info' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<SignalTone, string> = {
  cited: GM.sig.cited,
  mention: GM.sig.mention,
  competitor: GM.sig.competitor,
  absent: GM.sig.absent,
  info: GM.status.info,
  warning: GM.status.warning,
  danger: GM.status.danger,
  neutral: GM.fg.f2,
};

const ENGINE_MAP = new Map<string, (typeof S.VISIBILITY_ENGINES)[number]>(
  S.VISIBILITY_ENGINES.map((item) => [item.key, item]),
);

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace('#', '');
  if (c.length !== 6) return `rgba(154,166,178,${alpha})`;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

function ColorPill({
  color,
  children,
  title,
}: {
  color: string;
  children: ReactNode;
  title?: string;
}) {
  const style = {
    color,
    background: hexToRgba(color, 0.14),
    border: `1px solid ${hexToRgba(color, 0.32)}`,
  };
  return (
    <span className="gm-pill" title={title} style={style}>
      <span className="gm-pill-dot" style={{ background: color }} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function SignalKpiCard(p: {
  label: string;
  value: string;
  tone?: SignalTone;
  numerator?: number;
  denominator?: number;
  caption?: string;
  testId?: string;
  onClick?: () => void;
  loading?: boolean;
}): JSX.Element {
  if (p.loading) return <SignalSkeleton variant="kpi" />;
  const toneColor = TONE_COLOR[p.tone ?? 'cited'];
  const hasNums = typeof p.numerator === 'number' && typeof p.denominator === 'number';
  const pct =
    p.value !== '—' &&
    hasNums &&
    Number.isFinite(p.numerator) &&
    Number.isFinite(p.denominator) &&
    p.denominator! > 0
      ? Math.max(0, Math.min(100, (p.numerator! / p.denominator!) * 100))
      : 0;
  const valCls = p.value.length > 8 ? 'gm-kpi-value gm-kpi-value-sm gm-num' : 'gm-kpi-value gm-num';
  const cardCls = p.onClick ? 'gm-kpi gm-kpi-clickable' : 'gm-kpi';
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (p.onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      p.onClick();
    }
  };
  return (
    <div
      className={cardCls}
      data-testid={p.testId}
      role={p.onClick ? 'button' : undefined}
      tabIndex={p.onClick ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={p.onClick ? onKeyDown : undefined}
      style={{ '--gm-kpi-ratio': `${pct}%`, '--gm-kpi-bar': toneColor } as CSSProperties}
    >
      <div className="gm-kpi-label gm-clamp-1">{p.label}</div>
      <div className={valCls}>{p.value}</div>
      {hasNums || p.caption ? (
        <div className="gm-kpi-caption gm-clamp-1">
          {hasNums ? (
            <>
              <span className="gm-num">{p.numerator}</span> /{' '}
              <span className="gm-num">{p.denominator}</span>
              {p.caption ? ` · ${p.caption}` : null}
            </>
          ) : (
            p.caption
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SignalPill(p: {
  tone: SignalTone;
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <ColorPill color={TONE_COLOR[p.tone]} title={p.title}>
      {p.children}
    </ColorPill>
  );
}

export function SourceKindChip(p: { kind: S.CitationSourceKind }): JSX.Element {
  return <ColorPill color={GM.sourceKind[p.kind]}>{S.CITATION_SOURCE_LABELS[p.kind]}</ColorPill>;
}

export function SentimentDot(p: { sentiment: S.VisibilitySentiment | null }): JSX.Element {
  if (p.sentiment === null) return <span className="gm-sentiment-empty">—</span>;
  const bg = GM.sentiment[p.sentiment];
  return (
    <span className="gm-sentiment">
      <span className="gm-sentiment-dot" style={{ background: bg }} aria-hidden="true" />
      <span>{S.VISIBILITY_SENTIMENT_LABELS[p.sentiment]}</span>
    </span>
  );
}

export function EngineChip(p: { engine: string }): JSX.Element {
  const entry = ENGINE_MAP.get(p.engine);
  const label = entry ? S.VISIBILITY_ENGINE_LABELS[entry.key] : p.engine;
  const dotCls = `gm-engine-dot ${entry?.domestic ? 'gm-engine-dot-domestic' : 'gm-engine-dot-overseas'}`;
  return (
    <span className="gm-engine-chip">
      <span className={dotCls} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function EngineChipList(p: { engines: string[]; max?: number }): JSX.Element {
  const max = p.max ?? 3;
  const hidden = p.engines.slice(max);
  const tip = hidden
    .map((e) => S.VISIBILITY_ENGINE_LABELS[e as S.VisibilityEngineKey] ?? e)
    .join('、');
  return (
    <span className="gm-engine-list">
      {p.engines.slice(0, max).map((eng, idx) => (
        <EngineChip key={`${eng}-${idx}`} engine={eng} />
      ))}
      {hidden.length > 0 ? (
        <Tooltip title={tip}>
          <span className="gm-engine-more gm-num">+{hidden.length}</span>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function StatusPill(p: {
  status: S.TaskStatusName | S.ItemStatusName;
  kind: 'task' | 'item';
}): JSX.Element {
  const isTask = p.kind === 'task';
  const label =
    (isTask
      ? S.TASK_STATUS_LABELS[p.status as S.TaskStatusName]
      : S.ITEM_STATUS_LABELS[p.status as S.ItemStatusName]) ?? p.status;
  const color =
    (isTask
      ? GM.taskStatus[p.status as S.TaskStatusName]
      : GM.itemStatus[p.status as S.ItemStatusName]) ?? GM.fg.f3;
  return <ColorPill color={color}>{label}</ColorPill>;
}

export function SignalSkeleton(p: {
  variant: 'kpi' | 'row' | 'block';
  rows?: number;
  height?: number;
}): JSX.Element {
  if (p.variant === 'kpi') {
    return (
      <div className="gm-kpi gm-skeleton-kpi" aria-busy="true">
        {[64, 96, 140].map((w, i) => (
          <div key={i} className="gm-skeleton" style={{ width: w, height: i === 1 ? 24 : 10 }} />
        ))}
      </div>
    );
  }
  if (p.variant === 'row') {
    return (
      <div aria-busy="true">
        {Array.from({ length: p.rows ?? 5 }, (_, idx) => (
          <div key={idx} className="gm-skeleton-row">
            <div className="gm-skeleton" style={{ width: 16, height: 16, flex: 'none' }} />
            <div className="gm-skeleton" style={{ width: '60%', height: 10 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      className="gm-skeleton"
      aria-busy="true"
      style={{ width: '100%', height: p.height ?? 240 }}
    />
  );
}

const EMPTY_RINGS = [
  [18, 'var(--gm-line-2)'],
  [12, 'var(--gm-line-2)'],
  [6, 'var(--gm-phosphor-a40)'],
] as const;

export function SignalEmpty(p: {
  title: string;
  description?: string;
  actionText?: string;
  onAction?: () => void;
}): JSX.Element {
  return (
    <div className="gm-empty">
      <svg className="gm-empty-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        {EMPTY_RINGS.map(([r, stroke]) => (
          <circle key={r} cx="20" cy="20" r={r} fill="none" stroke={stroke} strokeWidth="1.5" />
        ))}
      </svg>
      <div className="gm-empty-title">{p.title}</div>
      {p.description ? <div className="gm-empty-desc">{p.description}</div> : null}
      {p.actionText ? (
        <Button type="primary" size="small" onClick={p.onAction}>
          {p.actionText}
        </Button>
      ) : null}
    </div>
  );
}

export function SignalError(p: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="gm-signal-error" role="alert">
      <span>{p.message}</span>
      {p.onRetry ? (
        <Button size="small" onClick={p.onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function TruncText(p: {
  text: string;
  lines?: 1 | 2 | 3;
  mono?: boolean;
  middle?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowed, setOverflowed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    setOverflowed(Boolean(el && el.scrollHeight > el.clientHeight));
  }, [p.text, p.lines, p.middle]);

  const cls = [`gm-clamp-${p.lines ?? 1}`, p.mono ? 'gm-mono' : ''].filter(Boolean).join(' ');
  const content = (
    <span ref={ref} className={cls}>
      {p.middle ? truncateMiddle(p.text) : p.text}
    </span>
  );
  if (overflowed || p.text.length > 56) {
    return (
      <Tooltip
        title={<span style={{ wordBreak: 'break-all' }}>{p.text}</span>}
        styles={{ root: { maxWidth: 480 } }}
      >
        {content}
      </Tooltip>
    );
  }
  return content;
}
