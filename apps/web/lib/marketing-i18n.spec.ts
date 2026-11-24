import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKETING_LOCALE,
  DEFAULT_MARKETING_SITE_URL,
  MARKETING_STATIC_PATHS,
  ZH_LOCALE_PREFIX,
  buildMarketingAlternates,
  buildMarketingCanonical,
  getMarketingLocaleFromPath,
  getMarketingSiteUrl,
  isMarketingPath,
  stripMarketingLocalePrefix,
  switchMarketingPathLocale,
  toLocalizedMarketingPath,
} from './marketing-i18n';

describe('marketing-i18n constants and getMarketingLocaleFromPath', () => {
  it('exports canonical defaults and detects EN vs ZH locales with exact /zh segment boundary', () => {
    expect(DEFAULT_MARKETING_LOCALE).toBe('en');
    expect(ZH_LOCALE_PREFIX).toBe('/zh');
    expect(DEFAULT_MARKETING_SITE_URL).toBe('http://localhost:3000');
    expect(MARKETING_STATIC_PATHS).toEqual(['/', '/pricing', '/guides', '/demo']);

    expect(getMarketingLocaleFromPath('/')).toBe('en');
    expect(getMarketingLocaleFromPath('/pricing')).toBe('en');
    expect(getMarketingLocaleFromPath('/guides/geo-citation-vs-mention')).toBe('en');
    expect(getMarketingLocaleFromPath('/demo')).toBe('en');
    expect(getMarketingLocaleFromPath(null)).toBe('en');
    expect(getMarketingLocaleFromPath(undefined)).toBe('en');
    expect(getMarketingLocaleFromPath('')).toBe('en');
    expect(getMarketingLocaleFromPath('   ')).toBe('en');

    expect(getMarketingLocaleFromPath('/zh')).toBe('zh-CN');
    expect(getMarketingLocaleFromPath('/zh/')).toBe('zh-CN');
    expect(getMarketingLocaleFromPath('/zh/pricing')).toBe('zh-CN');
    expect(getMarketingLocaleFromPath('/zh/guides/geo-citation-vs-mention')).toBe('zh-CN');
    expect(getMarketingLocaleFromPath('/zh/demo?estimatedPts=500')).toBe('zh-CN');
    expect(getMarketingLocaleFromPath('/zh/zh/pricing')).toBe('zh-CN');
    expect(getMarketingLocaleFromPath('/zh#workflow')).toBe('zh-CN');

    // Lookalike prefixes must NOT be misclassified as /zh
    expect(getMarketingLocaleFromPath('/zh-cn')).toBe('en');
    expect(getMarketingLocaleFromPath('/zh-cn/pricing')).toBe('en');
    expect(getMarketingLocaleFromPath('/zh2')).toBe('en');
    expect(getMarketingLocaleFromPath('/zhang')).toBe('en');

    // Non-marketing and unsafe paths default to EN
    expect(getMarketingLocaleFromPath('/home')).toBe('en');
    expect(getMarketingLocaleFromPath('/login')).toBe('en');
    expect(getMarketingLocaleFromPath('//evil.example/zh/pricing')).toBe('en');
    expect(getMarketingLocaleFromPath('https://evil.example/zh/pricing')).toBe('en');
  });
});

