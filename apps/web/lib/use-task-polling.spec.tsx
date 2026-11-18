// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskPolling, type UseTaskPollingOptions } from './use-task-polling';

describe('useTaskPolling (#264)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('triggers onPoll periodically when enabled and active', async () => {
    const onPoll = vi.fn(async () => {});
    renderHook(() =>
      useTaskPolling({
        enabled: true,
        active: true,
        intervalMs: 1_000,
        onPoll,
      }),
    );

    expect(onPoll).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it('pauses timer when active=false or enabled=false and resumes when reactivated', async () => {
    const onPoll = vi.fn();
    const { rerender } = renderHook((props: UseTaskPollingOptions) => useTaskPolling(props), {
      initialProps: {
        enabled: true,
        active: false,
        intervalMs: 1_000,
        onPoll,
      },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onPoll).not.toHaveBeenCalled();

    rerender({
      enabled: true,
      active: true,
      intervalMs: 1_000,
      onPoll,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);

    rerender({
      enabled: false,
      active: true,
      intervalMs: 1_000,
      onPoll,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping intervals while a slow async poll request is still in flight', async () => {
    let resolveSlowPoll: (() => void) | null = null;
    const onPoll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSlowPoll = resolve;
        }),
    );

    renderHook(() =>
      useTaskPolling({
        enabled: true,
        intervalMs: 1_000,
        onPoll,
      }),
    );

    // First tick starts slow request
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    // Three more ticks fire while slow request is still pending -> skipped
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    // Resolve slow request, next tick should trigger again
    await act(async () => {
      resolveSlowPoll?.();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('cleans up interval on unmount and recovers cleanly after a rejected poll', async () => {
    let count = 0;
    const onPoll = vi.fn(async () => {
      count += 1;
      if (count === 1) {
        throw new Error('temporary network failure');
      }
    });

    const { unmount } = renderHook(() =>
      useTaskPolling({
        enabled: true,
        intervalMs: 1_000,
        onPoll,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });
});
