'use client';

import { Tooltip } from 'antd';
import type { ReactNode } from 'react';

export type CostChipProps = {
  points: number;
  freeLabel?: string;
  tooltip?: ReactNode;
  className?: string;
  'data-testid'?: string;
};

/**
 * 弱化点数角标：将「（10 点）」「（免费）」从按钮/标题文案剥离，保证控件文本锁定 2–4 字。
 */
export function CostChip({
  points,
  freeLabel = '免费',
  tooltip,
  className,
  'data-testid': testId,
}: CostChipProps) {
  const isFree = points <= 0;
  const label = isFree ? freeLabel : `${points}点`;
  const classes = ['gm-cost-chip', 'gm-num', isFree ? 'gm-cost-chip--free' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  const node = (
    <span className={classes} data-testid={testId}>
      {label}
    </span>
  );

  if (tooltip) {
    return (
      <Tooltip title={tooltip} trigger={['hover', 'focus']}>
        {node}
      </Tooltip>
    );
  }
  return node;
}
