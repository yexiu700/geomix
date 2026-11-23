import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
  VersioningType,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  AUTH_ERROR,
  type ChannelConnectionDto,
  type ChannelConnectionTestResultDto,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { OUTBOUND_HTTP_DEPS, OutboundHttpClient } from '../infra/outbound-http';
import { parseSsrfAllowlist } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import {
  CmsConnectorRegistry,
  ShopifyConnector,
  WebflowConnector,
  WebhookConnector,
  WordPressConnector,
} from './connectors';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type BrandRow = {
  id: string;
  tenantId: string;
  name: string;
};

type BrandMarketRow = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
};

type QuotaRow = {
  tenantId: string;
  key: string;
  used: bigint;
  limit: bigint;
};

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
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DistributionTaskRow = {
  id: string;
  tenantId: string;
  connectionId: string | null;
};

const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_AUTH_CONFIG: AuthConfig = {
  accessSecret: 'test-access-secret-for-connections-http-spec-32bytes',
  refreshSecret: 'test-refresh-secret-for-connections-http-spec-32bytes',
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 86400,
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

class InMemoryConnectionsDb {
  users: AuthUser[] = [];
  brands: BrandRow[] = [];
  brandMarkets: BrandMarketRow[] = [];
  quotas: QuotaRow[] = [];
  connections: ConnectionRow[] = [];
  distributionTasks: DistributionTaskRow[] = [];
  failNextConnectionCreate = false;
  private idCounter = 1;

  reset(): void {
    this.idCounter = 1;
    this.failNextConnectionCreate = false;
    const future = new Date(Date.now() + 86_400_000 * 30);
    const past = new Date(Date.now() - 86_400_000 * 2);

    this.users = [
      {
        id: 'user_a',
        tenantId: 'tenant_a',
        username: 'merchant_a',
        passwordHash: 'hash_a',
        nickname: 'Merchant A',
        role: 'MERCHANT',
        tenantName: 'Tenant A',
        expiresAt: future,
        isActive: true,
      },
      {
        id: 'user_b',
        tenantId: 'tenant_b',
        username: 'merchant_b',
        passwordHash: 'hash_b',
        nickname: 'Merchant B',
        role: 'MERCHANT',
        tenantName: 'Tenant B',
        expiresAt: future,
        isActive: true,
      },
      {
        id: 'user_expired',
        tenantId: 'tenant_expired',
        username: 'merchant_expired',
        passwordHash: 'hash_exp',
        nickname: 'Expired',
        role: 'MERCHANT',
        tenantName: 'Expired Tenant',
        expiresAt: past,
        isActive: true,
      },
      {
        id: 'user_inactive',
        tenantId: 'tenant_inactive',
        username: 'merchant_inactive',
        passwordHash: 'hash_inact',
        nickname: 'Inactive',
        role: 'MERCHANT',
        tenantName: 'Inactive Tenant',
        expiresAt: future,
        isActive: false,
      },
    ];

    this.brands = [
      { id: 'brand_a', tenantId: 'tenant_a', name: 'SolarCo' },
      { id: 'brand_b', tenantId: 'tenant_b', name: 'OtherCo' },
      { id: 'brand_exp', tenantId: 'tenant_expired', name: 'ExpiredCo' },
      { id: 'brand_inact', tenantId: 'tenant_inactive', name: 'InactiveCo' },
    ];

    this.brandMarkets = [
      { id: 'bm_a_global', tenantId: 'tenant_a', brandId: 'brand_a', market: 'GLOBAL' },
      { id: 'bm_a_cn', tenantId: 'tenant_a', brandId: 'brand_a', market: 'CN' },
      { id: 'bm_b_global', tenantId: 'tenant_b', brandId: 'brand_b', market: 'GLOBAL' },
      { id: 'bm_exp_global', tenantId: 'tenant_expired', brandId: 'brand_exp', market: 'GLOBAL' },
      {
        id: 'bm_inact_global',
        tenantId: 'tenant_inactive',
        brandId: 'brand_inact',
        market: 'GLOBAL',
      },
    ];

    this.quotas = [
      { tenantId: 'tenant_a', key: 'SOCIAL_AUTH', used: 0n, limit: 2n },
      { tenantId: 'tenant_b', key: 'SOCIAL_AUTH', used: 0n, limit: 5n },
      { tenantId: 'tenant_expired', key: 'SOCIAL_AUTH', used: 0n, limit: 5n },
      { tenantId: 'tenant_inactive', key: 'SOCIAL_AUTH', used: 0n, limit: 5n },
    ];

    this.connections = [];
    this.distributionTasks = [];
  }

  getQuota(tenantId: string, key: string): QuotaRow | undefined {
    return this.quotas.find((q) => q.tenantId === tenantId && q.key === key);
  }

  createAuthStore(): AuthStore {
    return {
      findUserByUsername: async (username: string) =>
        this.users.find((u) => u.username === username) ?? null,
      findUserById: async (id: string) => this.users.find((u) => u.id === id) ?? null,
      touchLogin: async () => undefined,
      updatePassword: async () => undefined,
      revoke: async () => undefined,
      latestRevokeAt: async () => null,
    };
  }

  createPrismaService(): PrismaService {
    const requireTenant = (): string => {
      const tid = currentTenantId();
      if (!tid) throw new Error('Missing tenant context');
      return tid;
    };

    const withMarket = (row: ConnectionRow) => {
      const bm = this.brandMarkets.find((m) => m.id === row.brandMarketId);
      return {
        ...row,
        brandMarket: bm ? { market: bm.market } : null,
      };
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
        const row = this.quotas.find((q) => q.tenantId === tenantId && q.key === key);
        if (!row || row.used + delta > row.limit) return 0;
        row.used += delta;
        return 1;
      }
      if (sql.includes('SET used = used -')) {
        const delta = BigInt(values[0] as bigint | number);
        const tenantId = String(values[1]);
        const key = String(values[2]);
        const row = this.quotas.find((q) => q.tenantId === tenantId && q.key === key);
        if (!row || row.used < delta) return 0;
        row.used -= delta;
        return 1;
      }
      throw new Error(`Unsupported $executeRaw SQL: ${sql}`);
    };

    const queryRaw = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{ used: bigint; limit: bigint }>> => {
      const sql = strings.join(' ');
      if (sql.includes('FROM "Quota"')) {
        const tenantId = String(values[0]);
        const key = String(values[1]);
        const row = this.quotas.find((q) => q.tenantId === tenantId && q.key === key);
        return row ? [{ used: row.used, limit: row.limit }] : [];
      }
      throw new Error(`Unsupported $queryRaw SQL: ${sql}`);
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
      channelConnection: {
        findMany: async (args: { where: { brandId?: string; brandMarketId?: string } }) => {
          const tenantId = requireTenant();
          return this.connections
            .filter(
              (c) =>
                c.tenantId === tenantId &&
                (!args.where.brandId || c.brandId === args.where.brandId) &&
                (!args.where.brandMarketId || c.brandMarketId === args.where.brandMarketId),
            )
            .sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
            )
            .map(withMarket);
        },
        findFirst: async (args: { where: { id: string; brandId?: string } }) => {
          const tenantId = requireTenant();
          const found = this.connections.find(
            (c) =>
              c.tenantId === tenantId &&
              c.id === args.where.id &&
              (!args.where.brandId || c.brandId === args.where.brandId),
          );
          return found ? withMarket(found) : null;
        },
        create: async (args: {
          data: Omit<
            ConnectionRow,
            'id' | 'createdAt' | 'updatedAt' | 'lastTestedAt' | 'lastError'
          >;
        }) => {
          const tenantId = requireTenant();
          if (this.failNextConnectionCreate) {
            this.failNextConnectionCreate = false;
            throw new Error('Simulated DB create failure');
          }
          const now = new Date();
          const row: ConnectionRow = {
            id: `conn_${this.idCounter++}`,
            ...args.data,
            tenantId,
            lastTestedAt: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          };
          this.connections.push(row);
          return withMarket(row);
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const tenantId = requireTenant();
          const idx = this.connections.findIndex(
            (c) => c.id === args.where.id && c.tenantId === tenantId,
          );
          if (idx === -1) throw new Error('Not found');
          const prev = this.connections[idx]!;
          const next: ConnectionRow = {
            ...prev,
            ...(args.data as Partial<ConnectionRow>),
            updatedAt: new Date(),
          };
          this.connections[idx] = next;
          return withMarket(next);
        },
        deleteMany: async (args: { where: { id: string; brandId?: string } }) => {
          const tenantId = requireTenant();
          const before = this.connections.length;
          const removedIds = new Set<string>();
          this.connections = this.connections.filter((c) => {
            const match =
              c.tenantId === tenantId &&
              c.id === args.where.id &&
              (!args.where.brandId || c.brandId === args.where.brandId);
            if (match) removedIds.add(c.id);
            return !match;
          });
          // Simulate PostgreSQL ON DELETE SET NULL on GeoDistributionTask.connectionId
          for (const task of this.distributionTasks) {
            if (task.connectionId && removedIds.has(task.connectionId)) {
              task.connectionId = null;
            }
          }
          return { count: before - this.connections.length };
        },
      },
    };

    const runTransaction = async <T>(fn: (tx: typeof scopedOps) => Promise<T>): Promise<T> => {
      const quotasSnapshot = this.quotas.map((q) => ({ ...q }));
      const connectionsSnapshot = this.connections.map((c) => ({
        ...c,
        configJson: { ...c.configJson },
      }));
      const tasksSnapshot = this.distributionTasks.map((t) => ({ ...t }));
      try {
        return await fn(scopedOps);
      } catch (error) {
        this.quotas = quotasSnapshot;
        this.connections = connectionsSnapshot;
        this.distributionTasks = tasksSnapshot;
        throw error;
      }
    };

    return {
      scoped: {
        ...scopedOps,
        $transaction: runTransaction,
      },
      base: {
        $transaction: runTransaction,
      },
    } as unknown as PrismaService;
  }
}

