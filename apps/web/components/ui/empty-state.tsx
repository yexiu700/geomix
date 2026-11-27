'use client';

import type { ReactNode } from 'react';
import { shouldCollapseToExplain } from '../../lib/copy-length';
import { Explain } from './explain';

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
  const collapseDesc = typeof description === 'string' && shouldCollapseToExplain(description);

  return (
    <div className={classes} data-size={size} data-testid={testId}>
      <div className="gm-ui-empty-content">
        {icon ? (
          <span className="gm-ui-empty-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="gm-ui-empty-copy">
          <div className="gm-ui-empty-title-row">
            <p className="gm-ui-empty-title">{title}</p>
            {collapseDesc ? <Explain text={description} /> : null}
          </div>
          {!collapseDesc && description ? <p className="gm-ui-empty-desc">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="gm-ui-empty-action">{action}</div> : null}
    </div>
  );
}
