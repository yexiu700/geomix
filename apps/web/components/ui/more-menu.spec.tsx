// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoreMenu } from './index';

const mockConfirm = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
  }),
}));

describe('MoreMenu', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('returns null when items array is empty', () => {
    const { container } = render(<MoreMenu items={[]} />);
    expect(container.querySelector('.gm-more-menu-trigger')).toBeNull();
  });

  it('opens dropdown items and triggers action or confirmation safely', async () => {
    const onExport = vi.fn();
    const onDelete = vi.fn();

    render(
      <MoreMenu
        data-testid="page-more-menu"
        items={[
          { key: 'export', label: '导出', testId: 'more-export', onClick: onExport },
          {
            key: 'delete',
            label: '删除',
            danger: true,
            confirm: { title: '确认删除？' },
            onClick: onDelete,
          },
        ]}
      />,
    );

    const trigger = screen.getByTestId('page-more-menu');
    expect(trigger.getAttribute('aria-label')).toBe('更多');
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByTestId('more-export'));
    expect(onExport).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText('删除'));
    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledTimes(1);
    });
    expect(onDelete).not.toHaveBeenCalled();
  });
});
