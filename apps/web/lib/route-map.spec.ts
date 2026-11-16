import { describe, expect, it } from 'vitest';
import { LEGACY_REDIRECTS, legacyPathname, safeConsoleHref } from './route-map';

describe('legacy redirects', () => {
  it('sends the path named in issue #7 to the writing prompts route', () => {
    expect(Object.keys(LEGACY_REDIRECTS)).toEqual(['/user/zhiling']);
    expect(legacyPathname('/user/zhiling')).toBe('/writing/prompts');
    expect(legacyPathname('/user/zhiling/')).toBe('/writing/prompts');
  });

  it('does not invent targets for other old paths', () => {
    expect(legacyPathname('/user/other')).toBeNull();
    expect(legacyPathname('/writing/prompts')).toBeNull();
    expect(legacyPathname('/dashboard')).toBeNull();
  });

  it('only accepts an in-app console href after login', () => {
    expect(safeConsoleHref('/writing/prompts')).toBe('/writing/prompts');
    expect(safeConsoleHref('/material/questions?keywordId=demo')).toBe(
      '/material/questions?keywordId=demo',
    );
    expect(safeConsoleHref('https://example.com/writing/prompts')).toBeNull();
    expect(safeConsoleHref('//example.com')).toBeNull();
    expect(safeConsoleHref('/user/zhiling')).toBeNull();
  });
});
