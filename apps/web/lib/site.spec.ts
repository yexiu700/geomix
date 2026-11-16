import { SITE_NAME } from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import { HOME_LEAD, homeTitle } from './site';

describe('home copy', () => {
  it('uses the GeoMix placeholder', () => {
    expect(homeTitle()).toBe('GeoMix');
    expect(homeTitle()).toBe(SITE_NAME);
    expect(HOME_LEAD).toContain('工程骨架');
  });
});
