// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateFreshness,
  resetFreshnessForTests,
  useTabFreshness,
  type FreshnessDomain,
  type FreshnessRefreshReason,
} from './tab-freshness';

function Probe({
  active,
  domains,
  refreshOnActivate = true,
  onRefresh,
}: {
  active: boolean;
  domains: FreshnessDomain[];
  refreshOnActivate?: boolean;
  onRefresh: (reason: FreshnessRefreshReason) => void;
}) {
  useTabFreshness({ active, domains, refreshOnActivate, onRefresh });
  return createElement('div', { 'data-testid': 'probe' }, active ? 'active' : 'inactive');
}

describe('useTabFreshness (#215)', () => {
  beforeEach(() => {
    resetFreshnessForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not trigger extra refresh on initial mount and refreshes on tab re-activation', async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      createElement(Probe, { active: true, domains: ['brands'], onRefresh }),
    );
    expect(onRefresh).not.toHaveBeenCalled();

    rerender(createElement(Probe, { active: false, domains: ['brands'], onRefresh }));
    expect(onRefresh).not.toHaveBeenCalled();

    rerender(createElement(Probe, { active: true, domains: ['brands'], onRefresh }));
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    expect(onRefresh).toHaveBeenCalledWith('activated');
  });

  it('queues background domain invalidations while inactive and flushes on activation', async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      createElement(Probe, {
        active: false,
        domains: ['brands', 'brand-facts'],
        refreshOnActivate: false,
        onRefresh,
      }),
    );

    // Unrelated domain should not trigger refresh
    invalidateFreshness('briefs');
    rerender(
      createElement(Probe, {
        active: true,
        domains: ['brands', 'brand-facts'],
        refreshOnActivate: false,
        onRefresh,
      }),
    );
    expect(onRefresh).not.toHaveBeenCalled();

    // Switch back to inactive, then mutate a subscribed domain
    rerender(
      createElement(Probe, {
        active: false,
        domains: ['brands', 'brand-facts'],
        refreshOnActivate: false,
        onRefresh,
      }),
    );
    invalidateFreshness('brand-facts');
    expect(onRefresh).not.toHaveBeenCalled();

    // Reactivate -> flushes dirty state
    rerender(
      createElement(Probe, {
        active: true,
        domains: ['brands', 'brand-facts'],
        refreshOnActivate: false,
        onRefresh,
      }),
    );
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('probe').textContent).toBe('active');
  });

  it('refreshes immediately when an invalidation arrives while tab is active', () => {
    const onRefresh = vi.fn();
    render(createElement(Probe, { active: true, domains: ['brand-media'], onRefresh }));

    invalidateFreshness('brand-media');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('invalidated');
  });

  it('supports v2.1 channel-connections and distributions freshness domains', async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      createElement(Probe, {
        active: false,
        domains: ['channel-connections', 'distributions'],
        refreshOnActivate: false,
        onRefresh,
      }),
    );

    invalidateFreshness('channel-connections');
    expect(onRefresh).not.toHaveBeenCalled();

    rerender(
      createElement(Probe, {
        active: true,
        domains: ['channel-connections', 'distributions'],
        refreshOnActivate: false,
        onRefresh,
      }),
    );
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    expect(onRefresh).toHaveBeenLastCalledWith('activated');

    invalidateFreshness('distributions');
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenLastCalledWith('invalidated');
  });

  it('supports v2.2 roi-reports freshness domain', () => {
    const onRefresh = vi.fn();
    render(createElement(Probe, { active: true, domains: ['roi-reports'], onRefresh }));

    invalidateFreshness('roi-reports');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('invalidated');
  });

  it('supports v2.2 extension-tokens freshness domain across /brands and /account', () => {
    const onRefresh = vi.fn();
    render(createElement(Probe, { active: true, domains: ['extension-tokens'], onRefresh }));

    invalidateFreshness('extension-tokens');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('invalidated');
  });
});