describe('stripMarketingLocalePrefix and isMarketingPath', () => {
  it('strips single and repeated /zh prefixes while preserving query/hash and rejecting unsafe input', () => {
    expect(stripMarketingLocalePrefix('/')).toBe('/');
    expect(stripMarketingLocalePrefix('///')).toBe('/');
    expect(stripMarketingLocalePrefix('/zh')).toBe('/');
    expect(stripMarketingLocalePrefix('/zh/')).toBe('/');
    expect(stripMarketingLocalePrefix('/zh/zh')).toBe('/');
    expect(stripMarketingLocalePrefix('/zh/zh/pricing/')).toBe('/pricing');
    expect(stripMarketingLocalePrefix('/zh/guides/geo-citation-vs-mention/')).toBe(
      '/guides/geo-citation-vs-mention',
    );
    expect(stripMarketingLocalePrefix('/zh/demo?estimatedPts=500#form')).toBe(
      '/demo?estimatedPts=500#form',
    );
    expect(stripMarketingLocalePrefix('/zh#workflow')).toBe('/#workflow');
    expect(stripMarketingLocalePrefix('/zh-cn/pricing')).toBe('/zh-cn/pricing');
    expect(stripMarketingLocalePrefix('/login?next=/home')).toBe('/login?next=/home');

    expect(stripMarketingLocalePrefix('//evil.example/pricing')).toBe('/');
    expect(stripMarketingLocalePrefix('https://evil.example/zh')).toBe('/');
    expect(stripMarketingLocalePrefix('/guides/../admin')).toBe('/');
    expect(stripMarketingLocalePrefix('\\admin')).toBe('/');
    expect(stripMarketingLocalePrefix('')).toBe('/');
  });

  it('classifies valid public marketing paths accurately and rejects non-marketing/unsafe paths', () => {
    const validPaths = [
      '/',
      '/zh',
      '/zh/',
      '/pricing/',
      '/zh/pricing',
      '/guides',
      '/zh/guides',
      '/guides/geo-citation-vs-mention',
      '/zh/guides/t7-t14-t30-attribution/',
      '/demo?estimatedPts=500',
      '/zh/zh/demo',
    ];
    for (const path of validPaths) {
      expect(isMarketingPath(path)).toBe(true);
    }

    const invalidPaths = [
      '/login',
      '/home',
      '/admin/leads',
      '/share/pr/tok',
      '/api/v2/public/pricing',
      '/guides/a/b',
      '/zh/login',
      '/zh-cn/pricing',
      '/unknown',
      '/robots.txt',
      '//evil.example/pricing',
      '///evil.example/pricing',
      '////pricing',
      '///zh/pricing',
      '//?next=https://evil.example',
      'https://evil.example/zh',
      '/guides/../admin',
      '/guides/%2e%2e',
      '/zh/guides/%2e%2e',
      '/guides/%2E%2E',
      '/guides/%2e',
      '/zh/guides/%2e%2e/admin',
      '/guides/%2e%2e%2fadmin',
      '/zh/guides/%2e%2e%2f..%2fadmin',
      '/guides/..%2fadmin',
      '/guides/%5cadmin',
      '/guides/%2f%2fevil.example',
      '/guides/foo%00bar',
      '/guides/foo%0d%0abar',
      '/guides/foo bar',
      '/guides/foo%20bar',
      '/guides/%ZZ',
      '/guides/%E0%A4%A',
      '/guides/%2',
      '/guides/UpperCase',
      '/pricing\r\n',
      '\\admin',
      '',
    ];
    for (const path of invalidPaths) {
      expect(isMarketingPath(path)).toBe(false);
    }

    const adversarialSafeFallbacks = [
      '/guides/%2e%2e',
      '/zh/guides/%2e%2e',
      '/guides/%2E%2E',
      '/guides/%2e',
      '/zh/guides/%2e%2e/admin',
      '/guides/%2e%2e%2fadmin',
      '/guides/%5cadmin',
      '/guides/%2f%2fevil.example',
      '/guides/foo%00bar',
      '/guides/foo%0d%0abar',
      '/guides/foo bar',
      '/guides/%ZZ',
      '///evil.example/pricing',
      '////pricing',
      '///zh/pricing',
      '//?next=https://evil.example',
      '/pricing\r\n',
    ];
    for (const path of adversarialSafeFallbacks) {
      expect(stripMarketingLocalePrefix(path)).toBe('/');
      expect(toLocalizedMarketingPath(path, 'en')).toBe('/');
      expect(toLocalizedMarketingPath(path, 'zh-CN')).toBe('/zh');
      expect(buildMarketingCanonical(path, 'https://geomix.example')).toBe(
        'https://geomix.example/',
      );
    }
  });
});

