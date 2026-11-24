import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import IORedis from 'ioredis';
import {
  API_ERROR,
  AUTH_ERROR,
  parseEnv,
  supportedLocalesForMarket,
  type ChannelConnectionDto,
  type GeoMarket,
  type SupportedLocale,
} from '@geomix/shared';
import { type BillingTx, TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { SecretBox, SecretBoxError, type EncryptedEnvelope } from '../common/secret-box';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { UrlPolicyError } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { presentConnection } from './connections.service';
import { parseJsonSafe, redactSecrets, type ConnectorSecrets } from './connectors';

export const SHOPIFY_OAUTH_DEPS = Symbol('SHOPIFY_OAUTH_DEPS');
export const SHOPIFY_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_SHOPIFY_OAUTH_SCOPES = 'read_content,write_content';
const DEFAULT_SHOPIFY_API_VERSION = '2025-01';
const CALLBACK_TIMESTAMP_SKEW_SECONDS = 600;
const STATE_KEY_PREFIX = 'geomix:shopify:oauth:state:';
const MYSHOPIFY_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const STATE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/i;
const STRICT_B64_SHA256_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const MAX_IN_MEMORY_STATES = 10_000;

const CONSUME_STATE_LUA = `
local v = redis.call('GET', KEYS[1])
if v then
  redis.call('DEL', KEYS[1])
end
return v
`;

export type ShopifyOAuthStatePayload = {
  tenantId: string;
  userId: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  shop: string;
  displayName?: string;
  targetLocale?: SupportedLocale | null;
  createdAt: number;
  expiresAt: number;
};

export interface ShopifyOAuthStateStore {
  set(state: string, payload: ShopifyOAuthStatePayload, ttlMs: number): Promise<void>;
  consume(state: string): Promise<ShopifyOAuthStatePayload | null>;
  close?(): Promise<void>;
}

export type ShopifyOAuthDeps = {
  stateStore?: ShopifyOAuthStateStore;
  now?: () => number;
  env?: Record<string, string | undefined>;
  randomBytes?: (size: number) => Buffer;
};

export type ShopifyOAuthAuthContext = {
  tenantId: string;
  userId: string;
};

export type ShopifyOAuthStartInput = {
  shop: string;
  market?: GeoMarket;
  displayName?: string;
  targetLocale?: SupportedLocale | null;
};

export type ShopifyOAuthStartResult = {
  authorizeUrl: string;
  state: string;
  shop: string;
  expiresAt: string;
};

export type ShopifyOAuthCallbackResult = {
  connection: ChannelConnectionDto;
  shop: string;
  webhookRegistered: boolean;
  redirectUrl: string;
};

export type ShopifyAppUninstalledResult = {
  received: true;
  shop: string;
  disabledCount: number;
};

export class InMemoryShopifyOAuthStateStore implements ShopifyOAuthStateStore {
  private readonly entries = new Map<string, ShopifyOAuthStatePayload>();

  constructor(private readonly nowFn: () => number = () => Date.now()) {}

  async set(state: string, payload: ShopifyOAuthStatePayload, _ttlMs: number): Promise<void> {
    const now = this.nowFn();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size >= MAX_IN_MEMORY_STATES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(state, payload);
  }

  async consume(state: string): Promise<ShopifyOAuthStatePayload | null> {
    const hit = this.entries.get(state);
    this.entries.delete(state);
    if (!hit || hit.expiresAt <= this.nowFn()) {
      return null;
    }
    return hit;
  }
}

function isValidStatePayload(raw: unknown): raw is ShopifyOAuthStatePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.tenantId === 'string' &&
    obj.tenantId.length > 0 &&
    typeof obj.userId === 'string' &&
    typeof obj.brandId === 'string' &&
    obj.brandId.length > 0 &&
    typeof obj.brandMarketId === 'string' &&
    obj.brandMarketId.length > 0 &&
    (obj.market === 'CN' || obj.market === 'GLOBAL') &&
    typeof obj.shop === 'string' &&
    obj.shop.length > 0 &&
    typeof obj.expiresAt === 'number' &&
    Number.isFinite(obj.expiresAt)
  );
}

