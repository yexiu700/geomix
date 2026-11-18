'use client';

import { Button } from 'antd';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { hasOpenFloatingOverlay } from '../../lib/ux-foundation';

export function CrudModal({
  open,
  title,
  minimized,
  maximized,
  confirmLoading = false,
  width,
  showCancel = true,
  cancelText = '取消',
  maskClosable = true,
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
  width?: number | string;
  showCancel?: boolean;
  cancelText?: string;
  maskClosable?: boolean;
  error?: string | null;
  ok?: ReactNode;
  onMinimize?: () => void;
  onRestore?: () => void;
  onMaximize?: () => void;
  onClose: () => void;
  onReset?: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || minimized || confirmLoading) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (dialogRef.current?.closest('[hidden]')) return;
      if (hasOpenFloatingOverlay()) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, minimized, confirmLoading, onClose]);

  useEffect(() => {
    if (!open || minimized || !error) return;
    const bodyEl = bodyRef.current;
    if (bodyEl && typeof bodyEl.scrollTo === 'function') {
      bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (bodyEl) {
      bodyEl.scrollTop = 0;
    }
  }, [open, minimized, error]);

  if (!open) return null;
  if (minimized) {
    return (
      <button type="button" className="gm-crud-dock" aria-label="还原弹层" onClick={onRestore}>
        {title}
      </button>
    );
  }

  const customStyle: CSSProperties | undefined =
    !maximized && width !== undefined
      ? { width: typeof width === 'number' ? `min(${width}px, calc(100vw - 32px))` : width }
      : undefined;

  return (
    <div
      className={maximized ? 'gm-crud-mask max' : 'gm-crud-mask'}
      onClick={(event) => {
        if (maskClosable && !confirmLoading && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={maximized ? 'gm-crud-dialog max' : 'gm-crud-dialog'}
        style={customStyle}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="gm-crud-head">
          <strong>{title}</strong>
          <span>
            {onMinimize ? (
              <Button
                type="text"
                aria-label="最小化"
                disabled={confirmLoading}
                onClick={onMinimize}
              >
                最小化
              </Button>
            ) : null}
            {onMaximize ? (
              <Button
                type="text"
                aria-label={maximized ? '还原窗口' : '最大化'}
                disabled={confirmLoading}
                onClick={onMaximize}
              >
                {maximized ? '还原' : '最大化'}
              </Button>
            ) : null}
            <Button type="text" aria-label="关闭" disabled={confirmLoading} onClick={onClose}>
              关闭
            </Button>
          </span>
        </header>
        <div ref={bodyRef} className="gm-crud-body">
          {children}
        </div>
        <footer className="gm-crud-footer">
          {error ? (
            <p className="gm-crud-error gm-form-error" role="alert">
              {error}
            </p>
          ) : null}
          {showCancel ? (
            <Button aria-label={cancelText} onClick={onClose} disabled={confirmLoading}>
              {cancelText}
            </Button>
          ) : null}
          {onReset ? (
            <Button aria-label="重置" onClick={onReset} disabled={confirmLoading}>
              重置
            </Button>
          ) : null}
          {ok}
        </footer>
      </div>
    </div>
  );
}
