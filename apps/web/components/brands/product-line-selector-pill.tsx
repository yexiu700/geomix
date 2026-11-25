'use client';

import type { JSX } from 'react';
import { useWorkspaceStore } from '../../lib/workspace-store';

export type ProductLineSelectorPillProps = {
  compact?: boolean;
  className?: string;
  disabled?: boolean;
};

/**
 * 渐进式产品线切换器（#387）：
 * - 单品类品牌（0 条产品线）返回 null，保持零 DOM 噪音；
 * - 配置 >= 1 条产品线后自动出现「全部产品线」与各产品线独立药丸按钮。
 */
export function ProductLineSelectorPill({
  compact = false,
  className,
  disabled = false,
}: ProductLineSelectorPillProps): JSX.Element | null {
  const activeBrandId = useWorkspaceStore((s) => s.activeBrandId);
  const productLinesBrandId = useWorkspaceStore((s) => s.productLinesBrandId);
  const productLines = useWorkspaceStore((s) => s.productLines);
  const activeProductLineId = useWorkspaceStore((s) => s.activeProductLineId);
  const setActiveProductLine = useWorkspaceStore((s) => s.setActiveProductLine);

  if (!activeBrandId || productLinesBrandId !== activeBrandId || productLines.length === 0) {
    return null;
  }

  const classes = [
    'gm-product-line-switcher',
    compact ? 'gm-product-line-switcher--compact' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-testid="product-line-switcher"
      role="radiogroup"
      aria-label="产品线筛选"
    >
      <button
        type="button"
        role="radio"
        aria-checked={activeProductLineId === null}
        data-testid="product-line-option-all"
        disabled={disabled}
        className={
          activeProductLineId === null ? 'gm-product-line-pill is-active' : 'gm-product-line-pill'
        }
        onClick={() => setActiveProductLine(null)}
      >
        <span>全部产品线</span>
      </button>
      {productLines.map((line) => {
        const selected = activeProductLineId === line.id;
        return (
          <button
            key={line.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`product-line-option-${line.id}`}
            disabled={disabled}
            className={selected ? 'gm-product-line-pill is-active' : 'gm-product-line-pill'}
            onClick={() => setActiveProductLine(line.id)}
          >
            <span>{line.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export { ProductLineSelectorPill as ProductLineSwitcher };
