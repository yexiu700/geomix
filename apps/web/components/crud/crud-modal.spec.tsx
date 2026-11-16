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
});
