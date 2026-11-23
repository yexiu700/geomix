import { describe, expect, it, vi } from 'vitest';
import { AUTH_ERROR, CRAWL_PROBE_BOTS, crawlProbeReportSchema } from '@geomix/shared';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import type { DnsResolver, HttpTransport, TransportResponse } from '../infra/guarded-request';
import { OutboundHttpClient } from '../infra/outbound-http';
import type { PrismaService } from '../prisma/prisma.service';
import { currentTenantId, runInTenant } from '../tenant/tenant-context';
import { CrawlProbeService, readCrawlProbeRateLimit } from './crawl-probe.service';

function makeClient(
  routes: Record<string, TransportResponse | ((url: URL) => TransportResponse)>,
  dnsMap: Record<string, Array<{ address: string; family: 4 | 6 }>> = {},
) {
  const calls: string[] = [];
  const resolver: DnsResolver = {
    async resolve(host) {
      return dnsMap[host] ?? [{ address: '93.184.216.34', family: 4 }];
    },
  };
  const transport: HttpTransport = async (req) => {
    const key = req.url.toString();
    calls.push(key);
    const handler = routes[key];
    if (!handler) {
      return {
        status: 404,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('Not Found'),
      };
    }
    return typeof handler === 'function' ? handler(req.url) : handler;
  };
  const client = new OutboundHttpClient({ resolver, transport });
  return { client, calls };
}

function htmlRes(
  html: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
    body: Buffer.from(html, 'utf8'),
  };
}

function textRes(text: string, status = 200): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from(text, 'utf8'),
  };
}

function makeDummyPrisma(): PrismaService {
  return {
    scoped: { geoPublishRecord: {} },
    base: { geoPublishRecord: {} },
  } as unknown as PrismaService;
}

