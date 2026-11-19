import type { CSSProperties } from 'react';

/**
 * Sonar Ink 暗色主题下原生 `<select>` 统一内联样式（表单全宽与工具栏紧凑双规格）。
 */
export const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
  outline: 'none',
  whiteSpace: 'nowrap',
};

export const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
  outline: 'none',
  maxWidth: '100%',
  whiteSpace: 'nowrap',
};
