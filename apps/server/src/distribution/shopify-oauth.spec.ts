import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  VersioningType,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelConnectionDto, ChannelConnectionTestResultDto } from '@geomix/shared';
import { AuthContextMiddleware } from '../auth/auth-context.middleware';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService, passwordFingerprint } from '../auth/auth.service';
import type { AuthConfig, AuthStore, AuthUser } from '../auth/auth.types';
import { CaptchaService } from '../auth/captcha.service';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { signToken } from '../auth/token';
import { QuotaService } from '../billing/quota.service';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { SECRET_BOX_OPTIONS, SecretBox } from '../common/secret-box';
import type { HttpTransport } from '../infra/guarded-request';
import { OUTBOUND_HTTP_DEPS, OutboundHttpClient } from '../infra/outbound-http';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import {
  CmsConnectorRegistry,
  DevtoConnector,
  GhostConnector,
  GithubMdxConnector,
  HashnodeConnector,
  ShopifyConnector,
  WebflowConnector,
  WebhookConnector,
  WechatOfficialConnector,
  WordPressConnector,
} from './connectors';
import { ShopifyOAuthController } from './shopify-oauth.controller';
import {
  InMemoryShopifyOAuthStateStore,
  SHOPIFY_OAUTH_DEPS,
  SHOPIFY_OAUTH_STATE_TTL_MS,
  ShopifyOAuthService,
  normalizeShopifyShopDomain,
  verifyShopifyOAuthCallbackHmac,
  verifyShopifyWebhookHmac,
} from './shopify-oauth.service';

