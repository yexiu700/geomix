'use client';

import { Dropdown, type MenuProps } from 'antd';
import { useCallback, useMemo, type MouseEvent, type ReactNode } from 'react';
import { useUxFeedback } from '../crud/ux-feedback';

export type RowActionConfirmConfig = {
  title: ReactNode;
  content?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
};

export type RowActionItem = {
  key: string;
  label: string;
  onClick: () => void | Promise<void>;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  testId?: string;
  ariaLabel?: string;
  confirm?: RowActionConfirmConfig;
};

export type RowActionsProps = {
  primary?: RowActionItem;
  secondary?: readonly RowActionItem[];
  menuItems?: readonly RowActionItem[];
  moreAriaLabel?: string;
  moreTestId?: string;
  revealOnHover?: boolean;
  className?: string;
  'data-testid'?: string;
};

export function RowActions({
  primary,
  secondary,
  menuItems,
  moreAriaLabel = '更多操作',
  moreTestId,
  revealOnHover = true,
  className,
  'data-testid': testId,
}: RowActionsProps) {
  const feedback = useUxFeedback();

  const runAction = useCallback(
    (item: RowActionItem) => {
      if (item.disabled || item.loading) {
        return;
      }
      if (item.confirm) {
        const isDanger = item.confirm.danger ?? item.danger;
        feedback.confirm({
          title: item.confirm.title,
          content: item.confirm.content,
          okText: item.confirm.okText,
          cancelText: item.confirm.cancelText,
          okButtonProps: isDanger ? { danger: true } : undefined,
          onOk: () => item.onClick(),
        });
        return;
      }
      void item.onClick();
    },
    [feedback],
  );

  const handleButtonClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, item: RowActionItem) => {
      event.stopPropagation();
      runAction(item);
    },
    [runAction],
  );

  const menuItemMap = useMemo(() => {
    const map = new Map<string, RowActionItem>();
    for (const item of menuItems ?? []) {
      map.set(item.key, item);
    }
    return map;
  }, [menuItems]);

  const dropdownMenu: MenuProps | undefined = useMemo(() => {
    if (!menuItems || menuItems.length === 0) {
      return undefined;
    }
    return {
      items: menuItems.map((item) => ({
        key: item.key,
        label: item.testId ? <span data-testid={item.testId}>{item.label}</span> : item.label,
        icon: item.icon,
        danger: item.danger,
        disabled: item.disabled || item.loading,
      })),
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        const item = menuItemMap.get(String(key));
        if (item) {
          runAction(item);
        }
      },
    };
  }, [menuItems, menuItemMap, runAction]);

  const classes = className ? `gm-ui-row-actions ${className}` : 'gm-ui-row-actions';
  const secondaryClasses = revealOnHover
    ? 'gm-ui-row-actions-secondary gm-ui-row-actions-secondary--reveal'
    : 'gm-ui-row-actions-secondary';

  const hasSecondary = Boolean(secondary && secondary.length > 0);

  return (
    <div className={classes} data-testid={testId}>
      {hasSecondary ? (
        <div className={secondaryClasses}>
          {secondary!.map((item) => {
            const btnClasses = item.danger
              ? 'gm-ui-row-action-btn gm-ui-row-action-btn--danger'
              : 'gm-ui-row-action-btn';
            return (
              <button
                key={item.key}
                type="button"
                className={btnClasses}
                disabled={item.disabled || item.loading}
                aria-label={item.ariaLabel}
                aria-busy={item.loading ? 'true' : undefined}
                data-testid={item.testId}
                onClick={(event) => handleButtonClick(event, item)}
              >
                {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {primary ? (
        <button
          type="button"
          className={
            primary.danger
              ? 'gm-ui-row-action-btn gm-ui-row-action-btn--primary gm-ui-row-action-btn--danger'
              : 'gm-ui-row-action-btn gm-ui-row-action-btn--primary'
          }
          disabled={primary.disabled || primary.loading}
          aria-label={primary.ariaLabel}
          aria-busy={primary.loading ? 'true' : undefined}
          data-testid={primary.testId}
          onClick={(event) => handleButtonClick(event, primary)}
        >
          {primary.icon ? <span aria-hidden="true">{primary.icon}</span> : null}
          <span>{primary.label}</span>
        </button>
      ) : null}

      {dropdownMenu ? (
        <Dropdown trigger={['click']} placement="bottomRight" menu={dropdownMenu}>
          <button
            type="button"
            className="gm-ui-row-action-more"
            aria-label={moreAriaLabel}
            title={moreAriaLabel}
            data-testid={moreTestId}
            onClick={(event) => event.stopPropagation()}
          >
            ⋯
          </button>
        </Dropdown>
      ) : null}
    </div>
  );
}