function createRedisShopifyOAuthStateStore(
  redisUrl: string,
  fallback: InMemoryShopifyOAuthStateStore,
  nowFn: () => number,
): ShopifyOAuthStateStore {
  let client: IORedis | null = null;
  const ensure = (): IORedis => {
    if (!client) {
      const next = new IORedis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        connectTimeout: 3_000,
      });
      next.on('error', () => {
        // 降级至进程内存储，避免未捕获的 EventEmitter 异常
      });
      client = next;
    }
    return client;
  };

  return {
    async set(state: string, payload: ShopifyOAuthStatePayload, ttlMs: number): Promise<void> {
      const safeTtl = Math.max(1_000, Math.round(ttlMs));
      try {
        await ensure().set(`${STATE_KEY_PREFIX}${state}`, JSON.stringify(payload), 'PX', safeTtl);
      } catch {
        await fallback.set(state, payload, safeTtl);
      }
    },

    async consume(state: string): Promise<ShopifyOAuthStatePayload | null> {
      try {
        const raw = await ensure().eval(CONSUME_STATE_LUA, 1, `${STATE_KEY_PREFIX}${state}`);
        if (typeof raw === 'string' && raw.trim()) {
          const parsed = parseJsonSafe<unknown>(raw);
          if (isValidStatePayload(parsed) && parsed.expiresAt > nowFn()) {
            return parsed;
          }
          return null;
        }
      } catch {
        // Redis 不可用时尝试从降级存储消费
      }
      return fallback.consume(state);
    },

    async close(): Promise<void> {
      const current = client;
      client = null;
      if (!current) return;
      try {
        await current.quit();
      } catch {
        current.disconnect();
      }
    },
  };
}

/**
 * 严格校验并规范化 Shopify 店铺域名（仅允许单级子域 `*.myshopify.com`）。
 * `allowHttpsUrl: true` 时允许用户输入 `https://<shop>.myshopify.com`（不含路径/端口/凭据/查询串）。
 */
