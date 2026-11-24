import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  API_ERROR,
  AUTH_ERROR,
  CHANNEL_PROVIDERS,
  DISTRIBUTION_MODES,
  FREE_RATE_LIMITED_ACTIONS,
  GEO_BRIEF_SOURCES,
  L1_CHANNEL_PROVIDERS,
  PRICING_DEFAULTS,
  computeDifferenceInDifferences,
  computeWilsonInterval,
  detectLocaleLeakage,
  evaluateDistributionPreflight,
  sanitizeSummaryForPublicReport,
  updateBrandMarketSchema,
  validateControlPromptsAgainstSeeds,
  type CreateExtensionTokenResponseDto,
  type ExtensionConfirmPublishedResultDto,
  type ExtensionMeDto,
  type ExtensionPendingTasksResponseDto,
  type GeoBriefRecord,
  type GeoRoiReportRecordDto,
  type GeoRoiReportShareResultDto,
  type GeoRoiReportSummaryDto,
  type GeoVariantJobDto,
  type NearMissListResponse,
  type PublicGeoRoiReportDto,
} from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { createIsolatedTestContext, httpCall } from '../common/test-db';
import { PublicFetchService } from '../infra/adapters.module';
import type { DnsResolver, HttpTransport } from '../infra/guarded-request';
import { OutboundHttpClient, PUBLIC_ONLY_ALLOWLIST } from '../infra/outbound-http';
import { resetRobotsCache } from '../infra/public-fetch';
import { QueueRuntime } from '../queue/queue.runtime';
import { RoiReportHtmlRenderer } from '../reports/roi-report-html.renderer';
import { RoiReportPublicService } from '../reports/roi-report-public.service';
import {
  RetestMetricsHookService,
  computeControlMetricsSnapshot,
  computeScheduleMetricsSnapshot,
} from '../studio/retest-metrics-hook.service';
import { runInTenant } from '../tenant/tenant-context';
import {
  parseRetrievedSourcesFromRawMeta,
  sanitizeObservationRawMeta,
} from '../visibility/visibility-raw-meta';
import { VISIBILITY_RUN_HANDLER, VisibilityRunRunner } from '../visibility/visibility-run.runner';
import { WorkerModule } from '../worker.module';
import { CmsConnectorRegistry, ConnectorError, verifyWebhookSignature } from './connectors';
import { DISTRIBUTION_HANDLER, DistributionRunner } from './distribution.runner';
import { RetestSchedulerService } from './retest-scheduler.service';
import { VARIANT_JOB_HANDLER, VariantJobRunner } from './variant-job.runner';

const TEST_CREDENTIAL_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SHOPIFY_SECRET = 'v22_shopify_client_secret_998877';
const VALID_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

type MockCapture = {
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyText: string;
};

type VirtualMockServer = {
  port: number;
  captures: MockCapture[];
  wechatErrorCode: number;
  clearCaptures(): void;
  close(): Promise<void>;
};

async function readStreamBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
  });
  res.end(buf);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(buf.length),
  });
  res.end(buf);
}

function createVirtualMockServer(): Promise<VirtualMockServer> {
  const captures: MockCapture[] = [];
  let wechatErrorCode = 0;

  const server: Server = createServer(async (req, res) => {
    const rawHost =
      String(req.headers['x-mock-host'] ?? req.headers.host ?? '')
        .toLowerCase()
        .split(':')[0] ?? '';
    const method = (req.method ?? 'GET').toUpperCase();
    const urlPath = req.url ?? '/';
    const bodyBuf = await readStreamBuffer(req);
    const bodyText = bodyBuf.toString('utf8');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
    }
    captures.push({ host: rawHost, method, path: urlPath, headers, bodyText });

    // Robots.txt allow for all virtual hosts
    if (urlPath === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }

    // 1. Ghost Admin API v5
    if (rawHost === 'ghost.v22.example') {
      if (urlPath.startsWith('/ghost/api/admin/site/')) {
        sendJson(res, 200, { site: { title: 'Ghost V22 Blog', url: 'https://ghost.v22.example' } });
        return;
      }
      if (urlPath.startsWith('/ghost/api/admin/posts/')) {
        const parsed = bodyText
          ? (JSON.parse(bodyText) as { posts?: Array<{ status?: string }> })
          : {};
        const post = parsed.posts?.[0] ?? {};
        const isLive = post.status === 'published';
        sendJson(res, 201, {
          posts: [
            {
              id: 'ghost_post_v22_1',
              slug: 'v22-ghost-guide',
              status: isLive ? 'published' : 'draft',
              url: isLive
                ? 'https://ghost.v22.example/v22-ghost-guide/'
                : 'https://ghost.v22.example/p/draft-v22/',
            },
          ],
        });
        return;
      }
    }

    // 2. Dev.to Forem REST v1
    if (rawHost === 'dev.to') {
      if (urlPath === '/api/users/me') {
        sendJson(res, 200, { id: 101, username: 'geomix_v22', name: 'GeoMix V22' });
        return;
      }
      if (urlPath === '/api/articles' && method === 'POST') {
        const parsed = JSON.parse(bodyText) as {
          article?: { tags?: string[]; published?: boolean };
        };
        const tags = parsed.article?.tags ?? [];
        if (tags.length > 4) {
          sendJson(res, 422, { error: 'Too many tags' });
          return;
        }
        sendJson(res, 201, {
          id: 9901,
          url: parsed.article?.published
            ? 'https://dev.to/geomix_v22/quiet-home-nas-guide-9901'
            : 'https://dev.to/geomix_v22/quiet-home-nas-guide-draft-9901',
        });
        return;
      }
    }

    // 3. Hashnode GraphQL
    if (rawHost === 'gql.hashnode.com') {
      const parsed = JSON.parse(bodyText) as { query?: string };
      const q = parsed.query ?? '';
      if (q.includes('createDraft')) {
        sendJson(res, 200, {
          data: {
            createDraft: {
              draft: {
                id: 'hn_draft_1',
                slug: 'v22-hashnode-draft',
                title: 'Hashnode Draft',
              },
            },
          },
        });
        return;
      }
      if (q.includes('publishPost')) {
        sendJson(res, 200, {
          data: {
            publishPost: {
              post: {
                id: 'hn_post_1',
                slug: 'v22-hashnode-post',
                url: 'https://blog.v22.example/v22-hashnode-post',
              },
            },
          },
        });
        return;
      }
      sendJson(res, 200, {
        data: {
          me: {
            id: 'hn_user_1',
            username: 'geomix_hn',
            publications: {
              edges: [{ node: { id: 'pub_v22_1', title: 'GeoMix Hashnode' } }],
            },
          },
        },
      });
      return;
    }

    // 4. GitHub REST v3 (MDX PR draft & live commit)
    if (rawHost === 'api.github.com') {
      if (method === 'GET' && urlPath === '/repos/geomix-demo/geo-docs') {
        sendJson(res, 200, {
          id: 777,
          full_name: 'geomix-demo/geo-docs',
          default_branch: 'main',
          permissions: { push: true },
        });
        return;
      }
      if (method === 'GET' && urlPath.startsWith('/repos/geomix-demo/geo-docs/git/ref/heads/')) {
        sendJson(res, 200, { object: { sha: 'abc123def4567890abc123def4567890abc12345' } });
        return;
      }
      if (method === 'POST' && urlPath === '/repos/geomix-demo/geo-docs/git/refs') {
        sendJson(res, 201, { ref: 'refs/heads/geomix/draft', object: { sha: 'abc123' } });
        return;
      }
      if (method === 'GET' && urlPath.startsWith('/repos/geomix-demo/geo-docs/contents/')) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'PUT' && urlPath.startsWith('/repos/geomix-demo/geo-docs/contents/')) {
        sendJson(res, 201, {
          content: {
            path: urlPath.split('/contents/')[1]?.split('?')[0] ?? 'content/post.mdx',
            sha: 'file_sha_v22',
            html_url: 'https://github.com/geomix-demo/geo-docs/blob/main/content/post.mdx',
          },
          commit: { sha: 'commit_sha_v22' },
        });
        return;
      }
      if (method === 'POST' && urlPath === '/repos/geomix-demo/geo-docs/pulls') {
        sendJson(res, 201, {
          number: 42,
          html_url: 'https://github.com/geomix-demo/geo-docs/pull/42',
        });
        return;
      }
    }

    // 5. WeChat Official Draft API ONLY (strict red-line check on mass-send / freepublish)
    if (rawHost === 'api.weixin.qq.com') {
      if (/freepublish|mass\/send|mass\/sendall/i.test(urlPath)) {
        sendJson(res, 403, { errcode: 48001, errmsg: 'MASS_SEND_FORBIDDEN_BY_CONTRACT' });
        return;
      }
      if (urlPath.startsWith('/cgi-bin/stable_token')) {
        if (wechatErrorCode === 40164) {
          sendJson(res, 200, {
            errcode: 40164,
            errmsg: 'invalid ip 203.0.113.42, not in whitelist rid: v22-int',
          });
          return;
        }
        sendJson(res, 200, { access_token: 'wx_stable_tok_v22', expires_in: 7200 });
        return;
      }
      if (urlPath.startsWith('/cgi-bin/draft/count')) {
        sendJson(res, 200, { total_count: 5 });
        return;
      }
      if (urlPath.startsWith('/cgi-bin/material/add_material')) {
        sendJson(res, 200, {
          media_id: 'wx_thumb_media_v22',
          url: 'https://mmbiz.qpic.cn/mmbiz_png/v22thumb/0',
        });
        return;
      }
      if (urlPath.startsWith('/cgi-bin/media/uploadimg')) {
        sendJson(res, 200, { url: 'https://mmbiz.qpic.cn/mmbiz_png/v22inline/0' });
        return;
      }
      if (urlPath.startsWith('/cgi-bin/draft/add')) {
        sendJson(res, 200, { media_id: 'wx_draft_media_v22' });
        return;
      }
    }

    // 6. Shopify OAuth 2.0 + Webhook Registration
    if (rawHost.endsWith('.myshopify.com')) {
      if (method === 'POST' && urlPath === '/admin/oauth/access_token') {
        sendJson(res, 200, {
          access_token: 'shpat_v22_oauth_secret_token',
          scope: 'read_content,write_content',
        });
        return;
      }
      if (method === 'POST' && urlPath.includes('/graphql.json')) {
        sendJson(res, 200, {
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1001' },
              userErrors: [],
            },
            shop: { name: 'Demo Store', primaryDomain: { url: `https://${rawHost}` } },
          },
        });
        return;
      }
      if (method === 'POST' && urlPath.includes('/webhooks.json')) {
        sendJson(res, 201, { webhook: { id: 1001, topic: 'app/uninstalled' } });
        return;
      }
    }

    // 7. Public HTML pages for Near-Miss fetch & Extension confirm-published
    if (rawHost === 'xingyun.example' || rawHost === 'zhuanlan.zhihu.com') {
      sendHtml(
        res,
        200,
        '<!doctype html><html lang="zh-CN"><head><title>星云存储静音 NAS 产品随笔</title></head><body><article><h1>星云存储静音 NAS 产品随笔</h1><p>家庭私有云存储在客厅环境中需要长期安静运行，本文将持续更新更多日常相册备份经验。</p></article></body></html>',
      );
      return;
    }

    // 8. IndexNow sink
    if (rawHost === 'api.indexnow.org') {
      res.writeHead(200);
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'unhandled mock route', host: rawHost, path: urlPath });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind mock server'));
        return;
      }
      resolve({
        port: addr.port,
        captures,
        get wechatErrorCode() {
          return wechatErrorCode;
        },
        set wechatErrorCode(code: number) {
          wechatErrorCode = code;
        },
        clearCaptures() {
          captures.length = 0;
        },
        close() {
          return new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          });
        },
      });
    });
  });
}

