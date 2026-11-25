'use client';

import type { ReactNode } from 'react';

export const STATUS_TONES = ['success', 'active', 'warning', 'danger', 'neutral'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];
export type StatusBadgeSize = 'sm' | 'md';

export const STATUS_TONE_MAP: Readonly<Record<string, StatusTone>> = {
  // Success
  COMPLETED: 'success',
  SUCCESS: 'success',
  PUBLISHED: 'success',
  OK: 'success',
  ACTIVE: 'success',
  DONE: 'success',
  ONLINE: 'success',
  TRIAL_PROVISIONED: 'success',
  CITED: 'success',
  POSITIVE: 'success',
  ENABLED: 'success',
  VERIFIED: 'success',
  PASSED: 'success',

  // Active / In-progress / Actionable
  RUNNING: 'active',
  PUBLISHING: 'active',
  INDEXING: 'active',
  WRITING: 'active',
  READY: 'active',
  READY_TO_PUBLISH: 'active',
  DRAFT_PUSHED: 'active',
  OPEN: 'active',
  NEW: 'active',
  CONTACTED: 'active',
  INFO: 'active',

  // Warning
  PAUSED: 'warning',
  PARTIAL: 'warning',
  WARNING: 'warning',
  REPLACED: 'warning',
  MIXED: 'warning',
  SKIPPED_INSUFFICIENT_POINTS: 'warning',
  SKIPPED_NO_ENGINE: 'warning',
  SKIPPED_BUDGET_CAP: 'warning',
  EXPIRING: 'warning',
  READ_ONLY: 'warning',
  LOW_POINTS: 'warning',

  // Danger
  FAILED: 'danger',
  BLOCKED: 'danger',
  INVALID: 'danger',
  OFFLINE: 'danger',
  NEGATIVE: 'danger',
  EXPIRED: 'danger',
  REVOKED: 'danger',
  ERROR: 'danger',

  // Neutral
  QUEUED: 'neutral',
  PENDING: 'neutral',
  DRAFT: 'neutral',
  DRAFT_VARIANT: 'neutral',
  CANCELLED: 'neutral',
  SKIPPED: 'neutral',
  ARCHIVED: 'neutral',
  DISABLED: 'neutral',
  DISMISSED: 'neutral',
  NONE: 'neutral',
  NEUTRAL: 'neutral',
  ABSENT: 'neutral',
  MENTION: 'neutral',
};

export function resolveStatusTone(status?: string | null): StatusTone {
  if (!status) {
    return 'neutral';
  }
  const key = status.trim().toUpperCase();
  if (!key) {
    return 'neutral';
  }
  return STATUS_TONE_MAP[key] ?? 'neutral';
}

export type StatusBadgeProps = {
  status?: string | null;
  tone?: StatusTone;
  label?: ReactNode;
  children?: ReactNode;
  size?: StatusBadgeSize;
  title?: string;
  className?: string;
  'data-testid'?: string;
};

export function StatusBadge({
  status,
  tone,
  label,
  children,
  size = 'sm',
  title,
  className,
  'data-testid': testId,
}: StatusBadgeProps) {
  const normalizedStatus = typeof status === 'string' && status.trim() ? status.trim() : undefined;
  const normalizedLabel = typeof label === 'string' ? (label.trim() ? label : undefined) : label;
  const resolvedTone = tone ?? resolveStatusTone(normalizedStatus);
  const content = children ?? normalizedLabel ?? normalizedStatus ?? '—';
  const classes = [
    'gm-ui-status-badge',
    `gm-ui-status-badge--${resolvedTone}`,
    `gm-ui-status-badge--${size}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      data-tone={resolvedTone}
      data-status={normalizedStatus}
      title={title}
      data-testid={testId}
    >
      <span className="gm-ui-status-badge-dot" aria-hidden="true" />
      <span className="gm-ui-status-badge-label">{content}</span>
    </span>
  );
}
