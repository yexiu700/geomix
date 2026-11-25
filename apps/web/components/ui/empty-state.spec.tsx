// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './index';

describe('EmptyState', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults to full size and renders icon, title, description, and action', () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="empty-icon" />}
        title="尚未生成诊断建议"
        description="发起一轮可见度诊断后，系统会自动汇总优先写作选题"
        action={<button type="button">去写作台自由选题 →</button>}
        data-testid="empty-full"
      />,
    );

    const root = screen.getByTestId('empty-full');
    expect(root.getAttribute('data-size')).toBe('full');
    expect(root.className).toContain('gm-ui-empty--full');
    expect(screen.getByTestId('empty-icon')).toBeTruthy();
    expect(container.querySelector('.gm-ui-empty-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('尚未生成诊断建议')).toBeTruthy();
    expect(screen.getByText('发起一轮可见度诊断后，系统会自动汇总优先写作选题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去写作台自由选题 →' })).toBeTruthy();
  });

  it('supports compact inline size and omits optional slots when absent', () => {
    const { container } = render(
      <EmptyState
        size="compact"
        title="暂无近期成稿"
        className="my-empty"
        data-testid="empty-sm"
      />,
    );

    const root = screen.getByTestId('empty-sm');
    expect(root.getAttribute('data-size')).toBe('compact');
    expect(root.className).toContain('gm-ui-empty--compact');
    expect(root.className).toContain('my-empty');
    expect(container.querySelector('.gm-ui-empty-icon')).toBeNull();
    expect(container.querySelector('.gm-ui-empty-desc')).toBeNull();
    expect(container.querySelector('.gm-ui-empty-action')).toBeNull();
  });
});