const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_CLIENT_ID = 'shopify_client_id_test';
const TEST_CLIENT_SECRET = 'shopify_client_secret_super_sensitive_998877';
const TEST_AUTH_CONFIG: AuthConfig = {
  accessSecret: 'test-access-secret-for-shopify-oauth-spec-32bytes',
  refreshSecret: 'test-refresh-secret-for-shopify-oauth-spec-32bytes',
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 86400,
};

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type ConnectionRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  credentialsCiphertext: string;
  credentialsIv: string;
  credentialsTag: string;
  keyVersion: number;
  credentialHint: string;
  configJson: Record<string, unknown>;
  status: string;
  authType: string;
  oauthAccessTokenCiphertext: string | null;
  oauthExpiresAt: Date | null;
  targetLocale: string | null;
  externalShopDomain: string | null;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function signShopifyQuery(params: Record<string, string>, secret: string): string {
  const entries = Object.entries(params)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .map(([k, v]): [string, string] => [
      k.replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D'),
      v.replace(/%/g, '%25').replace(/&/g, '%26'),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const message = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const hmac = createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  const qs = new URLSearchParams({ ...params, hmac });
  return qs.toString();
}

function signWebhookBody(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

function tokenForUser(user: AuthUser): string {
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  return signToken(
    {
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      typ: 'access',
      fp: passwordFingerprint(user.passwordHash),
      lms: nowMs,
      iat,
      exp: iat + TEST_AUTH_CONFIG.accessTtlSeconds,
    },
    TEST_AUTH_CONFIG.accessSecret,
  );
}

class InMemoryOAuthDb {
  users: AuthUser[] = [];
  brands: Array<{ id: string; tenantId: string; name: string }> = [];
  brandMarkets: Array<{ id: string; tenantId: string; brandId: string; market: 'CN' | 'GLOBAL' }> =
    [];
  quotas: Array<{ tenantId: string; key: string; used: bigint; limit: bigint }> = [];
  connections: ConnectionRow[] = [];
  private seq = 1;

  reset(): void {
    this.seq = 1;
    const future = new Date(Date.now() + 30 * 86_400_000);
    const expired = new Date(Date.now() - 86_400_000);
    this.users = [
      {
        id: 'user_a',
        tenantId: 'tenant_a',
        username: 'alice',
        passwordHash: 'hash_a',
        nickname: 'Alice',
        role: 'MERCHANT',
        tenantName: 'Tenant A',
        expiresAt: future,
        isActive: true,
      },
      {
        id: 'user_b',
        tenantId: 'tenant_b',
        username: 'bob',
        passwordHash: 'hash_b',
        nickname: 'Bob',
        role: 'MERCHANT',
        tenantName: 'Tenant B',
        expiresAt: future,
        isActive: true,
      },
      {
        id: 'user_expired',
        tenantId: 'tenant_exp',
        username: 'expired',
        passwordHash: 'hash_exp',
        nickname: 'Expired',
        role: 'MERCHANT',
        tenantName: 'Expired Tenant',
        expiresAt: expired,
        isActive: true,
      },
    ];
    this.brands = [
      { id: 'brand_a', tenantId: 'tenant_a', name: 'Brand A' },
      { id: 'brand_b', tenantId: 'tenant_b', name: 'Brand B' },
      { id: 'brand_exp', tenantId: 'tenant_exp', name: 'Brand Exp' },
    ];
    this.brandMarkets = [
      { id: 'bm_a_global', tenantId: 'tenant_a', brandId: 'brand_a', market: 'GLOBAL' },
      { id: 'bm_a_cn', tenantId: 'tenant_a', brandId: 'brand_a', market: 'CN' },
      { id: 'bm_b_global', tenantId: 'tenant_b', brandId: 'brand_b', market: 'GLOBAL' },
      { id: 'bm_exp_global', tenantId: 'tenant_exp', brandId: 'brand_exp', market: 'GLOBAL' },
    ];
    this.quotas = [
      { tenantId: 'tenant_a', key: 'SOCIAL_AUTH', used: 0n, limit: 10n },
      { tenantId: 'tenant_b', key: 'SOCIAL_AUTH', used: 0n, limit: 10n },
      { tenantId: 'tenant_exp', key: 'SOCIAL_AUTH', used: 0n, limit: 10n },
    ];
    this.connections = [];
  }

  createAuthStore(): AuthStore {
    return {
      findUserByUsername: async (username) =>
        this.users.find((u) => u.username === username) ?? null,
      findUserById: async (id) => this.users.find((u) => u.id === id) ?? null,
      touchLogin: async () => undefined,
      updatePassword: async () => undefined,
      revoke: async () => undefined,
      latestRevokeAt: async () => null,
    };
  }

  private matchesConnectionWhere(
    row: ConnectionRow,
    where: Record<string, unknown>,
    tenantFilter?: string,
  ): boolean {
    if (tenantFilter && row.tenantId !== tenantFilter) return false;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'OR' && Array.isArray(v)) {
        const anyMatch = v.some((sub) =>
          this.matchesConnectionWhere(row, sub as Record<string, unknown>, undefined),
        );
        if (!anyMatch) return false;
        continue;
      }
      const actual = (row as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'in' in v && Array.isArray((v as { in: unknown[] }).in)) {
        if (!(v as { in: unknown[] }).in.includes(actual)) return false;
        continue;
      }
      if (actual !== v) return false;
    }
    return true;
  }

  createPrismaService(): PrismaService {
    const requireTenant = (): string => {
      const tid = currentTenantId();
      if (!tid) throw new Error('Missing tenant context');
      return tid;
    };
    const withMarket = (row: ConnectionRow) => {
      const bm = this.brandMarkets.find((m) => m.id === row.brandMarketId);
      return { ...row, brandMarket: bm ? { market: bm.market } : null };
    };

    const executeRaw = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> => {
      const sql = strings.join(' ');
      if (sql.includes('SET used = used +')) {
        const delta = BigInt(values[0] as bigint | number);
        const tenantId = String(values[1]);
        const key = String(values[2]);
        const q = this.quotas.find((item) => item.tenantId === tenantId && item.key === key);
        if (!q || q.used + delta > q.limit) return 0;
        q.used += delta;
        return 1;
      }
      if (sql.includes('SET used = used -')) {
        const delta = BigInt(values[0] as bigint | number);
        const tenantId = String(values[1]);
        const key = String(values[2]);
        const q = this.quotas.find((item) => item.tenantId === tenantId && item.key === key);
        if (!q || q.used < delta) return 0;
        q.used -= delta;
        return 1;
      }
      throw new Error(`Unsupported SQL: ${sql}`);
    };

    const queryRaw = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{ used: bigint; limit: bigint }>> => {
      const sql = strings.join(' ');
      if (sql.includes('FROM "Quota"')) {
        const tenantId = String(values[0]);
        const key = String(values[1]);
        const q = this.quotas.find((item) => item.tenantId === tenantId && item.key === key);
        return q ? [{ used: q.used, limit: q.limit }] : [];
      }
      throw new Error(`Unsupported SQL: ${sql}`);
    };

    const scopedOps = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      brand: {
        findFirst: async (args: { where: { id: string }; include?: { markets?: boolean } }) => {
          const tenantId = requireTenant();
          const brand = this.brands.find((b) => b.id === args.where.id && b.tenantId === tenantId);
          if (!brand) return null;
          return {
            ...brand,
            ...(args.include?.markets
              ? {
                  markets: this.brandMarkets.filter(
                    (m) => m.brandId === brand.id && m.tenantId === tenantId,
                  ),
                }
              : {}),
          };
        },
      },
      brandMarket: {
        findFirst: async (args: { where: { id: string; brandId?: string } }) => {
          const tenantId = requireTenant();
          return (
            this.brandMarkets.find(
              (m) =>
                m.tenantId === tenantId &&
                m.id === args.where.id &&
                (!args.where.brandId || m.brandId === args.where.brandId),
            ) ?? null
          );
        },
      },
      channelConnection: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          const tenantId = requireTenant();
          return this.connections
            .filter((c) => this.matchesConnectionWhere(c, args.where ?? {}, tenantId))
            .map(withMarket);
        },
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const tenantId = requireTenant();
          const hit = this.connections.find((c) =>
            this.matchesConnectionWhere(c, args.where ?? {}, tenantId),
          );
          return hit ? withMarket(hit) : null;
        },
        create: async (args: { data: Partial<ConnectionRow> }) => {
          const tenantId = requireTenant();
          const now = new Date();
          const row: ConnectionRow = {
            id: `conn_${this.seq++}`,
            tenantId,
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            provider: String(args.data.provider),
            displayName: String(args.data.displayName),
            siteBaseUrl: String(args.data.siteBaseUrl),
            credentialsCiphertext: String(args.data.credentialsCiphertext ?? ''),
            credentialsIv: String(args.data.credentialsIv ?? ''),
            credentialsTag: String(args.data.credentialsTag ?? ''),
            keyVersion: Number(args.data.keyVersion ?? 1),
            credentialHint: String(args.data.credentialHint ?? '****'),
            configJson: (args.data.configJson ?? {}) as Record<string, unknown>,
            status: String(args.data.status ?? 'ACTIVE'),
            authType: String(args.data.authType ?? 'API_KEY'),
            oauthAccessTokenCiphertext: args.data.oauthAccessTokenCiphertext ?? null,
            oauthExpiresAt: args.data.oauthExpiresAt ?? null,
            targetLocale: args.data.targetLocale ?? null,
            externalShopDomain: args.data.externalShopDomain ?? null,
            lastTestedAt: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          };
          this.connections.push(row);
          return withMarket(row);
        },
        update: async (args: { where: { id: string }; data: Partial<ConnectionRow> }) => {
          const tenantId = requireTenant();
          const idx = this.connections.findIndex(
            (c) => c.id === args.where.id && c.tenantId === tenantId,
          );
          if (idx === -1) throw new Error('Not found');
          const next: ConnectionRow = {
            ...this.connections[idx]!,
            ...args.data,
            updatedAt: new Date(),
          };
          this.connections[idx] = next;
          return withMarket(next);
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Partial<ConnectionRow>;
        }) => {
          const tenantId = requireTenant();
          let count = 0;
          this.connections = this.connections.map((row) => {
            if (!this.matchesConnectionWhere(row, args.where ?? {}, tenantId)) return row;
            count += 1;
            return { ...row, ...args.data, updatedAt: new Date() };
          });
          return { count };
        },
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          const tenantId = requireTenant();
          const before = this.connections.length;
          this.connections = this.connections.filter(
            (row) => !this.matchesConnectionWhere(row, args.where ?? {}, tenantId),
          );
          return { count: before - this.connections.length };
        },
      },
    };

    const scoped = {
      ...scopedOps,
      $transaction: async <T>(fn: (tx: typeof scopedOps) => Promise<T>): Promise<T> => {
        const snapshotQuotas = this.quotas.map((q) => ({ ...q }));
        const snapshotConns = this.connections.map((c) => ({ ...c }));
        try {
          return await fn(scopedOps);
        } catch (err) {
          this.quotas = snapshotQuotas;
          this.connections = snapshotConns;
          throw err;
        }
      },
    };

    const base = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      quota: {
        findUnique: async (args: {
          where: { tenantId_key: { tenantId: string; key: string } };
        }) => {
          const { tenantId, key } = args.where.tenantId_key;
          return this.quotas.find((q) => q.tenantId === tenantId && q.key === key) ?? null;
        },
      },
      channelConnection: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          return this.connections
            .filter((row) => this.matchesConnectionWhere(row, args.where ?? {}, undefined))
            .map((row) => ({ id: row.id, tenantId: row.tenantId }));
        },
      },
    };

    return { scoped, base } as unknown as PrismaService;
  }
}