describe('toLocalizedMarketingPath and switchMarketingPathLocale', () => {
  it('maps EN <-> ZH paths bidirectionally while preserving query strings and hashes', () => {
    expect(toLocalizedMarketingPath('/', 'zh-CN')).toBe('/zh');
    expect(toLocalizedMarketingPath('/', 'en')).toBe('/');
    expect(toLocalizedMarketingPath('/zh', 'en')).toBe('/');
    expect(toLocalizedMarketingPath('/zh/', 'en')).toBe('/');
    expect(toLocalizedMarketingPath('/zh/', 'zh-CN')).toBe('/zh');

    expect(toLocalizedMarketingPath('/pricing/', 'zh-CN')).toBe('/zh/pricing');
    expect(toLocalizedMarketingPath('/pricing/', 'en')).toBe('/pricing');
    expect(toLocalizedMarketingPath('/zh/demo/', 'en')).toBe('/demo');
    expect(toLocalizedMarketingPath('/zh/demo/', 'zh-CN')).toBe('/zh/demo');

    expect(toLocalizedMarketingPath('/guides/geo-citation-vs-mention', 'zh-CN')).toBe(
      '/zh/guides/geo-citation-vs-mention',
    );
    expect(toLocalizedMarketingPath('/zh/guides/geo-citation-vs-mention', 'en')).toBe(
      '/guides/geo-citation-vs-mention',
    );

    expect(toLocalizedMarketingPath('/demo?estimatedPts=500', 'zh-CN')).toBe(
      '/zh/demo?estimatedPts=500',
    );
    expect(toLocalizedMarketingPath('/zh/demo?estimatedPts=500', 'en')).toBe(
      '/demo?estimatedPts=500',
    );
    expect(toLocalizedMarketingPath('/#workflow', 'zh-CN')).toBe('/zh#workflow');
    expect(toLocalizedMarketingPath('/zh#workflow', 'en')).toBe('/#workflow');
    expect(toLocalizedMarketingPath('/zh/pricing/?estimatedPts=1200#calc', 'en')).toBe(
      '/pricing?estimatedPts=1200#calc',
    );
  });

  it('normalizes malformed /zh/zh prefixes, supports toggle switching, and guards non-marketing/unsafe paths', () => {
    expect(toLocalizedMarketingPath('/zh/zh/pricing', 'zh-CN')).toBe('/zh/pricing');
    expect(switchMarketingPathLocale('/zh/zh/demo', 'en')).toBe('/demo');
    expect(switchMarketingPathLocale('/zh/pricing')).toBe('/pricing');
    expect(switchMarketingPathLocale('/pricing')).toBe('/zh/pricing');
    expect(switchMarketingPathLocale('/')).toBe('/zh');
    expect(switchMarketingPathLocale('/zh')).toBe('/');

    // Non-marketing paths fall back cleanly without leaking query parameters
    expect(switchMarketingPathLocale('/login?next=/home', 'zh-CN')).toBe('/zh');
    expect(switchMarketingPathLocale('/home', 'en')).toBe('/');
    expect(switchMarketingPathLocale('/admin/leads', 'zh-CN')).toBe('/zh');
    expect(toLocalizedMarketingPath('/zh-cn/pricing', 'zh-CN')).toBe('/zh');
    expect(toLocalizedMarketingPath('/zh-cn/pricing', 'en')).toBe('/');

    // Unsafe inputs fall back safely
    expect(toLocalizedMarketingPath('//evil.example/pricing', 'zh-CN')).toBe('/zh');
    expect(toLocalizedMarketingPath('javascript:alert(1)', 'en')).toBe('/');
    expect(toLocalizedMarketingPath('/guides/../admin/leads', 'zh-CN')).toBe('/zh');
  });
});

