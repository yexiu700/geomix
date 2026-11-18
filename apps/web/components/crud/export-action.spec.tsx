// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportAction } from './export-action';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExportAction', () => {
  it('warns instead of silently doing nothing when table is empty', () => {
    const warnSpy = vi
      .spyOn(message, 'warning')
      .mockImplementation(() => (() => undefined) as never);
    const onExport = vi.fn();

    render(<ExportAction empty onExport={onExport} />);
    const btn = screen.getByRole('button', { name: '导出' });
    expect(btn.textContent).toContain('▾');

    fireEvent.click(btn);
    expect(warnSpy).toHaveBeenCalledWith('当前列表暂无可导出数据');
    expect(onExport).not.toHaveBeenCalled();
  });

  it('opens format menu on click and awaits async export handler', async () => {
    let resolveExport: (() => void) | undefined;
    const onExport = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }),
    );

    render(<ExportAction empty={false} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    fireEvent.click(await screen.findByText('Excel'));

    expect(onExport).toHaveBeenCalledWith('xlsx');
    resolveExport?.();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '导出' }).classList.contains('ant-btn-loading'),
      ).toBe(false);
    });
  });

  it('supports singleFormat direct export button without dropdown', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<ExportAction label="导出 CSV" singleFormat="csv" onExport={onExport} />);

    const btn = screen.getByRole('button', { name: '导出 CSV' });
    expect(btn.textContent).not.toContain('▾');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onExport).toHaveBeenCalledWith('csv');
    });
  });
});
