import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DnsResolver } from '../../infra/guarded-request';
import { OutboundHttpClient } from '../../infra/outbound-http';
import { parseSsrfAllowlist } from '../../infra/ssrf';
import {
  CmsConnectorRegistry,
  ConnectorError,
  DevtoConnector,
  GhostConnector,
  GithubMdxConnector,
  HashnodeConnector,
  ShopifyConnector,
  WebflowConnector,
  WebhookConnector,
  WechatOfficialConnector,
  WordPressConnector,
  collectSecretCandidates,
  joinBasePath,
  redactSecrets,
  signWebhookPayload,
  verifyWebhookSignature,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
} from './index';

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
};

type RouteResponse = {
  status: number;
  headers?: Record<string, string>;
  body: string;
};

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makePublishPayload(
  overrides: Partial<ConnectorPublishPayload> = {},
): ConnectorPublishPayload {
  return {
    taskId: 'task_001',
    articleId: 'art_001',
    market: 'GLOBAL',
    channelLabel: 'Official Blog',
    title: 'Solar Generator 2026 Buying Guide',
    slug: 'solar-generator-2026-guide',
    metaDesc: 'Verified comparison of portable power stations.',
    markdown: '# Solar Generator Guide\n\nFacts backed by lab tests.',
    html: '<h1>Solar Generator Guide</h1><p>Facts backed by lab tests.</p>',
    publishAsDraft: false,
    tags: ['solar', 'guide'],
    schemaJsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Solar Generator </script><script>alert(1)</script>',
    },
    llmsTxtSnippet: '- [Solar Generator Guide](https://brand.example/blog/solar): Summary',
    ...overrides,
  };
}