describe('getMarketingSiteUrl', () => {
  it('prefers PUBLIC_APP_URL, falls back to first WEB_ORIGIN entry, and sanitizes invalid values', () => {
    expect(
      getMarketingSiteUrl({
        PUBLIC_APP_URL: 'https://geomix.example///',
        WEB_ORIGIN: 'http://127.0.0.1:3000',
      }),
    ).toBe('https://geomix.example');

    expect(
      getMarketingSiteUrl({
        PUBLIC_APP_URL: '   ',
        WEB_ORIGIN: '  http://127.0.0.1:3000/ , https://other.example ',
      }),
    ).toBe('http://127.0.0.1:3000');

    expect(
      getMarketingSiteUrl({
        PUBLIC_APP_URL: 'https://geomix.example/sub/?a=1#hash',
      }),
    ).toBe('https://geomix.example/sub');

    expect(
      getMarketingSiteUrl({
        WEB_ORIGIN: 'invalid-url, https://geomix.example/',
      }),
    ).toBe('https://geomix.example');

    expect(
      getMarketingSiteUrl({
        WEB_ORIGIN: ', https://geomix.example/',
      }),
    ).toBe('https://geomix.example');

    expect(
      getMarketingSiteUrl({
        PUBLIC_APP_URL: 'https://geomix.example//sub//dir///',
      }),
    ).toBe('https://geomix.example/sub/dir');

    expect(getMarketingSiteUrl({ PUBLIC_APP_URL: 'https://geomix.example\r\n' })).toBe(
      DEFAULT_MARKETING_SITE_URL,
    );
    expect(getMarketingSiteUrl({ PUBLIC_APP_URL: 'ftp://geomix.example' })).toBe(
      DEFAULT_MARKETING_SITE_URL,
    );
    expect(getMarketingSiteUrl({ PUBLIC_APP_URL: 'not-a-url' })).toBe(DEFAULT_MARKETING_SITE_URL);
    expect(getMarketingSiteUrl({ PUBLIC_APP_URL: 'https://user:pass@geomix.example' })).toBe(
      DEFAULT_MARKETING_SITE_URL,
    );
    expect(getMarketingSiteUrl({})).toBe(DEFAULT_MARKETING_SITE_URL);
  });
});

