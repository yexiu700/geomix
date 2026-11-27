// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CostChip } from './index';

describe('CostChip', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders numeric points badge and free badge separately from control copy', async () => {
    const { rerender } = render(
      <CostChip points={10} tooltip="每次生成扣除 10 点数" data-testid="cost-chip" />,
    );

    const paid = screen.getByTestId('cost-chip');
    expect(paid.textContent).toBe('10点');
    expect(paid.className).toContain('gm-cost-chip');
    expect(paid.className).toContain('gm-num');
    expect(paid.className).not.toContain('gm-cost-chip--free');

    fireEvent.mouseEnter(paid);
    await waitFor(() => {
      expect(screen.getByText('每次生成扣除 10 点数')).toBeTruthy();
    });

    rerender(<CostChip points={0} data-testid="cost-chip" />);
    const free = screen.getByTestId('cost-chip');
    expect(free.textContent).toBe('免费');
    expect(free.className).toContain('gm-cost-chip--free');
  });
});
