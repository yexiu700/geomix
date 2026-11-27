import { describe, expect, it } from 'vitest';
import {
  HOME_ROUTE,
  MENU,
  STATIC_ROUTES,
  buildMenu,
  buildWorkspaceHref,
  collectHrefs,
  isCommandPaletteRoute,
  isConsoleRouteAccessible,
  matchRoute,
  menuSelection,
} from './routes';

describe('GeoMix minimalist 6-workspace routes', () => {
  it('defines flat 5 left business workspaces and 6 total console routes', () => {
    expect(HOME_ROUTE).toBe('/home');
    expect(collectHrefs(MENU)).toEqual(['/home', '/brands', '/visibility', '/studio', '/publish']);
    expect(Object.keys(STATIC_ROUTES)).toEqual([
      '/home',
      '/brands',
      '/visibility',
      '/studio',
      '/publish',
      '/account',
    ]);
  });

  it('hides /visibility from menu and command palette when visibilityEnabled=false', () => {
    expect(collectHrefs(buildMenu({ visibilityEnabled: false }))).toEqual([
      '/home',
      '/brands',
      '/studio',
      '/publish',
    ]);
    expect(isCommandPaletteRoute('/visibility', 'MERCHANT', { visibilityEnabled: false })).toBe(
      false,
    );
    expect(isCommandPaletteRoute('/home', 'MERCHANT', { visibilityEnabled: false })).toBe(true);
    expect(isCommandPaletteRoute('/publish', 'MERCHANT', { visibilityEnabled: false })).toBe(true);
  });

  it('canonicalizes allowed workspace query parameters without leaking raw CUIDs into title', () => {
    const cuid = 'cm8x9abc1234567890def1234';
    const matched = matchRoute(`/studio/?brandId=${cuid}&market=GLOBAL&briefId=${cuid}&junk=1`);
    expect(matched).toEqual({
      href: `/studio?brandId=${cuid}&market=GLOBAL&briefId=${cuid}`,
      path: '/studio',
      title: 'GEO 写作台',
    });
    expect(matched?.title).not.toContain(cuid);

    const publishMatched = matchRoute(
      `/publish/?brandId=${cuid}&market=CN&articleId=${cuid}&tab=tracking&junk=1`,
    );
    expect(publishMatched).toEqual({
      href: `/publish?brandId=${cuid}&market=CN&articleId=${cuid}&tab=tracking`,
      path: '/publish',
      title: '发布中心',
    });
  });

  it('rejects removed v1 routes, external origins, and path traversal', () => {
    for (const invalid of [
      '/dashboard',
      '/me/money',
      '/material/keywords',
      '/writing/tasks',
      '/rewrite/single',
      '/image',
      '/visibility/overview',
      '//evil.example/home',
      'https://evil.example/home',
      '/home/../admin',
      '/home\\evil',
    ]) {
      expect(matchRoute(invalid)).toBeNull();
      expect(isConsoleRouteAccessible(invalid)).toBe(false);
    }
  });

  it('builds workspace hrefs preserving brandId & market on business routes', () => {
    expect(buildWorkspaceHref('/visibility', 'brand-1', 'GLOBAL')).toBe(
      '/visibility?brandId=brand-1&market=GLOBAL',
    );
    expect(buildWorkspaceHref('/studio', 'brand-1', 'CN', { briefId: 'brief-9' })).toBe(
      '/studio?brandId=brand-1&market=CN&briefId=brief-9',
    );
    expect(buildWorkspaceHref('/studio', 'brand-1', 'CN', { batchJobId: 'gb_123456' })).toBe(
      '/studio?brandId=brand-1&market=CN&batchJobId=gb_123456',
    );
    expect(
      matchRoute('/studio?brandId=brand-1&market=CN&batchJobId=gb_123456&extra=ignored'),
    ).toEqual({
      href: '/studio?brandId=brand-1&market=CN&batchJobId=gb_123456',
      path: '/studio',
      title: 'GEO 写作台',
    });
    expect(buildWorkspaceHref('/account', 'brand-1', 'CN', { tab: 'rights' })).toBe(
      '/account?tab=rights',
    );
    expect(menuSelection('/brands?brandId=b1&market=CN')).toEqual({
      selected: '/brands',
      parents: [],
    });
  });
});