export function normalizeShopifyShopDomain(
  raw: unknown,
  opts?: { allowHttpsUrl?: boolean },
): string | null {
  if (typeof raw !== 'string') return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;

  let candidate = trimmed.toLowerCase();
  if (candidate.startsWith('http://')) {
    return null;
  }
  if (candidate.startsWith('https://')) {
    if (!opts?.allowHttpsUrl) {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    candidate = parsed.hostname.toLowerCase();
  }

  if (candidate.length > 253 || !MYSHOPIFY_DOMAIN_RE.test(candidate)) {
    return null;
  }
  return candidate;
}

function escapeShopifyHmacKey(value: string): string {
  return value.replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
}

function escapeShopifyHmacValue(value: string): string {
  return value.replace(/%/g, '%25').replace(/&/g, '%26');
}

/**
 * 校验 Shopify OAuth 回调查询串的 HEX HMAC-SHA256 签名（防参数污染 + `timingSafeEqual`）。
 */
export function verifyShopifyOAuthCallbackHmac(
  rawQueryString: string,
  clientSecret: string,
): { ok: boolean; params: Record<string, string>; duplicateKey?: string } {
  const cleanedQuery = rawQueryString.startsWith('?') ? rawQueryString.slice(1) : rawQueryString;
  const searchParams = new URLSearchParams(cleanedQuery);
  const seen = new Set<string>();
  const params: Record<string, string> = Object.create(null);

  for (const [key, value] of searchParams.entries()) {
    if (seen.has(key)) {
      return { ok: false, params: Object.create(null), duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }

  const hmac = params.hmac?.trim() ?? '';
  if (!HEX_SHA256_RE.test(hmac)) {
    return { ok: false, params };
  }

  const pairs = Object.entries(params)
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .map(([key, value]): [string, string] => [
      escapeShopifyHmacKey(key),
      escapeShopifyHmacValue(value),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const message = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  const expected = createHmac('sha256', clientSecret).update(message, 'utf8').digest();
  const actual = Buffer.from(hmac, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, params };
  }

  return { ok: true, params };
}

/**
 * 校验 Shopify Webhook 的原始字节流 Base64 `X-Shopify-Hmac-Sha256` 签名（严格要求原始 `Buffer`）。
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  hmacHeader: string,
  clientSecret: string,
): boolean {
  if (!Buffer.isBuffer(rawBody) || typeof hmacHeader !== 'string' || !clientSecret) {
    return false;
  }
  const trimmed = hmacHeader.trim();
  if (!STRICT_B64_SHA256_RE.test(trimmed)) {
    return false;
  }
  const actual = Buffer.from(trimmed, 'base64');
  if (actual.length !== 32) {
    return false;
  }
  const expected = createHmac('sha256', clientSecret).update(rawBody).digest();
  const expectedB64 = expected.toString('base64');
  const actualUtf8 = Buffer.from(trimmed, 'utf8');
  const expectedUtf8 = Buffer.from(expectedB64, 'utf8');
  return (
    actualUtf8.length === expectedUtf8.length &&
    timingSafeEqual(actual, expected) &&
    timingSafeEqual(actualUtf8, expectedUtf8)
  );
}

function readSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof val === 'string') return val.trim();
    if (Array.isArray(val) && val.length === 1 && typeof val[0] === 'string') {
      return val[0].trim();
    }
    return undefined;
  }
  return undefined;
}

type ResolvedShopifyOAuthConfig = {
  clientId: string;
  clientSecret: string;
  scopes: string;
  publicApiBaseUrl: string;
  webBaseUrl: string;
};

type ShopifyTokenExchangeResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
};

@Injectable()
export class ShopifyOAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(ShopifyOAuthService.name);
  private readonly stateStore: ShopifyOAuthStateStore;
  private readonly nowFn: () => number;
  private readonly envOverride?: Record<string, string | undefined>;
  private readonly randomBytesFn: (size: number) => Buffer;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(SecretBox) private readonly secretBox: SecretBox,
    @Inject(OutboundHttpClient) private readonly outboundHttp: OutboundHttpClient,
    @Optional() @Inject(SHOPIFY_OAUTH_DEPS) deps?: ShopifyOAuthDeps,
  ) {
    this.nowFn = deps?.now ?? (() => Date.now());
    this.envOverride = deps?.env;
    this.randomBytesFn = deps?.randomBytes ?? nodeRandomBytes;

    if (deps?.stateStore) {
      this.stateStore = deps.stateStore;
    } else {
      const envSource = deps?.env ?? process.env;
      const fallback = new InMemoryShopifyOAuthStateStore(this.nowFn);
      const redisUrl = envSource.REDIS_URL?.trim();
      this.stateStore =
        envSource.NODE_ENV !== 'test' && redisUrl
          ? createRedisShopifyOAuthStateStore(redisUrl, fallback, this.nowFn)
          : fallback;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stateStore.close?.();
  }

  async startOAuth(
    auth: ShopifyOAuthAuthContext,
    brandId: string,
    input: ShopifyOAuthStartInput,
  ): Promise<ShopifyOAuthStartResult> {
    const cfg = this.readShopifyOAuthConfig();

    const shop = normalizeShopifyShopDomain(input.shop, { allowHttpsUrl: true });
    if (!shop) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '请输入有效的 Shopify 店铺域名（*.myshopify.com）',
      );
    }

    const market: GeoMarket = input.market ?? 'GLOBAL';
    const targetLocale = this.validateTargetLocaleForMarket(input.targetLocale, market);

    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: { markets: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }
    const brandMarket = brand.markets.find((m) => m.market === market);
    if (!brandMarket) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该品牌尚未开启目标市场');
    }

    const existing = await this.prisma.scoped.channelConnection.findFirst({
      where: {
        brandId,
        brandMarketId: brandMarket.id,
        provider: 'SHOPIFY',
        authType: 'OAUTH',
        OR: [
          { externalShopDomain: shop },
          { siteBaseUrl: { in: [`https://${shop}`, `https://${shop}/`] } },
        ],
      },
      select: { id: true },
    });
    if (!existing) {
      await this.quota.assertAvailable(auth.tenantId, 'SOCIAL_AUTH', 1);
    }

    const state = this.randomBytesFn(32).toString('base64url');
    const now = this.nowFn();
    const expiresAt = now + SHOPIFY_OAUTH_STATE_TTL_MS;
    const statePayload: ShopifyOAuthStatePayload = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      brandId,
      brandMarketId: brandMarket.id,
      market,
      shop,
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      ...(targetLocale !== undefined ? { targetLocale } : {}),
      createdAt: now,
      expiresAt,
    };
    await this.stateStore.set(state, statePayload, SHOPIFY_OAUTH_STATE_TTL_MS);

    const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', cfg.clientId);
    authorizeUrl.searchParams.set('scope', cfg.scopes);
    authorizeUrl.searchParams.set(
      'redirect_uri',
      `${cfg.publicApiBaseUrl}/api/v2/integrations/shopify/callback`,
    );
    authorizeUrl.searchParams.set('state', state);

    return {
      authorizeUrl: authorizeUrl.toString(),
      state,
      shop,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async handleCallback(rawQueryString: string): Promise<ShopifyOAuthCallbackResult> {
    const cfg = this.readShopifyOAuthConfig();

    // 必须先验签再消费 state，防止伪造 HMAC 请求恶意消耗有效授权会话
    const hmacCheck = verifyShopifyOAuthCallbackHmac(rawQueryString, cfg.clientSecret);
    if (hmacCheck.duplicateKey) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify OAuth 回调参数重复');
    }
    if (!hmacCheck.ok) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, 'Shopify OAuth 签名校验失败');
    }

    const { params } = hmacCheck;
    const shop = normalizeShopifyShopDomain(params.shop, { allowHttpsUrl: false });
    if (!shop) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify OAuth 回调缺少有效的店铺域名');
    }
    const code = params.code?.trim() ?? '';
    if (!code || code.length > 512) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify OAuth 回调缺少有效的授权码');
    }
    const state = params.state?.trim() ?? '';
    if (!STATE_TOKEN_RE.test(state)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify OAuth state 格式无效');
    }

    if (params.timestamp !== undefined && params.timestamp.trim() !== '') {
      const tsStr = params.timestamp.trim();
      if (!/^\d{1,12}$/.test(tsStr)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify OAuth 回调时间戳无效');
      }
      const nowSec = Math.floor(this.nowFn() / 1000);
      if (Math.abs(nowSec - Number(tsStr)) > CALLBACK_TIMESTAMP_SKEW_SECONDS) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify OAuth 回调已过期，请重新授权');
      }
    }

    const saved = await this.stateStore.consume(state);
    if (!saved || saved.expiresAt <= this.nowFn()) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        'Shopify OAuth state 无效或已过期，请重新发起授权',
      );
    }
    if (saved.shop !== shop) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify 店铺域名与授权会话不匹配');
    }

    // 使用授权码换取 Admin Access Token（经 OutboundHttpClient，禁止重定向）
    const tokenRes = await this.exchangeAuthorizationCode(shop, code, cfg);
    const accessToken = tokenRes.accessToken;
    const grantedScope = tokenRes.grantedScope;
    const oauthExpiresAt = tokenRes.expiresAt;

    const secretPayload: ConnectorSecrets = {
      accessToken,
      oauthAccessToken: accessToken,
      ...(grantedScope ? { oauthScope: grantedScope } : {}),
    };
    const envelope = this.encryptSecrets(secretPayload);
    const credentialHint = this.secretBox.maskSecret(accessToken) || '****';
    const siteBaseUrl = `https://${shop}`;

    const connection = await runInTenant(saved.tenantId, async () => {
      const brandMarket = await this.prisma.scoped.brandMarket.findFirst({
        where: { id: saved.brandMarketId, brandId: saved.brandId },
        select: { id: true, market: true },
      });
      if (!brandMarket) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该品牌尚未开启目标市场');
      }

      const existing = await this.prisma.scoped.channelConnection.findFirst({
        where: {
          brandId: saved.brandId,
          brandMarketId: saved.brandMarketId,
          provider: 'SHOPIFY',
          authType: 'OAUTH',
          OR: [
            { externalShopDomain: shop },
            { siteBaseUrl: { in: [siteBaseUrl, `${siteBaseUrl}/`] } },
          ],
        },
        include: { brandMarket: { select: { market: true } } },
      });

      if (existing) {
        const existingConfig =
          existing.configJson &&
          typeof existing.configJson === 'object' &&
          !Array.isArray(existing.configJson)
            ? (existing.configJson as Record<string, unknown>)
            : {};
        const nextConfig: Record<string, unknown> = {
          ...existingConfig,
          ...(grantedScope ? { oauthScope: grantedScope } : {}),
        };

        const updated = await this.prisma.scoped.channelConnection.update({
          where: { id: existing.id },
          data: {
            displayName: saved.displayName?.trim() || existing.displayName,
            siteBaseUrl,
            credentialsCiphertext: envelope.ciphertext,
            credentialsIv: envelope.iv,
            credentialsTag: envelope.tag,
            keyVersion: envelope.keyVersion,
            credentialHint,
            authType: 'OAUTH',
            oauthAccessTokenCiphertext: envelope.ciphertext,
            oauthExpiresAt,
            externalShopDomain: shop,
            ...(saved.targetLocale !== undefined ? { targetLocale: saved.targetLocale } : {}),
            configJson: nextConfig as Prisma.InputJsonValue,
            status: 'ACTIVE',
            lastError: null,
          },
          include: { brandMarket: { select: { market: true } } },
        });
        return presentConnection(updated, saved.market);
      }

      const created = await this.prisma.scoped.$transaction(async (tx) => {
        await this.quota.consume(saved.tenantId, 'SOCIAL_AUTH', 1, tx as unknown as BillingTx);
        return tx.channelConnection.create({
          data: {
            tenantId: saved.tenantId,
            brandId: saved.brandId,
            brandMarketId: saved.brandMarketId,
            provider: 'SHOPIFY',
            displayName:
              saved.displayName?.trim() || `Shopify (${shop.replace(/\.myshopify\.com$/, '')})`,
            siteBaseUrl,
            credentialsCiphertext: envelope.ciphertext,
            credentialsIv: envelope.iv,
            credentialsTag: envelope.tag,
            keyVersion: envelope.keyVersion,
            credentialHint,
            authType: 'OAUTH',
            oauthAccessTokenCiphertext: envelope.ciphertext,
            oauthExpiresAt,
            externalShopDomain: shop,
            targetLocale: saved.targetLocale ?? null,
            configJson: (grantedScope ? { oauthScope: grantedScope } : {}) as Prisma.InputJsonValue,
            status: 'ACTIVE',
          },
          include: { brandMarket: { select: { market: true } } },
        });
      }, TX_OPTIONS);

      return presentConnection(created, saved.market);
    });

    const webhookRegistered = await this.registerUninstallWebhook(shop, accessToken, cfg);
    const redirectUrl =
      `${cfg.webBaseUrl}/brands?brandId=${encodeURIComponent(saved.brandId)}` +
      `&shopifyOAuth=connected&connectionId=${encodeURIComponent(connection.id)}`;

    return {
      connection,
      shop,
      webhookRegistered,
      redirectUrl,
    };
  }

  async handleAppUninstalledWebhook(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<ShopifyAppUninstalledResult> {
    const cfg = this.readShopifyOAuthConfig();
    const hmacHeader = readSingleHeader(headers, 'x-shopify-hmac-sha256') ?? '';
    if (
      !rawBody ||
      !Buffer.isBuffer(rawBody) ||
      !verifyShopifyWebhookHmac(rawBody, hmacHeader, cfg.clientSecret)
    ) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, 'Shopify Webhook 签名校验失败');
    }

    const topic = readSingleHeader(headers, 'x-shopify-topic');
    if (topic && topic.toLowerCase() !== 'app/uninstalled') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '不支持的 Shopify Webhook 事件类型');
    }

    const headerShop = readSingleHeader(headers, 'x-shopify-shop-domain');
    let rawShop: unknown = headerShop;
    if (!rawShop) {
      const parsedBody = parseJsonSafe<Record<string, unknown>>(rawBody.toString('utf8'));
      rawShop = parsedBody?.myshopify_domain ?? parsedBody?.domain;
    }

    const shopDomain = normalizeShopifyShopDomain(rawShop, { allowHttpsUrl: false });
    if (!shopDomain) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '缺少有效的 Shopify 店铺域名');
    }

    // 唯一 prisma.base 查询：通过店铺域名定位受影响连接及其归属 tenantId，随后立即切入 runInTenant + prisma.scoped
    const matched = await this.prisma.base.channelConnection.findMany({
      where: {
        provider: 'SHOPIFY',
        authType: 'OAUTH',
        OR: [
          { externalShopDomain: shopDomain },
          { siteBaseUrl: { in: [`https://${shopDomain}`, `https://${shopDomain}/`] } },
        ],
      },
      select: { id: true, tenantId: true },
    });

    const byTenant = new Map<string, string[]>();
    for (const row of matched) {
      const ids = byTenant.get(row.tenantId) ?? [];
      ids.push(row.id);
      byTenant.set(row.tenantId, ids);
    }

    let disabledCount = 0;
    for (const [tenantId, ids] of byTenant) {
      const updated = await runInTenant(tenantId, () =>
        this.prisma.scoped.channelConnection.updateMany({
          where: { id: { in: ids }, provider: 'SHOPIFY', authType: 'OAUTH' },
          data: {
            status: 'DISABLED',
            credentialsCiphertext: '',
            credentialsIv: '',
            credentialsTag: '',
            credentialHint: '',
            oauthAccessTokenCiphertext: null,
            oauthExpiresAt: null,
            lastError: 'Shopify 应用已卸载，授权凭据已自动清除，请重新授权连接',
          },
        }),
      );
      disabledCount += updated.count;
    }

    return {
      received: true,
      shop: shopDomain,
      disabledCount,
    };
  }

  private readShopifyOAuthConfig(): ResolvedShopifyOAuthConfig {
    const env = parseEnv(this.envOverride ?? process.env);
    const clientId = env.SHOPIFY_OAUTH_CLIENT_ID?.trim() ?? '';
    const clientSecret = env.SHOPIFY_OAUTH_CLIENT_SECRET?.trim() ?? '';
    if (!clientId || !clientSecret) {
      throw new ApiError(
        503,
        API_ERROR.UPSTREAM_UNAVAILABLE,
        'Shopify OAuth 尚未配置（请先设置 SHOPIFY_OAUTH_CLIENT_ID 与 SHOPIFY_OAUTH_CLIENT_SECRET，或使用 Custom App Token 接入）',
      );
    }

    const scopes = env.SHOPIFY_OAUTH_SCOPES?.trim() || DEFAULT_SHOPIFY_OAUTH_SCOPES;
    const publicApiBaseUrl = this.resolvePublicApiBaseUrl(env);
    const webBaseUrl = this.resolveWebBaseUrl(env);

    return {
      clientId,
      clientSecret,
      scopes,
      publicApiBaseUrl,
      webBaseUrl,
    };
  }

  private resolvePublicApiBaseUrl(env: ReturnType<typeof parseEnv>): string {
    if (env.PUBLIC_APP_URL) {
      return env.PUBLIC_APP_URL.replace(/\/+$/, '');
    }
    const nextApiBase = env.NEXT_PUBLIC_API_BASE?.trim();
    if (nextApiBase && /^https?:\/\//i.test(nextApiBase)) {
      return nextApiBase.replace(/\/api\/v\d+\/?$/i, '').replace(/\/+$/, '');
    }
    return `http://localhost:${env.API_PORT}`;
  }

  private resolveWebBaseUrl(env: ReturnType<typeof parseEnv>): string {
    if (env.PUBLIC_APP_URL) {
      return env.PUBLIC_APP_URL.replace(/\/+$/, '');
    }
    const firstOrigin = env.WEB_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .find((origin) => origin.length > 0);
    return (firstOrigin || 'http://localhost:3000').replace(/\/+$/, '');
  }

  private validateTargetLocaleForMarket(
    rawLocale: SupportedLocale | null | undefined,
    market: GeoMarket,
  ): SupportedLocale | null | undefined {
    if (rawLocale === undefined) return undefined;
    if (rawLocale === null) return null;
    const allowed = supportedLocalesForMarket(market);
    if (!allowed.includes(rawLocale)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `目标语种 ${rawLocale} 与当前市场（${market}）不匹配`,
      );
    }
    return rawLocale;
  }

  private encryptSecrets(secrets: ConnectorSecrets): EncryptedEnvelope {
    try {
      return this.secretBox.encryptJson(secrets);
    } catch (error) {
      if (
        error instanceof SecretBoxError &&
        (error.code === 'MISSING_KEY' || error.code === 'INVALID_KEY')
      ) {
        throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, error.message);
      }
      throw error;
    }
  }

  private async exchangeAuthorizationCode(
    shop: string,
    code: string,
    cfg: ResolvedShopifyOAuthConfig,
  ): Promise<{ accessToken: string; grantedScope?: string; expiresAt: Date | null }> {
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const candidates = [cfg.clientSecret, code];

    let response;
    try {
      response = await this.outboundHttp.request({
        url: tokenUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
        }),
        maxRedirects: 0,
      });
    } catch (error) {
      if (
        error instanceof UrlPolicyError ||
        (error instanceof ProviderError && error.kind === PROVIDER_KIND.SSRF)
      ) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Shopify 店铺地址未通过公网安全校验');
      }
      const rawMsg = error instanceof Error ? error.message : 'Shopify OAuth 令牌换取失败';
      throw new ApiError(
        502,
        API_ERROR.UPSTREAM_UNAVAILABLE,
        redactSecrets(`Shopify OAuth 令牌换取失败：${rawMsg}`, candidates, 240),
      );
    }

    if (response.status < 200 || response.status >= 300) {
      const safeDetail = redactSecrets(response.body, candidates, 180);
      throw new ApiError(
        502,
        API_ERROR.UPSTREAM_UNAVAILABLE,
        safeDetail
          ? `Shopify OAuth 令牌换取失败（HTTP ${response.status}）：${safeDetail}`
          : `Shopify OAuth 令牌换取失败（HTTP ${response.status}）`,
      );
    }

    const parsed = parseJsonSafe<ShopifyTokenExchangeResponse>(response.body);
    const accessToken = parsed?.access_token?.trim() ?? '';
    if (!accessToken) {
      throw new ApiError(
        502,
        API_ERROR.UPSTREAM_UNAVAILABLE,
        'Shopify OAuth 响应缺少 access_token',
      );
    }

    const grantedScope =
      typeof parsed?.scope === 'string' && parsed.scope.trim() ? parsed.scope.trim() : undefined;
    const expiresAt =
      typeof parsed?.expires_in === 'number' && parsed.expires_in > 0
        ? new Date(this.nowFn() + parsed.expires_in * 1000)
        : null;

    return { accessToken, grantedScope, expiresAt };
  }

  private async registerUninstallWebhook(
    shop: string,
    accessToken: string,
    cfg: ResolvedShopifyOAuthConfig,
  ): Promise<boolean> {
    const webhookUrl = `https://${shop}/admin/api/${DEFAULT_SHOPIFY_API_VERSION}/webhooks.json`;
    const candidates = [accessToken, cfg.clientSecret];
    try {
      const response = await this.outboundHttp.request({
        url: webhookUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          webhook: {
            topic: 'app/uninstalled',
            address: `${cfg.publicApiBaseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
            format: 'json',
          },
        }),
        maxRedirects: 0,
      });

      if (response.status === 200 || response.status === 201) {
        return true;
      }
      if (response.status === 422 && /already been taken/i.test(response.body)) {
        return true;
      }
      this.logger.warn(
        `shopify uninstall webhook registration returned HTTP ${response.status}: ${redactSecrets(response.body, candidates, 180)}`,
      );
      return false;
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `shopify uninstall webhook registration error: ${redactSecrets(rawMsg, candidates, 180)}`,
      );
      return false;
    }
  }
}
