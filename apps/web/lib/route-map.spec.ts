import { describe, expect, it } from 'vitest';
import {
  LEGACY_REDIRECTS,
  legacyPathname,
  safeAdminHref,
  safeConsoleHref,
  safePostLoginHref,
} from './route-map';

describe('legacy redirects (#7 / #72)', () => {
  it('maps all 15 documented legacy /user/* routes (including trailing slashes and common subpaths)', () => {
    const expected: Record<string, string> = {
      '/user/dashboard': '/dashboard',
      '/user/company_keyword': '/material/keywords',
      '/user/company_question': '/material/questions',
      '/user/images_type/index/type/1': '/material/gallery',
      '/user/user_huaxiang': '/material/knowledge',
      '/user/article_type': '/writing/categories',
      '/user/zhiling': '/writing/prompts',
      '/user/ai_task': '/writing/tasks',
      '/user/article': '/writing/articles',
      '/user/weixin_baowen': '/rewrite/single',
      '/user/piliang_baowen': '/rewrite/batch',
      '/user/ai_image': '/image',
      '/user/user_score_log': '/me/points',
      '/user/user_money_log': '/me/money',
      '/user/quanyi': '/me/rights',
      '/user/account_rights': '/me/rights',
    };

    expect(LEGACY_REDIRECTS).toEqual(expected);

    for (const [legacy, target] of Object.entries(expected)) {
      expect(legacyPathname(legacy)).toBe(target);
      expect(legacyPathname(`${legacy}/`)).toBe(target);
      expect(legacyPathname(`${legacy}/index`)).toBe(target);
    }
  });

  it('does not collide between /user/article_type and /user/article or invent targets for unknown paths', () => {
    expect(legacyPathname('/user/article_type')).toBe('/writing/categories');
    expect(legacyPathname('/user/article')).toBe('/writing/articles');
    expect(legacyPathname('/user/articles')).toBeNull();
    expect(legacyPathname('/user/other')).toBeNull();
    expect(legacyPathname('/writing/prompts')).toBeNull();
    expect(legacyPathname('/dashboard')).toBeNull();
  });

  it('only accepts an in-app console or admin href after login (#194)', () => {
    expect(safeConsoleHref('/writing/prompts')).toBe('/writing/prompts');
    expect(safeConsoleHref('/material/questions?keywordId=demo')).toBe(
      '/material/questions?keywordId=demo',
    );
    expect(safeConsoleHref('https://example.com/writing/prompts')).toBeNull();
    expect(safeConsoleHref('//example.com')).toBeNull();
    expect(safeConsoleHref('/user/zhiling')).toBeNull();

    expect(safeAdminHref('/admin')).toBe('/admin/tenants');
    expect(safeAdminHref('/admin/tenants')).toBe('/admin/tenants');
    expect(safeAdminHref('/admin/llm-costs/')).toBe('/admin/llm-costs');
    expect(safeAdminHref('/admin/unknown')).toBeNull();
    expect(safeAdminHref('//evil.example/admin/tenants')).toBeNull();

    expect(safePostLoginHref('/admin/tenants')).toBe('/admin/tenants');
    expect(safePostLoginHref('/me/rights')).toBe('/me/rights');
    expect(safePostLoginHref('https://example.com/admin/tenants')).toBeNull();
  });
});
