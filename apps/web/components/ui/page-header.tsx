'use client';

import type { ReactNode } from 'react';
import { shouldCollapseToExplain } from '../../lib/copy-length';
import { Explain } from './explain';

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  tags?: ReactNode;
  action?: ReactNode;
  extra?: ReactNode;
  className?: string;
  'data-testid'?: string;
};

export function PageHeader({
  title,
  description,
  meta,
  tags,
  action,
  extra,
  className,
  'data-testid': testId,
}: PageHeaderProps) {
  const classes = className ? `gm-ui-page-header ${className}` : 'gm-ui-page-header';
  const hasActions = Boolean(extra || action);
  const collapseDesc = typeof description === 'string' && shouldCollapseToExplain(description);

  return (
    <header className={classes} data-testid={testId}>
      <div className="gm-ui-page-header-main">
        <div className="gm-ui-page-header-title-row">
          <h1 className="gm-ui-page-header-title">{title}</h1>
          {collapseDesc ? <Explain text={description} /> : null}
          {tags ? <div className="gm-ui-page-header-tags">{tags}</div> : null}
        </div>
        {!collapseDesc && description ? (
          <p className="gm-ui-page-header-desc gm-clamp-1">{description}</p>
        ) : null}
        {meta ? <div className="gm-ui-page-header-meta">{meta}</div> : null}
      </div>
      {hasActions ? (
        <div className="gm-ui-page-header-actions">
          {extra ? <div className="gm-ui-page-header-extra">{extra}</div> : null}
          {action ? <div className="gm-ui-page-header-action">{action}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