describe('CrawlProbeService.probeUrl', () => {
  it('returns OK and extracts @type, array, and @graph JSON-LD + matching canonical on healthy 200 page', async () => {
    const pageUrl = 'https://blog.example.com/guides/nas-setup/';
    const html = `<!doctype html>
      <html>
        <head>
          <link href="/guides/nas-setup" rel="canonical" />
          <script type="application/ld+json; charset=utf-8">
            {"@context":"https://schema.org","@type":"Article","headline":"NAS Setup"}
          </script>
          <script type='application/ld+json'>
            {"@context":"https://schema.org","@graph":[
              {"@type":["FAQPage","WebPage"]},
              {"@type":"Article"}
            ]}
          </script>
          <script type="application/ld+json">
            [{"@type":"BreadcrumbList"}]
          </script>
        </head>
        <body><h1>Guide</h1></body>
      </html>`;
    const { client } = makeClient({
      [pageUrl]: htmlRes(html),
      'https://blog.example.com/robots.txt': textRes('User-agent: *\nAllow: /\n'),
    });

    const service = new CrawlProbeService(makeDummyPrisma(), client);
    const result = await service.probeUrl(pageUrl);

    expect(result.status).toBe('OK');
    expect(result.report.httpStatus).toBe(200);
    expect(result.report.robotsTxtFound).toBe(true);
    expect(result.report.robotsMatrix).toHaveLength(CRAWL_PROBE_BOTS.length);
    expect(result.report.robotsMatrix.every((r) => r.allowed)).toBe(true);
    expect(result.report.metaNoindex).toBe(false);
    expect(result.report.jsonLdTypes).toEqual(['Article', 'FAQPage', 'WebPage', 'BreadcrumbList']);
    expect(result.report.jsonLdParseErrors).toEqual([]);
    expect(result.report.canonicalUrl).toBe('https://blog.example.com/guides/nas-setup');
    expect(result.report.canonicalMatches).toBe(true);
    expect(result.report.issues).toEqual([]);
    expect(crawlProbeReportSchema.safeParse(result.report).success).toBe(true);
  });

  it('returns BLOCKED when robots.txt disallows GPTBot while allowing other bots', async () => {
    const pageUrl = 'https://blog.example.com/guides/nas';
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Article"}</script>
    </head><body>ok</body></html>`;
    const robots = ['User-agent: *', 'Allow: /', '', 'User-agent: GPTBot', 'Disallow: /'].join(
      '\n',
    );
    const { client } = makeClient({
      [pageUrl]: htmlRes(html),
      'https://blog.example.com/robots.txt': textRes(robots),
    });

    const service = new CrawlProbeService(makeDummyPrisma(), client);
    const result = await service.probeUrl(pageUrl);

    expect(result.status).toBe('BLOCKED');
    const gpt = result.report.robotsMatrix.find((r) => r.bot === 'GPTBot');
    const perplexity = result.report.robotsMatrix.find((r) => r.bot === 'PerplexityBot');
    expect(gpt).toEqual({ bot: 'GPTBot', allowed: false, matchedRule: 'Disallow: /' });
    expect(perplexity?.allowed).toBe(true);
    expect(result.report.issues.some((i) => i.includes('GPTBot'))).toBe(true);
    expect(crawlProbeReportSchema.safeParse(result.report).success).toBe(true);
  });

  it('returns BLOCKED when meta robots or X-Robots-Tag contains noindex', async () => {
    const pageUrl1 = 'https://blog.example.com/noindex-meta';
    const pageUrl2 = 'https://blog.example.com/noindex-header';
    const { client } = makeClient({
      [pageUrl1]: htmlRes(
        `<html><head>
          <meta content='index, NOINDEX' name=robots>
          <script type="application/ld+json">{"@type":"Article"}</script>
        </head></html>`,
      ),
      [pageUrl2]: htmlRes(
        `<html><head>
          <script type="application/ld+json">{"@type":"Article"}</script>
        </head></html>`,
        200,
        { 'X-Robots-Tag': 'googlebot: noindex' },
      ),
      'https://blog.example.com/robots.txt': textRes('', 404),
    });

    const service = new CrawlProbeService(makeDummyPrisma(), client);

    const res1 = await service.probeUrl(pageUrl1);
    expect(res1.status).toBe('BLOCKED');
    expect(res1.report.metaNoindex).toBe(true);
    expect(res1.report.robotsTxtFound).toBe(false);
    expect(res1.report.robotsMatrix.every((r) => r.allowed)).toBe(true);

    const res2 = await service.probeUrl(pageUrl2);
    expect(res2.status).toBe('BLOCKED');
    expect(res2.report.metaNoindex).toBe(true);
  });

  it('returns WARNING for malformed JSON-LD, missing JSON-LD, canonical mismatch, and robots.txt 500', async () => {
    const malformedUrl = 'https://blog.example.com/malformed';
    const missingUrl = 'https://blog.example.com/missing';
    const canonicalMismatchUrl = 'https://blog.example.com/canonical-diff';
    const robots500Url = 'https://err-robots.example.com/page';

    const { client } = makeClient({
      [malformedUrl]: htmlRes(
        '<html><head><script type="application/ld+json">{bad json</script></head></html>',
      ),
      [missingUrl]: htmlRes('<html><body>no schema here</body></html>'),
      [canonicalMismatchUrl]: htmlRes(
        `<html><head>
          <link rel="canonical" href="https://other.example.com/different-page" />
          <script type="application/ld+json">{"@type":"Article"}</script>
        </head></html>`,
      ),
      'https://blog.example.com/robots.txt': textRes('User-agent: *\nAllow: /\n'),
      [robots500Url]: htmlRes(
        '<html><head><script type="application/ld+json">{"@type":"Article"}</script></head></html>',
      ),
      'https://err-robots.example.com/robots.txt': textRes('Server Error', 500),
    });

    const service = new CrawlProbeService(makeDummyPrisma(), client);

    const malformed = await service.probeUrl(malformedUrl);
    expect(malformed.status).toBe('WARNING');
    expect(malformed.report.jsonLdParseErrors.length).toBeGreaterThan(0);

    const missing = await service.probeUrl(missingUrl);
    expect(missing.status).toBe('WARNING');
    expect(missing.report.jsonLdTypes).toEqual([]);

    const mismatch = await service.probeUrl(canonicalMismatchUrl);
    expect(mismatch.status).toBe('WARNING');
    expect(mismatch.report.canonicalMatches).toBe(false);
    expect(mismatch.report.canonicalUrl).toBe('https://other.example.com/different-page');

    const robotsErr = await service.probeUrl(robots500Url);
    expect(robotsErr.status).toBe('WARNING');
    expect(robotsErr.report.robotsTxtFound).toBe(false);
    expect(robotsErr.report.issues.some((i) => i.includes('robots.txt'))).toBe(true);
  });

  it('classifies HTTP 401/403 as BLOCKED and HTTP 300/304/404/500 as FAILED', async () => {
    const { client } = makeClient({
      'https://blog.example.com/auth': htmlRes('Unauthorized', 401),
      'https://blog.example.com/forbid': htmlRes('Forbidden', 403),
      'https://blog.example.com/multiple-choices': htmlRes('Multiple Choices', 300),
      'https://blog.example.com/not-modified': htmlRes('', 304),
      'https://blog.example.com/missing': htmlRes('Not Found', 404),
      'https://blog.example.com/crash': htmlRes('Internal Error', 500),
    });
    const service = new CrawlProbeService(makeDummyPrisma(), client);

    const r401 = await service.probeUrl('https://blog.example.com/auth');
    expect(r401.status).toBe('BLOCKED');
    expect(r401.report.httpStatus).toBe(401);

    const r403 = await service.probeUrl('https://blog.example.com/forbid');
    expect(r403.status).toBe('BLOCKED');
    expect(r403.report.httpStatus).toBe(403);

    const r300 = await service.probeUrl('https://blog.example.com/multiple-choices');
    expect(r300.status).toBe('FAILED');
    expect(r300.report.httpStatus).toBe(300);
    expect(crawlProbeReportSchema.safeParse(r300.report).success).toBe(true);

    const r304 = await service.probeUrl('https://blog.example.com/not-modified');
    expect(r304.status).toBe('FAILED');
    expect(r304.report.httpStatus).toBe(304);
    expect(crawlProbeReportSchema.safeParse(r304.report).success).toBe(true);

    const r404 = await service.probeUrl('https://blog.example.com/missing');
    expect(r404.status).toBe('FAILED');
    expect(r404.report.httpStatus).toBe(404);

    const r500 = await service.probeUrl('https://blog.example.com/crash');
    expect(r500.status).toBe('FAILED');
    expect(r500.report.httpStatus).toBe(500);
  });

  it('produces schema-valid FAILED report with non-empty checkedUrl when probeUrl is called with empty or blank URL', async () => {
    const { client } = makeClient({});
    const service = new CrawlProbeService(makeDummyPrisma(), client);

    for (const raw of ['', '   ']) {
      const result = await service.probeUrl(raw);
      expect(result.status).toBe('FAILED');
      expect(result.report.checkedUrl).toBe('(empty)');
      expect(result.report.httpStatus).toBeNull();
      expect(crawlProbeReportSchema.safeParse(result.report).success).toBe(true);
    }
  });

  it('blocks private IP, metadata IP, DNS-to-private-IP, and redirect-to-private-IP without leaking private IPs', async () => {
    const { client, calls } = makeClient(
      {
        'https://public-redir.example.com/jump': {
          status: 302,
          headers: { location: 'http://192.168.1.50/internal' },
          body: Buffer.alloc(0),
        },
      },
      {
        'dns-rebind.example.com': [{ address: '10.0.0.42', family: 4 }],
      },
    );
    const service = new CrawlProbeService(makeDummyPrisma(), client);

    const directPrivate = await service.probeUrl('http://127.0.0.1/secret');
    expect(directPrivate.status).toBe('FAILED');
    expect(directPrivate.report.httpStatus).toBeNull();
    expect(directPrivate.report.errorMessage).not.toContain('127.0.0.1');
    expect(directPrivate.report.issues.join(' ')).not.toContain('127.0.0.1');

    const metadata = await service.probeUrl('http://169.254.169.254/latest/meta-data/');
    expect(metadata.status).toBe('FAILED');
    expect(metadata.report.errorMessage).not.toContain('169.254.169.254');

    const dnsPrivate = await service.probeUrl('https://dns-rebind.example.com/post');
    expect(dnsPrivate.status).toBe('FAILED');
    expect(dnsPrivate.report.errorMessage).not.toContain('10.0.0.42');
    expect(dnsPrivate.report.issues.join(' ')).not.toContain('10.0.0.42');

    const redirectPrivate = await service.probeUrl('https://public-redir.example.com/jump');
    expect(redirectPrivate.status).toBe('FAILED');
    expect(redirectPrivate.report.httpStatus).toBeNull();
    expect(redirectPrivate.report.errorMessage).not.toContain('192.168.1.50');
    expect(redirectPrivate.report.issues.join(' ')).not.toContain('192.168.1.50');

    // Only the initial public redirect URL ever hit transport — zero private transport calls
    expect(calls).toEqual(['https://public-redir.example.com/jump']);
  });
});

describe('CrawlProbeService.probePublishRecord & runSweep', () => {
  it('enforces crawl_probe rate limit on manual trigger, returns 404 on missing record, and persists report', async () => {
    const pageUrl = 'https://blog.example.com/post-1';
    const { client } = makeClient({
      [pageUrl]: htmlRes(
        '<html><head><script type="application/ld+json">{"@type":"Article"}</script></head></html>',
      ),
      'https://blog.example.com/robots.txt': textRes('User-agent: *\nAllow: /\n'),
    });

    const baseRow = {
      id: 'pub_1',
      tenantId: 'tenant_a',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      articleId: 'art_1',
      publishedUrl: pageUrl,
      channel: 'Shopify',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
      baselineRunId: null,
      latestRetestRunId: null,
      beforeMetrics: null,
      afterMetrics: null,
      distributionTaskId: null,
      crawlStatus: 'PENDING',
      crawlCheckedAt: null as Date | null,
      crawlReportJson: null as unknown,
      indexNowSubmitted: false,
      retestSchedules: [],
    };

    const updateSpy = vi.fn(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...baseRow,
        ...args.data,
      }),
    );

    const prisma = {
      scoped: {
        geoPublishRecord: {
          findFirst: vi.fn(async (args: { where: { id: string } }) =>
            args.where.id === 'pub_1' && currentTenantId() === 'tenant_a' ? baseRow : null,
          ),
          update: updateSpy,
        },
      },
      base: { geoPublishRecord: { findMany: vi.fn() } },
    } as unknown as PrismaService;

    const rateLimiter = new FreeActionRateLimiter();
    const service = new CrawlProbeService(prisma, client, rateLimiter);

    // Cross-tenant 404
    await runInTenant('tenant_b', async () => {
      await expect(service.probePublishRecord('pub_1')).rejects.toMatchObject({
        status: 404,
        code: AUTH_ERROR.NOT_FOUND,
      });
    });

    // Manual trigger succeeds and persists crawlStatus='OK'
    await runInTenant('tenant_a', async () => {
      const dto = await service.probePublishRecord('pub_1');
      expect(dto.crawlStatus).toBe('OK');
      expect(dto.crawlCheckedAt).toBeTruthy();
      expect(dto.crawlReportJson?.jsonLdTypes).toEqual(['Article']);
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    // Exhaust 30/min default rate limit -> 429
    const prevMax = process.env.CRAWL_PROBE_RATE_LIMIT_MAX;
    process.env.CRAWL_PROBE_RATE_LIMIT_MAX = '1';
    try {
      const strictLimiter = new FreeActionRateLimiter();
      const limitedService = new CrawlProbeService(prisma, client, strictLimiter);
      await runInTenant('tenant_a', async () => {
        await limitedService.probePublishRecord('pub_1');
        await expect(limitedService.probePublishRecord('pub_1')).rejects.toMatchObject({
          status: 429,
          code: AUTH_ERROR.TOO_MANY_REQUESTS,
        });
      });
    } finally {
      if (prevMax === undefined) delete process.env.CRAWL_PROBE_RATE_LIMIT_MAX;
      else process.env.CRAWL_PROBE_RATE_LIMIT_MAX = prevMax;
    }
  });

  it('runSweep respects 24h cutoff, batchSize cap, runInTenant isolation, and skips rate limit', async () => {
    const pageUrlA = 'https://a.example.com/article';
    const pageUrlB = 'https://b.example.com/article';
    const { client } = makeClient({
      [pageUrlA]: htmlRes(
        '<html><head><script type="application/ld+json">{"@type":"Article"}</script></head></html>',
      ),
      'https://a.example.com/robots.txt': textRes('User-agent: *\nAllow: /\n'),
      [pageUrlB]: htmlRes('<html><body>no schema</body></html>'),
      'https://b.example.com/robots.txt': textRes('User-agent: *\nAllow: /\n'),
    });

    const seenTenants: string[] = [];
    const baseFindMany = vi.fn(async (_args?: unknown) => [
      { id: 'pub_a', tenantId: 'tenant_a' },
      { id: 'pub_b', tenantId: 'tenant_b' },
    ]);

    const rows: Record<string, { id: string; tenantId: string; publishedUrl: string }> = {
      pub_a: { id: 'pub_a', tenantId: 'tenant_a', publishedUrl: pageUrlA },
      pub_b: { id: 'pub_b', tenantId: 'tenant_b', publishedUrl: pageUrlB },
    };

    const prisma = {
      base: {
        geoPublishRecord: {
          findMany: baseFindMany,
        },
      },
      scoped: {
        geoPublishRecord: {
          findFirst: vi.fn(async (args: { where: { id: string } }) => {
            const tid = currentTenantId();
            seenTenants.push(tid ?? 'none');
            const row = rows[args.where.id];
            if (!row || row.tenantId !== tid) return null;
            return {
              ...row,
              brandId: 'brand_1',
              brandMarketId: 'bm_1',
              articleId: 'art_1',
              channel: 'Blog',
              publishedAt: new Date('2026-10-01T00:00:00Z'),
              baselineRunId: null,
              latestRetestRunId: null,
              beforeMetrics: null,
              afterMetrics: null,
            };
          }),
          update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
            ...rows[args.where.id],
            brandId: 'brand_1',
            brandMarketId: 'bm_1',
            articleId: 'art_1',
            channel: 'Blog',
            publishedAt: new Date('2026-10-01T00:00:00Z'),
            baselineRunId: null,
            latestRetestRunId: null,
            beforeMetrics: null,
            afterMetrics: null,
            retestSchedules: [],
            ...args.data,
          })),
        },
      },
    } as unknown as PrismaService;

    const assertAllowedSpy = vi.fn();
    const rateLimiter = { assertAllowed: assertAllowedSpy } as unknown as FreeActionRateLimiter;

    const service = new CrawlProbeService(prisma, client, rateLimiter);
    const now = new Date('2026-10-05T12:00:00Z');
    const report = await service.runSweep({ now, batchSize: 150 });

    expect(report).toEqual({ scanned: 2, probed: 2, failed: 0 });
    expect(seenTenants).toEqual(['tenant_a', 'tenant_b']);
    expect(assertAllowedSpy).not.toHaveBeenCalled();

    const firstCall = baseFindMany.mock.calls[0]?.[0] as unknown as {
      where: { crawlStatus: string; publishedAt: { lte: Date } };
      take: number;
    };
    expect(firstCall.where.crawlStatus).toBe('PENDING');
    expect(firstCall.where.publishedAt.lte.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    // Batch size capped at 100
    expect(firstCall.take).toBe(100);
  });

  it('readCrawlProbeRateLimit returns 30/60s default and honors positive env overrides', () => {
    expect(readCrawlProbeRateLimit({})).toEqual({ max: 30, windowMs: 60_000 });
    expect(
      readCrawlProbeRateLimit({
        CRAWL_PROBE_RATE_LIMIT_MAX: '10',
        CRAWL_PROBE_RATE_LIMIT_WINDOW_SECONDS: '120',
      }),
    ).toEqual({ max: 10, windowMs: 120_000 });
    expect(
      readCrawlProbeRateLimit({
        CRAWL_PROBE_RATE_LIMIT_MAX: '0',
        CRAWL_PROBE_RATE_LIMIT_WINDOW_SECONDS: '-1',
      }),
    ).toEqual({ max: 30, windowMs: 60_000 });
  });
});
