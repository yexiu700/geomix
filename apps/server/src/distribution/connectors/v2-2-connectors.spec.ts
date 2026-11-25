import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DnsResolver } from '../../infra/guarded-request';
import { OutboundHttpClient } from '../../infra/outbound-http';
import { parseSsrfAllowlist } from '../../infra/ssrf';
import { normalizeGitHubBranch } from './github-mdx.connector';
import {
  ConnectorError,
  DevtoConnector,
  GhostConnector,
  GithubMdxConnector,
  HashnodeConnector,
  WechatOfficialConnector,
  buildGitHubMdxDocument,
  buildMultipartFormData,
  mapWeChatError,
  normalizeDevtoTags,
  normalizeGitHubContentDir,
  parseGhostAdminApiKey,
  renderGitHubPublicUrl,
  signGhostAdminJwt,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
} from './index';

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
  rawBuffer: Buffer;
};

type RouteResponse = {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
};

const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=',
  'base64',
);

async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makePayload(overrides: Partial<ConnectorPublishPayload> = {}): ConnectorPublishPayload {
  return {
    taskId: 'task_v22_1',
    articleId: 'art_v22_1',
    market: 'GLOBAL',
    channelLabel: 'Official Blog',
    title: 'GeoMix v2.2 Architecture Guide',
    slug: 'geomix-v22-architecture-guide',
    metaDesc: 'Detailed technical guide covering GeoMix v2.2 connectors and GEO indexing.',
    markdown: '# GeoMix v2.2\n\nComplete **Markdown** content with concrete benchmarks.',
    html: '<h1>GeoMix v2.2</h1><p>Complete <strong>HTML</strong> content.</p>',
    publishAsDraft: false,
    tags: ['GEO', 'AI Search', 'TypeScript', 'Next.js', 'Extra Tag'],
    schemaJsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'GeoMix v2.2 </script><script>alert(1)</script>',
    },
    canonicalUrl: 'https://brand.example.com/blog/geomix-v22',
    targetLocale: 'en-US',
    ...overrides,
  };
}

