'use client';

import type { ReactNode } from 'react';

export type EmptyStateSize = 'compact' | 'full';

export type EmptyStateProps = {
  size?: EmptyStateSize;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  'data-testid'?: string;
};

export function EmptyState({
  size = 'full',
  icon,
  title,
  description,
  action,
  className,
  'data-testid': testId,
}: EmptyStateProps) {
  const classes = ['gm-ui-empty', `gm-ui-empty--${size}`, className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-size={size} data-testid={testId}>
      <div className="gm-ui-empty-content">
        {icon ? (
          <span className="gm-ui-empty-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="gm-ui-empty-copy">
          <p className="gm-ui-empty-title">{title}</p>
          {description ? <p className="gm-ui-empty-desc">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="gm-ui-empty-action">{action}</div> : null}
    </div>
  );
}
