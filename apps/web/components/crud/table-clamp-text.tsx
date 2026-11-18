'use client';

import { Tooltip } from 'antd';
import type { CSSProperties } from 'react';

/**
 * 表格长文本多行截断保护组件：
 * 超出指定行数时自动使用省略号截断，并在悬停时以 Tooltip 展示全文，防止超长提示词或标题撑爆行高与横向宽度。
 */
export function TableClampText({
  text,
  lines = 2,
  strong = false,
  maxWidth,
  tooltipThreshold = 42,
  style,
}: {
  text: string | null | undefined;
  lines?: 1 | 2 | 3;
  strong?: boolean;
  maxWidth?: number | string;
  tooltipThreshold?: number;
  style?: CSSProperties;
}) {
  const value = text?.trim() ?? '';
  if (!value) {
    return <span style={{ color: 'var(--gm-fg-3)' }}>—</span>;
  }

  const clampClass = `gm-clamp-${lines}`;
  const node = (
    <div
      className={clampClass}
      style={{
        maxWidth,
        fontWeight: strong ? 600 : undefined,
        wordBreak: 'break-word',
        lineHeight: 1.55,
        ...style,
      }}
    >
      {value}
    </div>
  );

  if (value.length >= tooltipThreshold) {
    return (
      <Tooltip
        title={<span style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{value}</span>}
        styles={{ root: { maxWidth: 520 } }}
      >
        {node}
      </Tooltip>
    );
  }

  return node;
}
