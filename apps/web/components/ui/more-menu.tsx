'use client';

import { Dropdown, type MenuProps } from 'antd';
import { useCallback, useMemo } from 'react';
import { useUxFeedback } from '../crud/ux-feedback';
import type { RowActionItem } from './row-actions';

export type MoreMenuProps = {
  items: readonly RowActionItem[];
  ariaLabel?: string;
  placement?: 'bottomRight' | 'bottomLeft' | 'topRight' | 'topLeft';
  className?: string;
  'data-testid'?: string;
};

/**
 * ⋯ 溢出菜单原语：用于页面头部、分节头部与工具栏收纳低频/高级操作，保持主界面最多 1 个实心主按钮。
 */
export function MoreMenu({
  items,
  ariaLabel = '更多',
  placement = 'bottomRight',
  className,
  'data-testid': testId,
}: MoreMenuProps) {
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

  const itemMap = useMemo(() => {
    const map = new Map<string, RowActionItem>();
    for (const item of items) {
      map.set(item.key, item);
    }
    return map;
  }, [items]);

  const menu: MenuProps = useMemo(
    () => ({
      items: items.map((item) => ({
        key: item.key,
        label: item.testId ? <span data-testid={item.testId}>{item.label}</span> : item.label,
        icon: item.icon,
        danger: item.danger,
        disabled: item.disabled || item.loading,
      })),
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        const target = itemMap.get(String(key));
        if (target) {
          runAction(target);
        }
      },
    }),
    [items, itemMap, runAction],
  );

  if (items.length === 0) {
    return null;
  }

  const classes = ['gm-ui-row-action-more', 'gm-more-menu-trigger', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <Dropdown trigger={['click']} placement={placement} menu={menu}>
      <button
        type="button"
        className={classes}
        aria-label={ariaLabel}
        title={ariaLabel}
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        ⋯
      </button>
    </Dropdown>
  );
}
