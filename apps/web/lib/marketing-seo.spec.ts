import { MARKETING_GUIDES, PUBLIC_PRICING_FALLBACK, SITE_NAME } from '@geomix/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as getLlmsTxt, dynamic as llmsDynamic } from '../app/llms.txt/route';
import robots, { dynamic as robotsDynamic } from '../app/robots';
import sitemap, { dynamic as sitemapDynamic } from '../app/sitemap';
import { buildLlmsTxt } from '../components/marketing/llms-txt';

const ORIGINAL_PUBLIC_APP_URL = process.env.PUBLIC_APP_URL;

afterEach(() => {
  if (ORIGINAL_PUBLIC_APP_URL === undefined) {
    delete process.env.PUBLIC_APP_URL;
  } else {
    process.env.PUBLIC_APP_URL = ORIGINAL_PUBLIC_APP_URL;
  }
});

describe('Self-GEO endpoints (robots.ts, sitemap.ts, llms.txt/route.ts)', () => {
  it('robots() allows major search & AI crawlers on / while disallowing private workspace/admin/API routes', () => {
    process.env.PUBLIC_APP_URL = 'https://geomix.example';
    const result = robots();

    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules.length).toBeGreaterThan(0);

    const primary = rules[0];
    if (!primary) throw new Error('Expected at least one robots rule');
    expect(primary.allow).toBe('/');
    expect(primary.userAgent).toEqual(
      expect.arrayContaining([
        '*',
        'Googlebot',
        'GPTBot',
        'OAI-SearchBot',
        'PerplexityBot',
        'ClaudeBot',
        'Bingbot',
        'Applebot-Extended',
      ]),
    );
    expect(primary.disallow).toEqual(
      expect.arrayContaining([
        '/admin',
        '/home',
        '/brands',
        '/visibility',
        '/studio',
        '/publish',
        '/account',
        '/share/',
        '/api/',
      ]),
    );
    expect(result.sitemap).toBe('https://geomix.example/sitemap.xml');
  });

  it('sitemap() emits all 16 EN + ZH static and guide entries with reciprocal alternates.languages', () => {
    process.env.PUBLIC_APP_URL = 'https://geomix.example';
    const entries = sitemap();

    // 4 static routes * 2 locales + 4 guides * 2 locales = 16
    expect(entries).toHaveLength(16);

    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain('https://geomix.example/');
    expect(urls).toContain('https://geomix.example/zh');
    expect(urls).toContain('https://geomix.example/pricing');
    expect(urls).toContain('https://geomix.example/zh/pricing');
    expect(urls).toContain('https://geomix.example/guides');
    expect(urls).toContain('https://geomix.example/zh/guides');
    expect(urls).toContain('https://geomix.example/demo');
    expect(urls).toContain('https://geomix.example/zh/demo');

    for (const guide of MARKETING_GUIDES) {
      expect(urls).toContain(`https://geomix.example/guides/${guide.slug}`);
      expect(urls).toContain(`https://geomix.example/zh/guides/${guide.slug}`);
    }

    for (const entry of entries) {
      const langs = entry.alternates?.languages as Record<string, string> | undefined;
      expect(langs?.en).toBeTruthy();
      expect(langs?.['zh-CN']).toBeTruthy();
      expect(langs?.['x-default']).toBe(langs?.en);
    }
  });

  it('GET /llms.txt returns text/plain; charset=utf-8 with accurate pricing, 7 free actions, guides, and Demo URL', async () => {
    process.env.PUBLIC_APP_URL = 'https://geomix.example';

    const response = await getLlmsTxt();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const text = await response.text();
    expect(text).toBe(buildLlmsTxt('https://geomix.example'));
    expect(text).toContain(`# ${SITE_NAME}`);
    expect(text).toContain('https://geomix.example/demo');
    expect(text).toContain('https://geomix.example/zh/demo');
    expect(text).toContain('https://geomix.example/pricing');
    expect(text).toContain('1,000 points valid for 365 days');

    for (const item of PUBLIC_PRICING_FALLBACK.items) {
      expect(text).toContain(`${item.action}`);
      expect(text).toContain(`${item.unitPoints} ${item.unitEn}`);
    }
    for (const freeAction of PUBLIC_PRICING_FALLBACK.freeActions) {
      expect(text).toContain(`${freeAction.action}`);
    }
    for (const guide of MARKETING_GUIDES) {
      expect(text).toContain(`https://geomix.example/guides/${guide.slug}`);
      expect(text).toContain(`https://geomix.example/zh/guides/${guide.slug}`);
    }
  });

  it('marks robots.ts, sitemap.ts, and llms.txt/route.ts as force-dynamic for runtime PUBLIC_APP_URL resolution', async () => {
    expect(robotsDynamic).toBe('force-dynamic');
    expect(sitemapDynamic).toBe('force-dynamic');
    expect(llmsDynamic).toBe('force-dynamic');

    const llmsRouteModule = await import('../app/llms.txt/route');
    expect(Object.keys(llmsRouteModule).sort()).toEqual(['GET', 'dynamic']);
  });
});
