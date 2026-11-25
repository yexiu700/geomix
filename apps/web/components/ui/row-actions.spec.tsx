// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ModalFuncProps } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowActions } from './index';

const mockConfirm = vi.fn<(props: ModalFuncProps) => void>();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: vi.fn(),
    notifyWarning: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

describe('RowActions', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  });

  it('renders primary, hover-reveal secondary actions, stops click propagation, and respects revealOnHover=false', () => {
    const onRowClick = vi.fn();
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();

    const { container, rerender } = render(
      <div className="gm-ui-row" onClick={onRowClick}>
        <RowActions
          primary={{ key: 'retest', label: '发起复测', onClick: onPrimary, testId: 'act-primary' }}
          secondary={[
            { key: 'edit', label: '继续编辑', onClick: onSecondary, testId: 'act-secondary' },
          ]}
          data-testid="row-actions"
        />
      </div>,
    );

    const secondaryWrap = container.querySelector('.gm-ui-row-actions-secondary');
    expect(secondaryWrap?.className).toContain('gm-ui-row-actions-secondary--reveal');
    expect(container.querySelector('.gm-ui-row-action-more')).toBeNull();

    fireEvent.click(screen.getByTestId('act-primary'));
    fireEvent.click(screen.getByTestId('act-secondary'));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    rerender(
      <RowActions
        revealOnHover={false}
        secondary={[{ key: 'edit', label: '继续编辑', onClick: onSecondary }]}
      />,
    );
    expect(container.querySelector('.gm-ui-row-actions-secondary--reveal')).toBeNull();
  });

  it('opens overflow menu, runs direct items, and gates confirm items behind useUxFeedback().confirm()', async () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const onRowClick = vi.fn();

    render(
      <div onClick={onRowClick}>
        <RowActions
          moreTestId="row-more-btn"
          menuItems={[
            {
              key: 'duplicate',
              label: '复制草稿',
              onClick: onDuplicate,
              testId: 'menu-duplicate',
            },
            {
              key: 'delete',
              label: '删除品牌',
              danger: true,
              onClick: onDelete,
              testId: 'menu-delete',
              confirm: {
                title: '确认删除该品牌？',
                content: '删除后关联资产将不可恢复',
                okText: '确认删除',
                cancelText: '取消',
              },
            },
          ]}
        />
      </div>,
    );

    const trigger = screen.getByTestId('row-more-btn');
    expect(trigger.getAttribute('aria-label')).toBe('更多操作');

    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(onRowClick).not.toHaveBeenCalled();

    // Direct non-confirm menu item
    const duplicateItem = await screen.findByTestId('menu-duplicate');
    await act(async () => {
      fireEvent.click(duplicateItem);
    });
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();

    // Re-open overflow menu and click destructive confirm item
    await act(async () => {
      fireEvent.click(trigger);
    });
    const deleteItem = await screen.findByTestId('menu-delete');
    await act(async () => {
      fireEvent.click(deleteItem);
    });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArgs = mockConfirm.mock.calls[0]?.[0];
    expect(confirmArgs?.title).toBe('确认删除该品牌？');
    expect(confirmArgs?.content).toBe('删除后关联资产将不可恢复');
    expect(confirmArgs?.okText).toBe('确认删除');
    expect(confirmArgs?.cancelText).toBe('取消');
    expect(confirmArgs?.okButtonProps).toEqual({ danger: true });

    // Cancel path: onDelete has NOT been invoked yet
    expect(onDelete).not.toHaveBeenCalled();

    // Confirm path: invoking onOk calls onDelete once
    await confirmArgs?.onOk?.();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('respects disabled and loading states on buttons', () => {
    const onDisabled = vi.fn();
    const onLoading = vi.fn();

    render(
      <RowActions
        primary={{
          key: 'busy',
          label: '提交中',
          loading: true,
          onClick: onLoading,
          testId: 'btn-loading',
        }}
        secondary={[
          {
            key: 'off',
            label: '禁用操作',
            disabled: true,
            onClick: onDisabled,
            testId: 'btn-disabled',
          },
        ]}
      />,
    );

    const loadingBtn = screen.getByTestId('btn-loading') as HTMLButtonElement;
    const disabledBtn = screen.getByTestId('btn-disabled') as HTMLButtonElement;
    expect(loadingBtn.disabled).toBe(true);
    expect(loadingBtn.getAttribute('aria-busy')).toBe('true');
    expect(disabledBtn.disabled).toBe(true);

    fireEvent.click(loadingBtn);
    fireEvent.click(disabledBtn);
    expect(onLoading).not.toHaveBeenCalled();
    expect(onDisabled).not.toHaveBeenCalled();
  });
});
