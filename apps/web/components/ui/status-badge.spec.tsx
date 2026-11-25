// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS_TONES, StatusBadge, resolveStatusTone } from './index';

describe('StatusBadge', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders all 5 strict semantic tones with dot and label', () => {
    for (const tone of STATUS_TONES) {
      render(<StatusBadge tone={tone} label={`状态-${tone}`} data-testid={`badge-${tone}`} />);
      const badge = screen.getByTestId(`badge-${tone}`);
      expect(badge.getAttribute('data-tone')).toBe(tone);
      expect(badge.className).toContain(`gm-ui-status-badge--${tone}`);
      expect(badge.className).toContain('gm-ui-status-badge--sm');
      expect(badge.querySelector('.gm-ui-status-badge-dot')).toBeTruthy();
      expect(badge.textContent).toBe(`状态-${tone}`);
    }
  });

  it('maps GeoMix domain statuses accurately across all 5 tones', () => {
    // Success (including ChannelConnectionStatus.ACTIVE -> success)
    for (const status of ['COMPLETED', 'PUBLISHED', 'OK', 'ACTIVE', 'DONE', 'online', 'CITED']) {
      expect(resolveStatusTone(status)).toBe('success');
    }
    // Active / In-progress
    for (const status of [
      'RUNNING',
      'PUBLISHING',
      'INDEXING',
      'WRITING',
      'READY',
      'READY_TO_PUBLISH',
      'OPEN',
    ]) {
      expect(resolveStatusTone(status)).toBe('active');
    }
    // Warning (including upcoming SKIPPED_BUDGET_CAP)
    for (const status of [
      'PAUSED',
      'PARTIAL',
      'WARNING',
      'SKIPPED_INSUFFICIENT_POINTS',
      'SKIPPED_NO_ENGINE',
      'SKIPPED_BUDGET_CAP',
    ]) {
      expect(resolveStatusTone(status)).toBe('warning');
    }
    // Danger
    for (const status of ['FAILED', 'BLOCKED', 'INVALID', 'offline', 'NEGATIVE']) {
      expect(resolveStatusTone(status)).toBe('danger');
    }
    // Neutral & fallbacks
    for (const status of [
      'DRAFT',
      'QUEUED',
      'PENDING',
      'CANCELLED',
      'DISABLED',
      'DISMISSED',
      'NONE',
      'UNKNOWN_FUTURE_STATUS',
      '   ',
      '',
      null,
      undefined,
    ]) {
      expect(resolveStatusTone(status)).toBe('neutral');
    }
  });

  it('handles lowercase/whitespace inputs, explicit tone override, children precedence, and md size', () => {
    render(
      <>
        <StatusBadge status="  published  " data-testid="badge-trimmed" />
        <StatusBadge
          status="ACTIVE"
          tone="active"
          label="忽略的文案"
          size="md"
          title="执行中"
          data-testid="badge-override"
        >
          正在同步
        </StatusBadge>
        <StatusBadge data-testid="badge-empty" />
      </>,
    );

    const trimmed = screen.getByTestId('badge-trimmed');
    expect(trimmed.getAttribute('data-tone')).toBe('success');
    expect(trimmed.getAttribute('data-status')).toBe('published');
    expect(trimmed.textContent).toBe('published');

    const override = screen.getByTestId('badge-override');
    expect(override.getAttribute('data-tone')).toBe('active');
    expect(override.getAttribute('data-status')).toBe('ACTIVE');
    expect(override.getAttribute('title')).toBe('执行中');
    expect(override.className).toContain('gm-ui-status-badge--md');
    expect(override.textContent).toBe('正在同步');

    const empty = screen.getByTestId('badge-empty');
    expect(empty.getAttribute('data-tone')).toBe('neutral');
    expect(empty.getAttribute('data-status')).toBeNull();
    expect(empty.textContent).toBe('—');
  });

  it('falls back to em-dash with neutral tone for empty and whitespace-only status or label', () => {
    render(
      <>
        <StatusBadge status="" data-testid="badge-empty-string" />
        <StatusBadge status="   " data-testid="badge-whitespace-string" />
        <StatusBadge label="   " data-testid="badge-whitespace-label" />
        <StatusBadge status="FAILED" label="   " data-testid="badge-whitespace-label-with-status" />
      </>,
    );

    const emptyStr = screen.getByTestId('badge-empty-string');
    expect(emptyStr.getAttribute('data-tone')).toBe('neutral');
    expect(emptyStr.getAttribute('data-status')).toBeNull();
    expect(emptyStr.textContent).toBe('—');

    const whitespaceStr = screen.getByTestId('badge-whitespace-string');
    expect(whitespaceStr.getAttribute('data-tone')).toBe('neutral');
    expect(whitespaceStr.getAttribute('data-status')).toBeNull();
    expect(whitespaceStr.textContent).toBe('—');

    const whitespaceLabel = screen.getByTestId('badge-whitespace-label');
    expect(whitespaceLabel.getAttribute('data-tone')).toBe('neutral');
    expect(whitespaceLabel.textContent).toBe('—');

    const whitespaceLabelWithStatus = screen.getByTestId('badge-whitespace-label-with-status');
    expect(whitespaceLabelWithStatus.getAttribute('data-tone')).toBe('danger');
    expect(whitespaceLabelWithStatus.getAttribute('data-status')).toBe('FAILED');
    expect(whitespaceLabelWithStatus.textContent).toBe('FAILED');
  });
});
