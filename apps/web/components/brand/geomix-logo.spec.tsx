// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GeoMixIcon, GeoMixLockup, GeoMixWordmark } from './geomix-logo';

describe('GeoMix Brand Kit v2.2 SVG components', () => {
  it('renders GeoMixIcon with locked 64x64 viewBox and themeable fill variables', () => {
    const { container } = render(<GeoMixIcon size={24} className="test-icon" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('circle')?.getAttribute('fill')).toBe(
      'var(--gm-logo-accent, #CEFA29)',
    );
  });

  it('renders GeoMixLockup with locked 258.22x48 viewBox and proportional width', () => {
    const { container } = render(<GeoMixLockup height={24} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 258.22 48');
    expect(svg?.getAttribute('height')).toBe('24');
    expect(Number(svg?.getAttribute('width'))).toBeCloseTo(129.11, 2);
  });

  it('renders GeoMixWordmark with locked 188.62x48 viewBox', () => {
    const { container } = render(<GeoMixWordmark height={24} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 188.62 48');
    expect(Number(svg?.getAttribute('width'))).toBeCloseTo(94.31, 2);
  });
});