async function createTestNestApp(
  db: InMemoryConnectionsDb,
  allowlist?: ReturnType<typeof parseSsrfAllowlist>,
): Promise<{ app: INestApplication; baseUrl: string }> {
  const authService = new AuthService(db.createAuthStore(), new CaptchaService(), TEST_AUTH_CONFIG);
  const prismaService = db.createPrismaService();

  @Module({
    controllers: [ConnectionsController],
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
        useValue: allowlist
          ? {
              defaultAllowlist: allowlist,
              resolver: {
                async resolve() {
                  return [{ address: '93.184.216.34', family: 4 }];
                },
              },
            }
          : {},
      },
      OutboundHttpClient,
      ShopifyConnector,
      WordPressConnector,
      WebflowConnector,
      WebhookConnector,
      CmsConnectorRegistry,
      ConnectionsService,
    ],
  })
  class TestConnectionsAppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(AuthContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
    }
  }

  const app = await NestFactory.create(TestConnectionsAppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
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

describe('ConnectionsController & ConnectionsService HTTP Stack (/api/v2/brands/:brandId/connections)', () => {
  const db = new InMemoryConnectionsDb();
  let mockCmsServer: Server;
  let mockCmsBaseUrl = '';
  let cmsMode: 'ok' | 'upstream_401' | 'upstream_500' | 'custom_400' = 'ok';
  let custom400Body = '';
  let app: INestApplication;
  let apiBaseUrl = '';
  let strictApp: INestApplication;
  let strictApiBaseUrl = '';

  async function apiFetch<T = unknown>(
    path: string,
    opts: {
      method?: string;
      token?: string;
      body?: unknown;
      base?: string;
    } = {},
  ): Promise<{ status: number; rawText: string; json: Envelope<T> }> {
    const res = await fetch(`${opts.base ?? apiBaseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const rawText = await res.text();
    const json = JSON.parse(rawText) as Envelope<T>;
    return { status: res.status, rawText, json };
  }

  function assertNoSecretsLeaked(rawText: string, secrets: string[]): void {
    expect(rawText).not.toContain('credentialsCiphertext');
    expect(rawText).not.toContain('credentialsIv');
    expect(rawText).not.toContain('credentialsTag');
    for (const secret of secrets) {
      expect(rawText).not.toContain(secret);
    }
  }

  beforeAll(async () => {
    mockCmsServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const rawBody = await readRawBody(req);
        const authHeader = String(req.headers.authorization ?? '');
        const shopifyHeader = String(req.headers['x-shopify-access-token'] ?? '');

        if (cmsMode === 'upstream_401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `Unauthorized token=${shopifyHeader} auth=${authHeader} body=${rawBody}`,
            }),
          );
          return;
        }
        if (cmsMode === 'upstream_500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(`Crash exposing ${shopifyHeader} ${authHeader}`);
          return;
        }
        if (cmsMode === 'custom_400') {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(custom400Body);
          return;
        }

        if (req.url?.includes('/shopify/admin/api/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                shop: { name: 'SolarCo', primaryDomain: { url: 'https://solarco.example.com' } },
                blogs: {
                  nodes: [{ id: 'gid://shopify/Blog/1', title: 'News', handle: 'news' }],
                },
              },
            }),
          );
          return;
        }

        if (req.url === '/wp/wp-json/wp/v2/users/me') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 1, name: 'WP Admin', slug: 'wp-admin' }));
          return;
        }
        if (req.url?.startsWith('/wp/wp-json/wp/v2/categories')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{ id: 3, name: 'Guides', slug: 'guides' }]));
          return;
        }
        if (req.url === '/webhook') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      })();
    });

    await new Promise<void>((resolve) => mockCmsServer.listen(0, '127.0.0.1', resolve));
    const { port } = mockCmsServer.address() as AddressInfo;
    mockCmsBaseUrl = `http://127.0.0.1:${port}`;
    const allowlist = parseSsrfAllowlist(`127.0.0.1:${port}`, { includeDefaults: false });

    db.reset();
    const primary = await createTestNestApp(db, allowlist);
    app = primary.app;
    apiBaseUrl = primary.baseUrl;

    const strict = await createTestNestApp(db);
    strictApp = strict.app;
    strictApiBaseUrl = strict.baseUrl;
  });

  beforeEach(() => {
    db.reset();
    cmsMode = 'ok';
  });

  afterAll(async () => {
    await app.close();
    await strictApp.close();
    await closeHttpServer(mockCmsServer);
  });

  it('enforces AuthGuard (401), TenantActiveGuard (expired & inactive 403), and cross-tenant 404', async () => {
    const tokenA = tokenForUser(db.users[0]!);
    const tokenB = tokenForUser(db.users[1]!);
    const tokenExpired = tokenForUser(db.users[2]!);
    const tokenInactive = tokenForUser(db.users[3]!);

    // Unauthenticated -> 401 / 40101
    const unauth = await apiFetch('/api/v2/brands/brand_a/connections');
    expect(unauth.status).toBe(401);
    expect(unauth.json.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    // Expired tenant: GET allowed (200), writes blocked (403 / 40301)
    const expGet = await apiFetch('/api/v2/brands/brand_exp/connections', { token: tokenExpired });
    expect(expGet.status).toBe(200);
    const expPost = await apiFetch('/api/v2/brands/brand_exp/connections', {
      method: 'POST',
      token: tokenExpired,
      body: {
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'Expired Store',
        siteBaseUrl: `${mockCmsBaseUrl}/shopify`,
        credentials: { accessToken: 'shpat_expired_test_12345' },
      },
    });
    expect(expPost.status).toBe(403);
    expect(expPost.json.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Inactive tenant: GET and writes blocked (403 / 40301)
    const inactGet = await apiFetch('/api/v2/brands/brand_inact/connections', {
      token: tokenInactive,
    });
    expect(inactGet.status).toBe(403);
    expect(inactGet.json.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Cross-tenant isolation: Tenant B accessing Tenant A's brand -> 404 / 40401
    const crossList = await apiFetch('/api/v2/brands/brand_a/connections', { token: tokenB });
    expect(crossList.status).toBe(404);
    expect(crossList.json.code).toBe(AUTH_ERROR.NOT_FOUND);

    // Create under Tenant A, verify Tenant B cannot PATCH/DELETE/test it
    const created = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'Tenant A Store',
        siteBaseUrl: `${mockCmsBaseUrl}/shopify`,
        credentials: { accessToken: 'shpat_tenant_a_secret_9876' },
      },
    });
    expect(created.status).toBe(200);
    const connId = created.json.data.id;

    const crossTest = await apiFetch(`/api/v2/brands/brand_a/connections/${connId}/test`, {
      method: 'POST',
      token: tokenB,
      body: {},
    });
    expect(crossTest.status).toBe(404);
  });

  it('enforces SOCIAL_AUTH stock quota: consume, 409/40901 on limit, rollback on DB error, release on DELETE preserving task history', async () => {
    const tokenA = tokenForUser(db.users[0]!);
    const secret1 = 'shpat_quota_secret_one_11111';
    const secret2 = 'whsec_quota_secret_two_22222';

    const c1 = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'Conn 1',
        siteBaseUrl: `${mockCmsBaseUrl}/shopify`,
        credentials: { accessToken: secret1 },
      },
    });
    expect(c1.status).toBe(200);
    expect(db.getQuota('tenant_a', 'SOCIAL_AUTH')?.used).toBe(1n);

    // Simulate DB failure during 2nd create -> quota MUST roll back to 1
    db.failNextConnectionCreate = true;
    const failedCreate = await apiFetch('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'WEBHOOK',
        displayName: 'Will Fail',
        siteBaseUrl: `${mockCmsBaseUrl}/webhook`,
        credentials: { signingSecret: secret2 },
      },
    });
    expect(failedCreate.status).toBe(500);
    expect(db.getQuota('tenant_a', 'SOCIAL_AUTH')?.used).toBe(1n);

    // Retry 2nd create -> succeeds (used === 2, equals limit)
    const c2 = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'WEBHOOK',
        displayName: 'Conn 2',
        siteBaseUrl: `${mockCmsBaseUrl}/webhook`,
        credentials: { signingSecret: secret2 },
      },
    });
    expect(c2.status).toBe(200);
    expect(db.getQuota('tenant_a', 'SOCIAL_AUTH')?.used).toBe(2n);

    // 3rd create -> 409 / 40901 QUOTA_EXCEEDED
    const c3 = await apiFetch('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'CN',
        provider: 'WEBHOOK',
        displayName: 'Conn 3 Over Limit',
        siteBaseUrl: `${mockCmsBaseUrl}/webhook`,
        credentials: { signingSecret: 'whsec_over_limit_33333' },
      },
    });
    expect(c3.status).toBe(409);
    expect(c3.json.code).toBe(API_ERROR.QUOTA_EXCEEDED);

    // Attach a historical distribution task to c1, then DELETE c1
    db.distributionTasks.push({
      id: 'dist_task_1',
      tenantId: 'tenant_a',
      connectionId: c1.json.data.id,
    });

    const del = await apiFetch<{ deleted: number; id: string }>(
      `/api/v2/brands/brand_a/connections/${c1.json.data.id}`,
      { method: 'DELETE', token: tokenA },
    );
    expect(del.status).toBe(200);
    expect(del.json.data).toEqual({ deleted: 1, id: c1.json.data.id });
    expect(db.getQuota('tenant_a', 'SOCIAL_AUTH')?.used).toBe(1n);
    // Historical distribution task is preserved with connectionId = null
    expect(db.distributionTasks[0]).toEqual({
      id: 'dist_task_1',
      tenantId: 'tenant_a',
      connectionId: null,
    });

    // Now creating a new connection succeeds again
    const c4 = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'CN',
        provider: 'WEBHOOK',
        displayName: 'Conn 4 After Release',
        siteBaseUrl: `${mockCmsBaseUrl}/webhook`,
        credentials: { signingSecret: 'whsec_after_release_44444' },
      },
    });
    expect(c4.status).toBe(200);
    expect(db.getQuota('tenant_a', 'SOCIAL_AUTH')?.used).toBe(2n);
  });

  it('preserves encrypted ciphertext/iv/tag on PATCH with blank/omitted credentials and updates on rotation', async () => {
    const tokenA = tokenForUser(db.users[0]!);
    const oldPass = 'wp_app_pass_old_1111_2222';
    const newPass = 'wp_app_pass_new_9999_8888';
    const wpUser = 'wp_editor_user';

    const created = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'WORDPRESS',
        displayName: 'WP Original',
        siteBaseUrl: `${mockCmsBaseUrl}/wp`,
        credentials: { username: wpUser, appPassword: oldPass },
        configJson: { defaultPublishAsDraft: true, categoryIds: [3] },
      },
    });
    expect(created.status).toBe(200);
    assertNoSecretsLeaked(created.rawText, [oldPass]);
    expect(created.json.data.credentialHint).toContain('****');

    const connId = created.json.data.id;
    const storedBefore = { ...db.connections[0]! };

    // PATCH with blank credentials + displayName change -> ciphertext/iv/tag/hint UNCHANGED
    const patchedBlank = await apiFetch<ChannelConnectionDto>(
      `/api/v2/brands/brand_a/connections/${connId}`,
      {
        method: 'PATCH',
        token: tokenA,
        body: {
          displayName: 'WP Renamed',
          credentials: { username: '', appPassword: '   ' },
          configJson: { inlineJsonLd: true },
        },
      },
    );
    expect(patchedBlank.status).toBe(200);
    assertNoSecretsLeaked(patchedBlank.rawText, [oldPass]);
    expect(patchedBlank.json.data.displayName).toBe('WP Renamed');
    expect(patchedBlank.json.data.configJson).toMatchObject({
      defaultPublishAsDraft: true,
      categoryIds: [3],
      inlineJsonLd: true,
    });
    expect(db.connections[0]!.credentialsCiphertext).toBe(storedBefore.credentialsCiphertext);
    expect(db.connections[0]!.credentialsIv).toBe(storedBefore.credentialsIv);
    expect(db.connections[0]!.credentialsTag).toBe(storedBefore.credentialsTag);
    expect(db.connections[0]!.credentialHint).toBe(storedBefore.credentialHint);

    // PATCH with new appPassword -> rotates ciphertext & hint while preserving username
    const patchedRotate = await apiFetch<ChannelConnectionDto>(
      `/api/v2/brands/brand_a/connections/${connId}`,
      {
        method: 'PATCH',
        token: tokenA,
        body: {
          credentials: { appPassword: newPass },
        },
      },
    );
    expect(patchedRotate.status).toBe(200);
    assertNoSecretsLeaked(patchedRotate.rawText, [oldPass, newPass]);
    expect(db.connections[0]!.credentialsCiphertext).not.toBe(storedBefore.credentialsCiphertext);
    expect(db.connections[0]!.credentialHint).toContain('8888');
  });

  it('rejects private/loopback/metadata/internal SSRF URLs with 400 / 40001 on create and update', async () => {
    const tokenA = tokenForUser(db.users[0]!);
    const ssrfUrls = [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/internal',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/wp',
      'http://sonargate:8080/api',
    ];

    for (const siteBaseUrl of ssrfUrls) {
      const res = await apiFetch('/api/v2/brands/brand_a/connections', {
        method: 'POST',
        token: tokenA,
        base: strictApiBaseUrl,
        body: {
          market: 'GLOBAL',
          provider: 'WEBHOOK',
          displayName: 'SSRF Hook',
          siteBaseUrl,
          credentials: { signingSecret: 'whsec_ssrf_blocked_12345' },
        },
      });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe(API_ERROR.BAD_REQUEST);
    }

    // Also reject private configJson.apiBaseUrl
    const badApiBase = await apiFetch('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'WEBFLOW',
        displayName: 'Webflow SSRF ApiBase',
        siteBaseUrl: `${mockCmsBaseUrl}/webflow`,
        credentials: { apiToken: 'wf_token_1234567890' },
        configJson: { apiBaseUrl: 'http://169.254.169.254/latest/meta-data/' },
      },
    });
    expect(badApiBase.status).toBe(400);
    expect(badApiBase.json.code).toBe(API_ERROR.BAD_REQUEST);
    expect(db.getQuota('tenant_a', 'SOCIAL_AUTH')?.used).toBe(0n);

    // Explicit PATCH SSRF 400 checks (siteBaseUrl & configJson.apiBaseUrl)
    const validCreated = await apiFetch<ChannelConnectionDto>(
      '/api/v2/brands/brand_a/connections',
      {
        method: 'POST',
        token: tokenA,
        body: {
          market: 'GLOBAL',
          provider: 'WEBFLOW',
          displayName: 'Valid Webflow For Patch SSRF',
          siteBaseUrl: `${mockCmsBaseUrl}/webflow`,
          credentials: { apiToken: 'wf_patch_ssrf_token_123456' },
        },
      },
    );
    expect(validCreated.status).toBe(200);
    const connId = validCreated.json.data.id;

    for (const siteBaseUrl of ssrfUrls) {
      const patchSiteRes = await apiFetch(`/api/v2/brands/brand_a/connections/${connId}`, {
        method: 'PATCH',
        token: tokenA,
        base: strictApiBaseUrl,
        body: { siteBaseUrl },
      });
      expect(patchSiteRes.status).toBe(400);
      expect(patchSiteRes.json.code).toBe(API_ERROR.BAD_REQUEST);
    }

    const patchApiBaseRes = await apiFetch(`/api/v2/brands/brand_a/connections/${connId}`, {
      method: 'PATCH',
      token: tokenA,
      body: {
        configJson: { apiBaseUrl: 'http://169.254.169.254/latest/meta-data/' },
      },
    });
    expect(patchApiBaseRes.status).toBe(400);
    expect(patchApiBaseRes.json.code).toBe(API_ERROR.BAD_REQUEST);
    expect(db.connections[0]?.siteBaseUrl).toBe(`${mockCmsBaseUrl}/webflow`);
  });

  it('tests connection against real mock CMS and guarantees zero secret leakage across GET/POST/PATCH/test including 401/500 failures', async () => {
    const tokenA = tokenForUser(db.users[0]!);
    const shopifySecret = 'shpat_zero_leak_test_secret_424242';

    const created = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'Zero Leak Store',
        siteBaseUrl: `${mockCmsBaseUrl}/shopify`,
        credentials: { accessToken: shopifySecret },
      },
    });
    expect(created.status).toBe(200);
    assertNoSecretsLeaked(created.rawText, [shopifySecret]);
    const connId = created.json.data.id;

    // Positive /test -> ACTIVE with targets + discovered primaryDomain
    const testOk = await apiFetch<ChannelConnectionTestResultDto>(
      `/api/v2/brands/brand_a/connections/${connId}/test`,
      { method: 'POST', token: tokenA },
    );
    expect(testOk.status).toBe(200);
    expect(testOk.json.data.ok).toBe(true);
    expect(testOk.json.data.status).toBe('ACTIVE');
    expect(testOk.json.data.targets).toHaveLength(1);
    assertNoSecretsLeaked(testOk.rawText, [shopifySecret]);

    // Upstream 401 echoing secret -> INVALID, zero leak in response & stored lastError
    cmsMode = 'upstream_401';
    const test401 = await apiFetch<ChannelConnectionTestResultDto>(
      `/api/v2/brands/brand_a/connections/${connId}/test`,
      { method: 'POST', token: tokenA, body: {} },
    );
    expect(test401.status).toBe(200);
    expect(test401.json.data.ok).toBe(false);
    expect(test401.json.data.status).toBe('INVALID');
    assertNoSecretsLeaked(test401.rawText, [shopifySecret]);
    expect(db.connections[0]!.lastError ?? '').not.toContain(shopifySecret);

    // Upstream 500 echoing secret -> INVALID, zero leak
    cmsMode = 'upstream_500';
    const test500 = await apiFetch<ChannelConnectionTestResultDto>(
      `/api/v2/brands/brand_a/connections/${connId}/test`,
      { method: 'POST', token: tokenA, body: {} },
    );
    expect(test500.status).toBe(200);
    expect(test500.json.data.ok).toBe(false);
    expect(test500.json.data.status).toBe('INVALID');
    assertNoSecretsLeaked(test500.rawText, [shopifySecret]);

    // GET list filtered by market -> zero leak
    const listed = await apiFetch<{ items: ChannelConnectionDto[] }>(
      '/api/v2/brands/brand_a/connections?market=GLOBAL',
      { token: tokenA },
    );
    expect(listed.status).toBe(200);
    expect(listed.json.data.items).toHaveLength(1);
    expect(listed.json.data.items[0]?.status).toBe('INVALID');
    assertNoSecretsLeaked(listed.rawText, [shopifySecret]);
  });

  it('S-02: redacts lowercase %xx, + form-encoded, whitespace-split, PHP JSON-escaped \\/, and configJson secrets in ConnectionsService.test() 400 errors', async () => {
    const tokenA = tokenForUser(db.users[0]!);
    const wpPass = 'abcd efgh ijkl mnop';
    const slashToken = 'tok+abc/def=9876';
    const indexNowKey = 'indexnow_secret_key_test_77';
    const wpBase64 = Buffer.from(`wpadmin:${wpPass}`, 'utf8').toString('base64');

    const createdWp = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'WORDPRESS',
        displayName: 'WP Redaction Test',
        siteBaseUrl: `${mockCmsBaseUrl}/wp`,
        credentials: { username: 'wpadmin', appPassword: wpPass },
        configJson: { indexNowKey },
      },
    });
    expect(createdWp.status).toBe(200);
    const wpConnId = createdWp.json.data.id;

    // 1. WordPress 400 echoing whitespace-split password, + form-encoded password, and indexNowKey
    cmsMode = 'custom_400';
    custom400Body = `Rejected pass=abcd\nefgh\tijkl  mnop form=abcd+efgh+ijkl+mnop key=${indexNowKey} b64=${wpBase64.replace(/\//g, '\\/')}`;
    const wpTestRes = await apiFetch<ChannelConnectionTestResultDto>(
      `/api/v2/brands/brand_a/connections/${wpConnId}/test`,
      { method: 'POST', token: tokenA, body: {} },
    );
    expect(wpTestRes.status).toBe(200);
    expect(wpTestRes.json.data.ok).toBe(false);
    expect(wpTestRes.json.data.message).toContain('[REDACTED]');
    const wpStoredErr = db.connections.find((c) => c.id === wpConnId)?.lastError ?? '';
    for (const out of [wpTestRes.rawText, wpStoredErr]) {
      expect(out).not.toContain(wpPass);
      expect(out).not.toContain('abcd+efgh+ijkl+mnop');
      expect(out).not.toContain(indexNowKey);
      expect(out).not.toContain(wpBase64);
      expect(out).not.toContain(wpBase64.replace(/\//g, '\\/'));
    }

    // 2. Shopify 400 echoing lowercase %xx encoded token and PHP json_encode \/ escaped token
    const createdShop = await apiFetch<ChannelConnectionDto>('/api/v2/brands/brand_a/connections', {
      method: 'POST',
      token: tokenA,
      body: {
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'Shopify Encoded Redaction',
        siteBaseUrl: `${mockCmsBaseUrl}/shopify`,
        credentials: { accessToken: slashToken },
      },
    });
    expect(createdShop.status).toBe(200);
    const shopConnId = createdShop.json.data.id;

    cmsMode = 'custom_400';
    custom400Body = 'PHP error: {"err":"bad tok+abc\\/def=9876" pct=tok%2babc%2fdef%3d9876';
    const shopTestRes = await apiFetch<ChannelConnectionTestResultDto>(
      `/api/v2/brands/brand_a/connections/${shopConnId}/test`,
      { method: 'POST', token: tokenA, body: {} },
    );
    expect(shopTestRes.status).toBe(200);
    expect(shopTestRes.json.data.ok).toBe(false);
    expect(shopTestRes.json.data.message).toContain('[REDACTED]');
    const shopStoredErr = db.connections.find((c) => c.id === shopConnId)?.lastError ?? '';
    for (const out of [shopTestRes.rawText, shopStoredErr]) {
      expect(out).not.toContain(slashToken);
      expect(out).not.toContain('tok+abc\\/def=9876');
      expect(out).not.toContain('tok%2babc%2fdef%3d9876');
    }
    cmsMode = 'ok';
  });
});
