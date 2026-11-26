'use client';

import { UX_TERMS } from '@geomix/shared';
import { Button, Dropdown, type ButtonProps } from 'antd';
import { useState } from 'react';
import { useUxFeedback } from './ux-feedback';

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportActionOption<F extends string = ExportFormat> {
  key: F;
  label: string;
}

const DEFAULT_OPTIONS: ReadonlyArray<ExportActionOption<ExportFormat>> = [
  { key: 'csv', label: 'CSV' },
  { key: 'xlsx', label: 'Excel' },
];

/**
 * 统一列表导出按钮包装器：
 * - 下拉模式统一使用点击展开（`trigger={['click']}`）并附带 `▾` 指示符，消除悬停静默失效；
 * - 内置异步 Loading 防连点、空列表前置拦截提示与异常兜底反馈。
 */
export function ExportAction<F extends string = ExportFormat>({
  label = '导出',
  ariaLabel,
  size,
  type,
  disabled = false,
  empty = false,
  emptyMessage = UX_TERMS.exportEmptyNotice,
  successMessage,
  options,
  singleFormat,
  onEmpty,
  onError,
  onExport,
}: {
  label?: string;
  ariaLabel?: string;
  size?: ButtonProps['size'];
  type?: ButtonProps['type'];
  disabled?: boolean;
  /** 当前列表是否无可导出记录（若为 true，点击给出明确空态提示而不静默下载空表） */
  empty?: boolean;
  emptyMessage?: string;
  /** 导出触发成功后的轻提示（传 null 则由调用方自行展示横幅提示） */
  successMessage?: string | null;
  options?: ReadonlyArray<ExportActionOption<F>>;
  /** 若提供 singleFormat，则渲染为直接触发该格式的独立按钮而非下拉菜单 */
  singleFormat?: F;
  onEmpty?: (message: string) => void;
  onError?: (message: string) => void;
  onExport: (format: F) => void | Promise<void>;
}) {
  const [exporting, setExporting] = useState(false);
  const feedback = useUxFeedback();
  const resolvedAriaLabel = ariaLabel ?? label;

  async function runExport(format: F) {
    if (exporting || disabled) return;
    if (empty) {
      if (onEmpty) {
        onEmpty(emptyMessage);
      } else {
        feedback.notifyWarning(emptyMessage);
      }
      return;
    }

    setExporting(true);
    try {
      await onExport(format);
      if (successMessage !== null) {
        feedback.notifySuccess(successMessage ?? `已开始导出 ${format.toUpperCase()} 文件`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message ? err.message : '导出失败，请稍后重试';
      if (onError) {
        onError(msg);
      } else {
        feedback.notifyError(msg);
      }
    } finally {
      setExporting(false);
    }
  }

  if (singleFormat !== undefined) {
    return (
      <Button
        aria-label={resolvedAriaLabel}
        size={size}
        type={type}
        loading={exporting}
        disabled={disabled}
        onClick={() => void runExport(singleFormat)}
      >
        {label}
      </Button>
    );
  }

  const menuOptions = (options ?? DEFAULT_OPTIONS) as ReadonlyArray<ExportActionOption<F>>;
  const fallbackFormat = menuOptions[0]?.key ?? ('csv' as F);

  if (empty) {
    return (
      <Button
        aria-label={resolvedAriaLabel}
        size={size}
        type={type}
        loading={exporting}
        disabled={disabled}
        onClick={() => void runExport(fallbackFormat)}
      >
        <span>{label}</span>
        <span aria-hidden="true" className="gm-export-caret">
          ▾
        </span>
      </Button>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      disabled={disabled || exporting}
      menu={{
        items: menuOptions.map((opt) => ({
          key: opt.key,
          label: opt.label,
        })),
        onClick: ({ key }) => {
          const matched = menuOptions.find((item) => item.key === key);
          if (matched) {
            void runExport(matched.key);
          }
        },
      }}
    >
      <Button
        aria-label={resolvedAriaLabel}
        size={size}
        type={type}
        loading={exporting}
        disabled={disabled}
      >
        <span>{label}</span>
        <span aria-hidden="true" className="gm-export-caret">
          ▾
        </span>
      </Button>
    </Dropdown>
  );
}
