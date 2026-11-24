import { ADMIN_ROUTES } from '@geomix/shared';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../middleware';
import {
  LEGACY_REDIRECTS,
  legacyAccountTab,
  legacyPathname,
  safeAdminHref,
  safeConsoleHref,
  safePostLoginHref,
} from './route-map';

describe('GeoMix 2.0 route-map & legacy redirects', () => {
  it('redirects v1 console routes and historical /user/* paths to v2 workspaces', () => {
    expect(legacyPathname('/dashboard')).toBe('/home');
    expect(legacyPathname('/dashboard/')).toBe('/home');
    expect(legacyPathname('/visibility/overview')).toBe('/visibility');
    expect(legacyPathname('/visibility/monitors')).toBe('/visibility');
    expect(legacyPathname('/me/points')).toBe('/account');
    expect(legacyPathname('/me/rights')).toBe('/account');
    expect(legacyPathname('/me/verify')).toBe('/account');
    expect(legacyPathname('/me/money')).toBe('/account');

    expect(legacyPathname('/user/dashboard')).toBe('/home');
    expect(legacyPathname('/user/company_keyword/index')).toBe('/brands');
    expect(legacyPathname('/user/images_type/index/type/1')).toBe('/brands');
    expect(legacyPathname('/user/zhiling')).toBe('/studio');
    expect(legacyPathname('/user/ai_task')).toBe('/studio');
    expect(legacyPathname('/user/weixin_baowen')).toBe('/studio');
    expect(legacyPathname('/user/piliang_baowen')).toBe('/studio');
    expect(legacyPathname('/user/ai_image')).toBe('/studio');
    expect(legacyPathname('/user/user_score_log')).toBe('/account');
    expect(legacyPathname('/user/user_money_log')).toBe('/account');
    expect(legacyPathname('/user/quanyi')).toBe('/account');
    expect(legacyPathname('/user/account_rights')).toBe('/account');

    expect(Object.keys(LEGACY_REDIRECTS).length).toBeGreaterThanOrEqual(20);
    expect(legacyPathname('/home')).toBeNull();
    expect(legacyPathname('/unknown')).toBeNull();
  });

  it('maps legacy personal-center paths to the matching /account tab', () => {
    expect(legacyAccountTab('/me/points')).toBe('points');
    expect(legacyAccountTab('/me/money')).toBe('points');
    expect(legacyAccountTab('/me/rights')).toBe('rights');
    expect(legacyAccountTab('/me/verify')).toBe('verify');
    expect(legacyAccountTab('/user/quanyi')).toBe('rights');
    expect(legacyAccountTab('/dashboard')).toBeNull();
  });

  it('validates safeConsoleHref, safeAdminHref (rejecting /admin/templates), and safePostLoginHref', () => {
    expect(safeConsoleHref('/home')).toBe('/home');
    expect(safeConsoleHref('/studio?brandId=b1&market=GLOBAL')).toBe(
      '/studio?brandId=b1&market=GLOBAL',
    );
    expect(safeConsoleHref('/account?tab=rights')).toBe('/account?tab=rights');
    expect(safeConsoleHref('/dashboard')).toBeNull();
    expect(safeConsoleHref('/me/money')).toBeNull();
    expect(safeConsoleHref('https://evil.example/home')).toBeNull();

    expect(safeAdminHref('/admin')).toBe('/admin/tenants');
    expect(safeAdminHref('/admin/tenants')).toBe('/admin/tenants');
    expect(safeAdminHref('/admin/pricing')).toBe('/admin/pricing');
    expect(safeAdminHref('/admin/announcements')).toBe('/admin/announcements');
    expect(safeAdminHref('/admin/llm-costs')).toBe('/admin/llm-costs');
    expect(safeAdminHref('/admin/leads')).toBe('/admin/leads');
    expect(safeAdminHref('/admin/leads/')).toBe('/admin/leads');
    expect(safeAdminHref('/admin/templates')).toBeNull();
    expect(safeAdminHref('//evil.example/admin/tenants')).toBeNull();

    expect(safePostLoginHref('/brands?market=CN')).toBe('/brands?market=CN');
    expect(safePostLoginHref('/admin/pricing')).toBe('/admin/pricing');
    expect(safePostLoginHref('/admin/leads')).toBe('/admin/leads');
    expect(safePostLoginHref('/admin/templates')).toBeNull();
    expect(safePostLoginHref('/dashboard')).toBeNull();
  });

  it('keeps safeAdminHref in sync with @geomix/shared ADMIN_ROUTES', () => {
    expect(ADMIN_ROUTES.leads).toBe('/admin/leads');
    for (const route of Object.values(ADMIN_ROUTES)) {
      expect(safeAdminHref(route)).toBe(route);
      expect(safePostLoginHref(route)).toBe(route);
    }
  });

  it('redirects trailing-slash legacy paths to clean canonical paths while preserving query parameters', () => {
    const cases: Array<[string, string]> = [
      ['http://localhost:3000/dashboard/', 'http://localhost:3000/home'],
      ['http://localhost:3000/me/points/', 'http://localhost:3000/account?tab=points'],
      ['http://localhost:3000/visibility/overview/', 'http://localhost:3000/visibility'],
      [
        'http://localhost:3000/me/points?brandId=b1&market=GLOBAL',
        'http://localhost:3000/account?brandId=b1&market=GLOBAL&tab=points',
      ],
      ['http://localhost:3000/me/points?tab=verify', 'http://localhost:3000/account?tab=verify'],
    ];

    for (const [input, expectedLocation] of cases) {
      const response = middleware(new NextRequest(input));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(expectedLocation);
    }

    const passthrough = middleware(new NextRequest('http://localhost:3000/home?brandId=b1'));
    expect(passthrough.status).toBe(200);
    expect(passthrough.headers.get('location')).toBeNull();
  });
});
