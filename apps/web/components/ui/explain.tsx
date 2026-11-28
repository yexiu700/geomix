'use client';

import { Tooltip, type TooltipProps } from 'antd';
import { useId, type ReactNode } from 'react';
import { shouldCollapseToExplain } from '../../lib/copy-length';

export type ExplainProps = {
  text: ReactNode;
  label?: string;
  placement?: TooltipProps['placement'];
  descriptionId?: string;
  className?: string;
  'data-testid'?: string;
};

/**
 * ⓘ 解释性 UI 原语：
 * - 超过 8 字的说明、帮助、提示与告警不常驻正文，收进标题或标签旁的 ⓘ
 * - 独立 <button> 触发器（不嵌套于 h1/h2/label 内部），支持悬停、聚焦与点击查看
 * - 通过 .gm-sr-only + aria-describedby 保持无障碍读屏语义与测试文本可达
 */
export function Explain({
  text,
  label = '说明',
  placement = 'bottom',
  descriptionId,
  className,
  'data-testid': testId,
}: ExplainProps) {
  const autoId = useId();
  if (text === null || text === undefined || text === false) {
    return null;
  }
  if (typeof text === 'string' && !text.trim()) {
    return null;
  }

  const resolvedId = descriptionId ?? autoId;
  const classes = className ? `gm-explain ${className}` : 'gm-explain';

  return (
    <span className={classes} data-testid={testId}>
      <Tooltip title={text} placement={placement} trigger={['hover', 'focus', 'click']}>
        <span className="gm-explain-anchor">
          <button
            type="button"
            className="gm-explain-trigger"
            aria-label={label}
            aria-describedby={resolvedId}
            onClick={(event) => event.stopPropagation()}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 7.2V11.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="8" cy="4.9" r="0.85" fill="currentColor" />
            </svg>
          </button>
        </span>
      </Tooltip>
      <span id={resolvedId} className="gm-sr-only">
        {text}
      </span>
    </span>
  );
}

export type ExplainOrInlineProps = {
  content: ReactNode;
  inlineClassName?: string;
  inlineId?: string;
  label?: string;
  as?: 'p' | 'div' | 'span';
  'data-testid'?: string;
};

/**
 * 根据文案长度决定渲染位置：
 * - 字符串 > 8 字自动收敛为 <Explain />
 * - 字符串 <= 8 字或自定义 JSX 节点保留内联展示
 */
export function ExplainOrInline({
  content,
  inlineClassName,
  inlineId,
  label = '说明',
  as: Tag = 'span',
  'data-testid': testId,
}: ExplainOrInlineProps) {
  if (content === null || content === undefined || content === false) {
    return null;
  }
  if (typeof content === 'string') {
    if (!content.trim()) {
      return null;
    }
    if (shouldCollapseToExplain(content)) {
      return <Explain text={content} descriptionId={inlineId} label={label} data-testid={testId} />;
    }
  }
  return (
    <Tag id={inlineId} className={inlineClassName} data-testid={testId}>
      {content}
    </Tag>
  );
}
