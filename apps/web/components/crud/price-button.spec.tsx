// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriceButton } from './price-button';

afterEach(() => {
  cleanup();
});

describe('price button', () => {
  it('reads the unit price into the agreed label', () => {
    const onClick = vi.fn();
    render(
      <PriceButton
        action="geo_write"
        prices={[{ action: 'geo_write', unitPoints: 10, enabled: true, label: 'GEO 靶向写作' }]}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'GEO 靶向写作（10点数/篇）' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('stays inactive when the price is disabled', () => {
    render(
      <PriceButton
        action="geo_write"
        prices={[{ action: 'geo_write', unitPoints: 10, enabled: false, label: 'GEO 靶向写作' }]}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '价格未启用' })).toHaveProperty('disabled', true);
  });
});
