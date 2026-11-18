// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrudModal } from './crud-modal';

afterEach(() => {
  cleanup();
});

function Harness() {
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const onReset = vi.fn();
  return (
    <>
      <CrudModal
        open
        title="添加记录"
        minimized={minimized}
        maximized={maximized}
        onMinimize={() => setMinimized(true)}
        onRestore={() => setMinimized(false)}
        onMaximize={() => setMaximized((value) => !value)}
        onClose={() => undefined}
        onReset={onReset}
        ok={<button type="button">确定</button>}
      >
        <p>表单内容</p>
      </CrudModal>
      <button type="button" onClick={() => onReset.mock.calls.length}>
        探针
      </button>
    </>
  );
}

describe('crud modal', () => {
  it('minimizes to a dock and can fill the page', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: '添加记录' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '最小化' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '还原弹层' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化' }));
    expect(document.querySelector('.gm-crud-mask.max')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  });

  it('closes on Escape only when no floating overlay is open and not submitting', () => {
    const onClose = vi.fn();
    const view = render(
      <CrudModal
        open
        title="编辑记录"
        minimized={false}
        maximized={false}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={onClose}
        ok={<button type="button">保存</button>}
      >
        <p>内容</p>
      </CrudModal>,
    );

    const dropdown = document.createElement('div');
    dropdown.className = 'ant-select-dropdown';
    document.body.appendChild(dropdown);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    dropdown.remove();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <CrudModal
        open
        title="编辑记录"
        minimized={false}
        maximized={false}
        confirmLoading
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={onClose}
        ok={<button type="button">保存</button>}
      >
        <p>内容</p>
      </CrudModal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders error alert and scrolls modal body to top when error appears', () => {
    const scrollToSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollToSpy,
    });

    const view = render(
      <CrudModal
        open
        title="新建记录"
        minimized={false}
        maximized={false}
        error={null}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => undefined}
        ok={<button type="button">确定</button>}
      >
        <p>长表单</p>
      </CrudModal>,
    );

    view.rerender(
      <CrudModal
        open
        title="新建记录"
        minimized={false}
        maximized={false}
        error="请补全必填字段"
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => undefined}
        ok={<button type="button">确定</button>}
      >
        <p>长表单</p>
      </CrudModal>,
    );

    expect(screen.getByText('请补全必填字段')).toBeTruthy();
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});
