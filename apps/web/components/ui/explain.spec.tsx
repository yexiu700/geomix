// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Explain, ExplainOrInline } from './index';

describe('Explain', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders focusable trigger button linked via aria-describedby to sr-only text', async () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <Explain
          text="对同一监测问句连续采样三次并合并统计"
          descriptionId="sample-help-id"
          data-testid="explain-node"
        />
      </div>,
    );

    const root = screen.getByTestId('explain-node');
    expect(root.className).toContain('gm-explain');

    const trigger = screen.getByRole('button', { name: '说明' });
    expect(trigger.getAttribute('aria-describedby')).toBe('sample-help-id');

    const srText = document.getElementById('sample-help-id');
    expect(srText?.className).toContain('gm-sr-only');
    expect(srText?.textContent).toBe('对同一监测问句连续采样三次并合并统计');

    fireEvent.click(trigger);
    expect(parentClick).not.toHaveBeenCalled();

    fireEvent.focus(trigger);
    await waitFor(() => {
      const tooltips = screen.getAllByText('对同一监测问句连续采样三次并合并统计');
      expect(tooltips.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('returns null when text is empty or nullish', () => {
    const { container } = render(
      <>
        <Explain text="" />
        <Explain text="   " />
        <Explain text={null} />
      </>,
    );
    expect(container.querySelector('.gm-explain')).toBeNull();
  });

  it('ExplainOrInline keeps <= 8 char text inline and collapses > 8 char text to ⓘ', () => {
    const { rerender } = render(
      <ExplainOrInline content="最多 10 项" inlineClassName="hint-inline" data-testid="hint-el" />,
    );
    expect(screen.getByTestId('hint-el').className).toContain('hint-inline');
    expect(screen.queryByRole('button', { name: '说明' })).toBeNull();

    rerender(
      <ExplainOrInline
        content="这是一段超过八个字的详细操作说明文案"
        inlineClassName="hint-inline"
        inlineId="long-hint-id"
        data-testid="hint-el"
      />,
    );
    expect(screen.getByRole('button', { name: '说明' }).getAttribute('aria-describedby')).toBe(
      'long-hint-id',
    );
    expect(document.querySelector('.hint-inline')).toBeNull();
  });
});