describe('L1 CMS Connectors (Shopify, WordPress, Webflow, Webhook)', () => {
  let mockServer: Server;
  let mockBaseUrl = '';
  let positiveClient: OutboundHttpClient;
  let strictPublicClient: OutboundHttpClient;
  let captured: CapturedRequest[] = [];
  let routeHandler: (req: CapturedRequest) => RouteResponse | Promise<RouteResponse> = () => ({
    status: 404,
    body: JSON.stringify({ error: 'unhandled route' }),
  });

  beforeAll(async () => {
    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const rawBody = await readRawBody(req);
        const record: CapturedRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          rawBody,
        };
        captured.push(record);
        const out = await routeHandler(record);
        res.writeHead(out.status, {
          'content-type': 'application/json',
          ...(out.headers ?? {}),
        });
        res.end(out.body);
      })();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const { port } = mockServer.address() as AddressInfo;
    mockBaseUrl = `http://127.0.0.1:${port}`;
    const portPinnedAllowlist = parseSsrfAllowlist(`127.0.0.1:${port}`, {
      includeDefaults: false,
    });
    const testDnsResolver: DnsResolver = {
      async resolve(hostname: string) {
        const lower = hostname.toLowerCase();
        if (lower === 'rebind.example.com') {
          return [{ address: '10.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
    };
    positiveClient = new OutboundHttpClient({
      defaultAllowlist: portPinnedAllowlist,
      resolver: testDnsResolver,
    });
    strictPublicClient = new OutboundHttpClient();
  });

  beforeEach(() => {
    captured = [];
    routeHandler = () => ({
      status: 404,
      body: JSON.stringify({ error: 'not found' }),
    });
  });

  afterAll(async () => {
    await closeHttpServer(mockServer);
  });

  it('joinBasePath preserves base path prefixes and query params', () => {
    expect(joinBasePath('http://127.0.0.1:4100/shopify/', '/admin/api/2025-01/graphql.json')).toBe(
      'http://127.0.0.1:4100/shopify/admin/api/2025-01/graphql.json',
    );
    expect(
      joinBasePath('http://127.0.0.1:4100/wp', '/wp-json/wp/v2/categories', { per_page: 100 }),
    ).toBe('http://127.0.0.1:4100/wp/wp-json/wp/v2/categories?per_page=100');
  });

  it('CmsConnectorRegistry resolves all 9 L1 connectors', () => {
    const shopify = new ShopifyConnector(positiveClient);
    const wordpress = new WordPressConnector(positiveClient);
    const webflow = new WebflowConnector(positiveClient);
    const webhook = new WebhookConnector(positiveClient);
    const ghost = new GhostConnector(positiveClient);
    const devto = new DevtoConnector(positiveClient);
    const hashnode = new HashnodeConnector(positiveClient);
    const githubMdx = new GithubMdxConnector(positiveClient);
    const wechatOfficial = new WechatOfficialConnector(positiveClient);
    const registry = new CmsConnectorRegistry(
      shopify,
      wordpress,
      webflow,
      webhook,
      ghost,
      devto,
      hashnode,
      githubMdx,
      wechatOfficial,
    );

    expect(registry.get('SHOPIFY')).toBe(shopify);
    expect(registry.get('WORDPRESS')).toBe(wordpress);
    expect(registry.get('WEBFLOW')).toBe(webflow);
    expect(registry.get('WEBHOOK')).toBe(webhook);
    expect(registry.get('GHOST')).toBe(ghost);
    expect(registry.get('DEVTO')).toBe(devto);
    expect(registry.get('HASHNODE')).toBe(hashnode);
    expect(registry.get('GITHUB_MDX')).toBe(githubMdx);
    expect(registry.get('WECHAT_OFFICIAL')).toBe(wechatOfficial);
  });

  describe('ShopifyConnector', () => {
    const token = 'shpat_super_secret_shopify_token_998877';
    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_shopify_1',
      provider: 'SHOPIFY',
      displayName: 'GeoMix Store',
      siteBaseUrl: `${mockBaseUrl}/shopify`,
      configJson: { blogId: 'gid://shopify/Blog/101', blogHandle: 'insights' },
      ...overrides,
    });

    it('testConnection discovers blogs via both nodes and edges shapes and extracts primaryDomain', async () => {
      const connector = new ShopifyConnector(positiveClient);
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          data: {
            shop: { name: 'SolarCo Store', primaryDomain: { url: 'https://solarco.example.com' } },
            blogs: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/Blog/101',
                    title: 'News & Guides',
                    handle: 'news',
                  },
                },
              ],
            },
          },
        }),
      });

      const result = await connector.testConnection(makeConn(), { accessToken: token });
      expect(result.ok).toBe(true);
      expect(result.discoveredConfig?.primaryDomain).toBe('https://solarco.example.com');
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]?.id).toBe('gid://shopify/Blog/101');
      expect(result.targets[0]?.url).toBe('https://solarco.example.com/blogs/news');
      expect(captured[0]?.url).toBe('/shopify/admin/api/2025-01/graphql.json');
      expect(captured[0]?.headers['x-shopify-access-token']).toBe(token);
      expect(captured[0]?.headers.accept).toBe('application/json');
    });

    it('publish appends safely escaped inline JSON-LD and differentiates draft vs live', async () => {
      const connector = new ShopifyConnector(positiveClient);
      routeHandler = (req) => {
        const body = JSON.parse(req.rawBody) as {
          variables?: { article?: { isPublished?: boolean; body?: string; handle?: string } };
        };
        const isPublished = body.variables?.article?.isPublished ?? false;
        return {
          status: 200,
          body: JSON.stringify({
            data: {
              articleCreate: {
                article: {
                  id: 'gid://shopify/Article/777123',
                  handle: body.variables?.article?.handle ?? 'solar-guide',
                  title: 'Solar Generator 2026 Buying Guide',
                  isPublished,
                  blog: { id: 'gid://shopify/Blog/101', handle: 'insights' },
                },
                userErrors: [],
              },
            },
          }),
        };
      };

      const liveRes = await connector.publish(
        makeConn({
          configJson: {
            blogId: 'gid://shopify/Blog/101',
            blogHandle: 'insights',
            primaryDomain: 'https://solarco.example.com',
          },
        }),
        { accessToken: token },
        makePublishPayload({ publishAsDraft: false }),
      );
      expect(liveRes.remotePostId).toBe('gid://shopify/Article/777123');
      expect(liveRes.publishedAsDraft).toBe(false);
      expect(liveRes.remoteAdminUrl).toBe(`${mockBaseUrl}/shopify/admin/articles/777123`);
      expect(liveRes.remotePublishedUrl).toBe(
        'https://solarco.example.com/blogs/insights/solar-generator-2026-guide',
      );

      const sentLive = JSON.parse(captured[0]?.rawBody ?? '{}') as {
        variables: { article: { body: string; isPublished: boolean } };
      };
      expect(sentLive.variables.article.isPublished).toBe(true);
      expect(sentLive.variables.article.body).toContain('<script type="application/ld+json">');
      expect(sentLive.variables.article.body).toContain('\\u003c/script>');
      expect(sentLive.variables.article.body).not.toContain('</script><script>alert(1)');

      const draftRes = await connector.publish(
        makeConn(),
        { accessToken: token },
        makePublishPayload({ publishAsDraft: true }),
      );
      expect(draftRes.publishedAsDraft).toBe(true);
      expect(draftRes.remotePublishedUrl).toBeUndefined();
    });

    it('maps GraphQL userErrors and throttled errors without leaking accessToken', async () => {
      const connector = new ShopifyConnector(positiveClient);
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          data: {
            articleCreate: {
              article: null,
              userErrors: [
                {
                  field: ['handle'],
                  message: `Invalid handle with token ${token}`,
                  code: 'INVALID',
                },
              ],
            },
          },
        }),
      });

      await expect(
        connector.publish(makeConn(), { accessToken: token }, makePublishPayload()),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.code).toBe('VALIDATION_ERROR');
        expect(ce.message).not.toContain(token);
        expect(ce.message).toContain('[REDACTED]');
        return true;
      });

      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          errors: [
            {
              message: `Throttled for ${token}`,
              extensions: { code: 'THROTTLED' },
            },
          ],
        }),
      });

      await expect(connector.testConnection(makeConn(), { accessToken: token })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const ce = err as ConnectorError;
          expect(ce.code).toBe('RATE_LIMITED');
          expect(ce.retryable).toBe(true);
          expect(ce.message).not.toContain(token);
          return true;
        },
      );
    });

    it('rejects private/metadata/rebound onlineStoreUrl on publish and discards private shop primaryDomain', async () => {
      const connector = new ShopifyConnector(positiveClient);

      // listTargets / testConnection discards private primaryDomain instead of persisting it
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          data: {
            shop: {
              name: 'Evil Primary Store',
              primaryDomain: { url: 'http://169.254.169.254/latest/meta-data/' },
            },
            blogs: {
              nodes: [{ id: 'gid://shopify/Blog/101', title: 'News', handle: 'news' }],
            },
          },
        }),
      });
      const testRes = await connector.testConnection(makeConn(), { accessToken: token });
      expect(testRes.ok).toBe(true);
      expect(testRes.discoveredConfig).toBeUndefined();
      expect(testRes.targets[0]?.url).toBeUndefined();

      for (const badUrl of [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1:80/internal',
        'https://rebind.example.com/blogs/news/post',
      ]) {
        routeHandler = () => ({
          status: 200,
          body: JSON.stringify({
            data: {
              articleCreate: {
                article: {
                  id: 'gid://shopify/Article/999',
                  handle: 'post',
                  title: 'Title',
                  isPublished: true,
                  onlineStoreUrl: badUrl,
                  blog: { id: 'gid://shopify/Blog/101', handle: 'news' },
                },
                userErrors: [],
              },
            },
          }),
        });

        await expect(
          connector.publish(
            makeConn(),
            { accessToken: token },
            makePublishPayload({ publishAsDraft: false }),
          ),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const ce = err as ConnectorError;
          expect(ce.provider).toBe('SHOPIFY');
          expect(ce.code).toBe('SSRF_BLOCKED');
          return true;
        });
      }
    });
  });

  describe('WordPressConnector', () => {
    const username = 'editor_geo';
    const appPassword = 'abCD efGH ijKL mnOP qrST uvWX';
    const expectedBasic = Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64');

    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_wp_1',
      provider: 'WORDPRESS',
      displayName: 'WP Editorial',
      siteBaseUrl: `${mockBaseUrl}/wp`,
      configJson: { categoryIds: [12] },
      ...overrides,
    });

    it('testConnection authenticates via Basic Auth and fetches categories', async () => {
      const connector = new WordPressConnector(positiveClient);
      routeHandler = (req) => {
        if (req.url === '/wp/wp-json/wp/v2/users/me') {
          return { status: 200, body: JSON.stringify({ id: 7, name: 'Geo Editor', slug: 'geo' }) };
        }
        if (req.url === '/wp/wp-json/wp/v2/categories?per_page=100') {
          return {
            status: 200,
            body: JSON.stringify([
              {
                id: 12,
                name: 'Solar Guides',
                slug: 'solar-guides',
                link: 'https://wp.example/cat/solar',
                count: 8,
              },
            ]),
          };
        }
        return { status: 404, body: '{}' };
      };

      const res = await connector.testConnection(makeConn(), { username, appPassword });
      expect(res.ok).toBe(true);
      expect(res.targets).toHaveLength(1);
      expect(res.targets[0]?.id).toBe('12');
      expect(captured[0]?.headers.authorization).toBe(`Basic ${expectedBasic}`);
      expect(captured[0]?.headers.accept).toBe('application/json');
    });

    it('publish injects Gutenberg wp:html JSON-LD block and handles draft vs live', async () => {
      const connector = new WordPressConnector(positiveClient);
      routeHandler = (req) => {
        const body = JSON.parse(req.rawBody) as { status: string; slug?: string };
        return {
          status: 201,
          body: JSON.stringify({
            id: 456,
            status: body.status,
            link: `https://wp.example.com/${body.slug ?? 'post'}/`,
          }),
        };
      };

      const live = await connector.publish(
        makeConn(),
        { username, appPassword },
        makePublishPayload({ publishAsDraft: false }),
      );
      expect(live.remotePostId).toBe('456');
      expect(live.publishedAsDraft).toBe(false);
      expect(live.remoteAdminUrl).toBe(`${mockBaseUrl}/wp/wp-admin/post.php?post=456&action=edit`);
      expect(live.remotePublishedUrl).toBe('https://wp.example.com/solar-generator-2026-guide/');

      const sent = JSON.parse(captured[0]?.rawBody ?? '{}') as {
        status: string;
        content: string;
        categories: number[];
      };
      expect(sent.status).toBe('publish');
      expect(sent.categories).toEqual([12]);
      expect(sent.content).toContain('<!-- wp:html -->');
      expect(sent.content).toContain('<script type="application/ld+json">');
      expect(sent.content).toContain('<!-- /wp:html -->');
      expect(sent.content).toContain('\\u003c/script>');

      const draft = await connector.publish(
        makeConn(),
        { username, appPassword },
        makePublishPayload({ publishAsDraft: true }),
      );
      expect(draft.publishedAsDraft).toBe(true);
      expect(draft.remotePublishedUrl).toBeUndefined();
    });

    it('never leaks appPassword, compact password, or Basic token on HTTP 400/401/403/500 errors', async () => {
      const connector = new WordPressConnector(positiveClient);
      const compactPass = appPassword.replace(/\s+/g, '');
      const leakyBody = JSON.stringify({
        message: `Auth failed: Basic ${expectedBasic} raw=${appPassword} compact=${compactPass}`,
      });

      for (const [status, expectedCode] of [
        [400, 'VALIDATION_ERROR'],
        [401, 'AUTH_FAILED'],
        [403, 'FORBIDDEN'],
        [404, 'NOT_FOUND'],
        [429, 'RATE_LIMITED'],
        [500, 'UPSTREAM_ERROR'],
      ] as const) {
        routeHandler = () => ({ status, body: leakyBody });
        await expect(
          connector.testConnection(makeConn(), { username, appPassword }),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const ce = err as ConnectorError;
          expect(ce.code).toBe(expectedCode);
          expect(ce.message).not.toContain(appPassword);
          expect(ce.message).not.toContain(compactPass);
          expect(ce.message).not.toContain(expectedBasic);
          return true;
        });
      }
    });

    it('rejects private/metadata/rebound post.link returned by WordPress on live publish', async () => {
      const connector = new WordPressConnector(positiveClient);
      for (const badLink of [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1:80/internal',
        'https://rebind.example.com/post/',
      ]) {
        routeHandler = () => ({
          status: 201,
          body: JSON.stringify({
            id: 789,
            status: 'publish',
            link: badLink,
          }),
        });

        await expect(
          connector.publish(
            makeConn(),
            { username, appPassword },
            makePublishPayload({ publishAsDraft: false }),
          ),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const ce = err as ConnectorError;
          expect(ce.provider).toBe('WORDPRESS');
          expect(ce.code).toBe('SSRF_BLOCKED');
          return true;
        });
      }
    });
  });

  describe('WebflowConnector', () => {
    const apiToken = 'wf_secret_webflow_token_abc123456';
    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_wf_1',
      provider: 'WEBFLOW',
      displayName: 'Webflow Blog',
      siteBaseUrl: `${mockBaseUrl}/webflow`,
      configJson: {
        siteId: 'site_1',
        collectionId: 'col_blog',
        primaryDomain: 'https://brand.example.com',
        fieldMap: {
          title: 'name',
          slug: 'slug',
          bodyHtml: 'rich-body',
          metaDesc: 'summary',
          jsonLd: 'schema-json',
        },
      },
      ...overrides,
    });

    it('testConnection falls back from /v2/sites/:id/collections 404 to /v2/collections?siteId and loads fields', async () => {
      const connector = new WebflowConnector(positiveClient);
      routeHandler = (req) => {
        if (req.url === '/webflow/v2/sites') {
          return {
            status: 200,
            body: JSON.stringify({ sites: [{ id: 'site_1', displayName: 'Brand Site' }] }),
          };
        }
        if (req.url === '/webflow/v2/sites/site_1/collections') {
          return { status: 404, body: JSON.stringify({ message: 'not found' }) };
        }
        if (req.url === '/webflow/v2/collections?siteId=site_1') {
          return {
            status: 200,
            body: JSON.stringify({
              collections: [{ id: 'col_blog', displayName: 'Blog Posts', slug: 'blog' }],
            }),
          };
        }
        if (req.url === '/webflow/v2/collections/col_blog') {
          return {
            status: 200,
            body: JSON.stringify({
              id: 'col_blog',
              displayName: 'Blog Posts',
              fields: [
                {
                  id: 'f1',
                  slug: 'name',
                  displayName: 'Name',
                  type: 'PlainText',
                  isRequired: true,
                },
                {
                  id: 'f2',
                  slug: 'rich-body',
                  displayName: 'Body',
                  type: 'RichText',
                  isRequired: false,
                },
              ],
            }),
          };
        }
        return { status: 404, body: '{}' };
      };

      const res = await connector.testConnection(makeConn(), { apiToken });
      expect(res.ok).toBe(true);
      expect(res.targets).toHaveLength(1);
      expect(res.targets[0]?.id).toBe('col_blog');
      expect(Array.isArray(res.targets[0]?.meta?.fields)).toBe(true);
      expect(captured[0]?.headers.authorization).toBe(`Bearer ${apiToken}`);
    });

    it('publish uses fieldMap and routes draft to /items vs live to /items/live', async () => {
      const connector = new WebflowConnector(positiveClient);
      routeHandler = (req) => {
        const body = JSON.parse(req.rawBody) as {
          isDraft: boolean;
          fieldData: Record<string, unknown>;
        };
        return {
          status: 200,
          body: JSON.stringify({
            items: [
              {
                id: body.isDraft ? 'wf_draft_1' : 'wf_live_1',
                isDraft: body.isDraft,
                fieldData: body.fieldData,
              },
            ],
          }),
        };
      };

      const draftRes = await connector.publish(
        makeConn(),
        { apiToken },
        makePublishPayload({ publishAsDraft: true }),
      );
      expect(captured[0]?.url).toBe('/webflow/v2/collections/col_blog/items');
      expect(draftRes.remotePostId).toBe('wf_draft_1');
      expect(draftRes.publishedAsDraft).toBe(true);
      expect(draftRes.remotePublishedUrl).toBeUndefined();

      const sentDraft = JSON.parse(captured[0]?.rawBody ?? '{}') as {
        isDraft: boolean;
        fieldData: Record<string, string>;
      };
      expect(sentDraft.isDraft).toBe(true);
      expect(sentDraft.fieldData['rich-body']).toContain('Solar Generator Guide');
      expect(sentDraft.fieldData['summary']).toContain('Verified comparison');
      expect(sentDraft.fieldData['schema-json']).toContain('\\u003c/script>');

      const liveRes = await connector.publish(
        makeConn(),
        { apiToken },
        makePublishPayload({ publishAsDraft: false }),
      );
      expect(captured[1]?.url).toBe('/webflow/v2/collections/col_blog/items/live');
      expect(liveRes.remotePostId).toBe('wf_live_1');
      expect(liveRes.publishedAsDraft).toBe(false);
      expect(liveRes.remotePublishedUrl).toBe(
        'https://brand.example.com/posts/solar-generator-2026-guide',
      );
    });

    it('rejects SSRF & DNS-rebound siteBaseUrl in testConnection and publish with 0 transport calls', async () => {
      let transportCalls = 0;
      const guardedClient = new OutboundHttpClient({
        resolver: {
          async resolve(hostname: string) {
            if (hostname.toLowerCase() === 'rebind.example.com') {
              return [{ address: '10.0.0.1', family: 4 }];
            }
            return [{ address: '93.184.216.34', family: 4 }];
          },
        },
        transport: async () => {
          transportCalls += 1;
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ sites: [], id: 'should_never_run' })),
          };
        },
      });
      const connector = new WebflowConnector(guardedClient);
      const blockedSiteUrls = [
        'http://localhost',
        'http://sonargate:8080',
        'http://user:pass@public.example.com/',
        'http://metadata.google.internal/',
        'https://rebind.example.com',
      ];

      for (const siteBaseUrl of blockedSiteUrls) {
        const conn = makeConn({ siteBaseUrl, configJson: { collectionId: 'col_blog' } });
        await expect(connector.testConnection(conn, { apiToken })).rejects.toSatisfy(
          (err: unknown) => {
            expect(err).toBeInstanceOf(ConnectorError);
            const ce = err as ConnectorError;
            expect(ce.provider).toBe('WEBFLOW');
            expect(ce.code).toBe('SSRF_BLOCKED');
            return true;
          },
        );
        await expect(
          connector.publish(conn, { apiToken }, makePublishPayload({ publishAsDraft: false })),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const ce = err as ConnectorError;
          expect(ce.provider).toBe('WEBFLOW');
          expect(ce.code).toBe('SSRF_BLOCKED');
          return true;
        });
      }

      expect(transportCalls).toBe(0);
    });

    it('rejects private/metadata/rebound publishedUrl returned by Webflow on live publish', async () => {
      const connector = new WebflowConnector(positiveClient);
      for (const badUrl of [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1:80/internal',
        'https://rebind.example.com/posts/item',
      ]) {
        routeHandler = () => ({
          status: 200,
          body: JSON.stringify({
            id: 'wf_ssrf_item',
            isDraft: false,
            publishedUrl: badUrl,
          }),
        });

        await expect(
          connector.publish(
            makeConn(),
            { apiToken },
            makePublishPayload({ publishAsDraft: false }),
          ),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const ce = err as ConnectorError;
          expect(ce.provider).toBe('WEBFLOW');
          expect(ce.code).toBe('SSRF_BLOCKED');
          return true;
        });
      }

      // Also reject private configJson.primaryDomain fallback when upstream omits publishedUrl
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({ id: 'wf_ssrf_primary', isDraft: false }),
      });
      await expect(
        connector.publish(
          makeConn({
            configJson: {
              siteId: 'site_1',
              collectionId: 'col_blog',
              primaryDomain: 'http://169.254.169.254',
            },
          }),
          { apiToken },
          makePublishPayload({ publishAsDraft: false }),
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.provider).toBe('WEBFLOW');
        expect(ce.code).toBe('SSRF_BLOCKED');
        return true;
      });
    });
  });

  describe('WebhookConnector', () => {
    const signingSecret = 'whsec_test_signing_secret_2026';
    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_wh_1',
      provider: 'WEBHOOK',
      displayName: 'Custom CMS Hook',
      siteBaseUrl: `${mockBaseUrl}/webhook`,
      configJson: {
        extraHeaders: {
          'X-Custom-Tenant': 'acme',
          'X-GeoMix-Signature': 'sha256=forged',
          'X-Bad-Header': 'line1\r\nInjected: yes',
        },
      },
      ...overrides,
    });

    it('signWebhookPayload & verifyWebhookSignature validate HMAC-SHA256 strictly', () => {
      const raw = '{"hello":"world"}';
      const sig = signWebhookPayload(raw, signingSecret);
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(verifyWebhookSignature(raw, signingSecret, sig)).toBe(true);
      expect(verifyWebhookSignature(`${raw} `, signingSecret, sig)).toBe(false);
      expect(verifyWebhookSignature(raw, 'wrong_secret_1234', sig)).toBe(false);
      expect(verifyWebhookSignature(raw, signingSecret, 'sha256=short')).toBe(false);
    });

    it('sends valid HMAC-SHA256 signature, filters forbidden/CRLF extraHeaders, and parses publishedUrl', async () => {
      const connector = new WebhookConnector(positiveClient);
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          id: 'wh_post_99',
          publishedUrl: `${mockBaseUrl}/articles/solar-2026`,
          publishedAsDraft: false,
        }),
      });

      const res = await connector.publish(
        makeConn(),
        { signingSecret },
        makePublishPayload({ publishAsDraft: false }),
      );
      expect(res.remotePostId).toBe('wh_post_99');
      expect(res.remotePublishedUrl).toBe(`${mockBaseUrl}/articles/solar-2026`);
      expect(res.publishedAsDraft).toBe(false);

      const req = captured[0];
      expect(req).toBeDefined();
      const sigHeader = String(req?.headers['x-geomix-signature'] ?? '');
      expect(verifyWebhookSignature(req?.rawBody ?? '', signingSecret, sigHeader)).toBe(true);
      expect(req?.headers['x-geomix-event']).toBe('geomix.article.publish');
      expect(typeof req?.headers['x-geomix-delivery-id']).toBe('string');
      expect(req?.headers['x-custom-tenant']).toBe('acme');
      expect(req?.headers['x-bad-header']).toBeUndefined();
    });

    it('rejects private/metadata publishedUrl returned by Webhook via SSRF check', async () => {
      const connector = new WebhookConnector(positiveClient);
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          id: 'wh_post_ssrf',
          publishedUrl: 'http://169.254.169.254/latest/meta-data/',
        }),
      });

      await expect(
        connector.publish(makeConn(), { signingSecret }, makePublishPayload()),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).code).toBe('SSRF_BLOCKED');
        return true;
      });
    });

    it('strips User-Agent and DEL (\\u007f) CTL extraHeaders and suppresses remotePublishedUrl on draft push', async () => {
      const connector = new WebhookConnector(positiveClient);
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          id: 'wh_post_draft_1',
          publishedUrl: `${mockBaseUrl}/articles/draft-preview`,
          publishedAsDraft: true,
        }),
      });

      const res = await connector.publish(
        makeConn({
          configJson: {
            extraHeaders: {
              'User-Agent': 'EvilSpoofUA/1.0',
              'X-Ctl-Del': 'bad\u007fvalue',
              'X-Allowed-Header': 'clean-ok',
            },
          },
        }),
        { signingSecret },
        makePublishPayload({ publishAsDraft: true }),
      );

      expect(res.remotePostId).toBe('wh_post_draft_1');
      expect(res.publishedAsDraft).toBe(true);
      expect(res.remotePublishedUrl).toBeUndefined();

      const req = captured[0];
      expect(req).toBeDefined();
      expect(req?.headers['x-allowed-header']).toBe('clean-ok');
      expect(req?.headers['x-ctl-del']).toBeUndefined();
      expect(String(req?.headers['user-agent'] ?? '')).not.toContain('EvilSpoofUA');

      // Draft push must still reject private/metadata publishedUrl with SSRF_BLOCKED
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          id: 'wh_post_draft_ssrf',
          publishedUrl: 'http://169.254.169.254/latest/meta-data/',
          publishedAsDraft: true,
        }),
      });
      await expect(
        connector.publish(
          makeConn(),
          { signingSecret },
          makePublishPayload({ publishAsDraft: true }),
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).code).toBe('SSRF_BLOCKED');
        return true;
      });
    });
  });

  describe('SSRF Protection (Direct Private Targets & 302 Redirects)', () => {
    it('blocks direct private/loopback/metadata/internal hostnames with default zero-allowlist client', async () => {
      const webhook = new WebhookConnector(strictPublicClient);
      const blockedUrls = [
        'http://127.0.0.1/webhook',
        `${mockBaseUrl}/webhook`,
        'http://10.0.0.1/internal',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost/webhook',
        'http://sonargate/api',
      ];

      for (const siteBaseUrl of blockedUrls) {
        await expect(
          webhook.testConnection(
            {
              id: 'conn_ssrf',
              provider: 'WEBHOOK',
              displayName: 'SSRF Test',
              siteBaseUrl,
              configJson: {},
            },
            { signingSecret: 'whsec_ssrf_test_secret' },
          ),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          expect((err as ConnectorError).code).toBe('SSRF_BLOCKED');
          return true;
        });
      }
      expect(captured).toHaveLength(0);
    });

    it('blocks real HTTP 302 redirects to 169.254.169.254 and 10.0.0.1', async () => {
      const shopify = new ShopifyConnector(positiveClient);
      for (const redirectTarget of [
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/admin',
      ]) {
        routeHandler = () => ({
          status: 302,
          headers: { location: redirectTarget },
          body: '',
        });

        await expect(
          shopify.testConnection(
            {
              id: 'conn_redir',
              provider: 'SHOPIFY',
              displayName: 'Redirect Store',
              siteBaseUrl: `${mockBaseUrl}/shopify`,
              configJson: {},
            },
            { accessToken: 'shpat_redirect_secret_token' },
          ),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          expect((err as ConnectorError).code).toBe('SSRF_BLOCKED');
          return true;
        });
      }
    });

    it('redactSecrets scrubs Bearer/Basic/token patterns and JSON secret keys', () => {
      const raw =
        'Authorization: Bearer my_secret_token_xyz {"signingSecret":"whsec_12345678","access_token":"shpat_abcdef1234"}';
      const cleaned = redactSecrets(raw, ['my_secret_token_xyz']);
      expect(cleaned).not.toContain('my_secret_token_xyz');
      expect(cleaned).not.toContain('whsec_12345678');
      expect(cleaned).not.toContain('shpat_abcdef1234');
      expect(cleaned).toContain('[REDACTED]');
    });

    it('S-02: redactSecrets blocks whitespace-collapsed reconstruction, lowercase/mixed %xx, + form-encoding, JSON-escaped \\/ and configJson secrets', () => {
      const wpPass = 'abcd efgh ijkl mnop';
      const slashToken = 'tok+abc/def=9876';
      const idxKey = 'idx_secret_config_key_42';
      const hdrSecret = 'hdr_secret_value_99';
      const candidates = collectSecretCandidates(
        {
          username: 'wpadmin',
          appPassword: wpPass,
          apiToken: slashToken,
        },
        {
          indexNowKey: idxKey,
          extraHeaders: { 'X-Api-Key': hdrSecret, 'X-Public-Tag': 'public-ok' },
        },
      );

      // (a) Whitespace-collapsed reconstruction of spaced WP password
      const wsReconstructed = redactSecrets(
        'Upstream rejected password: abcd\nefgh\tijkl  mnop',
        candidates,
      );
      expect(wsReconstructed).toContain('[REDACTED]');
      expect(wsReconstructed).not.toContain(wpPass);
      expect(wsReconstructed).not.toContain('abcd efgh');

      // (b) Lowercase/mixed %xx & + form-encoding
      const encodedLeak = redactSecrets(
        'Invalid token=tok%2babc%2fdef%3d9876 mixed=tok%2Babc%2fdef%3D9876 pass=abcd+efgh+ijkl+mnop',
        candidates,
      );
      expect(encodedLeak).toContain('[REDACTED]');
      expect(encodedLeak).not.toContain('tok%2babc%2fdef%3d9876');
      expect(encodedLeak).not.toContain('tok%2Babc%2fdef%3D9876');
      expect(encodedLeak).not.toContain('abcd+efgh+ijkl+mnop');

      // (c) PHP json_encode escaped \/ in truncated non-JSON error
      const jsonSlashLeak = redactSecrets(
        'PHP error: {"err":"bad tok+abc\\/def=9876" idx=idx_secret_config_key_42 hdr=hdr_secret_value_99',
        candidates,
      );
      expect(jsonSlashLeak).toContain('[REDACTED]');
      expect(jsonSlashLeak).not.toContain('tok+abc\\/def=9876');
      expect(jsonSlashLeak).not.toContain(slashToken);
      expect(jsonSlashLeak).not.toContain(idxKey);
      expect(jsonSlashLeak).not.toContain(hdrSecret);
    });

    it('R2-S-01: redacts configJson secrets straddling the 220-char truncation boundary across all 4 L1 connectors', async () => {
      const hdrSecret = 'wh_live_secret_header_998877665544';
      const idxSecret = 'idx_live_secret_config_887766554433';
      const pad = 'a'.repeat(160);
      const webhookBoundaryBody = `Validation failed on custom payload field: ${pad} key=${hdrSecret}`;
      const idxBoundaryBody = `Validation failed on custom payload field: ${pad} key=${idxSecret}`;

      // 1. WebhookConnector.testConnection & publish
      const webhook = new WebhookConnector(positiveClient);
      const webhookConn: ConnectorConnectionContext = {
        id: 'conn_wh_r2s01',
        provider: 'WEBHOOK',
        displayName: 'Webhook Boundary',
        siteBaseUrl: `${mockBaseUrl}/webhook`,
        configJson: {
          extraHeaders: { 'X-Api-Key': hdrSecret },
        },
      };
      routeHandler = () => ({ status: 400, body: webhookBoundaryBody });

      for (const action of [
        () => webhook.testConnection(webhookConn, { signingSecret: 'whsec_boundary_123456' }),
        () =>
          webhook.publish(
            webhookConn,
            { signingSecret: 'whsec_boundary_123456' },
            makePublishPayload(),
          ),
      ]) {
        await expect(action()).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const msg = (err as ConnectorError).message;
          expect(msg).toContain('[REDACTED]');
          expect(msg).not.toContain(hdrSecret);
          expect(msg).not.toContain('wh_live_secr');
          return true;
        });
      }

      // 2. ShopifyConnector.testConnection & publish
      const shopify = new ShopifyConnector(positiveClient);
      const shopifyConn: ConnectorConnectionContext = {
        id: 'conn_sh_r2s01',
        provider: 'SHOPIFY',
        displayName: 'Shopify Boundary',
        siteBaseUrl: `${mockBaseUrl}/shopify`,
        configJson: { blogId: 'gid://shopify/Blog/1', indexNowKey: idxSecret },
      };
      routeHandler = () => ({ status: 400, body: idxBoundaryBody });
      for (const action of [
        () => shopify.testConnection(shopifyConn, { accessToken: 'shpat_boundary_123456' }),
        () =>
          shopify.publish(
            shopifyConn,
            { accessToken: 'shpat_boundary_123456' },
            makePublishPayload(),
          ),
      ]) {
        await expect(action()).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const msg = (err as ConnectorError).message;
          expect(msg).toContain('[REDACTED]');
          expect(msg).not.toContain(idxSecret);
          expect(msg).not.toContain('idx_live_secr');
          return true;
        });
      }

      // 3. WordPressConnector.testConnection & publish
      const wp = new WordPressConnector(positiveClient);
      const wpConn: ConnectorConnectionContext = {
        id: 'conn_wp_r2s01',
        provider: 'WORDPRESS',
        displayName: 'WP Boundary',
        siteBaseUrl: `${mockBaseUrl}/wp`,
        configJson: { indexNowKey: idxSecret },
      };
      routeHandler = () => ({ status: 400, body: idxBoundaryBody });
      for (const action of [
        () =>
          wp.testConnection(wpConn, {
            username: 'wpadmin',
            appPassword: 'abcd efgh ijkl mnop',
          }),
        () =>
          wp.publish(
            wpConn,
            { username: 'wpadmin', appPassword: 'abcd efgh ijkl mnop' },
            makePublishPayload(),
          ),
      ]) {
        await expect(action()).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const msg = (err as ConnectorError).message;
          expect(msg).toContain('[REDACTED]');
          expect(msg).not.toContain(idxSecret);
          expect(msg).not.toContain('idx_live_secr');
          return true;
        });
      }

      // 4. WebflowConnector.testConnection & publish
      const webflow = new WebflowConnector(positiveClient);
      const wfConn: ConnectorConnectionContext = {
        id: 'conn_wf_r2s01',
        provider: 'WEBFLOW',
        displayName: 'Webflow Boundary',
        siteBaseUrl: `${mockBaseUrl}/webflow`,
        configJson: {
          siteId: 'site_1',
          collectionId: 'col_blog',
          indexNowKey: idxSecret,
        },
      };
      routeHandler = () => ({ status: 400, body: idxBoundaryBody });
      for (const action of [
        () => webflow.testConnection(wfConn, { apiToken: 'wf_boundary_token_123456' }),
        () =>
          webflow.publish(wfConn, { apiToken: 'wf_boundary_token_123456' }, makePublishPayload()),
      ]) {
        await expect(action()).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          const msg = (err as ConnectorError).message;
          expect(msg).toContain('[REDACTED]');
          expect(msg).not.toContain(idxSecret);
          expect(msg).not.toContain('idx_live_secr');
          return true;
        });
      }
    });
  });
});