describe('Shopify OAuth 2.0 & app/uninstalled Webhook', () => {
  describe('Pure domain & HMAC helpers', () => {
    it('normalizes valid *.myshopify.com domains and rejects invalid hosts', () => {
      expect(normalizeShopifyShopDomain('Demo-Store.myshopify.com')).toBe(
        'demo-store.myshopify.com',
      );
      expect(
        normalizeShopifyShopDomain('https://demo-store.myshopify.com/', { allowHttpsUrl: true }),
      ).toBe('demo-store.myshopify.com');
      expect(
        normalizeShopifyShopDomain('https://demo-store.myshopify.com/', { allowHttpsUrl: false }),
      ).toBeNull();

      for (const bad of [
        '',
        'evil.com',
        'myshopify.com',
        'sub.demo.myshopify.com',
        'demo.myshopify.com.evil.com',
        '-bad.myshopify.com',
        'bad-.myshopify.com',
        'http://demo.myshopify.com',
        'https://demo.myshopify.com/admin',
        '127.0.0.1',
        'localhost',
        'demo.myshopify.com\r\n',
        '\r\ndemo.myshopify.com',
        'demo.myshopify.com\t',
        'demo.myshopify.com\u0000',
      ]) {
        expect(normalizeShopifyShopDomain(bad, { allowHttpsUrl: true })).toBeNull();
        expect(normalizeShopifyShopDomain(bad, { allowHttpsUrl: false })).toBeNull();
      }
    });

    it('verifies Shopify OAuth query HMAC, rejects HPP duplicate keys, and rejects __proto__ injection', () => {
      const qs = signShopifyQuery(
        { code: 'code_1', shop: 'demo-store.myshopify.com', state: 'state_token_1234567890' },
        TEST_CLIENT_SECRET,
      );
      expect(verifyShopifyOAuthCallbackHmac(qs, TEST_CLIENT_SECRET).ok).toBe(true);
      expect(verifyShopifyOAuthCallbackHmac(qs, 'wrong_secret').ok).toBe(false);
      expect(
        verifyShopifyOAuthCallbackHmac(`${qs}&shop=evil.myshopify.com`, TEST_CLIENT_SECRET),
      ).toMatchObject({ ok: false, duplicateKey: 'shop' });
      expect(verifyShopifyOAuthCallbackHmac(`${qs}&__proto__=evil`, TEST_CLIENT_SECRET).ok).toBe(
        false,
      );
    });

    it('verifies raw-body base64 webhook HMAC strictly and rejects non-canonical padding bits', () => {
      const raw = Buffer.from('{  "id": 123,  "myshopify_domain": "demo.myshopify.com" }', 'utf8');
      const sig = signWebhookBody(raw, TEST_CLIENT_SECRET);
      expect(verifyShopifyWebhookHmac(raw, sig, TEST_CLIENT_SECRET)).toBe(true);
      expect(verifyShopifyWebhookHmac(raw, 'not-base64', TEST_CLIENT_SECRET)).toBe(false);
      expect(
        verifyShopifyWebhookHmac(
          Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8'),
          sig,
          TEST_CLIENT_SECRET,
        ),
      ).toBe(false);

      // Flip 1 unused trailing padding bit in the 43rd Base64 character (e.g. ...Es= -> ...Et=)
      const b64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const idx42 = b64Alphabet.indexOf(sig[42]!);
      expect(idx42).toBeGreaterThanOrEqual(0);
      expect(idx42 & 0b11).toBe(0);
      const malleatedSig = `${sig.slice(0, 42)}${b64Alphabet[idx42 | 1]}=`;
      // Node's permissive Base64 decoder decodes both to identical 32 bytes, yet canonical verifier MUST reject
      expect(Buffer.from(malleatedSig, 'base64').equals(Buffer.from(sig, 'base64'))).toBe(true);
      expect(verifyShopifyWebhookHmac(raw, malleatedSig, TEST_CLIENT_SECRET)).toBe(false);
    });
  });

  describe('Full HTTP OAuth & Webhook Flows', () => {
    let db: InMemoryOAuthDb;
    let app: INestApplication;
    let apiBaseUrl = '';
    let mockShopifyServer: Server;
    let mockShopifyPort = 0;
    let nowMs = 1_750_000_000_000;
    let envMap: Record<string, string | undefined>;
    let shopifyUpstreamMode: 'ok' | 'token_fail_500' | 'webhook_422_taken' = 'ok';
    let lastWebhookRegisteredBody: Record<string, unknown> | null = null;
    let lastShopifyApiTokenHeader: string | undefined;

    beforeAll(async () => {
      db = new InMemoryOAuthDb();
      db.reset();

      mockShopifyServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const url = req.url ?? '/';

        if (req.method === 'POST' && url === '/admin/oauth/access_token') {
          if (shopifyUpstreamMode === 'token_fail_500') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `Failed exchange client_secret=${TEST_CLIENT_SECRET} code=bad_code_99`,
              }),
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'shpat_oauth_live_token_abc123456',
              scope: 'read_content,write_content',
            }),
          );
          return;
        }

        if (req.method === 'POST' && url.includes('/webhooks.json')) {
          lastWebhookRegisteredBody = JSON.parse(rawBody);
          if (shopifyUpstreamMode === 'webhook_422_taken') {
            res.writeHead(422, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ errors: { address: ['for this topic has already been taken'] } }),
            );
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ webhook: { id: 7001, topic: 'app/uninstalled' } }));
          return;
        }

        if (req.method === 'POST' && url.includes('/graphql.json')) {
          lastShopifyApiTokenHeader = String(req.headers['x-shopify-access-token'] ?? '');
          const parsed = JSON.parse(rawBody);
          if (String(parsed.query || '').includes('articleCreate')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                data: {
                  articleCreate: {
                    article: {
                      id: 'gid://shopify/Article/77',
                      handle: 'oauth-test-post',
                      isPublished: true,
                    },
                    userErrors: [],
                  },
                },
              }),
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                shop: {
                  name: 'Demo Store',
                  primaryDomain: { url: 'https://demo-store.myshopify.com' },
                },
                blogs: {
                  nodes: [{ id: 'gid://shopify/Blog/10', title: 'News', handle: 'news' }],
                },
              },
            }),
          );
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });

      await new Promise<void>((resolve) => {
        mockShopifyServer.listen(0, '127.0.0.1', () => resolve());
      });
      mockShopifyPort = (mockShopifyServer.address() as AddressInfo).port;

      const forwardToMockShopify: HttpTransport = async (req) => {
        const res = await fetch(
          `http://127.0.0.1:${mockShopifyPort}${req.url.pathname}${req.url.search}`,
          {
            method: req.method,
            headers: req.headers,
            body: req.rawBody ?? req.body,
          },
        );
        const buf = Buffer.from(await res.arrayBuffer());
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body: buf };
      };

      envMap = {
        NODE_ENV: 'test',
        WEB_ORIGIN: 'https://app.geomix.test',
        PUBLIC_APP_URL: 'https://api.geomix.test',
        SHOPIFY_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
        SHOPIFY_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
        SHOPIFY_OAUTH_SCOPES: 'read_content,write_content',
      };

      const stateStore = new InMemoryShopifyOAuthStateStore(() => nowMs);
      const authService = new AuthService(
        db.createAuthStore(),
        new CaptchaService(),
        TEST_AUTH_CONFIG,
      );
      const prismaService = db.createPrismaService();

      @Module({
        controllers: [ConnectionsController, ShopifyOAuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          AuthContextMiddleware,
          AuthGuard,
          TenantActiveGuard,
          { provide: PrismaService, useValue: prismaService },
          QuotaService,
          { provide: SECRET_BOX_OPTIONS, useValue: { key: TEST_ENCRYPTION_KEY } },
          SecretBox,
          {
            provide: OUTBOUND_HTTP_DEPS,
            useValue: {
              resolver: {
                async resolve() {
                  return [{ address: '93.184.216.34', family: 4 }];
                },
              },
              transport: forwardToMockShopify,
            },
          },
          OutboundHttpClient,
          ShopifyConnector,
          WordPressConnector,
          WebflowConnector,
          WebhookConnector,
          GhostConnector,
          DevtoConnector,
          HashnodeConnector,
          GithubMdxConnector,
          WechatOfficialConnector,
          CmsConnectorRegistry,
          ConnectionsService,
          {
            provide: SHOPIFY_OAUTH_DEPS,
            useValue: {
              stateStore,
              now: () => nowMs,
              env: envMap,
            },
          },
          ShopifyOAuthService,
        ],
      })
      class TestShopifyOAuthAppModule implements NestModule {
        configure(consumer: MiddlewareConsumer): void {
          consumer.apply(AuthContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
        }
      }

      app = await NestFactory.create(TestShopifyOAuthAppModule, { logger: false, rawBody: true });
      app.setGlobalPrefix('api');
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });
      app.useGlobalFilters(new ApiExceptionFilter());
      await app.listen(0, '127.0.0.1');
      const addr = app.getHttpServer().address() as AddressInfo;
      apiBaseUrl = `http://127.0.0.1:${addr.port}`;
    });

    beforeEach(() => {
      db.reset();
      nowMs = 1_750_000_000_000;
      shopifyUpstreamMode = 'ok';
      lastWebhookRegisteredBody = null;
      lastShopifyApiTokenHeader = undefined;
      envMap.SHOPIFY_OAUTH_CLIENT_ID = TEST_CLIENT_ID;
      envMap.SHOPIFY_OAUTH_CLIENT_SECRET = TEST_CLIENT_SECRET;
    });

    afterAll(async () => {
      await app.close();
      await new Promise<void>((resolve, reject) =>
        mockShopifyServer.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it('enforces auth, TenantActiveGuard, tenant ownership, domain validation, and 503 when OAuth env is unset', async () => {
      const tokenA = tokenForUser(db.users[0]!);
      const tokenExpired = tokenForUser(db.users[2]!);

      // Unauthenticated -> 401
      const unauth = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com' }),
        },
      );
      expect(unauth.status).toBe(401);

      // Expired tenant -> 403 / 40301
      const expRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_exp/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenExpired}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com' }),
        },
      );
      expect(expRes.status).toBe(403);
      expect(((await expRes.json()) as Envelope).code).toBe(40301);

      // Cross-tenant brand -> 404
      const crossRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_b/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com' }),
        },
      );
      expect(crossRes.status).toBe(404);

      // Invalid shop domain (including trailing CRLF / control chars before trim) -> 400
      for (const badBody of [
        { shop: 'evil.example.com' },
        { shop: 'demo.myshopify.com\r\n' },
        { shopDomain: 'demo.myshopify.com\t' },
      ]) {
        const badDomain = await fetch(
          `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
            body: JSON.stringify(badBody),
          },
        );
        expect(badDomain.status).toBe(400);
      }

      // Unconfigured OAuth client env -> 503 with actionable message
      envMap.SHOPIFY_OAUTH_CLIENT_ID = '';
      envMap.SHOPIFY_OAUTH_CLIENT_SECRET = '';
      const uncfg = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com' }),
        },
      );
      expect(uncfg.status).toBe(503);
      expect(((await uncfg.json()) as Envelope).msg).toContain('SHOPIFY_OAUTH_CLIENT_ID');
    });

    it('runs complete OAuth flow (JSON + HTML redirect), protects state against forged HMAC/replay/expiry/shop-mismatch, and works with ShopifyConnector', async () => {
      const tokenA = tokenForUser(db.users[0]!);

      // 1. Start OAuth
      const startRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({
            shop: 'https://demo-store.myshopify.com/',
            market: 'GLOBAL',
            displayName: 'Demo Shopify OAuth',
            targetLocale: 'en-US',
          }),
        },
      );
      expect(startRes.status).toBe(200);
      const startJson = (await startRes.json()) as Envelope<{
        authorizeUrl: string;
        state: string;
        shop: string;
        expiresAt: string;
      }>;
      expect(startJson.data.shop).toBe('demo-store.myshopify.com');
      expect(startJson.data.authorizeUrl).toContain(
        'https://demo-store.myshopify.com/admin/oauth/authorize',
      );
      expect(startJson.data.authorizeUrl).toContain(`state=${startJson.data.state}`);

      // 2. Forged HMAC -> 401 and MUST NOT consume valid state!
      const forgedQs = signShopifyQuery(
        {
          code: 'auth_code_1',
          shop: 'demo-store.myshopify.com',
          state: startJson.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        'wrong_secret',
      );
      const forgedRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/callback?${forgedQs}`,
        {
          headers: { accept: 'application/json' },
        },
      );
      expect(forgedRes.status).toBe(401);

      // 3. Duplicate query param (HPP) -> 400
      const validQs = signShopifyQuery(
        {
          code: 'auth_code_1',
          shop: 'demo-store.myshopify.com',
          state: startJson.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const hppRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/callback?${validQs}&code=injected`,
        { headers: { accept: 'application/json' } },
      );
      expect(hppRes.status).toBe(400);

      // 4. Valid callback (JSON) succeeds because forged HMAC did not consume state!
      const cbRes = await fetch(`${apiBaseUrl}/api/v2/integrations/shopify/callback?${validQs}`, {
        headers: { accept: 'application/json' },
      });
      expect(cbRes.status).toBe(200);
      const cbRawText = await cbRes.text();
      expect(cbRawText).not.toContain('shpat_oauth_live_token_abc123456');
      const cbJson = JSON.parse(cbRawText) as Envelope<{
        connection: ChannelConnectionDto;
        shop: string;
        webhookRegistered: boolean;
      }>;
      expect(cbJson.data.shop).toBe('demo-store.myshopify.com');
      expect(cbJson.data.webhookRegistered).toBe(true);
      expect(cbJson.data.connection.authType).toBe('OAUTH');
      expect(cbJson.data.connection.externalShopDomain).toBe('demo-store.myshopify.com');
      expect(cbJson.data.connection.targetLocale).toBe('en-US');
      expect(cbJson.data.connection.status).toBe('ACTIVE');
      expect(db.quotas[0]!.used).toBe(1n);
      expect(lastWebhookRegisteredBody).toMatchObject({
        webhook: {
          topic: 'app/uninstalled',
          address: 'https://api.geomix.test/api/v2/integrations/shopify/webhooks/app-uninstalled',
          format: 'json',
        },
      });

      // 5. Replayed state -> 400
      const replayRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/callback?${validQs}`,
        {
          headers: { accept: 'application/json' },
        },
      );
      expect(replayRes.status).toBe(400);

      // 6. Verify ShopifyConnector works end-to-end with the OAuth-persisted connection via ConnectionsService.test()
      const testConnRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/${cbJson.data.connection.id}/test`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({}),
        },
      );
      expect(testConnRes.status).toBe(200);
      const testConnJson = (await testConnRes.json()) as Envelope<ChannelConnectionTestResultDto>;
      expect(testConnJson.data.ok).toBe(true);
      expect(lastShopifyApiTokenHeader).toBe('shpat_oauth_live_token_abc123456');

      // 7. Re-authorization via browser Accept: text/html -> 302 redirect & NO double SOCIAL_AUTH quota!
      shopifyUpstreamMode = 'webhook_422_taken';
      const startRes2 = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      const start2 = (await startRes2.json()) as Envelope<{ state: string }>;
      const qs2 = signShopifyQuery(
        {
          code: 'auth_code_2',
          shop: 'demo-store.myshopify.com',
          state: start2.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const htmlCb = await fetch(`${apiBaseUrl}/api/v2/integrations/shopify/callback?${qs2}`, {
        headers: { accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });
      expect(htmlCb.status).toBe(302);
      expect(htmlCb.headers.get('cache-control')).toBe('no-store');
      expect(htmlCb.headers.get('location')).toContain(
        `https://api.geomix.test/brands?brandId=brand_a&shopifyOAuth=connected&connectionId=${cbJson.data.connection.id}`,
      );
      expect(db.quotas[0]!.used).toBe(1n); // Still 1, no double-consume!
      expect(db.connections).toHaveLength(1);

      // 8. Shop mismatch -> 400
      const startRes3 = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      const start3 = (await startRes3.json()) as Envelope<{ state: string }>;
      const mismatchQs = signShopifyQuery(
        {
          code: 'auth_code_3',
          shop: 'other-store.myshopify.com',
          state: start3.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const mismatchRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/callback?${mismatchQs}`,
        { headers: { accept: 'application/json' } },
      );
      expect(mismatchRes.status).toBe(400);

      // 9. Expired state (> 10 min) -> 400
      const startRes4 = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      const start4 = (await startRes4.json()) as Envelope<{ state: string }>;
      nowMs += SHOPIFY_OAUTH_STATE_TTL_MS + 5_000;
      const expiredQs = signShopifyQuery(
        {
          code: 'auth_code_4',
          shop: 'demo-store.myshopify.com',
          state: start4.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const expiredCb = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/callback?${expiredQs}`,
        { headers: { accept: 'application/json' } },
      );
      expect(expiredCb.status).toBe(400);

      // 10. Upstream token exchange 500 -> 502 with client_secret redacted
      shopifyUpstreamMode = 'token_fail_500';
      const startRes5 = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      const start5 = (await startRes5.json()) as Envelope<{ state: string }>;
      const failQs = signShopifyQuery(
        {
          code: 'bad_code_99',
          shop: 'demo-store.myshopify.com',
          state: start5.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const failCb = await fetch(`${apiBaseUrl}/api/v2/integrations/shopify/callback?${failQs}`, {
        headers: { accept: 'application/json' },
      });
      expect(failCb.status).toBe(502);
      const failText = await failCb.text();
      expect(failText).not.toContain(TEST_CLIENT_SECRET);
      expect(failText).not.toContain('bad_code_99');

      // 11. Appending &__proto__=evil to a validly signed callback query MUST return 401
      shopifyUpstreamMode = 'ok';
      const startRes6 = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      const start6 = (await startRes6.json()) as Envelope<{ state: string }>;
      const validQs6 = signShopifyQuery(
        {
          code: 'auth_code_proto',
          shop: 'demo-store.myshopify.com',
          state: start6.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const protoTamperedCb = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/callback?${validQs6}&__proto__=evil`,
        { headers: { accept: 'application/json' } },
      );
      expect(protoTamperedCb.status).toBe(401);
    });

    it('verifies raw-body HMAC on app/uninstalled, wipes all credential columns on OAuth rows, and preserves Custom App Token connections', async () => {
      const tokenA = tokenForUser(db.users[0]!);

      // 1. Create an OAuth connection via start + callback
      const startRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'demo-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      const startJson = (await startRes.json()) as Envelope<{ state: string }>;
      const cbQs = signShopifyQuery(
        {
          code: 'code_uninstall_1',
          shop: 'demo-store.myshopify.com',
          state: startJson.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const cbRes = await fetch(`${apiBaseUrl}/api/v2/integrations/shopify/callback?${cbQs}`, {
        headers: { accept: 'application/json' },
      });
      const oauthConnId = ((await cbRes.json()) as Envelope<{ connection: ChannelConnectionDto }>)
        .data.connection.id;

      // 2. Also create a Custom App Token (API_KEY) Shopify connection for the same brand
      const customRes = await fetch(`${apiBaseUrl}/api/v2/brands/brand_a/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          market: 'GLOBAL',
          provider: 'SHOPIFY',
          displayName: 'Custom App Fallback Store',
          siteBaseUrl: 'https://demo-store.myshopify.com',
          credentials: { accessToken: 'shpat_custom_app_fallback_999' },
        }),
      });
      expect(customRes.status).toBe(200);
      const customConnId = ((await customRes.json()) as Envelope<ChannelConnectionDto>).data.id;

      // 3. Raw-body fidelity test: non-canonical JSON with extra spaces
      const nonCanonicalRaw = Buffer.from(
        '{   "id": 9901,   "myshopify_domain": "demo-store.myshopify.com"  }',
        'utf8',
      );
      const canonicalizedBuf = Buffer.from(
        JSON.stringify(JSON.parse(nonCanonicalRaw.toString('utf8'))),
        'utf8',
      );
      // Signing canonicalized JSON instead of exact raw wire bytes MUST fail with 401!
      const badSigRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-shop-domain': 'demo-store.myshopify.com',
            'x-shopify-hmac-sha256': signWebhookBody(canonicalizedBuf, TEST_CLIENT_SECRET),
          },
          body: nonCanonicalRaw,
        },
      );
      expect(badSigRes.status).toBe(401);
      expect(db.connections.find((c) => c.id === oauthConnId)?.status).toBe('ACTIVE');

      // Wrong topic -> 400
      const wrongTopicRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': 'orders/create',
            'x-shopify-shop-domain': 'demo-store.myshopify.com',
            'x-shopify-hmac-sha256': signWebhookBody(nonCanonicalRaw, TEST_CLIENT_SECRET),
          },
          body: nonCanonicalRaw,
        },
      );
      expect(wrongTopicRes.status).toBe(400);

      // Non-canonical Base64 padding-bit variant MUST return 401
      const validWebhookSig = signWebhookBody(nonCanonicalRaw, TEST_CLIENT_SECRET);
      const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const malleatedWebhookSig = `${validWebhookSig.slice(0, 42)}${b64Chars[b64Chars.indexOf(validWebhookSig[42]!) | 1]}=`;
      const nonCanonRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-shop-domain': 'demo-store.myshopify.com',
            'x-shopify-hmac-sha256': malleatedWebhookSig,
          },
          body: nonCanonicalRaw,
        },
      );
      expect(nonCanonRes.status).toBe(401);

      // 4. Valid raw-body HMAC disables OAuth connection, wipes ALL credential columns, leaves Custom App API_KEY untouched!
      const goodWebhookRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-shop-domain': 'demo-store.myshopify.com',
            'x-shopify-hmac-sha256': validWebhookSig,
          },
          body: nonCanonicalRaw,
        },
      );
      expect(goodWebhookRes.status).toBe(200);
      const webhookJson = (await goodWebhookRes.json()) as Envelope<{
        received: true;
        shop: string;
        disabledCount: number;
      }>;
      expect(webhookJson.data).toEqual({
        received: true,
        shop: 'demo-store.myshopify.com',
        disabledCount: 1,
      });

      const disabledOauth = db.connections.find((c) => c.id === oauthConnId)!;
      expect(disabledOauth.status).toBe('DISABLED');
      expect(disabledOauth.credentialsCiphertext).toBe('');
      expect(disabledOauth.credentialsIv).toBe('');
      expect(disabledOauth.credentialsTag).toBe('');
      expect(disabledOauth.credentialHint).toBe('');
      expect(disabledOauth.oauthAccessTokenCiphertext).toBeNull();
      expect(disabledOauth.oauthExpiresAt).toBeNull();

      // Custom App Token connection MUST stay ACTIVE and intact!
      const intactCustom = db.connections.find((c) => c.id === customConnId)!;
      expect(intactCustom.status).toBe('ACTIVE');
      expect(intactCustom.authType).toBe('API_KEY');
      expect(intactCustom.credentialsCiphertext.length).toBeGreaterThan(10);

      // 5. Testing the DISABLED uninstalled connection keeps status=DISABLED (does not overwrite to INVALID)
      const testDisabledRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/${oauthConnId}/test`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({}),
        },
      );
      expect(testDisabledRes.status).toBe(200);
      const testDisabledJson =
        (await testDisabledRes.json()) as Envelope<ChannelConnectionTestResultDto>;
      expect(testDisabledJson.data.ok).toBe(false);
      expect(testDisabledJson.data.status).toBe('DISABLED');
      expect(db.connections.find((c) => c.id === oauthConnId)?.status).toBe('DISABLED');

      // 6. Operator manually PATCHing the disabled OAuth connection with a Custom App accessToken switches cleanly to API_KEY and clears externalShopDomain
      const fallbackPatchRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/${oauthConnId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({
            status: 'ACTIVE',
            credentials: { accessToken: 'shpat_manual_recovery_token_777' },
          }),
        },
      );
      expect(fallbackPatchRes.status).toBe(200);
      const recovered = db.connections.find((c) => c.id === oauthConnId)!;
      expect(recovered.authType).toBe('API_KEY');
      expect(recovered.oauthAccessTokenCiphertext).toBeNull();
      expect(recovered.externalShopDomain).toBeNull();
      const recoveredCiphertext = recovered.credentialsCiphertext;
      expect(recoveredCiphertext.length).toBeGreaterThan(10);

      // 7. Delayed / retried app/uninstalled webhook MUST NOT match or wipe the recovered API_KEY connection!
      const delayedWebhookRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-shop-domain': 'demo-store.myshopify.com',
            'x-shopify-hmac-sha256': validWebhookSig,
          },
          body: nonCanonicalRaw,
        },
      );
      expect(delayedWebhookRes.status).toBe(200);
      const delayedWebhookJson = (await delayedWebhookRes.json()) as Envelope<{
        received: true;
        shop: string;
        disabledCount: number;
      }>;
      expect(delayedWebhookJson.data).toEqual({
        received: true,
        shop: 'demo-store.myshopify.com',
        disabledCount: 0,
      });

      const stillActiveRecovered = db.connections.find((c) => c.id === oauthConnId)!;
      expect(stillActiveRecovered.status).toBe('ACTIVE');
      expect(stillActiveRecovered.authType).toBe('API_KEY');
      expect(stillActiveRecovered.credentialsCiphertext).toBe(recoveredCiphertext);
    });

    it('preserves an active Shopify connection migrated directly from OAuth to Custom App Token when app/uninstalled arrives', async () => {
      const tokenA = tokenForUser(db.users[0]!);

      // 1. OAuth connect
      const startRes = await fetch(
        `${apiBaseUrl}/api/v2/brands/brand_a/connections/shopify/oauth/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ shop: 'migrated-store.myshopify.com', market: 'GLOBAL' }),
        },
      );
      expect(startRes.status).toBe(200);
      const startJson = (await startRes.json()) as Envelope<{ state: string }>;
      const cbQs = signShopifyQuery(
        {
          code: 'code_migrate_1',
          shop: 'migrated-store.myshopify.com',
          state: startJson.data.state,
          timestamp: String(Math.floor(nowMs / 1000)),
        },
        TEST_CLIENT_SECRET,
      );
      const cbRes = await fetch(`${apiBaseUrl}/api/v2/integrations/shopify/callback?${cbQs}`, {
        headers: { accept: 'application/json' },
      });
      expect(cbRes.status).toBe(200);
      const connId = ((await cbRes.json()) as Envelope<{ connection: ChannelConnectionDto }>).data
        .connection.id;

      // 2. PATCH directly to Custom App accessToken before uninstalling the OAuth app
      const patchRes = await fetch(`${apiBaseUrl}/api/v2/brands/brand_a/connections/${connId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          credentials: { accessToken: 'shpat_switched_custom_888' },
        }),
      });
      expect(patchRes.status).toBe(200);
      const migratedRow = db.connections.find((c) => c.id === connId)!;
      expect(migratedRow.authType).toBe('API_KEY');
      expect(migratedRow.externalShopDomain).toBeNull();
      const migratedCiphertext = migratedRow.credentialsCiphertext;

      // 3. Valid app/uninstalled webhook arrives -> disabledCount === 0, API_KEY remains ACTIVE & intact
      const rawBody = Buffer.from(
        JSON.stringify({ id: 42, myshopify_domain: 'migrated-store.myshopify.com' }),
        'utf8',
      );
      const webhookRes = await fetch(
        `${apiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-shop-domain': 'migrated-store.myshopify.com',
            'x-shopify-hmac-sha256': signWebhookBody(rawBody, TEST_CLIENT_SECRET),
          },
          body: rawBody,
        },
      );
      expect(webhookRes.status).toBe(200);
      const webhookJson = (await webhookRes.json()) as Envelope<{
        received: true;
        shop: string;
        disabledCount: number;
      }>;
      expect(webhookJson.data.disabledCount).toBe(0);

      const afterRow = db.connections.find((c) => c.id === connId)!;
      expect(afterRow.status).toBe('ACTIVE');
      expect(afterRow.authType).toBe('API_KEY');
      expect(afterRow.credentialsCiphertext).toBe(migratedCiphertext);
    });
  });
});