function createVirtualHostDeps(mockPort: number): {
  resolver: DnsResolver;
  transport: HttpTransport;
} {
  const resolver: DnsResolver = {
    async resolve(hostname: string) {
      const host = hostname.toLowerCase();
      if (host === 'rebind.v22.example') {
        return [{ address: '10.0.0.1', family: 4 }];
      }
      if (host === 'nxdomain.v22.example') {
        return [];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    },
  };

  const transport: HttpTransport = async (request) => {
    const forwardHeaders: Record<string, string> = {
      ...request.headers,
      'x-mock-host': request.url.hostname,
    };
    delete forwardHeaders.host;
    const bodyPayload = request.rawBody
      ? new Uint8Array(request.rawBody)
      : request.body !== undefined
        ? request.body
        : undefined;
    const targetUrl = `http://127.0.0.1:${mockPort}${request.url.pathname}${request.url.search}`;
    const res = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: bodyPayload,
      redirect: 'manual',
      signal: request.signal,
    });
    const arr = await res.arrayBuffer();
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    return {
      status: res.status,
      headers: outHeaders,
      body: Buffer.from(arr),
    };
  };

  return { resolver, transport };
}

function installVirtualHostOnApp(app: INestApplication, mockPort: number): void {
  const { resolver, transport } = createVirtualHostDeps(mockPort);
  const outbound = app.get(OutboundHttpClient) as unknown as {
    resolver: DnsResolver;
    transport: HttpTransport;
    defaultAllowlist: unknown;
  };
  outbound.resolver = resolver;
  outbound.transport = transport;
  // Explicitly preserve strict SSRF PUBLIC_ONLY_ALLOWLIST (zero relaxation!)
  outbound.defaultAllowlist = PUBLIC_ONLY_ALLOWLIST;

  const publicFetch = app.get(PublicFetchService) as unknown as {
    deps: { resolver: DnsResolver; transport: HttpTransport };
  };
  publicFetch.deps.resolver = resolver;
  publicFetch.deps.transport = transport;
}

function signShopifyCallbackQuery(
  params: Record<string, string>,
  secret = TEST_SHOPIFY_SECRET,
): string {
  const sorted = Object.entries(params)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hmac = createHmac('sha256', secret).update(sorted, 'utf8').digest('hex');
  return `${sorted}&hmac=${hmac}`;
}

function signShopifyWebhook(rawBody: string, secret = TEST_SHOPIFY_SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('base64');
}

// ============================================================================
// Layer A: Offline Real NestJS + Virtual-Host Mock Server + WorkerModule DI
// Runs 100% non-skipped under default `pnpm test` (zero PG/Redis required)
// ============================================================================

