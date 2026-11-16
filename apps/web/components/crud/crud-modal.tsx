'use client';

import { Button } from 'antd';
import type { ReactNode } from 'react';

export function CrudModal({
  open,
  title,
  minimized,
  maximized,
  confirmLoading = false,
  error,
  ok,
  onMinimize,
  onRestore,
  onMaximize,
  onClose,
  onReset,
  children,
}: {
  open: boolean;
  title: string;
  minimized: boolean;
  maximized: boolean;
  confirmLoading?: boolean;
  error?: string | null;
  ok?: ReactNode;
  onMinimize: () => void;
  onRestore: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  if (minimized) {
    return (
      <button type="button" className="gm-crud-dock" aria-label="还原弹层" onClick={onRestore}>
        {title}
      </button>
    );
  }
  return (
    <div className={maximized ? 'gm-crud-mask max' : 'gm-crud-mask'}>
      <div
        className={maximized ? 'gm-crud-dialog max' : 'gm-crud-dialog'}
        role="dialog"
        aria-label={title}
      >
        <header className="gm-crud-head">
          <strong>{title}</strong>
          <span>
            <Button type="text" aria-label="最小化" onClick={onMinimize}>
              最小化
            </Button>
            <Button type="text" aria-label={maximized ? '还原窗口' : '最大化'} onClick={onMaximize}>
              {maximized ? '还原' : '最大化'}
            </Button>
            <Button type="text" aria-label="关闭" onClick={onClose}>
              关闭
            </Button>
          </span>
        </header>
        <div className="gm-crud-body">{children}</div>
        <footer className="gm-crud-footer">
          {error ? <p className="gm-crud-error gm-form-error">{error}</p> : null}
          <Button aria-label="重置" onClick={onReset} disabled={confirmLoading}>
            重置
          </Button>
          {ok}
        </footer>
      </div>
    </div>
  );
}
