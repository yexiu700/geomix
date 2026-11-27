'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { shouldCollapseToExplain } from '../../lib/copy-length';
import { Explain } from './explain';
import type { StatusTone } from './status-badge';

export type KpiStripTone = StatusTone | 'accent';

export type KpiStripItem = {
  key: string;
  label: string;
  value: string | number | null | undefined;
  caption?: ReactNode;
  subtext?: ReactNode;
  progressPct?: number | null;
  tone?: KpiStripTone;
  testId?: string;
  onClick?: () => void;
};

export type KpiStripProps = {
  items: readonly KpiStripItem[];
  loading?: boolean;
  skeletonCount?: number;
  'aria-label'?: string;
  className?: string;
  'data-testid'?: string;
};

const NON_FINITE_STRINGS = new Set(['nan', 'infinity', '-infinity', '+infinity']);

export function formatKpiDisplayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '—';
  }
  const trimmed = value.trim();
  if (!trimmed || NON_FINITE_STRINGS.has(trimmed.toLowerCase())) {
    return '—';
  }
  return trimmed;
}

export function normalizeKpiProgressPct(progressPct: number | null | undefined): number | null {
  if (progressPct === undefined) {
    return null;
  }
  if (progressPct === null || !Number.isFinite(progressPct) || progressPct <= 0) {
    return 0;
  }
  if (progressPct >= 100) {
    return 100;
  }
  return progressPct;
}

function handleInteractiveKeyDown(event: KeyboardEvent<HTMLDivElement>, onClick: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onClick();
  }
}

export function KpiStrip({
  items,
  loading = false,
  skeletonCount,
  'aria-label': ariaLabel,
  className,
  'data-testid': testId,
}: KpiStripProps) {
  const classes = className ? `gm-ui-kpi-strip ${className}` : 'gm-ui-kpi-strip';

  if (loading) {
    const count = skeletonCount ?? (items.length > 0 ? items.length : 4);
    return (
      <div
        className={classes}
        role="region"
        aria-label={ariaLabel}
        aria-busy="true"
        data-testid={testId}
      >
        {Array.from({ length: count }, (_, idx) => (
          <div key={`skeleton-${idx}`} className="gm-ui-kpi-item gm-ui-kpi-item--loading">
            <div className="gm-skeleton gm-ui-kpi-skeleton-label" />
            <div className="gm-skeleton gm-ui-kpi-skeleton-value" />
            <div className="gm-skeleton gm-ui-kpi-skeleton-caption" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={classes} role="region" aria-label={ariaLabel} data-testid={testId}>
      {items.map((item) => {
        const displayValue = formatKpiDisplayValue(item.value);
        const pct = normalizeKpiProgressPct(item.progressPct);
        const caption = item.caption ?? item.subtext;
        const collapseCaption = typeof caption === 'string' && shouldCollapseToExplain(caption);
        const interactive = typeof item.onClick === 'function';
        const itemClasses = interactive
          ? 'gm-ui-kpi-item gm-ui-kpi-item--clickable'
          : 'gm-ui-kpi-item';
        const valueClasses = item.tone
          ? `gm-ui-kpi-value gm-num gm-ui-kpi-value--${item.tone}`
          : 'gm-ui-kpi-value gm-num';
        const fillClasses = item.tone
          ? `gm-ui-kpi-fill gm-ui-kpi-fill--${item.tone}`
          : 'gm-ui-kpi-fill';

        return (
          <div
            key={item.key}
            className={itemClasses}
            data-testid={item.testId}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={interactive ? item.onClick : undefined}
            onKeyDown={
              interactive && item.onClick
                ? (event) => handleInteractiveKeyDown(event, item.onClick!)
                : undefined
            }
          >
            <div className="gm-ui-kpi-label-row">
              <span className="gm-ui-kpi-label">{item.label}</span>
              {collapseCaption ? <Explain text={caption} /> : null}
            </div>
            <span className={valueClasses}>{displayValue}</span>
            {pct !== null ? (
              <div
                className="gm-ui-kpi-track"
                role="progressbar"
                aria-label={item.label}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                data-empty={pct === 0 ? 'true' : 'false'}
              >
                <svg
                  className="gm-ui-kpi-track-svg"
                  viewBox="0 0 100 3"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {pct > 0 ? (
                    <rect className={fillClasses} x="0" y="0" width={pct} height="3" rx="1.5" />
                  ) : null}
                </svg>
              </div>
            ) : null}
            {!collapseCaption && caption ? (
              <div className="gm-ui-kpi-caption">{caption}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