describe('v2.2 Official L1 Connectors', () => {
  let mockServer: Server;
  let mockBaseUrl = '';
  let captured: CapturedRequest[] = [];
  let routeHandler: (req: CapturedRequest) => RouteResponse = () => ({
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'not found' }),
  });

  let positiveClient: OutboundHttpClient;
  let strictPublicClient: OutboundHttpClient;

  beforeAll(async () => {
    mockServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const rawBuffer = await readRequestBuffer(req);
      const entry: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        rawBody: rawBuffer.toString('utf8'),
        rawBuffer,
      };
      captured.push(entry);
      const out = routeHandler(entry);
      res.writeHead(out.status, {
        'content-type': 'application/json',
        ...(out.headers ?? {}),
      });
      res.end(out.body);
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = mockServer.address() as AddressInfo;
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    const portPinnedAllowlist = parseSsrfAllowlist(`127.0.0.1:${addr.port}`, {
      includeDefaults: false,
    });
    const fakeResolver: DnsResolver = {
      async resolve(hostname: string) {
        if (hostname === 'rebind.example.com') {
          return [{ address: '10.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
    };

    positiveClient = new OutboundHttpClient({
      defaultAllowlist: portPinnedAllowlist,
      resolver: fakeResolver,
    });
    strictPublicClient = new OutboundHttpClient({
      resolver: fakeResolver,
    });
  });

  beforeEach(() => {
    captured = [];
  });

  afterAll(async () => {
    await closeHttpServer(mockServer);
  });

  // ── 1. Ghost Admin API v5 ──
  describe('GhostConnector', () => {
    const keyId = '65f1a2b3c4d5e6f708192a3b';
    const secretHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const adminApiKey = `${keyId}:${secretHex}`;

    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_ghost_1',
      provider: 'GHOST',
      displayName: 'GeoMix Ghost Blog',
      siteBaseUrl: `${mockBaseUrl}/ghost-site`,
      configJson: {},
      ...overrides,
    });

    it('signs valid 5-minute HS256 JWT with kid, aud=/admin/, and hex-decoded HMAC key', () => {
      const jwt = signGhostAdminJwt(adminApiKey, 1_700_000_000);
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
      expect(header).toEqual({ alg: 'HS256', typ: 'JWT', kid: keyId });
      expect(payload).toEqual({ iat: 1_700_000_000, exp: 1_700_000_300, aud: '/admin/' });

      const expectedSig = createHmac('sha256', Buffer.from(secretHex, 'hex'))
        .update(`${parts[0]}.${parts[1]}`)
        .digest('base64url');
      expect(parts[2]).toBe(expectedSig);

      // Odd-length hex secret must be rejected
      expect(() => parseGhostAdminApiKey('id1:0123456789abcdef1')).toThrow(ConnectorError);
    });

    it('tests connection, discovers primaryDomain/tags, and publishes draft & live posts with safe JSON-LD in codeinjection_head', async () => {
      routeHandler = (req) => {
        if (req.method === 'GET' && req.url.endsWith('/ghost/api/admin/site/')) {
          return {
            status: 200,
            body: JSON.stringify({
              site: { title: 'Acme Ghost', url: `${mockBaseUrl}/ghost-site/`, version: '5.90' },
            }),
          };
        }
        if (req.method === 'GET' && req.url.includes('/ghost/api/admin/tags/')) {
          return {
            status: 200,
            body: JSON.stringify({
              tags: [{ id: 'tag_1', name: 'GEO', slug: 'geo' }],
            }),
          };
        }
        if (req.method === 'POST' && req.url.includes('/ghost/api/admin/posts/?source=html')) {
          const parsed = JSON.parse(req.rawBody);
          const post = parsed.posts[0];
          return {
            status: 201,
            body: JSON.stringify({
              posts: [
                {
                  id: 'ghost_post_99',
                  slug: post.slug,
                  status: post.status,
                  url: `${mockBaseUrl}/ghost-site/${post.slug}/`,
                },
              ],
            }),
          };
        }
        return { status: 404, body: JSON.stringify({ errors: [{ message: 'not found' }] }) };
      };

      const connector = new GhostConnector(positiveClient);
      const testRes = await connector.testConnection(makeConn(), { adminApiKey });
      expect(testRes.ok).toBe(true);
      expect(testRes.targets).toHaveLength(1);
      expect(testRes.discoveredConfig?.primaryDomain).toBe(`${mockBaseUrl}/ghost-site`);
      expect(String(captured[0]?.headers.authorization)).toMatch(/^Ghost /);

      // Live publish
      const liveRes = await connector.publish(makeConn(), { adminApiKey }, makePayload());
      expect(liveRes.publishedAsDraft).toBe(false);
      expect(liveRes.remotePostId).toBe('ghost_post_99');
      expect(liveRes.remotePublishedUrl).toBe(
        `${mockBaseUrl}/ghost-site/geomix-v22-architecture-guide/`,
      );
      expect(liveRes.remoteAdminUrl).toContain('/ghost/#/editor/post/ghost_post_99');

      const postReq = captured.find((c) => c.method === 'POST')!;
      const body = JSON.parse(postReq.rawBody);
      expect(body.posts[0].status).toBe('published');
      expect(body.posts[0].codeinjection_head).toContain('<script type="application/ld+json">');
      expect(body.posts[0].codeinjection_head).not.toContain('</script><script>');
      expect(body.posts[0].html).not.toContain('application/ld+json');

      // Draft publish
      const draftRes = await connector.publish(
        makeConn(),
        { adminApiKey },
        makePayload({ publishAsDraft: true }),
      );
      expect(draftRes.publishedAsDraft).toBe(true);
      expect(draftRes.remotePublishedUrl).toBeUndefined();
    });

    it('blocks SSRF targets and redacts adminApiKey / hex secret / JWT on upstream errors', async () => {
      const strictConnector = new GhostConnector(strictPublicClient);
      for (const badUrl of [
        'http://127.0.0.1:8080',
        'http://169.254.169.254/latest/meta-data',
        'https://rebind.example.com',
      ]) {
        await expect(
          strictConnector.testConnection(makeConn({ siteBaseUrl: badUrl }), { adminApiKey }),
        ).rejects.toMatchObject({ provider: 'GHOST', code: 'SSRF_BLOCKED' });
      }

      routeHandler = (req) => ({
        status: 422,
        body: JSON.stringify({
          errors: [
            {
              message: `Bad key ${adminApiKey} secret=${secretHex} auth=${req.headers.authorization}`,
            },
          ],
        }),
      });
      const connector = new GhostConnector(positiveClient);
      try {
        await connector.publish(makeConn(), { adminApiKey }, makePayload());
        expect.fail('Expected VALIDATION_ERROR');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const msg = (err as ConnectorError).message;
        expect(msg).not.toContain(adminApiKey);
        expect(msg).not.toContain(secretHex);
        expect(msg).toContain('[REDACTED]');
      }
    });

    it('Tier 5 regression: evaluates created.url lazily so bare-hostname primaryDomain does not crash after live publish, and throws ConnectorError instead of TypeError when created.url is absent', async () => {
      const connector = new GhostConnector(positiveClient);

      // 1. Bare-hostname primaryDomain with valid created.url returned by Ghost -> MUST succeed cleanly
      routeHandler = (req) => {
        if (req.method === 'POST' && req.url.includes('/ghost/api/admin/posts/?source=html')) {
          const parsed = JSON.parse(req.rawBody);
          const post = parsed.posts[0];
          return {
            status: 201,
            body: JSON.stringify({
              posts: [
                {
                  id: 'ghost_post_bare_1',
                  slug: post.slug,
                  status: 'published',
                  url: `${mockBaseUrl}/ghost-site/${post.slug}/`,
                },
              ],
            }),
          };
        }
        return { status: 404, body: '{}' };
      };

      const resWithCreatedUrl = await connector.publish(
        makeConn({ configJson: { primaryDomain: 'blog.example.com' } }),
        { adminApiKey },
        makePayload(),
      );
      expect(resWithCreatedUrl.remotePostId).toBe('ghost_post_bare_1');
      expect(resWithCreatedUrl.publishedAsDraft).toBe(false);
      expect(resWithCreatedUrl.remotePublishedUrl).toBe(
        `${mockBaseUrl}/ghost-site/geomix-v22-architecture-guide/`,
      );

      // 2. Bare-hostname or unsafe-scheme primaryDomain when Ghost omits created.url -> clean ConnectorError (NOT uncaught TypeError)
      routeHandler = (req) => {
        if (req.method === 'POST' && req.url.includes('/ghost/api/admin/posts/?source=html')) {
          const parsed = JSON.parse(req.rawBody);
          const post = parsed.posts[0];
          return {
            status: 201,
            body: JSON.stringify({
              posts: [
                {
                  id: 'ghost_post_bare_2',
                  slug: post.slug,
                  status: 'published',
                },
              ],
            }),
          };
        }
        return { status: 404, body: '{}' };
      };

      for (const badPrimary of ['blog.example.com', 'javascript:alert(1)']) {
        await expect(
          connector.publish(
            makeConn({ configJson: { primaryDomain: badPrimary } }),
            { adminApiKey },
            makePayload(),
          ),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ConnectorError);
          expect(err).not.toBeInstanceOf(TypeError);
          expect((err as ConnectorError).provider).toBe('GHOST');
          expect((err as ConnectorError).code).toBe('CONFIG_ERROR');
          return true;
        });
      }

      // 3. Valid http(s) primaryDomain when Ghost omits created.url -> builds fallback URL cleanly
      const resWithValidPrimary = await connector.publish(
        makeConn({ configJson: { primaryDomain: `${mockBaseUrl}/custom-blog` } }),
        { adminApiKey },
        makePayload(),
      );
      expect(resWithValidPrimary.remotePublishedUrl).toBe(
        `${mockBaseUrl}/custom-blog/geomix-v22-architecture-guide/`,
      );
    });
  });

  // ── 2. Dev.to / Forem REST API v1 ──
  describe('DevtoConnector', () => {
    const apiKey = 'devto_live_api_key_9988776655';

    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_devto_1',
      provider: 'DEVTO',
      displayName: 'GeoMix Dev.to',
      siteBaseUrl: `${mockBaseUrl}/devto`,
      configJson: {},
      ...overrides,
    });

    it('normalizes tags to <= 4 lowercase ASCII alphanumeric values', () => {
      expect(
        normalizeDevtoTags([
          'AI Search',
          'Type-Script!',
          'Café',
          '中文标签',
          'Next.js',
          'React',
          'Node',
        ]),
      ).toEqual(['aisearch', 'typescript', 'cafe', 'nextjs']);
    });

    it('tests connection, publishes article (POST & PUT update) with canonical_url and normalized tags', async () => {
      routeHandler = (req) => {
        if (req.method === 'GET' && req.url.endsWith('/api/users/me')) {
          return {
            status: 200,
            body: JSON.stringify({
              id: 1001,
              username: 'geomix_dev',
              name: 'GeoMix Engineering',
              website_url: 'https://dev.to/geomix_dev',
            }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/api/articles')) {
          const parsed = JSON.parse(req.rawBody);
          return {
            status: 201,
            body: JSON.stringify({
              id: 5042,
              published: parsed.article.published,
              url: `${mockBaseUrl}/devto/geomix_dev/geomix-v22`,
            }),
          };
        }
        if (req.method === 'PUT' && req.url.endsWith('/api/articles/5042')) {
          const parsed = JSON.parse(req.rawBody);
          return {
            status: 200,
            body: JSON.stringify({
              id: 5042,
              published: parsed.article.published,
              url: `${mockBaseUrl}/devto/geomix_dev/geomix-v22`,
            }),
          };
        }
        return { status: 404, body: '{}' };
      };

      const connector = new DevtoConnector(positiveClient);
      const testRes = await connector.testConnection(makeConn(), { apiKey });
      expect(testRes.ok).toBe(true);
      expect(testRes.targets[0]?.handle).toBe('geomix_dev');
      expect(captured[0]?.headers['api-key']).toBe(apiKey);

      const pubRes = await connector.publish(makeConn(), { apiKey }, makePayload());
      expect(pubRes.remotePostId).toBe('5042');
      expect(pubRes.publishedAsDraft).toBe(false);
      expect(pubRes.remotePublishedUrl).toBe(`${mockBaseUrl}/devto/geomix_dev/geomix-v22`);
      expect(pubRes.remoteAdminUrl).toBe(`${mockBaseUrl}/devto/geomix_dev/geomix-v22/edit`);

      const sent = JSON.parse(captured[1]!.rawBody);
      expect(sent.article.tags).toEqual(['geo', 'aisearch', 'typescript', 'nextjs']);
      expect(sent.article.canonical_url).toBe('https://brand.example.com/blog/geomix-v22');
      expect(sent.article.published).toBe(true);

      // Update existing numeric remotePostId uses PUT
      const updRes = await connector.publish(
        makeConn(),
        { apiKey },
        makePayload({ remotePostId: '5042', publishAsDraft: true }),
      );
      expect(updRes.publishedAsDraft).toBe(true);
      expect(captured[2]?.method).toBe('PUT');
      expect(captured[2]?.url).toContain('/api/articles/5042');
    });

    it('blocks SSRF and redacts apiKey on 422 errors', async () => {
      const strictConnector = new DevtoConnector(strictPublicClient);
      await expect(
        strictConnector.testConnection(makeConn({ siteBaseUrl: 'http://127.0.0.1:9999' }), {
          apiKey,
        }),
      ).rejects.toMatchObject({ provider: 'DEVTO', code: 'SSRF_BLOCKED' });

      routeHandler = () => ({
        status: 422,
        body: JSON.stringify({ error: `Invalid api-key: ${apiKey}` }),
      });
      const connector = new DevtoConnector(positiveClient);
      try {
        await connector.publish(makeConn(), { apiKey }, makePayload());
        expect.fail('Expected VALIDATION_ERROR');
      } catch (err) {
        expect((err as ConnectorError).message).not.toContain(apiKey);
        expect((err as ConnectorError).message).toContain('[REDACTED]');
      }
    });
  });

  // ── 3. Hashnode GraphQL API ──
  describe('HashnodeConnector', () => {
    const apiToken = 'hn_pat_super_secret_token_887766';

    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_hashnode_1',
      provider: 'HASHNODE',
      displayName: 'GeoMix Hashnode',
      siteBaseUrl: `${mockBaseUrl}/hashnode`,
      configJson: {},
      ...overrides,
    });

    it('discovers publicationId, creates drafts via createDraft, and publishes via publishPost', async () => {
      routeHandler = (req) => {
        const parsed = JSON.parse(req.rawBody);
        const query = String(parsed.query || '');
        if (query.includes('GeoMixHashnodeMe')) {
          return {
            status: 200,
            body: JSON.stringify({
              data: {
                me: {
                  id: 'u_1',
                  username: 'geomix',
                  name: 'GeoMix Team',
                  publications: {
                    edges: [
                      {
                        node: {
                          id: 'pub_auto_123',
                          title: 'GeoMix Engineering',
                          url: 'https://geomix.hashnode.dev',
                          domainInfo: { hashnodeSubdomain: 'geomix' },
                        },
                      },
                    ],
                  },
                },
              },
            }),
          };
        }
        if (query.includes('createDraft')) {
          return {
            status: 200,
            body: JSON.stringify({
              data: {
                createDraft: {
                  draft: {
                    id: 'draft_hn_77',
                    slug: parsed.variables.input.slug,
                    title: parsed.variables.input.title,
                  },
                },
              },
            }),
          };
        }
        if (query.includes('publishPost')) {
          return {
            status: 200,
            body: JSON.stringify({
              data: {
                publishPost: {
                  post: {
                    id: 'post_hn_88',
                    slug: parsed.variables.input.slug,
                    title: parsed.variables.input.title,
                    url: `${mockBaseUrl}/hashnode/geomix-v22`,
                  },
                },
              },
            }),
          };
        }
        return { status: 400, body: '{}' };
      };

      const connector = new HashnodeConnector(positiveClient);
      const testRes = await connector.testConnection(makeConn(), { apiToken });
      expect(testRes.ok).toBe(true);
      expect(testRes.discoveredConfig?.publicationId).toBe('pub_auto_123');
      expect(captured[0]?.headers.authorization).toBe(apiToken);

      // Draft auto-discovers publicationId
      const draftRes = await connector.publish(
        makeConn(),
        { apiToken },
        makePayload({ publishAsDraft: true }),
      );
      expect(draftRes.publishedAsDraft).toBe(true);
      expect(draftRes.remotePostId).toBe('draft_hn_77');
      expect(draftRes.remoteAdminUrl).toBe('https://hashnode.com/draft/draft_hn_77');

      // Live publish
      const liveRes = await connector.publish(
        makeConn({ configJson: { publicationId: 'pub_auto_123' } }),
        { apiToken },
        makePayload({ publishAsDraft: false }),
      );
      expect(liveRes.publishedAsDraft).toBe(false);
      expect(liveRes.remotePostId).toBe('post_hn_88');
      expect(liveRes.remotePublishedUrl).toBe(`${mockBaseUrl}/hashnode/geomix-v22`);

      const liveVars = JSON.parse(captured[captured.length - 1]!.rawBody).variables.input;
      expect(liveVars.originalArticleURL).toBe('https://brand.example.com/blog/geomix-v22');
      expect(liveVars.metaTags.title).toContain('GeoMix v2.2');
    });

    it('maps GraphQL errors, blocks SSRF, and redacts apiToken', async () => {
      const strictConnector = new HashnodeConnector(strictPublicClient);
      await expect(
        strictConnector.testConnection(makeConn({ siteBaseUrl: 'http://169.254.169.254/' }), {
          apiToken,
        }),
      ).rejects.toMatchObject({ provider: 'HASHNODE', code: 'SSRF_BLOCKED' });

      const connector = new HashnodeConnector(positiveClient);
      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          errors: [
            { message: `Token ${apiToken} is invalid`, extensions: { code: 'UNAUTHENTICATED' } },
          ],
        }),
      });
      await expect(connector.testConnection(makeConn(), { apiToken })).rejects.toMatchObject({
        provider: 'HASHNODE',
        code: 'AUTH_FAILED',
      });

      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          errors: [
            {
              message: `Rate limit hit for ${apiToken}`,
              extensions: { code: 'TOO_MANY_REQUESTS' },
            },
          ],
        }),
      });
      await expect(connector.testConnection(makeConn(), { apiToken })).rejects.toMatchObject({
        provider: 'HASHNODE',
        code: 'RATE_LIMITED',
      });

      routeHandler = () => ({
        status: 200,
        body: JSON.stringify({
          errors: [
            { message: `Bad input leaking ${apiToken}`, extensions: { code: 'BAD_USER_INPUT' } },
          ],
        }),
      });
      try {
        await connector.testConnection(makeConn(), { apiToken });
        expect.fail('Expected VALIDATION_ERROR');
      } catch (err) {
        expect((err as ConnectorError).message).not.toContain(apiToken);
        expect((err as ConnectorError).message).toContain('[REDACTED]');
      }
    });
  });

  // ── 4. GitHub MDX REST API v3 ──
  describe('GithubMdxConnector', () => {
    const token = 'ghp_superSecretGitHubToken1234567890';

    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_gh_1',
      provider: 'GITHUB_MDX',
      displayName: 'GeoMix Docs Repo',
      siteBaseUrl: `${mockBaseUrl}/github`,
      configJson: {
        repoOwner: 'acme-corp',
        repoName: 'docs-site',
        branch: 'main',
        contentDir: 'content/blog',
        fileExtension: 'mdx',
        publicUrlTemplate: `${mockBaseUrl}/docs/{{locale}}/{{slug}}`,
      },
      ...overrides,
    });

    it('rejects path traversal in contentDir and builds valid MDX/MD frontmatter + JSON-LD', () => {
      expect(() => normalizeGitHubContentDir('../secrets')).toThrow(ConnectorError);
      expect(() => normalizeGitHubContentDir('content/../etc')).toThrow(ConnectorError);
      expect(normalizeGitHubContentDir('/content/blog/')).toBe('content/blog');
      expect(
        renderGitHubPublicUrl('https://docs.acme.com/{{locale}}/{{slug}}', {
          slug: 'hello-geo',
          locale: 'de-DE',
          date: '2026-11-24',
          path: 'content/blog/hello-geo.mdx',
        }),
      ).toBe('https://docs.acme.com/de-DE/hello-geo');

      const xssSchema = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'JSX {braces} and </script><script>alert(1)</script>\u2028\u2029',
      };
      const mdx = buildGitHubMdxDocument(
        makePayload({ schemaJsonLd: xssSchema }),
        'mdx',
        true,
        ['GEO'],
        'https://brand.example.com/blog/geomix-v22',
        '2026-11-24',
      );
      expect(mdx).toContain('---\ntitle: "GeoMix v2.2 Architecture Guide"');
      expect(mdx).toContain('export const jsonLd =');
      expect(mdx).toContain('dangerouslySetInnerHTML');
      expect(mdx).not.toContain('</script><script>');

      // Evaluate emitted JS expression from .mdx to verify SSR output contains ZERO raw </script> or unescaped U+2028/U+2029
      const exportMatch = /export const (jsonLd = [\s\S]+?;)\n/.exec(mdx);
      const exprMatch = /dangerouslySetInnerHTML=\{\{\s*__html:\s*([\s\S]+?)\s*\}\}/.exec(mdx);
      expect(exportMatch?.[1]).toBeTruthy();
      expect(exprMatch?.[1]).toBeTruthy();
      const ssrHtml = runInNewContext(`const ${exportMatch![1]}; (${exprMatch![1]})`) as string;
      expect(ssrHtml).not.toContain('</script>');
      expect(ssrHtml).not.toContain('<');
      expect(ssrHtml).not.toContain('\u2028');
      expect(ssrHtml).not.toContain('\u2029');
      expect(ssrHtml).toContain('\\u003c/script>');
      expect(JSON.parse(ssrHtml)).toEqual(xssSchema);

      const md = buildGitHubMdxDocument(
        makePayload({ schemaJsonLd: xssSchema }),
        'md',
        true,
        ['GEO'],
        undefined,
        '2026-11-24',
      );
      expect(md).toContain('<script type="application/ld+json">');
      expect(md).not.toContain('</script><script>');

      // GitHub branch git-ref & path-traversal validation
      expect(normalizeGitHubBranch('main')).toBe('main');
      expect(normalizeGitHubBranch('release/v2.2')).toBe('release/v2.2');
      for (const badBranch of [
        '',
        '   ',
        '../../pulls',
        'main/../other',
        'bad branch',
        'feat@{1}',
        'main.lock',
        'foo.lock/bar',
        '/main',
        'main/',
        'a//b',
        '.hidden',
        'main.',
        'main\\sub',
        'main\r\n',
        'main~1',
        'main^2',
        'main:foo',
        'main?a',
        'main*',
        'main[0]',
      ]) {
        expect(() => normalizeGitHubBranch(badBranch)).toThrow(ConnectorError);
      }
    });

    it('opens a Draft PR in draft mode and commits directly with SHA check in live mode', async () => {
      let existingFileSha: string | null = null;

      routeHandler = (req) => {
        if (req.method === 'GET' && req.url.endsWith('/repos/acme-corp/docs-site')) {
          return {
            status: 200,
            body: JSON.stringify({
              full_name: 'acme-corp/docs-site',
              default_branch: 'main',
              html_url: 'https://github.com/acme-corp/docs-site',
              permissions: { push: true },
            }),
          };
        }
        if (req.method === 'GET' && req.url.includes('/git/ref/heads/main')) {
          return {
            status: 200,
            body: JSON.stringify({ object: { sha: 'base_sha_111' } }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/git/refs')) {
          return { status: 201, body: JSON.stringify({ ref: JSON.parse(req.rawBody).ref }) };
        }
        if (req.method === 'GET' && req.url.includes('/contents/content/blog/')) {
          if (existingFileSha) {
            return { status: 200, body: JSON.stringify({ sha: existingFileSha }) };
          }
          return { status: 404, body: JSON.stringify({ message: 'Not Found' }) };
        }
        if (req.method === 'PUT' && req.url.includes('/contents/content/blog/')) {
          existingFileSha = 'file_sha_v2';
          return {
            status: 201,
            body: JSON.stringify({
              content: {
                sha: 'file_sha_v2',
                html_url:
                  'https://github.com/acme-corp/docs-site/blob/main/content/blog/geomix-v22-architecture-guide.mdx',
              },
              commit: { sha: 'commit_sha_999' },
            }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/pulls')) {
          return {
            status: 201,
            body: JSON.stringify({
              number: 42,
              html_url: 'https://github.com/acme-corp/docs-site/pull/42',
            }),
          };
        }
        return { status: 404, body: '{}' };
      };

      const connector = new GithubMdxConnector(positiveClient);
      const testRes = await connector.testConnection(makeConn(), { token });
      expect(testRes.ok).toBe(true);
      expect(testRes.discoveredConfig?.branch).toBe('main');

      // Draft mode -> branch + commit + PR
      const draftRes = await connector.publish(
        makeConn(),
        { token },
        makePayload({ publishAsDraft: true }),
      );
      expect(draftRes.publishedAsDraft).toBe(true);
      expect(draftRes.remotePostId).toBe('pr#42');
      expect(draftRes.remoteAdminUrl).toBe('https://github.com/acme-corp/docs-site/pull/42');
      expect(draftRes.remotePublishedUrl).toBeUndefined();

      // Live mode (existingFileSha already set -> must send sha on PUT for idempotent update)
      captured = [];
      const liveRes = await connector.publish(
        makeConn(),
        { token },
        makePayload({ publishAsDraft: false }),
      );
      expect(liveRes.publishedAsDraft).toBe(false);
      expect(liveRes.remotePostId).toBe('commit_sha_999');
      expect(liveRes.remotePublishedUrl).toBe(
        `${mockBaseUrl}/docs/en-US/geomix-v22-architecture-guide`,
      );
      const putReq = captured.find((c) => c.method === 'PUT')!;
      const putBody = JSON.parse(putReq.rawBody);
      expect(putBody.sha).toBe('file_sha_v2');
      expect(putBody.branch).toBe('main');
      const decodedMdx = Buffer.from(putBody.content, 'base64').toString('utf8');
      expect(decodedMdx).toContain('draft: false');
    });

    it('blocks SSRF in siteBaseUrl and publicUrlTemplate, and redacts token on errors', async () => {
      const strictConnector = new GithubMdxConnector(strictPublicClient);
      await expect(
        strictConnector.testConnection(makeConn({ siteBaseUrl: 'http://127.0.0.1:8080' }), {
          token,
        }),
      ).rejects.toMatchObject({ provider: 'GITHUB_MDX', code: 'SSRF_BLOCKED' });

      // Private publicUrlTemplate rejected fail-fast by validatePublishedUrl BEFORE any PUT /contents/... call
      routeHandler = (req) => {
        if (req.method === 'GET' && req.url.includes('/contents/')) {
          return { status: 404, body: '{}' };
        }
        if (req.method === 'PUT') {
          return { status: 201, body: JSON.stringify({ commit: { sha: 'abc' } }) };
        }
        return { status: 404, body: '{}' };
      };
      const connector = new GithubMdxConnector(positiveClient);

      for (const blockedConfig of [
        {
          repoOwner: 'acme-corp',
          repoName: 'docs-site',
          branch: 'main',
          publicUrlTemplate: 'http://127.0.0.1/{{slug}}',
        },
        {
          repoOwner: 'acme-corp',
          repoName: 'docs-site',
          branch: 'main',
          publicUrlTemplate: 'http://169.254.169.254/{{slug}}',
        },
        {
          repoOwner: 'acme-corp',
          repoName: 'docs-site',
          branch: 'main',
          primaryDomain: 'http://127.0.0.1',
        },
      ]) {
        captured = [];
        await expect(
          connector.publish(
            makeConn({ configJson: blockedConfig }),
            { token },
            makePayload({ publishAsDraft: false }),
          ),
        ).rejects.toMatchObject({ provider: 'GITHUB_MDX', code: 'SSRF_BLOCKED' });
        expect(captured.filter((req) => req.method === 'PUT')).toHaveLength(0);
        expect(captured).toHaveLength(0);
      }

      // Invalid branch values fail with CONFIG_ERROR and zero outbound HTTP requests
      for (const invalidBranch of [
        '../../pulls',
        'main/../other',
        'bad branch',
        'feat@{1}',
        'main.lock',
      ]) {
        captured = [];
        await expect(
          connector.publish(
            makeConn({
              configJson: {
                repoOwner: 'acme-corp',
                repoName: 'docs-site',
                branch: invalidBranch,
              },
            }),
            { token },
            makePayload({ publishAsDraft: true }),
          ),
        ).rejects.toMatchObject({ provider: 'GITHUB_MDX', code: 'CONFIG_ERROR' });
        expect(captured).toHaveLength(0);
      }

      // Redaction on 422
      routeHandler = () => ({
        status: 422,
        body: JSON.stringify({ message: `Rejected token ${token}` }),
      });
      try {
        await connector.testConnection(makeConn(), { token });
        expect.fail('Expected VALIDATION_ERROR');
      } catch (err) {
        expect((err as ConnectorError).message).not.toContain(token);
        expect((err as ConnectorError).message).toContain('[REDACTED]');
      }
    });
  });

  // ── 5. WeChat Official Draft-Only ──
  describe('WechatOfficialConnector', () => {
    const appId = 'wx_e2e_appid_123456';
    const appSecret = 'wx_super_secret_key_99887766';

    const makeConn = (
      overrides: Partial<ConnectorConnectionContext> = {},
    ): ConnectorConnectionContext => ({
      id: 'conn_wechat_1',
      provider: 'WECHAT_OFFICIAL',
      displayName: 'GeoMix 公众号',
      siteBaseUrl: `${mockBaseUrl}/wechat`,
      configJson: { author: 'GeoMix编辑' },
      ...overrides,
    });

    it('caches stable_token across calls, uploads binary cover & inline images, rewrites HTML, and is strictly draft-only', async () => {
      let stableTokenCalls = 0;
      let receivedCoverMultipart: Buffer = Buffer.alloc(0);
      let receivedInlineMultipart: Buffer = Buffer.alloc(0);

      routeHandler = (req) => {
        if (req.method === 'POST' && req.url.endsWith('/cgi-bin/stable_token')) {
          stableTokenCalls += 1;
          return {
            status: 200,
            body: JSON.stringify({ access_token: 'wx_runtime_token_alpha_999', expires_in: 7200 }),
          };
        }
        if (req.method === 'GET' && req.url.includes('/cgi-bin/draft/count')) {
          return { status: 200, body: JSON.stringify({ total_count: 3 }) };
        }
        if (req.method === 'GET' && req.url.endsWith('/assets/diagram.png')) {
          return {
            status: 200,
            headers: { 'content-type': 'image/png' },
            body: VALID_1X1_PNG,
          };
        }
        if (req.method === 'POST' && req.url.includes('/cgi-bin/media/uploadimg')) {
          receivedInlineMultipart = req.rawBuffer;
          return {
            status: 200,
            body: JSON.stringify({ url: 'https://mmbiz.qpic.cn/mmbiz_png/uploaded_inline_1/0' }),
          };
        }
        if (req.method === 'POST' && req.url.includes('/cgi-bin/material/add_material')) {
          receivedCoverMultipart = req.rawBuffer;
          return {
            status: 200,
            body: JSON.stringify({
              media_id: 'thumb_media_123',
              url: 'https://mmbiz.qpic.cn/cover',
            }),
          };
        }
        if (req.method === 'POST' && req.url.includes('/cgi-bin/draft/add')) {
          return {
            status: 200,
            body: JSON.stringify({ media_id: 'draft_media_888' }),
          };
        }
        return { status: 404, body: '{}' };
      };

      const connector = new WechatOfficialConnector(positiveClient);
      const testRes = await connector.testConnection(makeConn(), { appId, appSecret });
      expect(testRes.ok).toBe(true);
      expect(testRes.targets[0]?.id).toBe('wechat_draft_box');

      const inlineImgUrl = `${mockBaseUrl}/assets/diagram.png`;
      const longMetaDesc = 'A'.repeat(150); // SEO metaDesc > 120 chars should auto-truncate safely

      // Even if caller passes publishAsDraft: false, WeChat MUST stay strictly draft-only!
      const pub1 = await connector.publish(
        makeConn(),
        { appId, appSecret },
        makePayload({
          title: 'GeoMix 公众号技术指南',
          metaDesc: longMetaDesc,
          publishAsDraft: false,
          html: `<p>Intro</p><img src="${inlineImgUrl}" alt="diagram" />`,
        }),
      );
      expect(pub1.publishedAsDraft).toBe(true);
      expect(pub1.remotePostId).toBe('draft_media_888');
      expect(pub1.remotePublishedUrl).toBeUndefined();
      expect(pub1.remoteAdminUrl).toBe('https://mp.weixin.qq.com/');

      // Binary PNG signature bytes must survive multipart upload bit-for-bit
      expect(receivedInlineMultipart.includes(VALID_1X1_PNG)).toBe(true);
      expect(receivedCoverMultipart.includes(VALID_1X1_PNG)).toBe(true);

      const draftReq = captured.find((c) => c.url.includes('/cgi-bin/draft/add'))!;
      const draftBody = JSON.parse(draftReq.rawBody);
      expect(draftBody.articles[0].content).toContain(
        'https://mmbiz.qpic.cn/mmbiz_png/uploaded_inline_1/0',
      );
      expect(draftBody.articles[0].content).not.toContain(inlineImgUrl);
      expect(draftBody.articles[0].thumb_media_id).toBe('thumb_media_123');
      expect(draftBody.articles[0].digest.length).toBe(120);

      // Second publish reuses cached stable_token (total stable_token calls === 1)
      const pub2 = await connector.publish(
        makeConn({ configJson: { defaultCoverMediaId: 'cached_cover_1' } }),
        { appId, appSecret },
        makePayload({
          title: 'Second Draft',
          publishAsDraft: false,
          html: '<p>No external images</p>',
        }),
      );
      expect(pub2.publishedAsDraft).toBe(true);
      expect(stableTokenCalls).toBe(1);

      // Verify zero calls to any non-draft publishing endpoints
      for (const req of captured) {
        expect(req.url).not.toContain('freepublish');
        expect(req.url).not.toContain('message/mass');
      }
    });

    it('maps errcode 40164 to actionable IP whitelist FORBIDDEN error, validates lengths, retries once on 40001, blocks SSRF, and redacts secrets', async () => {
      // 1. 40164 IP whitelist
      const err40164 = mapWeChatError(40164, 'invalid ip 203.0.113.10 not in whitelist', [
        appSecret,
      ]);
      expect(err40164.code).toBe('FORBIDDEN');
      expect(err40164.message).toContain('40164');
      expect(err40164.message).toContain('IP 白名单');
      expect(err40164.message).toContain('203.0.113.10');

      // 2. Field length validations
      const connector = new WechatOfficialConnector(positiveClient);
      await expect(
        connector.publish(
          makeConn(),
          { appId, appSecret },
          makePayload({ title: '标'.repeat(65) }),
        ),
      ).rejects.toMatchObject({ provider: 'WECHAT_OFFICIAL', code: 'VALIDATION_ERROR' });

      await expect(
        connector.publish(
          makeConn({ configJson: { author: '作者'.repeat(10) } }),
          { appId, appSecret },
          makePayload({ title: 'Valid Title' }),
        ),
      ).rejects.toMatchObject({ provider: 'WECHAT_OFFICIAL', code: 'VALIDATION_ERROR' });

      await expect(
        connector.publish(
          makeConn(),
          { appId, appSecret },
          makePayload({
            title: 'Valid Title',
            extras: { digest: '摘'.repeat(121) },
          }),
        ),
      ).rejects.toMatchObject({ provider: 'WECHAT_OFFICIAL', code: 'VALIDATION_ERROR' });

      // 3. 40001 stale cached token eviction & single automatic retry + secret redaction
      let tokenSeq = 0;
      let draftAttempts = 0;
      routeHandler = (req) => {
        if (req.url.endsWith('/cgi-bin/stable_token')) {
          tokenSeq += 1;
          return {
            status: 200,
            body: JSON.stringify({ access_token: `wx_tok_seq_${tokenSeq}`, expires_in: 7200 }),
          };
        }
        if (req.url.includes('/cgi-bin/draft/add')) {
          draftAttempts += 1;
          if (draftAttempts === 1) {
            return {
              status: 200,
              body: JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }),
            };
          }
          return { status: 200, body: JSON.stringify({ media_id: 'draft_retried_ok' }) };
        }
        return { status: 404, body: '{}' };
      };

      const retried = await connector.publish(
        makeConn({ id: 'conn_wechat_retry', configJson: { defaultCoverMediaId: 'thumb_1' } }),
        { appId, appSecret },
        makePayload({ title: 'Retry Draft', html: '<p>ok</p>' }),
      );
      expect(retried.remotePostId).toBe('draft_retried_ok');
      expect(tokenSeq).toBe(2);
      expect(draftAttempts).toBe(2);

      // 4. SSRF on siteBaseUrl AND inline image AND coverImageUrl
      const strictConnector = new WechatOfficialConnector(strictPublicClient);
      await expect(
        strictConnector.testConnection(makeConn({ siteBaseUrl: 'http://127.0.0.1:8000' }), {
          appId,
          appSecret,
        }),
      ).rejects.toMatchObject({ provider: 'WECHAT_OFFICIAL', code: 'SSRF_BLOCKED' });

      await expect(
        connector.publish(
          makeConn({ id: 'conn_wechat_ssrf_img', configJson: { defaultCoverMediaId: 'thumb_1' } }),
          { appId, appSecret },
          makePayload({
            title: 'SSRF Inline Image',
            html: '<p><img src="http://127.0.0.1:9/internal.png" /></p>',
          }),
        ),
      ).rejects.toMatchObject({ provider: 'WECHAT_OFFICIAL', code: 'SSRF_BLOCKED' });

      await expect(
        connector.publish(
          makeConn({ id: 'conn_wechat_ssrf_cover', configJson: {} }),
          { appId, appSecret },
          makePayload({
            title: 'SSRF Cover Image',
            html: '<p>Clean body</p>',
            extras: { coverImageUrl: 'http://169.254.169.254/latest/meta-data' },
          }),
        ),
      ).rejects.toMatchObject({ provider: 'WECHAT_OFFICIAL', code: 'SSRF_BLOCKED' });

      // 5. Secret redaction of appSecret & access_token in error messages
      routeHandler = (req) => {
        if (req.url.endsWith('/cgi-bin/stable_token')) {
          return {
            status: 200,
            body: JSON.stringify({ access_token: 'wx_secret_tok_leak_test', expires_in: 7200 }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            errcode: 45003,
            errmsg: `Bad request secret=${appSecret} url=https://api.weixin.qq.com/cgi-bin/draft/add?access_token=wx_secret_tok_leak_test`,
          }),
        };
      };
      try {
        await connector.publish(
          makeConn({ id: 'conn_wechat_redact', configJson: { defaultCoverMediaId: 'thumb_1' } }),
          { appId, appSecret },
          makePayload({ title: 'Redact Test', html: '<p>ok</p>' }),
        );
        expect.fail('Expected VALIDATION_ERROR');
      } catch (err) {
        const msg = (err as ConnectorError).message;
        expect(msg).not.toContain(appSecret);
        expect(msg).not.toContain('wx_secret_tok_leak_test');
        expect(msg).toContain('[REDACTED]');
      }

      // 6. Pure multipart helper check
      const form = buildMultipartFormData('media', 'pic.png', 'image/png', VALID_1X1_PNG);
      expect(form.contentType).toContain('multipart/form-data; boundary=');
      expect(form.body.includes(VALID_1X1_PNG)).toBe(true);
    });

    it('rewrites prefix-sharing inline image URLs cleanly without corrupting query-string variants', async () => {
      let uploadCount = 0;
      const baseImgUrl = `${mockBaseUrl}/assets/a.png`;
      const queryImgUrl = `${mockBaseUrl}/assets/a.png?w=800`;

      routeHandler = (req) => {
        if (req.method === 'POST' && req.url.endsWith('/cgi-bin/stable_token')) {
          return {
            status: 200,
            body: JSON.stringify({ access_token: 'wx_prefix_test_tok', expires_in: 7200 }),
          };
        }
        if (req.method === 'GET' && req.url.startsWith('/assets/a.png')) {
          return {
            status: 200,
            headers: { 'content-type': 'image/png' },
            body: VALID_1X1_PNG,
          };
        }
        if (req.method === 'POST' && req.url.includes('/cgi-bin/media/uploadimg')) {
          uploadCount += 1;
          return {
            status: 200,
            body: JSON.stringify({
              url: `https://mmbiz.qpic.cn/mmbiz_png/uploaded_${uploadCount}/0`,
            }),
          };
        }
        if (req.method === 'POST' && req.url.includes('/cgi-bin/draft/add')) {
          return {
            status: 200,
            body: JSON.stringify({ media_id: 'draft_prefix_safe_1' }),
          };
        }
        return { status: 404, body: '{}' };
      };

      const connector = new WechatOfficialConnector(positiveClient);
      const res = await connector.publish(
        makeConn({
          id: 'conn_wechat_prefix_test',
          configJson: { defaultCoverMediaId: 'thumb_cover_1' },
        }),
        { appId, appSecret },
        makePayload({
          title: 'Prefix Collision Guard',
          html: `<p>Ref ${baseImgUrl}</p><img src="${baseImgUrl}" /><img src="${queryImgUrl}" />`,
        }),
      );
      expect(res.remotePostId).toBe('draft_prefix_safe_1');
      expect(uploadCount).toBe(2);

      const draftReq = captured.find((c) => c.url.includes('/cgi-bin/draft/add'))!;
      const content = JSON.parse(draftReq.rawBody).articles[0].content as string;
      expect(content).toContain('<img src="https://mmbiz.qpic.cn/mmbiz_png/uploaded_1/0" />');
      expect(content).toContain('<img src="https://mmbiz.qpic.cn/mmbiz_png/uploaded_2/0" />');
      expect(content).not.toContain('uploaded_1/0?w=800');
      expect(content).toContain(`<p>Ref ${baseImgUrl}</p>`);
    });
  });
});
