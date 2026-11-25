'use client';

import {
  cloneElement,
  Fragment,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from 'react';

export type FormFieldProps = {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  help?: ReactNode;
  error?: ReactNode;
  extra?: ReactNode;
  className?: string;
  'data-testid'?: string;
  children: ReactNode;
};

type AriaControlProps = {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
};

export function FormField({
  label,
  htmlFor,
  required = false,
  help,
  error,
  extra,
  className,
  'data-testid': testId,
  children,
}: FormFieldProps) {
  const baseId = useId();
  const errorId = error ? `${baseId}-error` : undefined;
  const helpId = help ? `${baseId}-help` : undefined;
  const generatedDescribedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;

  let renderedControl = children;
  if (isValidElement(children) && children.type !== Fragment && (generatedDescribedBy || error)) {
    const element = children as ReactElement<AriaControlProps>;
    const existingDescribedBy =
      typeof element.props['aria-describedby'] === 'string'
        ? element.props['aria-describedby'].trim()
        : '';
    const mergedDescribedBy = [existingDescribedBy, generatedDescribedBy].filter(Boolean).join(' ');

    const nextProps: AriaControlProps = {};
    if (mergedDescribedBy) {
      nextProps['aria-describedby'] = mergedDescribedBy;
    }
    if (error) {
      nextProps['aria-invalid'] = true;
    } else if (element.props['aria-invalid'] !== undefined) {
      nextProps['aria-invalid'] = element.props['aria-invalid'];
    }
    renderedControl = cloneElement(element, nextProps);
  }

  const classes = className ? `gm-ui-form-field ${className}` : 'gm-ui-form-field';

  return (
    <div className={classes} data-testid={testId}>
      <div className="gm-ui-form-field-header">
        <label htmlFor={htmlFor} className="gm-ui-form-field-label">
          <span>{label}</span>
          {required ? (
            <>
              <span className="gm-ui-form-field-required" aria-hidden="true">
                *
              </span>
              <span className="gm-sr-only">（必填）</span>
            </>
          ) : null}
        </label>
        {extra ? <div className="gm-ui-form-field-extra">{extra}</div> : null}
      </div>
      <div className="gm-ui-form-field-control">{renderedControl}</div>
      {error ? (
        <p id={errorId} className="gm-ui-form-field-error" role="alert">
          {error}
        </p>
      ) : null}
      {help ? (
        <p id={helpId} className="gm-ui-form-field-help">
          {help}
        </p>
      ) : null}
    </div>
  );
}