describe('buildMarketingCanonical and buildMarketingAlternates', () => {
  const originalPublicAppUrl = process.env.PUBLIC_APP_URL;
  const originalWebOrigin = process.env.WEB_ORIGIN;

  afterEach(() => {
    if (originalPublicAppUrl === undefined) {
      delete process.env.PUBLIC_APP_URL;
    } else {
      process.env.PUBLIC_APP_URL = originalPublicAppUrl;
    }

    if (originalWebOrigin === undefined) {
      delete process.env.WEB_ORIGIN;
    } else {
      process.env.WEB_ORIGIN = originalWebOrigin;
    }
  });

  it('builds clean canonical URLs stripping query strings, hashes, and duplicate slashes', () => {
    expect(buildMarketingCanonical('/', 'https://geomix.example///')).toBe(
      'https://geomix.example/',
    );
    expect(buildMarketingCanonical('/zh/', 'https://geomix.example///')).toBe(
      'https://geomix.example/zh',
    );
    expect(
      buildMarketingCanonical('/pricing/?estimatedPts=500#calc', 'https://geomix.example'),
    ).toBe('https://geomix.example/pricing');
    expect(
      buildMarketingCanonical('/zh/pricing/?estimatedPts=500#calc', 'https://geomix.example'),
    ).toBe('https://geomix.example/zh/pricing');
    expect(buildMarketingCanonical('/zh/zh/demo/', 'https://geomix.example')).toBe(
      'https://geomix.example/zh/demo',
    );
    expect(buildMarketingCanonical('/sitemap.xml', 'https://geomix.example/')).toBe(
      'https://geomix.example/sitemap.xml',
    );
    expect(buildMarketingCanonical('//evil.example/pricing', 'https://geomix.example')).toBe(
      'https://geomix.example/',
    );
  });

  it('produces reciprocal self-referencing alternates for EN and ZH pages and falls back on non-marketing routes', () => {
    const rootEn = buildMarketingAlternates('/', 'https://geomix.example');
    expect(rootEn).toEqual({
      canonical: 'https://geomix.example/',
      languages: {
        en: 'https://geomix.example/',
        'zh-CN': 'https://geomix.example/zh',
        'x-default': 'https://geomix.example/',
      },
    });

    const rootZh = buildMarketingAlternates('/zh', 'https://geomix.example');
    expect(rootZh).toEqual({
      canonical: 'https://geomix.example/zh',
      languages: {
        en: 'https://geomix.example/',
        'zh-CN': 'https://geomix.example/zh',
        'x-default': 'https://geomix.example/',
      },
    });

    const guideEn = buildMarketingAlternates(
      '/guides/geo-citation-vs-mention',
      'https://geomix.example/',
    );
    const guideZh = buildMarketingAlternates(
      '/zh/guides/geo-citation-vs-mention/?ref=nav#top',
      'https://geomix.example/',
    );
    expect(guideEn).toEqual({
      canonical: 'https://geomix.example/guides/geo-citation-vs-mention',
      languages: {
        en: 'https://geomix.example/guides/geo-citation-vs-mention',
        'zh-CN': 'https://geomix.example/zh/guides/geo-citation-vs-mention',
        'x-default': 'https://geomix.example/guides/geo-citation-vs-mention',
      },
    });
    expect(guideZh).toEqual({
      canonical: 'https://geomix.example/zh/guides/geo-citation-vs-mention',
      languages: guideEn.languages,
    });

    expect(buildMarketingAlternates('/zh/zh/demo', 'https://geomix.example')).toEqual({
      canonical: 'https://geomix.example/zh/demo',
      languages: {
        en: 'https://geomix.example/demo',
        'zh-CN': 'https://geomix.example/zh/demo',
        'x-default': 'https://geomix.example/demo',
      },
    });

    expect(buildMarketingAlternates('/login', 'https://geomix.example')).toEqual(rootEn);

    expect(buildMarketingAlternates('/zh/pricing', 'https://geomix.example//sub//dir///')).toEqual({
      canonical: 'https://geomix.example/sub/dir/zh/pricing',
      languages: {
        en: 'https://geomix.example/sub/dir/pricing',
        'zh-CN': 'https://geomix.example/sub/dir/zh/pricing',
        'x-default': 'https://geomix.example/sub/dir/pricing',
      },
    });

    process.env.PUBLIC_APP_URL = 'https://app.geomix.example/';
    expect(buildMarketingAlternates('/pricing')).toEqual({
      canonical: 'https://app.geomix.example/pricing',
      languages: {
        en: 'https://app.geomix.example/pricing',
        'zh-CN': 'https://app.geomix.example/zh/pricing',
        'x-default': 'https://app.geomix.example/pricing',
      },
    });
  });
});

describe('production deployment ops contract (Self-GEO & SSR pricing)', () => {
  it('exposes PUBLIC_APP_URL, WEB_ORIGIN, and INTERNAL_API_BASE to docker-compose.prod.yml web service without env_file and documents INTERNAL_API_BASE in .env.example', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const composeRaw = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    const envExampleRaw = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');

    const webServiceMatch = composeRaw.match(
      /\n  web:\n([\s\S]*?)(?:\n  [a-zA-Z0-9_-]+:|\nvolumes:|$)/,
    );
    expect(webServiceMatch, 'docker-compose.prod.yml must define a web service').toBeTruthy();
    const webBlock = webServiceMatch?.[1] ?? '';

    expect(webBlock).not.toMatch(/^\s*env_file:/m);
    expect(webBlock).toMatch(/^\s*PUBLIC_APP_URL:\s*\$\{PUBLIC_APP_URL:-\}/m);
    expect(webBlock).toMatch(/^\s*WEB_ORIGIN:\s*\$\{WEB_ORIGIN:-\}/m);
    expect(webBlock).toMatch(
      /^\s*INTERNAL_API_BASE:\s*\$\{INTERNAL_API_BASE:-http:\/\/api:3001\/api\/v1\}/m,
    );

    expect(envExampleRaw).toMatch(/^INTERNAL_API_BASE=/m);
  });
});