describe('GeoMix v2.2 Cross-Module Integration Suite (Offline Real NestJS + Virtual-Host Mock Server)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let mock: VirtualMockServer;
  let apiApp: INestApplication;
  let apiBase = '';

  beforeAll(async () => {
    for (const key of [
      'BILLING_MODE',
      'LLM_PROVIDERS',
      'VISIBILITY_COLLECTOR',
      'EMBEDDING_PROVIDER',
      'CREDENTIAL_ENCRYPTION_KEY',
      'PUBLIC_APP_URL',
      'WEB_ORIGIN',
      'SHOPIFY_OAUTH_CLIENT_ID',
      'SHOPIFY_OAUTH_CLIENT_SECRET',
      'SHOPIFY_OAUTH_SCOPES',
      'WECHAT_API_BASE_URL',
    ]) {
      savedEnv[key] = process.env[key];
    }

    process.env.BILLING_MODE = 'SHADOW';
    process.env.LLM_PROVIDERS = '{}';
    process.env.VISIBILITY_COLLECTOR = 'fake';
    process.env.EMBEDDING_PROVIDER = 'fake';
    process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_CREDENTIAL_KEY;
    process.env.PUBLIC_APP_URL = 'https://app.geomix.test';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.SHOPIFY_OAUTH_CLIENT_ID = 'v22_shopify_client_id';
    process.env.SHOPIFY_OAUTH_CLIENT_SECRET = TEST_SHOPIFY_SECRET;
    process.env.SHOPIFY_OAUTH_SCOPES = 'read_content,write_content';
    process.env.WECHAT_API_BASE_URL = 'https://api.weixin.qq.com';

    mock = await createVirtualMockServer();
    apiApp = await createApiApp();
    installVirtualHostOnApp(apiApp, mock.port);
    await apiApp.listen(0, '127.0.0.1');
    const addr = apiApp.getHttpServer().address() as { port: number };
    apiBase = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    resetRobotsCache();
    vi.restoreAllMocks();
    if (apiApp) await apiApp.close();
    if (mock) await mock.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── Suite 0: Foundation Contracts & Dual ApiModule / WorkerModule DI ──────
  it('Suite 0: enforces v2.2 shared contracts and dual ApiModule + WorkerModule DI for all 9 L1 connectors & runners', async () => {
    expect(PRICING_DEFAULTS).toHaveLength(4);
    expect(PRICING_DEFAULTS.map((item) => item.action).sort()).toEqual([
      'geo_variant',
      'geo_write',
      'inline_image_gen',
      'visibility_check',
    ]);
    expect(FREE_RATE_LIMITED_ACTIONS).toEqual(
      expect.arrayContaining([
        'near_miss_boost',
        'roi_report_export',
        'roi_report_share',
        'extension_token_issue',
        'extension_sync',
      ]),
    );
    expect(CHANNEL_PROVIDERS).toHaveLength(17);
    expect(DISTRIBUTION_MODES).toContain('L2_EXTENSION');
    expect(GEO_BRIEF_SOURCES).toContain('NEAR_MISS_BOOST');

    // Verify ApiModule resolves all 9 L1 connectors
    const apiRegistry = apiApp.get(CmsConnectorRegistry);
    for (const provider of L1_CHANNEL_PROVIDERS) {
      expect(apiRegistry.get(provider).provider).toBe(provider);
    }

    // Verify WorkerModule resolves all 9 L1 connectors + all v2.2 runners & hooks
    const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
    const workerCtx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    try {
      const workerRegistry = workerCtx.get(CmsConnectorRegistry);
      for (const provider of L1_CHANNEL_PROVIDERS) {
        expect(workerRegistry.get(provider).provider).toBe(provider);
      }
      expect(workerCtx.get(VARIANT_JOB_HANDLER)).toBeInstanceOf(VariantJobRunner);
      expect(workerCtx.get(DISTRIBUTION_HANDLER)).toBeInstanceOf(DistributionRunner);
      expect(workerCtx.get(VISIBILITY_RUN_HANDLER)).toBeInstanceOf(VisibilityRunRunner);
      expect(workerCtx.get(RetestMetricsHookService)).toBeInstanceOf(RetestMetricsHookService);
      expect(workerCtx.get(RetestSchedulerService)).toBeInstanceOf(RetestSchedulerService);
    } finally {
      await workerCtx.close();
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  // ── Suite 1: Near-Miss Raw Meta Sanitization, Cap-100 & Deduplication ─────
  it('Suite 1: enforces Near-Miss rawMeta whitelist, aiOverviewTriggered tolerance, deduplication and cap-100 per observation', () => {
    const rawMeta = {
      provider: 'deepseek',
      aiOverviewTriggered: true,
      serverToolSearchCount: 3,
      serverToolFetchCount: 2,
      secretDebugToken: 'MUST_BE_STRIPPED',
      openedPages: [
        {
          url: 'https://xingyun.example/guides/nas?utm_source=deepseek&ref=ai',
          title: '星云静音 NAS 指南',
          snippet: '四盘位客厅静音对比',
        },
      ],
      retrievedSources: [
        // Duplicate of openedPage with trailing slash + UTM -> merges as wasOpened: true
        {
          url: 'https://xingyun.example/guides/nas/?utm_medium=chat',
          title: '星云静音 NAS 指南',
          rank: 1,
        },
        // Private IP URL must be discarded
        { url: 'http://127.0.0.1/internal-secret', title: 'Local' },
        // >100 distinct public URLs to verify strict cap-100
        ...Array.from({ length: 120 }, (_, i) => ({
          url: `https://authority-${i}.example/article-${i}`,
          title: `Authority ${i}`,
          rank: i + 2,
        })),
      ],
    };

    const sanitized = sanitizeObservationRawMeta(rawMeta);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.provider).toBe('deepseek');
    expect(sanitized?.aiOverviewTriggered).toBe(true);
    expect(sanitized).not.toHaveProperty('secretDebugToken');

    const parsed = parseRetrievedSourcesFromRawMeta(rawMeta, {
      citations: [{ url: 'https://authority-0.example/article-0' }],
      ownedDomains: ['xingyun.example'],
      competitorDomains: ['authority-1.example'],
    });
    expect(parsed.length).toBeLessThanOrEqual(100);
    expect(parsed.some((row) => row.url.includes('127.0.0.1'))).toBe(false);

    const ownedOpened = parsed.find((row) => row.domain === 'xingyun.example');
    expect(ownedOpened).toBeDefined();
    expect(ownedOpened?.wasOpened).toBe(true);
    expect(ownedOpened?.wasCited).toBe(false);
    expect(ownedOpened?.sourceKind).toBe('OWNED');

    // On >100 overflow, !opened & cited (lowest Near-Miss priority) is evicted while !opened & !cited competitor stays
    const comp = parsed.find((row) => row.domain === 'authority-1.example');
    expect(comp?.sourceKind).toBe('COMPETITOR');
    expect(comp?.wasCited).toBe(false);

    // Under cap (non-overflow), cited URL is accurately marked wasCited: true
    const smallParsed = parseRetrievedSourcesFromRawMeta(
      {
        retrievedSources: [{ url: 'https://authority-0.example/article-0', title: 'Cited' }],
      },
      {
        citations: [{ url: 'https://authority-0.example/article-0' }],
        ownedDomains: ['xingyun.example'],
        competitorDomains: [],
      },
    );
    expect(smallParsed[0]?.wasCited).toBe(true);
  });

  // ── Suite 2: Control Prompts Validation, Wilson 95% CI, DiD & ROI HTML ────
  it('Suite 2: validates controlPrompts, Wilson 95% CI boundaries, DiD lift, zero-CDN XSS-safe ROI HTML & public DTO sanitization', () => {
    // 1. controlPrompts <= 5 and no seed overlap
    const validMarket = updateBrandMarketSchema.safeParse({
      seedPrompts: ['Best quiet 4-bay NAS 2026'],
      controlPrompts: ['  How to pick a home router  ', 'Best quiet SSD enclosure'],
    });
    expect(validMarket.success).toBe(true);

    const tooManyControls = updateBrandMarketSchema.safeParse({
      controlPrompts: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    });
    expect(tooManyControls.success).toBe(false);

    const overlapCheck = validateControlPromptsAgainstSeeds(
      ['  best quiet 4-bay nas 2026 '],
      ['Best quiet 4-bay NAS 2026'],
    );
    expect(overlapCheck.ok).toBe(false);

    // 2. Wilson 95% CI boundaries + DiD net lift
    const emptyCi = computeWilsonInterval(0, 0);
    expect(emptyCi.rate).toBe(0);
    expect(emptyCi.lower).toBe(0);
    expect(emptyCi.upper).toBe(0);

    const zeroHit = computeWilsonInterval(0, 3);
    expect(zeroHit.lower).toBeGreaterThanOrEqual(0);
    expect(zeroHit.upper).toBeLessThanOrEqual(1);

    const fullHit = computeWilsonInterval(3, 3);
    expect(fullHit.rate).toBe(1);
    expect(fullHit.lower).toBeGreaterThan(0);
    expect(fullHit.upper).toBeLessThanOrEqual(1);

    const did = computeDifferenceInDifferences({
      treatmentBaseline: 0.2,
      treatmentCurrent: 0.7,
      controlBaseline: 0.25,
      controlCurrent: 0.35,
    });
    expect(did.treatmentDelta).toBeCloseTo(0.5, 4);
    expect(did.controlDelta).toBeCloseTo(0.1, 4);
    expect(did.netLift).toBeCloseTo(0.4, 4);

    // Compute real schedule + control DiD snapshots
    const brandMarketLike = {
      localBrandName: 'NebulaNAS',
      aliases: [],
      ownedDomains: ['nebulanas.example'],
      competitors: [],
    };
    const treatmentSnap = computeScheduleMetricsSnapshot(
      [
        {
          id: 'obs_t_1',
          promptText: 'Best quiet 4-bay NAS 2026',
          status: 'SUCCESS',
          answerText: 'NebulaNAS is a quiet 4-bay NAS.',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'POSITIVE',
          competitorHits: [],
          citations: [
            {
              url: 'https://nebulanas.example/guide',
              domain: 'nebulanas.example',
              sourceKind: 'OWNED',
            },
          ],
        },
        {
          id: 'obs_t_2',
          promptText: 'Best quiet 4-bay NAS 2026',
          status: 'SUCCESS',
          answerText: 'NebulaNAS leads in quiet operation.',
          brandMentioned: true,
          brandPosition: 2,
          brandSentiment: 'POSITIVE',
          competitorHits: [],
          citations: [
            {
              url: 'https://nebulanas.example/guide',
              domain: 'nebulanas.example',
              sourceKind: 'OWNED',
            },
          ],
        },
      ],
      brandMarketLike,
    );
    expect(treatmentSnap?.wilson?.rate).toBe(1);

    const controlSnap = computeControlMetricsSnapshot({
      controlPrompts: ['Best quiet SSD enclosure'],
      controlObservations: [
        {
          id: 'obs_c_1',
          promptText: 'Best quiet SSD enclosure',
          status: 'SUCCESS',
          answerText: 'General SSD enclosure overview.',
          brandMentioned: false,
          brandPosition: null,
          brandSentiment: null,
          competitorHits: [],
          citations: [],
        },
      ],
      baselineControlObservations: [
        {
          id: 'obs_cb_1',
          promptText: 'Best quiet SSD enclosure',
          status: 'SUCCESS',
          answerText: 'General SSD enclosure overview.',
          brandMentioned: false,
          brandPosition: null,
          brandSentiment: null,
          competitorHits: [],
          citations: [],
        },
      ],
      brandMarket: brandMarketLike,
      treatmentBaselineMentionRate: 20,
      treatmentCurrentMentionRate: 100,
    });
    expect(controlSnap?.did?.netLift).toBeCloseTo(0.8, 4);

    // 3. ROI HTML export zero-CDN + XSS escape + strict public DTO sanitization
    const renderer = apiApp.get(RoiReportHtmlRenderer);
    const fullSummary: GeoRoiReportSummaryDto = {
      version: 1,
      overview: {
        totalObservations: 12,
        mentionHits: 8,
        mentionRate: 8 / 12,
        mentionWilson: computeWilsonInterval(8, 12),
        citationHits: 6,
        citationRate: 6 / 12,
        ownedCitationHits: 5,
        ownedCitationRate: 5 / 12,
        confidenceLevel: 'MEDIUM',
        did,
      },
      byEngine: [],
      funnel: {
        publishedTotal: 3,
        l1Count: 2,
        l2Count: 1,
        l3Count: 0,
        crawlCheckedCount: 3,
        crawlOkCount: 3,
        crawlOkRate: 1,
        indexNowAttemptedCount: 2,
        indexNowSuccessCount: 2,
        indexNowRate: 1,
      },
      channelRanking: [],
      milestoneTrend: [],
      nearMiss: {
        totalOpportunities: 3,
        boostBriefsCreated: 2,
        convertedToCited: 1,
        tierCounts: {
          OPENED_NOT_CITED: 1,
          RETRIEVED_NOT_CITED: 1,
          CRAWLED_NOT_CITED: 1,
          MENTIONED_NOT_OWNED: 0,
        },
      },
      pointsRoi: {
        totalPointsSpent: 120,
        articlesPublished: 3,
        citationHitsGained: 5,
        pointsPerPublishedArticle: 40,
        pointsPerCitationHit: 24,
      },
    };

    const html = renderer.render({
      title: 'Q4 ROI <script>alert(1)</script>',
      brandName: 'NebulaNAS "Pro"',
      category: 'Storage',
      market: 'GLOBAL',
      locale: 'en-US',
      whiteLabelOrg: '"Agency" <img src=x onerror=alert(2)>',
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-11-30T23:59:59.000Z',
      generatedAt: '2026-11-30T12:00:00.000Z',
      summary: fullSummary,
      includePointsRoi: true,
    });
    expect(html).toContain('<svg');
    expect(html).toContain('@media print');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;Agency&quot; &lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*(cdn|fonts\.googleapis|unpkg|jsdelivr)/i);
    expect(html).not.toMatch(/<script\s+src=/i);

    const sanitizedPublic = sanitizeSummaryForPublicReport(fullSummary);
    expect(sanitizedPublic).not.toHaveProperty('pointsRoi');
    expect(sanitizedPublic.overview.mentionWilson.rate).toBeCloseTo(8 / 12, 4);
  });

  // ── Suite 3: All 5 New L1 Connectors + SSRF 400 + WeChat 40164 & Zero Mass-Send ──
  it('Suite 3: exercises all 5 new L1 connectors via virtual-host mock server, blocks SSRF across all 5, enforces WeChat draft-only & 40164 hint', async () => {
    const registry = apiApp.get(CmsConnectorRegistry);
    mock.clearCaptures();

    const basePayload = {
      taskId: 'task_v22_int_1',
      articleId: 'art_v22_int_1',
      market: 'GLOBAL' as const,
      channelLabel: 'V22 Channel',
      title: '2026 Quiet 4-Bay NAS Benchmark',
      slug: 'quiet-4-bay-nas-benchmark',
      metaDesc: 'Measured 19dB noise and dual 2.5GbE throughput.',
      markdown:
        '# Quiet 4-Bay NAS\n\nMeasured 19dB idle acoustic floor with local AI photo search.',
      html: '<h1>Quiet 4-Bay NAS</h1><p>Measured 19dB idle acoustic floor.</p>',
      tags: ['nas', 'homelab', 'storage', 'quiet', 'extra-dropped-tag'],
      canonicalUrl: 'https://xingyun.example/guides/nas',
      schemaJsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: '</script>Test',
      },
      targetLocale: 'ja-JP',
      publishAsDraft: false,
      extras: {},
    };

    // 1. GHOST
    const ghostConn = {
      id: 'conn_ghost',
      provider: 'GHOST' as const,
      displayName: 'Ghost V22',
      siteBaseUrl: 'https://ghost.v22.example',
      configJson: { defaultTags: ['geo'] },
    };
    const ghostSecrets = {
      adminApiKey:
        'aabbccddeeff001122334455:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    const ghostTest = await registry.get('GHOST').testConnection(ghostConn, ghostSecrets);
    expect(ghostTest.ok).toBe(true);
    const ghostPub = await registry.get('GHOST').publish(ghostConn, ghostSecrets, basePayload);
    expect(ghostPub.remotePostId).toBe('ghost_post_v22_1');
    expect(ghostPub.remotePublishedUrl).toBe('https://ghost.v22.example/v22-ghost-guide/');
    const ghostPostReq = mock.captures.find(
      (c) => c.host === 'ghost.v22.example' && c.path.startsWith('/ghost/api/admin/posts/'),
    );
    expect(ghostPostReq?.headers.authorization).toMatch(
      /^Ghost [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(ghostPostReq?.bodyText).toContain('application/ld+json');
    expect(ghostPostReq?.bodyText).not.toContain('</script>Test');

    // 2. DEVTO (tags capped at <= 4, canonical_url preserved)
    const devtoConn = {
      id: 'conn_devto',
      provider: 'DEVTO' as const,
      displayName: 'Dev.to V22',
      siteBaseUrl: 'https://dev.to',
      configJson: {},
    };
    const devtoSecrets = { apiKey: 'devto_secret_key_v22' };
    expect((await registry.get('DEVTO').testConnection(devtoConn, devtoSecrets)).ok).toBe(true);
    const devtoPub = await registry.get('DEVTO').publish(devtoConn, devtoSecrets, basePayload);
    expect(devtoPub.remotePublishedUrl).toContain('https://dev.to/geomix_v22/');
    const devtoPostReq = mock.captures.find(
      (c) => c.host === 'dev.to' && c.path === '/api/articles',
    );
    expect(devtoPostReq?.headers['api-key']).toBe('devto_secret_key_v22');
    const devtoBody = JSON.parse(devtoPostReq!.bodyText) as {
      article: { tags: string[]; canonical_url: string };
    };
    expect(devtoBody.article.tags.length).toBeLessThanOrEqual(4);
    expect(devtoBody.article.canonical_url).toBe('https://xingyun.example/guides/nas');

    // 3. HASHNODE (GraphQL draft & live)
    const hnConn = {
      id: 'conn_hn',
      provider: 'HASHNODE' as const,
      displayName: 'Hashnode V22',
      siteBaseUrl: 'https://blog.v22.example',
      configJson: { publicationId: 'pub_v22_1' },
    };
    const hnSecrets = { apiToken: 'hn_pat_v22' };
    expect((await registry.get('HASHNODE').testConnection(hnConn, hnSecrets)).ok).toBe(true);
    const hnDraft = await registry
      .get('HASHNODE')
      .publish(hnConn, hnSecrets, { ...basePayload, publishAsDraft: true });
    expect(hnDraft.publishedAsDraft).toBe(true);
    const hnLive = await registry
      .get('HASHNODE')
      .publish(hnConn, hnSecrets, { ...basePayload, publishAsDraft: false });
    expect(hnLive.remotePublishedUrl).toBe('https://blog.v22.example/v22-hashnode-post');

    // 4. GITHUB_MDX (draft PR mode + live commit mode with publicUrlTemplate)
    const ghConn = {
      id: 'conn_gh',
      provider: 'GITHUB_MDX' as const,
      displayName: 'GitHub MDX V22',
      siteBaseUrl: 'https://docs.v22.example',
      configJson: {
        repoOwner: 'geomix-demo',
        repoName: 'geo-docs',
        branch: 'main',
        contentDir: 'content/blog',
        fileFormat: 'mdx' as const,
        publicUrlTemplate: 'https://docs.v22.example/{{locale}}/blog/{{slug}}',
      },
    };
    const ghSecrets = { token: 'ghp_v22_secret_token' };
    expect((await registry.get('GITHUB_MDX').testConnection(ghConn, ghSecrets)).ok).toBe(true);
    const ghDraft = await registry
      .get('GITHUB_MDX')
      .publish(ghConn, ghSecrets, { ...basePayload, publishAsDraft: true });
    expect(ghDraft.publishedAsDraft).toBe(true);
    expect(ghDraft.remoteAdminUrl).toBe('https://github.com/geomix-demo/geo-docs/pull/42');
    const ghLive = await registry
      .get('GITHUB_MDX')
      .publish(ghConn, ghSecrets, { ...basePayload, publishAsDraft: false });
    expect(ghLive.publishedAsDraft).toBe(false);
    expect(ghLive.remotePublishedUrl).toBe(
      'https://docs.v22.example/ja-JP/blog/quiet-4-bay-nas-benchmark',
    );

    // 5. WECHAT_OFFICIAL (strictly draft-only, ZERO mass-send, 40164 IP whitelist hint)
    const wxConn = {
      id: 'conn_wx',
      provider: 'WECHAT_OFFICIAL' as const,
      displayName: '微信公众号草稿箱',
      siteBaseUrl: 'https://mp.weixin.qq.com',
      configJson: { author: '星云实验室' },
    };
    const wxSecrets = {
      appId: 'wx1234567890abcdef',
      appSecret: 'wx_super_secret_0000111122223333',
    };
    expect((await registry.get('WECHAT_OFFICIAL').testConnection(wxConn, wxSecrets)).ok).toBe(true);
    const wxDraft = await registry
      .get('WECHAT_OFFICIAL')
      .publish(wxConn, wxSecrets, { ...basePayload, market: 'CN', publishAsDraft: false });
    expect(wxDraft.publishedAsDraft).toBe(true);
    expect(wxDraft.remotePublishedUrl).toBeUndefined();
    expect(wxDraft.remotePostId).toBe('wx_draft_media_v22');
    // Red-line check: ZERO freepublish or mass/send calls ever issued
    expect(
      mock.captures.filter(
        (c) =>
          c.host === 'api.weixin.qq.com' && /freepublish|mass\/send|mass\/sendall/i.test(c.path),
      ),
    ).toHaveLength(0);

    // 40164 IP whitelist actionable error (never leaks appSecret)
    mock.wechatErrorCode = 40164;
    const wxErrSecrets = {
      appId: 'wx_err_40164_appid',
      appSecret: 'wx_secret_must_not_leak_999',
    };
    let wx40164Err: unknown = null;
    try {
      await registry.get('WECHAT_OFFICIAL').testConnection(wxConn, wxErrSecrets);
    } catch (err) {
      wx40164Err = err;
    }
    expect(wx40164Err).toBeInstanceOf(ConnectorError);
    expect((wx40164Err as Error).message).toContain('40164');
    expect((wx40164Err as Error).message).toContain('203.0.113.42');
    expect((wx40164Err as Error).message).not.toContain('wx_secret_must_not_leak_999');
    mock.wechatErrorCode = 0;

    // 6. SSRF rejection across all 5 new connectors (zero mock hits)
    mock.clearCaptures();
    const ssrfCases: Array<{
      provider: 'GHOST' | 'DEVTO' | 'HASHNODE' | 'GITHUB_MDX' | 'WECHAT_OFFICIAL';
      siteBaseUrl: string;
      configJson: Record<string, unknown>;
      secrets: Record<string, string>;
    }> = [
      {
        provider: 'GHOST',
        siteBaseUrl: 'http://127.0.0.1:2368',
        configJson: {},
        secrets: ghostSecrets,
      },
      {
        provider: 'GHOST',
        siteBaseUrl: 'https://rebind.v22.example',
        configJson: {},
        secrets: ghostSecrets,
      },
      {
        provider: 'DEVTO',
        siteBaseUrl: 'https://dev.to',
        configJson: { apiBaseUrl: 'http://169.254.169.254/latest' },
        secrets: devtoSecrets,
      },
      {
        provider: 'HASHNODE',
        siteBaseUrl: 'https://blog.v22.example',
        configJson: { publicationId: 'pub_1', apiBaseUrl: 'http://10.0.0.1/graphql' },
        secrets: hnSecrets,
      },
      {
        provider: 'GITHUB_MDX',
        siteBaseUrl: 'https://docs.v22.example',
        configJson: { ...ghConn.configJson, apiBaseUrl: 'http://127.0.0.1:8080' },
        secrets: ghSecrets,
      },
      {
        provider: 'WECHAT_OFFICIAL',
        siteBaseUrl: 'https://mp.weixin.qq.com',
        configJson: { apiBaseUrl: 'http://169.254.169.254' },
        secrets: wxSecrets,
      },
    ];
    for (const tc of ssrfCases) {
      await expect(
        registry.get(tc.provider).publish(
          {
            id: 'conn_ssrf',
            provider: tc.provider,
            displayName: 'SSRF Test',
            siteBaseUrl: tc.siteBaseUrl,
            configJson: tc.configJson,
          },
          tc.secrets,
          basePayload,
        ),
      ).rejects.toBeInstanceOf(ConnectorError);
    }
    expect(mock.captures).toHaveLength(0);

    // 7. Shopify callback forged HMAC & webhook forged HMAC (real HTTP via createApiApp)
    const forgedCallback = await httpCall(
      apiBase,
      'GET',
      '/api/v2/integrations/shopify/callback?code=abc&shop=demo-store.myshopify.com&state=bad&hmac=deadbeef',
    );
    expect([400, 401]).toContain(forgedCallback.status);

    const forgedWebhook = await fetch(
      `${apiBase}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-shop-domain': 'demo-store.myshopify.com',
          'x-shopify-hmac-sha256': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        },
        body: JSON.stringify({ id: 12345, domain: 'demo-store.myshopify.com' }),
      },
    );
    expect([400, 401]).toContain(forgedWebhook.status);

    // Also verify webhook signature helper rejects tampered payload
    expect(verifyWebhookSignature('{"ok":true}', 'sha256=invalid', 'secret')).toBe(false);
  });

  // ── Suite 4: Multi-Locale Leakage Gate & Preflight ────────────────────────
  it('Suite 4: enforces ja-JP zero false positives, Simplified Chinese leak detection, and Latin GLOBAL_CJK_LEAK preflight', () => {
    // 1. Natural ja-JP with JIS Kanji + Hiragana + Katakana -> 0 false positives
    const naturalJa =
      '# 静音設計の四盤位家庭用NAS実測比較ガイド\n\nリビング設置を想定した実測テストでは、静音ファンと2.5GbEネットワークの組み合わせにより、ローカルAI写真検索と家族向けバックアップを快適に両立できます。';
    const jaClean = detectLocaleLeakage(naturalJa, 'ja-JP');
    expect(jaClean.leaked).toBe(false);

    const jaPreflight = evaluateDistributionPreflight({
      market: 'GLOBAL',
      targetLocale: 'ja-JP',
      provider: 'DEVTO',
      title: '静音設計の四盤位家庭用NAS実測比較ガイド',
      contentMarkdown: naturalJa,
      variantHtml: `<h1>静音設計の四盤位家庭用NAS実測比較ガイド</h1><p>${naturalJa}</p>`,
      variantMetaDesc: '静音ファンと2.5GbE対応の家庭用NAS実測ガイド。',
      brandNames: ['NebulaNAS'],
    });
    expect(jaPreflight.blockers.filter((i) => i.code === 'GLOBAL_CJK_LEAK')).toHaveLength(0);

    // 2. ja-JP with Continental Simplified Chinese exclusive chars -> flagged
    const jaLeaked = detectLocaleLeakage(
      '这款产品针对企业用户提供优势解决方案，请立即体验静音设计。',
      'ja-JP',
    );
    expect(jaLeaked.leaked).toBe(true);

    // 3. Latin locales (de-DE / en-GB / es-ES / fr-FR) with CJK -> blocked
    for (const locale of ['de-DE', 'en-GB', 'es-ES', 'fr-FR'] as const) {
      const latinLeak = detectLocaleLeakage(
        'Leiser 4-Bay Heim-NAS Vergleich mit 这款产品实测数据.',
        locale,
      );
      expect(latinLeak.leaked).toBe(true);

      const preflight = evaluateDistributionPreflight({
        market: 'GLOBAL',
        targetLocale: locale,
        provider: 'GHOST',
        title: '4-Bay NAS Benchmark',
        contentMarkdown: 'Solid benchmark notes with 这款产品实测数据.',
        variantHtml: '<p>Solid benchmark notes with 这款产品实测数据.</p>',
        variantMetaDesc: 'Benchmark guide',
        brandNames: ['NebulaNAS'],
      });
      expect(preflight.blockers.some((i) => i.code === 'GLOBAL_CJK_LEAK')).toBe(true);
    }

    // 4. Allowed brand term does not trigger false positive
    const allowedBrand = detectLocaleLeakage(
      'NebulaNAS (星云存储) 4-bay quiet NAS benchmark.',
      'en-US',
      ['星云存储'],
    );
    expect(allowedBrand.leaked).toBe(false);
  });

  // ── Suite 5: Extension Bridge Security, Cross-Route Isolation & CORS ──────
  it('Suite 5: enforces ExtensionAuthGuard cross-route isolation, RFC 6750 Bearer parsing, and controlled chrome-extension:// CORS', async () => {
    const fakeGmext = 'gmext_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';

    // 1. gmext_ token must NEVER authenticate non-bridge routes
    for (const [method, path] of [
      ['GET', '/api/v1/billing/wallet'],
      ['GET', '/api/v1/admin/tenants'],
      ['DELETE', '/api/v2/brands/brand_nonexistent'],
      ['GET', '/api/v2/extension/tokens'],
    ] as const) {
      const res = await httpCall(apiBase, method, path, { token: fakeGmext });
      expect([401, 403, 404]).toContain(res.status);
    }

    // 2. Malformed RFC 6750 headers rejected before DB lookup
    for (const badAuth of [
      `Bearer  ${fakeGmext}`,
      `Bearer\t${fakeGmext}`,
      'Basic dXNlcjpwYXNz',
      'Bearer not_a_gmext_token',
    ]) {
      const res = await fetch(`${apiBase}/api/v2/extension/me`, {
        headers: { authorization: badAuth },
      });
      expect(res.status).toBe(401);
    }

    // 3. Controlled chrome-extension:// CORS: allowed ONLY on /api/v2/extension/{me,tasks,tasks/:id/confirm-published}
    const allowedPreflight = await fetch(`${apiBase}/api/v2/extension/me`, {
      method: 'OPTIONS',
      headers: {
        origin: VALID_EXT_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect([200, 204]).toContain(allowedPreflight.status);
    expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(VALID_EXT_ORIGIN);

    // Denied on /api/v2/extension/tokens, /api/v2/brands, /api/v1/billing/wallet
    for (const deniedPath of [
      '/api/v2/extension/tokens',
      '/api/v2/brands',
      '/api/v1/billing/wallet',
    ]) {
      const denied = await fetch(`${apiBase}${deniedPath}`, {
        method: 'OPTIONS',
        headers: {
          origin: VALID_EXT_ORIGIN,
          'access-control-request-method': 'GET',
        },
      });
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    }

    // Denied for evil origin and malformed uppercase Chrome extension ID
    for (const badOrigin of [
      'https://evil.example',
      'chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP',
      'chrome-extension://shortid',
    ]) {
      const res = await fetch(`${apiBase}/api/v2/extension/me`, {
        method: 'OPTIONS',
        headers: {
          origin: badOrigin,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }

    // Also verify public ROI report returns uniform 404 on invalid token format
    const publicRoi = apiApp.get(RoiReportPublicService);
    publicRoi.resetRateLimits();
    const invalidTokenRes = await httpCall(
      apiBase,
      'GET',
      '/api/v2/public/roi-reports/invalid-short',
    );
    expect(invalidTokenRes.status).toBe(404);
  });
});

// ============================================================================
// Layer B: Real PostgreSQL 16 Full-Stack Integration Suite
// Runs when GEOMIX_DB_INTEGRATION=1
// ============================================================================

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'GeoMix v2.2 Full-Stack Real-Postgres Integration Suite',
  () => {
    it('verifies real PG16 DDL constraints, cross-tenant isolation, Near-Miss, DiD retest skip, ROI report share/revoke, Shopify OAuth+webhook, multi-locale async VariantJob & Extension Bridge closed loop', async () => {
      const savedEnv: Record<string, string | undefined> = {};
      for (const key of [
        'BILLING_MODE',
        'LLM_PROVIDERS',
        'VISIBILITY_COLLECTOR',
        'EMBEDDING_PROVIDER',
        'CREDENTIAL_ENCRYPTION_KEY',
        'PUBLIC_APP_URL',
        'WEB_ORIGIN',
        'SHOPIFY_OAUTH_CLIENT_ID',
        'SHOPIFY_OAUTH_CLIENT_SECRET',
        'SHOPIFY_OAUTH_SCOPES',
        'WECHAT_API_BASE_URL',
      ]) {
        savedEnv[key] = process.env[key];
      }
      process.env.BILLING_MODE = 'SHADOW';
      process.env.LLM_PROVIDERS = '{}';
      process.env.VISIBILITY_COLLECTOR = 'fake';
      process.env.EMBEDDING_PROVIDER = 'fake';
      process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_CREDENTIAL_KEY;
      process.env.PUBLIC_APP_URL = 'https://app.geomix.test';
      process.env.WEB_ORIGIN = 'http://localhost:3000';
      process.env.SHOPIFY_OAUTH_CLIENT_ID = 'v22_shopify_client_id';
      process.env.SHOPIFY_OAUTH_CLIENT_SECRET = TEST_SHOPIFY_SECRET;
      process.env.SHOPIFY_OAUTH_SCOPES = 'read_content,write_content';
      process.env.WECHAT_API_BASE_URL = 'https://api.weixin.qq.com';

      const mock = await createVirtualMockServer();
      const ctx = await createIsolatedTestContext('v2_2_int');
      try {
        installVirtualHostOnApp(ctx.app, mock.port);
        ctx.app.get(FreeActionRateLimiter).reset();
        ctx.app.get(RoiReportPublicService).resetRateLimits();

        const tenantA = await ctx.createTenantUser({
          prefix: 'v22_a',
          points: 200,
          billingMode: 'STRICT',
        });
        const tenantB = await ctx.createTenantUser({
          prefix: 'v22_b',
          points: 50,
          billingMode: 'STRICT',
        });
        const tenantZero = await ctx.createTenantUser({
          prefix: 'v22_zero',
          points: 0,
          billingMode: 'STRICT',
        });

        // ── 1. Create dual-market brand with supportedLocales & controlPrompts ──
        const brandRes = await httpCall<{
          id: string;
          markets: Array<{ id: string; market: string }>;
        }>(ctx.base, 'POST', '/api/v2/brands', {
          token: tenantA.token,
          body: {
            name: 'NebulaNAS',
            category: 'Home Storage',
            markets: [
              {
                market: 'CN',
                localBrandName: '星云存储',
                ownedDomains: ['xingyun.example'],
                seedPrompts: ['2026 四盘位家用静音 NAS 推荐'],
              },
              {
                market: 'GLOBAL',
                localBrandName: 'NebulaNAS',
                ownedDomains: ['nebulanas.example'],
                seedPrompts: ['Best quiet 4-bay home NAS 2026'],
                supportedLocales: ['en-US', 'ja-JP', 'de-DE'],
                controlPrompts: ['Best quiet external SSD enclosure'],
              },
            ],
          },
        });
        expect(brandRes.status).toBe(200);
        const brandId = brandRes.data.id;
        const cnMarketId = brandRes.data.markets.find((m) => m.market === 'CN')!.id;
        const globalMarketId = brandRes.data.markets.find((m) => m.market === 'GLOBAL')!.id;

        // CN market rejects non-zh-CN locale
        const cnBadLocale = await httpCall(
          ctx.base,
          'PATCH',
          `/api/v2/brands/${brandId}/markets/CN`,
          {
            token: tenantA.token,
            body: { supportedLocales: ['ja-JP'] },
          },
        );
        expect(cnBadLocale.status).toBe(400);

        // ── 2. Near-Miss real Postgres persistence + 4-tier API + 0-pt boost + SSRF & dns_empty ──
        const visRun = await ctx.prisma.base.visibilityRun.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId,
            brandMarketId: cnMarketId,
            name: 'V22 Near-Miss Run',
            engines: ['deepseek'],
            prompts: ['2026 四盘位家用静音 NAS 推荐'],
            totalChecks: 1,
            unitPrice: 2,
            status: 'COMPLETED',
          },
        });
        const visObs = await ctx.prisma.base.visibilityObservation.create({
          data: {
            tenantId: tenantA.tenantId,
            runId: visRun.id,
            brandId,
            brandMarketId: cnMarketId,
            promptText: '2026 四盘位家用静音 NAS 推荐',
            engine: 'deepseek',
            sampleIndex: 1,
            status: 'SUCCESS',
            brandMentioned: true,
            rawMetaJson: { provider: 'deepseek', aiOverviewTriggered: true },
          },
        });
        await ctx.prisma.base.visibilityRetrievedSource.createMany({
          data: [
            {
              tenantId: tenantA.tenantId,
              brandId,
              brandMarketId: cnMarketId,
              observationId: visObs.id,
              engine: 'deepseek',
              url: 'https://xingyun.example/guides/nas-silent',
              domain: 'xingyun.example',
              title: '星云静音 NAS 指南',
              sourceKind: 'OWNED',
              wasOpened: true,
              wasCited: false,
              rank: 1,
            },
            {
              tenantId: tenantA.tenantId,
              brandId,
              brandMarketId: cnMarketId,
              observationId: visObs.id,
              engine: 'deepseek',
              url: 'https://authority.example/nas-roundup',
              domain: 'authority.example',
              title: 'NAS Roundup',
              sourceKind: 'AUTHORITY',
              wasOpened: false,
              wasCited: false,
              rank: 2,
            },
          ],
        });

        const nearMissCn = await httpCall<NearMissListResponse>(
          ctx.base,
          'GET',
          `/api/v2/brands/${brandId}/visibility/near-miss?market=CN&days=30`,
          { token: tenantA.token },
        );
        expect(nearMissCn.status).toBe(200);
        expect(nearMissCn.data.hasRawRetrievalSignals).toBe(true);
        expect(nearMissCn.data.items.some((i) => i.tier === 'OPENED_NOT_CITED')).toBe(true);
        expect(nearMissCn.data.items.some((i) => i.tier === 'RETRIEVED_NOT_CITED')).toBe(true);

        const nearMissGlobalDay1 = await httpCall<NearMissListResponse>(
          ctx.base,
          'GET',
          `/api/v2/brands/${brandId}/visibility/near-miss?market=GLOBAL&days=30`,
          { token: tenantA.token },
        );
        expect(nearMissGlobalDay1.status).toBe(200);
        expect(nearMissGlobalDay1.data.hasRawRetrievalSignals).toBe(false);
        expect(
          nearMissGlobalDay1.data.items.every(
            (i) => i.tier !== 'OPENED_NOT_CITED' && i.tier !== 'RETRIEVED_NOT_CITED',
          ),
        ).toBe(true);

        const walletBeforeBoost = await ctx.prisma.base.wallet.findUniqueOrThrow({
          where: { tenantId: tenantA.tenantId },
        });
        const boostRes = await httpCall<GeoBriefRecord>(
          ctx.base,
          'POST',
          `/api/v2/brands/${brandId}/briefs/from-near-miss`,
          {
            token: tenantA.token,
            body: {
              market: 'CN',
              tier: 'OPENED_NOT_CITED',
              targetPrompt: '2026 四盘位家用静音 NAS 推荐',
              sourceUrl: 'https://xingyun.example/guides/nas-silent',
              sourceTitle: '星云静音 NAS 指南',
            },
          },
        );
        expect(boostRes.status).toBe(200);
        expect(boostRes.data.sourceType).toBe('NEAR_MISS_BOOST');
        const walletAfterBoost = await ctx.prisma.base.wallet.findUniqueOrThrow({
          where: { tenantId: tenantA.tenantId },
        });
        expect(walletAfterBoost.points).toBe(walletBeforeBoost.points);

        // dns_empty degrades gracefully to FETCH_FALLBACK (200), while real SSRF returns 400
        const nxBoost = await httpCall<GeoBriefRecord>(
          ctx.base,
          'POST',
          `/api/v2/brands/${brandId}/briefs/from-near-miss`,
          {
            token: tenantA.token,
            body: {
              market: 'CN',
              tier: 'OPENED_NOT_CITED',
              targetPrompt: '2026 四盘位家用静音 NAS 推荐',
              sourceUrl: 'https://nxdomain.v22.example/missing',
            },
          },
        );
        expect(nxBoost.status).toBe(200);
        expect(nxBoost.data.diagnosisSummary).toContain('目标域名暂时无法解析');

        const ssrfBoost = await httpCall(
          ctx.base,
          'POST',
          `/api/v2/brands/${brandId}/briefs/from-near-miss`,
          {
            token: tenantA.token,
            body: {
              market: 'CN',
              tier: 'OPENED_NOT_CITED',
              targetPrompt: '2026 四盘位家用静音 NAS 推荐',
              sourceUrl: 'https://rebind.v22.example/secret',
            },
          },
        );
        expect(ssrfBoost.status).toBe(400);
        expect(ssrfBoost.code).toBe(API_ERROR.BAD_REQUEST);

        // ── 3. STRICT 0-pt DiD Retest Skip + chk_wallet_nonneg ──
        const zeroBrand = await ctx.prisma.base.brand.create({
          data: { tenantId: tenantZero.tenantId, name: 'ZeroBrand', category: 'Storage' },
        });
        const zeroMarket = await ctx.prisma.base.brandMarket.create({
          data: {
            tenantId: tenantZero.tenantId,
            brandId: zeroBrand.id,
            market: 'GLOBAL',
            locale: 'en-US',
            region: 'US',
            localBrandName: 'ZeroBrand',
            controlPrompts: ['Control prompt 1'],
          },
        });
        const zeroArticle = await ctx.prisma.base.geoArticle.create({
          data: {
            tenantId: tenantZero.tenantId,
            brandId: zeroBrand.id,
            brandMarketId: zeroMarket.id,
            title: 'Zero Article',
            targetPrompt: 'Zero target prompt',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            contentMarkdown: '# Zero',
            contentHtml: '<h1>Zero</h1>',
          },
        });
        const zeroPub = await ctx.prisma.base.geoPublishRecord.create({
          data: {
            tenantId: tenantZero.tenantId,
            brandId: zeroBrand.id,
            brandMarketId: zeroMarket.id,
            articleId: zeroArticle.id,
            publishedUrl: 'https://nebulanas.example/zero',
            channel: 'Official Blog',
          },
        });
        const dueSched = await ctx.prisma.base.geoRetestSchedule.create({
          data: {
            tenantId: tenantZero.tenantId,
            brandId: zeroBrand.id,
            brandMarketId: zeroMarket.id,
            publishRecordId: zeroPub.id,
            milestoneDay: 7,
            sampleCount: 3,
            includeControlPrompts: true,
            dueAt: new Date(Date.now() - 60_000),
            status: 'PENDING',
          },
        });
        await ctx.app.get(RetestSchedulerService).runDueSweep();
        const updatedSched = await ctx.prisma.base.geoRetestSchedule.findUniqueOrThrow({
          where: { id: dueSched.id },
        });
        expect(updatedSched.status).toBe('SKIPPED_INSUFFICIENT_POINTS');
        const zeroWallet = await ctx.prisma.base.wallet.findUniqueOrThrow({
          where: { tenantId: tenantZero.tenantId },
        });
        expect(zeroWallet.points).toBe(0);
        await expect(
          ctx.prisma.base
            .$executeRaw`UPDATE "Wallet" SET points = -1 WHERE "tenantId" = ${tenantZero.tenantId}`,
        ).rejects.toThrow();

        // ── 4. Monthly ROI Report Create -> HTML Export -> Share -> Public GET -> Revoke 404 ──
        const createReport = await httpCall<GeoRoiReportRecordDto>(
          ctx.base,
          'POST',
          `/api/v2/brands/${brandId}/roi-reports`,
          {
            token: tenantA.token,
            body: {
              market: 'GLOBAL',
              title: 'Nov ROI <script>alert(1)</script>',
              periodStart: '2026-11-01',
              periodEnd: '2026-11-30',
              locale: 'en-US',
              whiteLabelOrg: 'WhiteLabel <img src=x onerror=alert(1)>',
            },
          },
        );
        expect(createReport.status).toBe(200);
        const reportId = createReport.data.id;

        const htmlRes = await fetch(`${ctx.base}/api/v2/roi-reports/${reportId}/export.html`, {
          headers: { authorization: `Bearer ${tenantA.token}` },
        });
        expect(htmlRes.status).toBe(200);
        expect(htmlRes.headers.get('content-type')).toContain('text/html');
        const exportedHtml = await htmlRes.text();
        expect(exportedHtml).toContain('<svg');
        expect(exportedHtml).toContain('@media print');
        expect(exportedHtml).not.toContain('<script>alert(1)</script>');

        const shareRes = await httpCall<GeoRoiReportShareResultDto>(
          ctx.base,
          'POST',
          `/api/v2/roi-reports/${reportId}/share`,
          { token: tenantA.token, body: { expiresInDays: 30 } },
        );
        expect(shareRes.status).toBe(200);
        const shareToken = shareRes.data.sharePath.split('/').pop()!;
        expect(shareToken.length).toBeGreaterThanOrEqual(32);
        const dbReport = await ctx.prisma.base.geoRoiReport.findUniqueOrThrow({
          where: { id: reportId },
        });
        expect(dbReport.shareTokenHash).toBe(
          createHash('sha256').update(shareToken, 'utf8').digest('hex'),
        );

        // Real Postgres unique constraint on GeoRoiReport.shareTokenHash
        await expect(
          ctx.prisma.base.geoRoiReport.create({
            data: {
              tenantId: tenantA.tenantId,
              brandId,
              brandMarketId: globalMarketId,
              title: 'Dup Share Hash',
              periodStart: new Date('2026-11-01'),
              periodEnd: new Date('2026-11-30'),
              summaryJson: {},
              shareTokenHash: dbReport.shareTokenHash,
            },
          }),
        ).rejects.toThrow();

        const pubReportRes = await httpCall<PublicGeoRoiReportDto>(
          ctx.base,
          'GET',
          `/api/v2/public/roi-reports/${shareToken}`,
        );
        expect(pubReportRes.status).toBe(200);
        expect(pubReportRes.data.whiteLabelOrg).toContain('WhiteLabel');
        expect(pubReportRes.data.summary).not.toHaveProperty('pointsRoi');
        expect(pubReportRes.data).not.toHaveProperty('tenantId');
        expect(pubReportRes.data).not.toHaveProperty('shareTokenHash');

        // Cross-tenant isolation: Tenant B gets 404 on Tenant A's report
        const foreignReport = await httpCall(ctx.base, 'GET', `/api/v2/roi-reports/${reportId}`, {
          token: tenantB.token,
        });
        expect(foreignReport.status).toBe(404);

        const revokeRes = await httpCall(
          ctx.base,
          'DELETE',
          `/api/v2/roi-reports/${reportId}/share`,
          { token: tenantA.token },
        );
        expect(revokeRes.status).toBe(200);
        const revokedPub = await httpCall(
          ctx.base,
          'GET',
          `/api/v2/public/roi-reports/${shareToken}`,
        );
        expect(revokedPub.status).toBe(404);

        // ── 5. Shopify OAuth 2.0 Start -> Callback -> Single-Use Replay -> Uninstall Webhook ──
        const startOAuth = await httpCall<{ authorizeUrl: string; state: string }>(
          ctx.base,
          'POST',
          `/api/v2/brands/${brandId}/connections/shopify/oauth/start`,
          {
            token: tenantA.token,
            body: { shop: 'demo-store.myshopify.com', market: 'GLOBAL', displayName: 'Demo Shop' },
          },
        );
        expect(startOAuth.status).toBe(200);
        const oauthState = new URL(startOAuth.data.authorizeUrl).searchParams.get('state')!;
        expect(oauthState).toBeTruthy();

        const cbQuery = signShopifyCallbackQuery({
          code: 'shopify_auth_code_123',
          shop: 'demo-store.myshopify.com',
          state: oauthState,
          timestamp: String(Math.floor(Date.now() / 1000)),
        });
        const cbRes = await httpCall<{ connection: { id: string; authType: string } }>(
          ctx.base,
          'GET',
          `/api/v2/integrations/shopify/callback?${cbQuery}`,
          { headers: { accept: 'application/json' } },
        );
        expect(cbRes.status).toBe(200);
        expect(cbRes.data.connection.authType).toBe('OAUTH');
        const shopifyConnId = cbRes.data.connection.id;

        // Replaying the same state fails
        const replayRes = await httpCall(
          ctx.base,
          'GET',
          `/api/v2/integrations/shopify/callback?${cbQuery}`,
          { headers: { accept: 'application/json' } },
        );
        expect([400, 401]).toContain(replayRes.status);

        // Valid raw-body app/uninstalled webhook disables connection & wipes credentials
        const uninstallBody = JSON.stringify({
          id: 999,
          myshopify_domain: 'demo-store.myshopify.com',
        });
        const validUninstall = await fetch(
          `${ctx.base}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-shopify-shop-domain': 'demo-store.myshopify.com',
              'x-shopify-hmac-sha256': signShopifyWebhook(uninstallBody),
            },
            body: uninstallBody,
          },
        );
        expect(validUninstall.status).toBe(200);
        const wipedConn = await ctx.prisma.base.channelConnection.findUniqueOrThrow({
          where: { id: shopifyConnId },
        });
        expect(wipedConn.status).toBe('DISABLED');
        expect(wipedConn.credentialsCiphertext).toBe('');
        expect(wipedConn.oauthAccessTokenCiphertext).toBeNull();

        // ── 6. Multi-Locale Async GeoVariantJob (ja-JP + CN ZHIHU_EXT) ──
        const jaArticle = await ctx.prisma.base.geoArticle.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId,
            brandMarketId: globalMarketId,
            title: '静音設計の四盤位家庭用NAS実測比較ガイド',
            targetPrompt: 'Best quiet 4-bay home NAS 2026',
            targetLocale: 'ja-JP',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            contentMarkdown:
              '# 静音設計の四盤位家庭用NAS実測比較ガイド\n\nリビング設置向けの実測レビュー。',
            contentHtml: '<h1>静音設計の四盤位家庭用NAS実測比較ガイド</h1><p>実測レビュー。</p>',
          },
        });
        const variantJobRes = await httpCall<GeoVariantJobDto>(
          ctx.base,
          'POST',
          `/api/v2/articles/${jaArticle.id}/distributions/variant-jobs`,
          {
            token: tenantA.token,
            body: {
              targets: [
                {
                  provider: 'DEVTO',
                  mode: 'L1_API',
                  channelLabel: 'Dev.to JP',
                  targetLocale: 'ja-JP',
                  variantTemplateKey: 'DEVELOPER_TECH_POST',
                },
              ],
            },
          },
        );
        expect(variantJobRes.status).toBe(200);
        const variantJobId = variantJobRes.data.id;
        await ctx.app
          .get(VariantJobRunner)
          .process({ tenantId: tenantA.tenantId, jobId: variantJobId });
        const finishedJob = await ctx.prisma.base.geoVariantJob.findUniqueOrThrow({
          where: { id: variantJobId },
        });
        expect(finishedJob.status).toBe('COMPLETED');
        expect(finishedJob.taskIds).toHaveLength(1);
        const jaTask = await ctx.prisma.base.geoDistributionTask.findUniqueOrThrow({
          where: { id: finishedJob.taskIds[0] },
        });
        expect(jaTask.targetLocale).toBe('ja-JP');

        // ── 7. L2 Chrome Extension Token CRUD, Isolation & Idempotent confirm-published ──
        const cnArticle = await ctx.prisma.base.geoArticle.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId,
            brandMarketId: cnMarketId,
            title: '2026 四盘位家用静音 NAS 实测指南',
            targetPrompt: '2026 四盘位家用静音 NAS 推荐',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_COMMUNITY_QA',
            contentMarkdown: '# 2026 四盘位家用静音 NAS 实测指南\n\n客厅低噪实测。',
            contentHtml: '<h1>2026 四盘位家用静音 NAS 实测指南</h1><p>客厅低噪实测。</p>',
          },
        });
        const zhihuTask = await ctx.prisma.base.geoDistributionTask.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId,
            brandMarketId: cnMarketId,
            articleId: cnArticle.id,
            provider: 'ZHIHU_EXT',
            mode: 'L2_EXTENSION',
            channelLabel: '知乎专栏（扩展助手）',
            variantTitle: '2026 四盘位家用静音 NAS 实测指南',
            variantMarkdown: '# 2026 四盘位家用静音 NAS 实测指南',
            variantHtml: '<h1>2026 四盘位家用静音 NAS 实测指南</h1>',
            status: 'READY_TO_PUBLISH',
          },
        });

        const createTokA = await httpCall<CreateExtensionTokenResponseDto>(
          ctx.base,
          'POST',
          '/api/v2/extension/tokens',
          { token: tenantA.token, body: { label: 'Chrome MacBook' } },
        );
        expect(createTokA.status).toBe(200);
        const gmextA = createTokA.data.plainToken;
        expect(gmextA.startsWith('gmext_')).toBe(true);
        const tokenAId = createTokA.data.token.id;

        // Real Postgres unique constraint on ExtensionAccessToken.tokenHash
        const dbTokA = await ctx.prisma.base.extensionAccessToken.findUniqueOrThrow({
          where: { id: tokenAId },
        });
        await expect(
          ctx.prisma.base.extensionAccessToken.create({
            data: {
              tenantId: tenantA.tenantId,
              userId: tenantA.userId,
              label: 'Dup',
              tokenPrefix: dbTokA.tokenPrefix,
              tokenHash: dbTokA.tokenHash,
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          }),
        ).rejects.toThrow();

        // Tenant B creates its own extension token to test cross-tenant IDOR protection
        const createTokB = await httpCall<CreateExtensionTokenResponseDto>(
          ctx.base,
          'POST',
          '/api/v2/extension/tokens',
          { token: tenantB.token, body: { label: 'Tenant B Chrome' } },
        );
        const gmextB = createTokB.data.plainToken;

        const meRes = await httpCall<ExtensionMeDto>(ctx.base, 'GET', '/api/v2/extension/me', {
          token: gmextA,
        });
        expect(meRes.status).toBe(200);
        expect(meRes.data.bridgeVersion).toBe('v1');

        const tasksRes = await httpCall<ExtensionPendingTasksResponseDto>(
          ctx.base,
          'GET',
          '/api/v2/extension/tasks?provider=ZHIHU_EXT',
          { token: gmextA },
        );
        expect(tasksRes.status).toBe(200);
        expect(tasksRes.data.items.map((t) => t.taskId)).toContain(zhihuTask.id);

        // Tenant B cannot confirm Tenant A's task -> 404
        const idorConfirm = await httpCall(
          ctx.base,
          'POST',
          `/api/v2/extension/tasks/${zhihuTask.id}/confirm-published`,
          { token: gmextB, body: { publishedUrl: 'https://zhuanlan.zhihu.com/p/99887766' } },
        );
        expect(idorConfirm.status).toBe(404);

        // SSRF blocked with 400
        const ssrfConfirm = await httpCall(
          ctx.base,
          'POST',
          `/api/v2/extension/tasks/${zhihuTask.id}/confirm-published`,
          { token: gmextA, body: { publishedUrl: 'http://127.0.0.1/p/1' } },
        );
        expect(ssrfConfirm.status).toBe(400);

        // Confirm published #1 -> creates GeoPublishRecord + 3 GeoRetestSchedule rows
        const confirm1 = await httpCall<ExtensionConfirmPublishedResultDto>(
          ctx.base,
          'POST',
          `/api/v2/extension/tasks/${zhihuTask.id}/confirm-published`,
          { token: gmextA, body: { publishedUrl: 'https://zhuanlan.zhihu.com/p/99887766' } },
        );
        expect(confirm1.status).toBe(200);
        expect(confirm1.data.alreadyRecorded).toBe(false);
        expect(confirm1.data.retestScheduledCount).toBe(3);

        // Confirm published #2 (idempotent replay) -> alreadyRecorded: true, zero duplicates
        const confirm2 = await httpCall<ExtensionConfirmPublishedResultDto>(
          ctx.base,
          'POST',
          `/api/v2/extension/tasks/${zhihuTask.id}/confirm-published`,
          { token: gmextA, body: { publishedUrl: 'https://zhuanlan.zhihu.com/p/99887766' } },
        );
        expect(confirm2.status).toBe(200);
        expect(confirm2.data.alreadyRecorded).toBe(true);
        expect(confirm2.data.publishRecordId).toBe(confirm1.data.publishRecordId);
        expect(confirm2.data.retestScheduledCount).toBe(3);
        const pubRecordCount = await ctx.prisma.base.geoPublishRecord.count({
          where: { distributionTaskId: zhihuTask.id },
        });
        const schedCount = await ctx.prisma.base.geoRetestSchedule.count({
          where: { publishRecordId: confirm1.data.publishRecordId },
        });
        expect(pubRecordCount).toBe(1);
        expect(schedCount).toBe(3);

        // Revoke token -> immediate 401
        const delTok = await httpCall(ctx.base, 'DELETE', `/api/v2/extension/tokens/${tokenAId}`, {
          token: tenantA.token,
        });
        expect(delTok.status).toBe(200);
        const afterRevoke = await httpCall(ctx.base, 'GET', '/api/v2/extension/me', {
          token: gmextA,
        });
        expect(afterRevoke.status).toBe(401);
        expect(afterRevoke.code).toBe(AUTH_ERROR.UNAUTHORIZED);

        // ── 8. Real prisma.scoped cross-tenant isolation across all 3 new v2.2 tables ──
        const bRetrieved = await runInTenant(tenantB.tenantId, () =>
          ctx.prisma.scoped.visibilityRetrievedSource.findMany(),
        );
        const bReports = await runInTenant(tenantB.tenantId, () =>
          ctx.prisma.scoped.geoRoiReport.findMany(),
        );
        const bTokens = await runInTenant(tenantB.tenantId, () =>
          ctx.prisma.scoped.extensionAccessToken.findMany(),
        );
        expect(bRetrieved).toHaveLength(0);
        expect(bReports).toHaveLength(0);
        expect(bTokens.every((t) => t.tenantId === tenantB.tenantId)).toBe(true);

        // Verify VisibilityRetrievedSource cascade delete on observation delete
        await ctx.prisma.base.visibilityObservation.delete({ where: { id: visObs.id } });
        const afterCascade = await ctx.prisma.base.visibilityRetrievedSource.findMany({
          where: { observationId: visObs.id },
        });
        expect(afterCascade).toHaveLength(0);
      } finally {
        await ctx.close();
        await mock.close();
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }, 90_000);
  },
);
