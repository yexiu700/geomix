'use client';

import { useId, type ReactNode } from 'react';

export type SectionVariant = 'plain' | 'card';

export type SectionProps = {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  variant?: SectionVariant;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  'data-testid'?: string;
  children: ReactNode;
};

export function Section({
  id,
  title,
  description,
  actions,
  variant = 'plain',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className,
  'data-testid': testId,
  children,
}: SectionProps) {
  const autoHeadingId = useId();
  const hasHeader = Boolean(title || description || actions);
  const headingId = title ? autoHeadingId : undefined;
  const resolvedLabelledBy = ariaLabel ? undefined : (ariaLabelledBy ?? headingId);
  const classes = ['gm-ui-section', `gm-ui-section--${variant}`, className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <section
      id={id}
      className={classes}
      aria-label={ariaLabel}
      aria-labelledby={resolvedLabelledBy}
      data-testid={testId}
    >
      {hasHeader ? (
        <div className="gm-ui-section-header">
          <div className="gm-ui-section-heading">
            {title ? (
              <h2 id={headingId} className="gm-ui-section-title">
                {title}
              </h2>
            ) : null}
            {description ? <p className="gm-ui-section-desc">{description}</p> : null}
          </div>
          {actions ? <div className="gm-ui-section-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="gm-ui-section-body">{children}</div>
    </section>
  );
}
