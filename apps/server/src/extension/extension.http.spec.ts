import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  EXTENSION_BRIDGE_VERSION,
  EXTENSION_DEFAULT_SCOPES,
  EXTENSION_DEFAULT_TTL_DAYS,
  EXTENSION_TOKEN_PREFIX,
  parseEnv,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BrandMediaService } from '../brands/brand-media.service';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { CrawlProbeService } from '../distribution/crawl-probe.service';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { hashExtensionToken } from './extension-token-lookup.service';

type TenantRow = {
  id: string;
  name: string;
  isActive: boolean;
  expiresAt: Date;
};

type UserRow = {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  nickname: string | null;
  role: 'MERCHANT' | 'ADMIN';
  uiPrefs?: unknown;
};

type BrandRow = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
};

type BrandMarketRow = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  localBrandName: string;
  localCategory: string | null;
  ownedDomains: string[];
  createdAt: Date;
};

type BrandMediaRow = {
  id: string;
  tenantId: string;
  brandId: string;
  title: string;
  url: string;
  mime: string | null;
  createdAt: Date;
};

type GeoArticleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  targetPrompt: string;
  status: string;
};

type DistributionTaskRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  provider: string;
  mode: string;
  channelLabel: string;
  targetUrlHint: string | null;
  variantTitle: string;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: unknown;
  status: string;
  remotePublishedUrl: string | null;
  publishedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
};

type ExtensionTokenRow = {
  id: string;
  tenantId: string;
  userId: string;
  label: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

type PublishRecordRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  publishedUrl: string;
  channel: string;
  publishedAt: Date;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: unknown;
  afterMetrics: unknown;
  distributionTaskId: string | null;
  crawlStatus: string;
  crawlCheckedAt: Date | null;
  crawlReportJson: unknown;
  indexNowSubmitted: boolean;
  createdAt: Date;
};

type RetestScheduleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: number;
  includeControlPrompts: boolean;
  dueAt: Date;
  status: string;
  visibilityRunId: string | null;
  lastError: string | null;
  triggeredAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const VALID_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const WEB_ORIGIN = 'http://localhost:3000';

function rawHttpRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function rawTcpHttpRequest(
  port: number,
  rawRequest: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(rawRequest);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const sepIdx = text.indexOf('\r\n\r\n');
      const head = sepIdx >= 0 ? text.slice(0, sepIdx) : text;
      const body = sepIdx >= 0 ? text.slice(sepIdx + 4) : '';
      const lines = head.split('\r\n');
      const statusLine = lines[0] ?? '';
      const statusMatch = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim().toLowerCase();
          const val = line.slice(colon + 1).trim();
          headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
        }
      }
      resolve({
        statusCode: statusMatch ? Number(statusMatch[1]) : 0,
        headers,
        body,
      });
    });
    socket.on('error', reject);
  });
}

describe('Extension Bridge & Token CRUD HTTP (full createApiApp)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let port: number;
  let rateLimiter: FreeActionRateLimiter;
  let brandMediaSvc: BrandMediaService;
  let crawlProbeSvc: CrawlProbeService;

  let tenants: Map<string, TenantRow>;
  let users: Map<string, UserRow>;
  let brands: Map<string, BrandRow>;
  let brandMarkets: BrandMarketRow[];
  let brandMediaAssets: BrandMediaRow[];
  let geoArticles: Map<string, GeoArticleRow>;
  let distributionTasks: Map<string, DistributionTaskRow>;
  let extensionTokens: ExtensionTokenRow[];
  let publishRecords: PublishRecordRow[];
  let retestSchedules: RetestScheduleRow[];
  let failLastUsedAtUpdate = false;
  let seq = 1;

  let jwtTenantA: string;
  let jwtTenantB: string;
  let jwtExpiredTenant: string;
  let jwtInactiveTenant: string;

  const savedEnv: Record<string, string | undefined> = {};

  function requireTenantAls(): string {
    const tid = currentTenantId();
    if (!tid) {
      throw new Error('Missing tenant ALS context in scoped Prisma call!');
    }
    return tid;
  }

  function mintJwt(user: UserRow): string {
    const env = parseEnv();
    const nowSec = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: user.id,
        tid: user.tenantId,
        role: user.role,
        typ: 'access',
        fp: passwordFingerprint(user.passwordHash),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );
  }

  function seedState() {
    seq = 1;
    failLastUsedAtUpdate = false;
    const future = new Date(Date.now() + 60 * 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const now = new Date();

    tenants = new Map<string, TenantRow>([
      ['tenant_a', { id: 'tenant_a', name: '租户甲', isActive: true, expiresAt: future }],
      ['tenant_b', { id: 'tenant_b', name: '租户乙', isActive: true, expiresAt: future }],
      [
        'tenant_expired',
        { id: 'tenant_expired', name: '到期租户', isActive: true, expiresAt: past },
      ],
      [
        'tenant_inactive',
        { id: 'tenant_inactive', name: '停用租户', isActive: false, expiresAt: future },
      ],
    ]);

    users = new Map<string, UserRow>([
      [
        'user_a',
        {
          id: 'user_a',
          tenantId: 'tenant_a',
          username: 'alice',
          passwordHash: 'hash_a',
          nickname: '林小美',
          role: 'MERCHANT',
        },
      ],
      [
        'user_b',
        {
          id: 'user_b',
          tenantId: 'tenant_b',
          username: 'bob',
          passwordHash: 'hash_b',
          nickname: '张大壮',
          role: 'MERCHANT',
        },
      ],
      [
        'user_exp',
        {
          id: 'user_exp',
          tenantId: 'tenant_expired',
          username: 'expuser',
          passwordHash: 'hash_exp',
          nickname: '到期用户',
          role: 'MERCHANT',
        },
      ],
      [
        'user_inact',
        {
          id: 'user_inact',
          tenantId: 'tenant_inactive',
          username: 'inactuser',
          passwordHash: 'hash_inact',
          nickname: '停用用户',
          role: 'MERCHANT',
        },
      ],
    ]);

    brands = new Map<string, BrandRow>([
      [
        'brand_a_cn',
        { id: 'brand_a_cn', tenantId: 'tenant_a', name: 'Aurelia', category: '智能家居' },
      ],
      [
        'brand_a_global',
        { id: 'brand_a_global', tenantId: 'tenant_a', name: 'GlobalOnly', category: 'SaaS' },
      ],
      [
        'brand_b_cn',
        { id: 'brand_b_cn', tenantId: 'tenant_b', name: 'Boreal', category: '美妆护肤' },
      ],
    ]);

    brandMarkets = [
      {
        id: 'bm_a_cn',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        market: 'CN',
        localBrandName: '奥瑞利亚空气净化',
        localCategory: '家用空气净化器',
        ownedDomains: ['aurelia.cn'],
        createdAt: now,
      },
      {
        id: 'bm_a_global',
        tenantId: 'tenant_a',
        brandId: 'brand_a_global',
        market: 'GLOBAL',
        localBrandName: 'GlobalOnly Inc',
        localCategory: 'Cloud SaaS',
        ownedDomains: ['globalonly.example'],
        createdAt: now,
      },
      {
        id: 'bm_b_cn',
        tenantId: 'tenant_b',
        brandId: 'brand_b_cn',
        market: 'CN',
        localBrandName: '北境护肤',
        localCategory: '功效护肤',
        ownedDomains: ['boreal.cn'],
        createdAt: now,
      },
    ];

    brandMediaAssets = [
      {
        id: 'media_a1',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        title: '实测噪音对比图',
        url: '/api/v2/brands/brand_a_cn/media/media_a1/file',
        mime: 'image/png',
        createdAt: now,
      },
      {
        id: 'media_b1',
        tenantId: 'tenant_b',
        brandId: 'brand_b_cn',
        title: '租户乙素材',
        url: '/api/v2/brands/brand_b_cn/media/media_b1/file',
        mime: 'image/jpeg',
        createdAt: now,
      },
    ];

    geoArticles = new Map<string, GeoArticleRow>([
      [
        'art_a1',
        {
          id: 'art_a1',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          targetPrompt: '2026年除甲醛空气净化器哪款实测数据最好？',
          status: 'READY',
        },
      ],
      [
        'art_a2',
        {
          id: 'art_a2',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          targetPrompt: '卧室静音净化器选购指南',
          status: 'READY',
        },
      ],
      [
        'art_b1',
        {
          id: 'art_b1',
          tenantId: 'tenant_b',
          brandId: 'brand_b_cn',
          brandMarketId: 'bm_b_cn',
          targetPrompt: '敏感肌修护面霜实测',
          status: 'READY',
        },
      ],
    ]);

    distributionTasks = new Map<string, DistributionTaskRow>([
      [
        'task_l2_zhihu',
        {
          id: 'task_l2_zhihu',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a1',
          provider: 'ZHIHU_EXT',
          mode: 'L2_EXTENSION',
          channelLabel: '知乎专栏（Chrome 扩展）',
          targetUrlHint: 'https://zhuanlan.zhihu.com/write',
          variantTitle: '除甲醛净化器实测：30天密闭舱数据拆解',
          variantMarkdown: '# 实测正文\nCADR 650 m³/h',
          variantHtml: '<h1>实测正文</h1><p>CADR 650 m³/h</p>',
          variantExtrasJson: {
            antiBanChecklist: ['人工复核后再发布', '如实标注实测样本来源'],
          },
          status: 'READY_TO_PUBLISH',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: new Date(now.getTime() - 1000),
        },
      ],
      [
        'task_l2_toutiao',
        {
          id: 'task_l2_toutiao',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a2',
          provider: 'TOUTIAO_EXT',
          mode: 'L2_EXTENSION',
          channelLabel: '头条号（Chrome 扩展）',
          targetUrlHint: 'https://mp.toutiao.com/profile_v4/graphic/publish',
          variantTitle: '卧室静音空气净化器怎么选？夜间噪音实测',
          variantMarkdown: '## 结论先行\n夜间睡眠档 22dB',
          variantHtml: '<h2>结论先行</h2><p>夜间睡眠档 22dB</p>',
          variantExtrasJson: null,
          status: 'DRAFT_VARIANT',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: new Date(now.getTime() - 2000),
        },
      ],
      [
        'task_l2_smzdm_pub',
        {
          id: 'task_l2_smzdm_pub',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a1',
          provider: 'SMZDM_EXT',
          mode: 'L2_EXTENSION',
          channelLabel: '什么值得买（Chrome 扩展）',
          targetUrlHint: 'https://post.smzdm.com/tougao/',
          variantTitle: '值友实测：滤网耗材成本核算',
          variantMarkdown: '参数对照表',
          variantHtml: '<p>参数对照表</p>',
          variantExtrasJson: null,
          status: 'PUBLISHED',
          remotePublishedUrl: 'https://post.smzdm.com/p/already-1',
          publishedAt: new Date(now.getTime() - 10_000),
          lastError: null,
          updatedAt: new Date(now.getTime() - 3000),
        },
      ],
      [
        'task_l2_archived',
        {
          id: 'task_l2_archived',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a1',
          provider: 'ZHIHU_EXT',
          mode: 'L2_EXTENSION',
          channelLabel: '知乎专栏（已归档）',
          targetUrlHint: null,
          variantTitle: '归档草稿',
          variantMarkdown: '归档内容',
          variantHtml: '<p>归档内容</p>',
          variantExtrasJson: null,
          status: 'ARCHIVED',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: new Date(now.getTime() - 4000),
        },
      ],
      [
        'task_l1_shopify',
        {
          id: 'task_l1_shopify',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a1',
          provider: 'SHOPIFY',
          mode: 'L1_API',
          channelLabel: 'Shopify Blog',
          targetUrlHint: null,
          variantTitle: 'Shopify L1 Post',
          variantMarkdown: 'L1 body',
          variantHtml: '<p>L1 body</p>',
          variantExtrasJson: null,
          status: 'READY_TO_PUBLISH',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: now,
        },
      ],
      [
        'task_l1_wechat',
        {
          id: 'task_l1_wechat',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a1',
          provider: 'WECHAT_OFFICIAL',
          mode: 'L1_API',
          channelLabel: '公众号草稿箱',
          targetUrlHint: null,
          variantTitle: 'WeChat L1 Draft',
          variantMarkdown: 'L1 wechat',
          variantHtml: '<p>L1 wechat</p>',
          variantExtrasJson: null,
          status: 'DRAFT_PUSHED',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: now,
        },
      ],
      [
        'task_l3_reddit',
        {
          id: 'task_l3_reddit',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          brandMarketId: 'bm_a_cn',
          articleId: 'art_a1',
          provider: 'REDDIT',
          mode: 'L3_COMMUNITY_ASSIST',
          channelLabel: 'Reddit',
          targetUrlHint: null,
          variantTitle: 'Reddit L3',
          variantMarkdown: 'L3 body',
          variantHtml: '<p>L3 body</p>',
          variantExtrasJson: null,
          status: 'READY_TO_PUBLISH',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: now,
        },
      ],
      [
        'task_b_zhihu',
        {
          id: 'task_b_zhihu',
          tenantId: 'tenant_b',
          brandId: 'brand_b_cn',
          brandMarketId: 'bm_b_cn',
          articleId: 'art_b1',
          provider: 'ZHIHU_EXT',
          mode: 'L2_EXTENSION',
          channelLabel: '租户乙知乎',
          targetUrlHint: null,
          variantTitle: '租户乙机密任务',
          variantMarkdown: 'tenant_b secret',
          variantHtml: '<p>tenant_b secret</p>',
          variantExtrasJson: null,
          status: 'READY_TO_PUBLISH',
          remotePublishedUrl: null,
          publishedAt: null,
          lastError: null,
          updatedAt: now,
        },
      ],
    ]);

    extensionTokens = [];
    publishRecords = [];
    retestSchedules = [];

    jwtTenantA = mintJwt(users.get('user_a')!);
    jwtTenantB = mintJwt(users.get('user_b')!);
    jwtExpiredTenant = mintJwt(users.get('user_exp')!);
    jwtInactiveTenant = mintJwt(users.get('user_inact')!);
  }

  function createExtensionTokenRow(
    tenantId: string,
    userId: string,
    overrides: Partial<ExtensionTokenRow> = {},
  ): { plainToken: string; row: ExtensionTokenRow } {
    const plainToken = `${EXTENSION_TOKEN_PREFIX}tok${String(seq++).padStart(4, '0')}${'x'.repeat(36)}`;
    const row: ExtensionTokenRow = {
      id: `ext_tok_${seq++}`,
      tenantId,
      userId,
      label: 'Seeded Chrome',
      tokenPrefix: plainToken.slice(0, 12),
      tokenHash: hashExtensionToken(plainToken),
      scopes: [...EXTENSION_DEFAULT_SCOPES],
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
      revokedAt: null,
      createdAt: new Date(),
      ...overrides,
    };
    extensionTokens.push(row);
    return { plainToken, row };
  }

  beforeAll(async () => {
    savedEnv.WEB_ORIGIN = process.env.WEB_ORIGIN;
    savedEnv.SHOPIFY_OAUTH_CLIENT_ID = process.env.SHOPIFY_OAUTH_CLIENT_ID;
    savedEnv.SHOPIFY_OAUTH_CLIENT_SECRET = process.env.SHOPIFY_OAUTH_CLIENT_SECRET;
    savedEnv.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX =
      process.env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX;
    savedEnv.EXTENSION_SYNC_RATE_LIMIT_MAX = process.env.EXTENSION_SYNC_RATE_LIMIT_MAX;
    process.env.WEB_ORIGIN = WEB_ORIGIN;
    process.env.SHOPIFY_OAUTH_CLIENT_ID = 'test_shopify_oauth_client_id';
    process.env.SHOPIFY_OAUTH_CLIENT_SECRET = 'test_shopify_oauth_secret';

    app = await createApiApp();
    rateLimiter = app.get(FreeActionRateLimiter);
    brandMediaSvc = app.get(BrandMediaService);
    crawlProbeSvc = app.get(CrawlProbeService);

    const prismaSvc = app.get(PrismaService) as unknown as {
      base: Record<string, unknown>;
      scoped: Record<string, unknown>;
    };

    const base = {
      $disconnect: async () => undefined,
      user: {
        findUnique: async (args: { where: { id?: string; username?: string } }) => {
          const found = args.where.id
            ? users.get(args.where.id)
            : Array.from(users.values()).find((u) => u.username === args.where.username);
          if (!found) return null;
          return { ...found, tenant: tenants.get(found.tenantId)! };
        },
      },
      auditLog: {
        findMany: async () => [],
        create: async () => ({ id: 'al_1' }),
      },
      channelConnection: {
        findMany: async () => [],
      },
      extensionAccessToken: {
        findUnique: async (args: { where: { tokenHash: string } }) => {
          const found = extensionTokens.find((t) => t.tokenHash === args.where.tokenHash);
          if (!found) return null;
          return {
            ...found,
            tenant: tenants.get(found.tenantId)!,
          };
        },
      },
      geoPublishRecord: {
        findMany: async (args: {
          where: { crawlStatus?: string; publishedAt?: { lte?: Date } };
          take?: number;
        }) => {
          const filtered = publishRecords.filter((rec) => {
            if (args.where.crawlStatus && rec.crawlStatus !== args.where.crawlStatus) return false;
            if (
              args.where.publishedAt?.lte &&
              rec.publishedAt.getTime() > args.where.publishedAt.lte.getTime()
            ) {
              return false;
            }
            return true;
          });
          return filtered
            .slice(0, args.take ?? filtered.length)
            .map((r) => ({ id: r.id, tenantId: r.tenantId }));
        },
      },
    };

    const scoped = {
      user: {
        findFirst: async (args: { where: { id?: string; tenantId?: string } }) => {
          const tid = requireTenantAls();
          const u = args.where.id ? users.get(args.where.id) : undefined;
          if (!u || u.tenantId !== tid) return null;
          if (args.where.tenantId && u.tenantId !== args.where.tenantId) return null;
          return { nickname: u.nickname, username: u.username };
        },
      },
      brandMarket: {
        findMany: async (args: { where: { tenantId?: string; market?: string } }) => {
          const tid = requireTenantAls();
          return brandMarkets
            .filter((bm) => {
              if (bm.tenantId !== tid) return false;
              if (args.where.tenantId && bm.tenantId !== args.where.tenantId) return false;
              if (args.where.market && bm.market !== args.where.market) return false;
              return true;
            })
            .map((bm) => ({
              ...bm,
              brand: brands.get(bm.brandId)!,
            }));
        },
      },
      brandMediaAsset: {
        findMany: async (args: { where: { tenantId?: string; brandId?: { in: string[] } } }) => {
          const tid = requireTenantAls();
          return brandMediaAssets.filter((a) => {
            if (a.tenantId !== tid) return false;
            if (args.where.brandId?.in && !args.where.brandId.in.includes(a.brandId)) {
              return false;
            }
            return true;
          });
        },
      },
      extensionAccessToken: {
        findMany: async () => {
          const tid = requireTenantAls();
          return extensionTokens
            .filter((t) => t.tenantId === tid)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((t) => ({
              id: t.id,
              label: t.label,
              tokenPrefix: t.tokenPrefix,
              scopes: [...t.scopes],
              lastUsedAt: t.lastUsedAt,
              expiresAt: t.expiresAt,
              revokedAt: t.revokedAt,
              createdAt: t.createdAt,
            }));
        },
        findFirst: async (args: { where: { id?: string } }) => {
          const tid = requireTenantAls();
          const found = extensionTokens.find(
            (t) => t.tenantId === tid && (!args.where.id || t.id === args.where.id),
          );
          return found ? { ...found } : null;
        },
        create: async (args: {
          data: Omit<ExtensionTokenRow, 'id' | 'lastUsedAt' | 'revokedAt' | 'createdAt'>;
        }) => {
          const tid = requireTenantAls();
          if (args.data.tenantId !== tid) {
            throw new Error('Cross-tenant create attempt');
          }
          const created: ExtensionTokenRow = {
            id: `ext_tok_${seq++}`,
            ...args.data,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
          };
          extensionTokens.push(created);
          return {
            id: created.id,
            label: created.label,
            tokenPrefix: created.tokenPrefix,
            scopes: [...created.scopes],
            lastUsedAt: created.lastUsedAt,
            expiresAt: created.expiresAt,
            revokedAt: created.revokedAt,
            createdAt: created.createdAt,
          };
        },
        updateMany: async (args: {
          where: { id?: string; revokedAt?: null };
          data: { revokedAt?: Date; lastUsedAt?: Date };
        }) => {
          const tid = requireTenantAls();
          if (args.data.lastUsedAt && failLastUsedAtUpdate) {
            throw new Error('Simulated DB transient failure on lastUsedAt');
          }
          let count = 0;
          for (const row of extensionTokens) {
            if (row.tenantId !== tid) continue;
            if (args.where.id && row.id !== args.where.id) continue;
            if (args.where.revokedAt === null && row.revokedAt !== null) continue;
            if (args.data.revokedAt !== undefined) row.revokedAt = args.data.revokedAt;
            if (args.data.lastUsedAt !== undefined) row.lastUsedAt = args.data.lastUsedAt;
            count += 1;
          }
          return { count };
        },
      },
      geoDistributionTask: {
        findMany: async (args: {
          where: {
            tenantId?: string;
            mode?: string;
            provider?: string | { in: string[] };
            brandId?: string;
            status?: string | { in: string[] };
          };
          take?: number;
        }) => {
          const tid = requireTenantAls();
          const list = Array.from(distributionTasks.values())
            .filter((t) => {
              if (t.tenantId !== tid) return false;
              if (args.where.mode && t.mode !== args.where.mode) return false;
              if (typeof args.where.provider === 'string' && t.provider !== args.where.provider) {
                return false;
              }
              if (
                args.where.provider &&
                typeof args.where.provider === 'object' &&
                !args.where.provider.in.includes(t.provider)
              ) {
                return false;
              }
              if (args.where.brandId && t.brandId !== args.where.brandId) return false;
              if (typeof args.where.status === 'string' && t.status !== args.where.status) {
                return false;
              }
              if (
                args.where.status &&
                typeof args.where.status === 'object' &&
                !args.where.status.in.includes(t.status)
              ) {
                return false;
              }
              return true;
            })
            .sort(
              (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id),
            );

          return list.slice(0, args.take ?? list.length).map((t) => ({
            ...t,
            brand: brands.get(t.brandId)!,
            brandMarket: brandMarkets.find((bm) => bm.id === t.brandMarketId)!,
          }));
        },
        findFirst: async (args: { where: { id?: string; tenantId?: string } }) => {
          const tid = requireTenantAls();
          const t = args.where.id ? distributionTasks.get(args.where.id) : undefined;
          if (!t || t.tenantId !== tid) return null;
          return { ...t };
        },
        update: async (args: {
          where: { id: string; tenantId?: string; status?: { not?: string } };
          data: Partial<DistributionTaskRow>;
        }) => {
          const tid = requireTenantAls();
          const t = distributionTasks.get(args.where.id);
          if (
            !t ||
            t.tenantId !== tid ||
            (args.where.tenantId && t.tenantId !== args.where.tenantId) ||
            (args.where.status?.not && t.status === args.where.status.not)
          ) {
            throw new Error('P2025');
          }
          Object.assign(t, args.data, { updatedAt: new Date() });
          return { ...t };
        },
        updateMany: async (args: {
          where: { id?: string; tenantId?: string; status?: { not?: string } };
          data: Partial<DistributionTaskRow>;
        }) => {
          const tid = requireTenantAls();
          let count = 0;
          for (const t of distributionTasks.values()) {
            if (t.tenantId !== tid) continue;
            if (args.where.tenantId && t.tenantId !== args.where.tenantId) continue;
            if (args.where.id && t.id !== args.where.id) continue;
            if (args.where.status?.not && t.status === args.where.status.not) continue;
            Object.assign(t, args.data, { updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      },
      geoArticle: {
        findFirst: async (args: { where: { id: string } }) => {
          const tid = requireTenantAls();
          const art = geoArticles.get(args.where.id);
          if (!art || art.tenantId !== tid) return null;
          return {
            ...art,
            brandMarket: brandMarkets.find((bm) => bm.id === art.brandMarketId)!,
          };
        },
        update: async (args: { where: { id: string }; data: { status: string } }) => {
          const tid = requireTenantAls();
          const art = geoArticles.get(args.where.id);
          if (!art || art.tenantId !== tid) throw new Error('P2025');
          art.status = args.data.status;
          return { ...art };
        },
      },
      visibilityRun: {
        findFirst: async () => null,
      },
      geoPublishRecord: {
        findFirst: async (args: {
          where: {
            id?: string;
            tenantId?: string;
            OR?: Array<{
              distributionTaskId?: string | null;
              articleId?: string;
              publishedUrl?: string;
            }>;
          };
        }) => {
          const tid = requireTenantAls();
          const found = publishRecords.find((r) => {
            if (r.tenantId !== tid) return false;
            if (args.where.id && r.id !== args.where.id) return false;
            if (args.where.tenantId && r.tenantId !== args.where.tenantId) return false;
            if (args.where.OR) {
              return args.where.OR.some((clause) => {
                if (
                  clause.distributionTaskId !== undefined &&
                  r.distributionTaskId !== clause.distributionTaskId
                ) {
                  return false;
                }
                if (clause.articleId && r.articleId !== clause.articleId) {
                  return false;
                }
                if (clause.publishedUrl && r.publishedUrl !== clause.publishedUrl) {
                  return false;
                }
                return true;
              });
            }
            return true;
          });
          if (!found) return null;
          return {
            ...found,
            retestSchedules: retestSchedules.filter((s) => s.publishRecordId === found.id),
          };
        },
        create: async (args: { data: Record<string, unknown> }) => {
          const tid = requireTenantAls();
          const now = new Date();
          const created: PublishRecordRow = {
            id: `pr_${seq++}`,
            tenantId: tid,
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            articleId: String(args.data.articleId),
            publishedUrl: String(args.data.publishedUrl),
            channel: String(args.data.channel),
            publishedAt: (args.data.publishedAt as Date) ?? now,
            baselineRunId: (args.data.baselineRunId as string | null) ?? null,
            latestRetestRunId: null,
            beforeMetrics: null,
            afterMetrics: null,
            distributionTaskId: (args.data.distributionTaskId as string | null) ?? null,
            crawlStatus: 'PENDING',
            crawlCheckedAt: null,
            crawlReportJson: null,
            indexNowSubmitted: Boolean(args.data.indexNowSubmitted),
            createdAt: now,
          };
          publishRecords.push(created);
          return { ...created };
        },
        update: async (args: { where: { id: string }; data: Partial<PublishRecordRow> }) => {
          const tid = requireTenantAls();
          const found = publishRecords.find((r) => r.id === args.where.id && r.tenantId === tid);
          if (!found) throw new Error('P2025');
          Object.assign(found, args.data);
          return {
            ...found,
            retestSchedules: retestSchedules.filter((s) => s.publishRecordId === found.id),
          };
        },
        updateMany: async (args: {
          where: { id?: string; tenantId?: string; distributionTaskId?: string | null };
          data: Partial<PublishRecordRow>;
        }) => {
          const tid = requireTenantAls();
          let count = 0;
          for (const row of publishRecords) {
            if (row.tenantId !== tid) continue;
            if (args.where.tenantId && row.tenantId !== args.where.tenantId) continue;
            if (args.where.id && row.id !== args.where.id) continue;
            if (
              args.where.distributionTaskId !== undefined &&
              row.distributionTaskId !== args.where.distributionTaskId
            ) {
              continue;
            }
            Object.assign(row, args.data);
            count += 1;
          }
          return { count };
        },
        deleteMany: async (args: { where: { id?: string; tenantId?: string } }) => {
          const tid = requireTenantAls();
          const before = publishRecords.length;
          for (let i = publishRecords.length - 1; i >= 0; i -= 1) {
            const row = publishRecords[i]!;
            if (row.tenantId !== tid) continue;
            if (args.where.tenantId && row.tenantId !== args.where.tenantId) continue;
            if (args.where.id && row.id !== args.where.id) continue;
            publishRecords.splice(i, 1);
          }
          return { count: before - publishRecords.length };
        },
      },
      geoRetestSchedule: {
        createMany: async (args: {
          data: Array<{
            tenantId: string;
            brandId: string;
            brandMarketId: string;
            publishRecordId: string;
            milestoneDay: number;
            sampleCount: number;
            includeControlPrompts: boolean;
            dueAt: Date;
            status: string;
          }>;
          skipDuplicates?: boolean;
        }) => {
          const tid = requireTenantAls();
          let count = 0;
          const now = new Date();
          for (const item of args.data) {
            const exists = retestSchedules.some(
              (s) =>
                s.publishRecordId === item.publishRecordId && s.milestoneDay === item.milestoneDay,
            );
            if (exists && args.skipDuplicates) continue;
            retestSchedules.push({
              id: `rs_${seq++}`,
              tenantId: tid,
              brandId: item.brandId,
              brandMarketId: item.brandMarketId,
              publishRecordId: item.publishRecordId,
              milestoneDay: item.milestoneDay,
              sampleCount: item.sampleCount,
              includeControlPrompts: item.includeControlPrompts,
              dueAt: item.dueAt,
              status: item.status,
              visibilityRunId: null,
              lastError: null,
              triggeredAt: null,
              completedAt: null,
              createdAt: now,
              updatedAt: now,
            });
            count += 1;
          }
          return { count };
        },
        findMany: async (args: { where: { publishRecordId: string } }) => {
          const tid = requireTenantAls();
          return retestSchedules
            .filter((s) => s.tenantId === tid && s.publishRecordId === args.where.publishRecordId)
            .sort((a, b) => a.milestoneDay - b.milestoneDay);
        },
        deleteMany: async (args: { where: { publishRecordId?: string; tenantId?: string } }) => {
          const tid = requireTenantAls();
          const before = retestSchedules.length;
          for (let i = retestSchedules.length - 1; i >= 0; i -= 1) {
            const row = retestSchedules[i]!;
            if (row.tenantId !== tid) continue;
            if (args.where.tenantId && row.tenantId !== args.where.tenantId) continue;
            if (args.where.publishRecordId && row.publishRecordId !== args.where.publishRecordId) {
              continue;
            }
            retestSchedules.splice(i, 1);
          }
          return { count: before - retestSchedules.length };
        },
      },
    };

    prismaSvc.base = base;
    prismaSvc.scoped = scoped;

    // Selective DNS-bypass ONLY for synthetic public test hostnames;
    // all SSRF / private / loopback / metadata / invalid URLs run through real OutboundHttpClient!
    const outbound = app.get(OutboundHttpClient);
    const origAssert = outbound.assertAllowedUrl.bind(outbound);
    vi.spyOn(outbound, 'assertAllowedUrl').mockImplementation(async (rawUrl, opts) => {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return origAssert(rawUrl, opts);
      }
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        !parsed.username &&
        !parsed.password &&
        ['zhuanlan.zhihu.com', 'www.toutiao.com', 'post.smzdm.com'].includes(parsed.hostname)
      ) {
        return parsed;
      }
      return origAssert(rawUrl, opts);
    });

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (savedEnv.WEB_ORIGIN === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = savedEnv.WEB_ORIGIN;
    if (savedEnv.SHOPIFY_OAUTH_CLIENT_ID === undefined) {
      delete process.env.SHOPIFY_OAUTH_CLIENT_ID;
    } else {
      process.env.SHOPIFY_OAUTH_CLIENT_ID = savedEnv.SHOPIFY_OAUTH_CLIENT_ID;
    }
    if (savedEnv.SHOPIFY_OAUTH_CLIENT_SECRET === undefined) {
      delete process.env.SHOPIFY_OAUTH_CLIENT_SECRET;
    } else {
      process.env.SHOPIFY_OAUTH_CLIENT_SECRET = savedEnv.SHOPIFY_OAUTH_CLIENT_SECRET;
    }
    if (savedEnv.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX === undefined) {
      delete process.env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX;
    } else {
      process.env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX =
        savedEnv.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX;
    }
    if (savedEnv.EXTENSION_SYNC_RATE_LIMIT_MAX === undefined) {
      delete process.env.EXTENSION_SYNC_RATE_LIMIT_MAX;
    } else {
      process.env.EXTENSION_SYNC_RATE_LIMIT_MAX = savedEnv.EXTENSION_SYNC_RATE_LIMIT_MAX;
    }
    await app.close();
  });

  beforeEach(() => {
    delete process.env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX;
    delete process.env.EXTENSION_SYNC_RATE_LIMIT_MAX;
    rateLimiter.reset();
    seedState();
  });

  describe('Suite 1: Console Token CRUD Lifecycle', () => {
    it('creates gmext_ token shown once, stores only SHA-256 hash, lists masked tokens without leakage, and revokes idempotently', async () => {
      const createRes = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwtTenantA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'MacBook Chrome' }),
      });
      expect(createRes.status).toBe(200);
      const createBody = (await createRes.json()) as {
        code: number;
        data: {
          token: Record<string, unknown>;
          plainToken: string;
        };
      };
      expect(createBody.code).toBe(0);
      const { token, plainToken } = createBody.data;
      expect(plainToken.startsWith(EXTENSION_TOKEN_PREFIX)).toBe(true);
      expect(plainToken.length).toBeGreaterThanOrEqual(48);
      expect(token.label).toBe('MacBook Chrome');
      expect(token.tokenPrefix).toBe(plainToken.slice(0, 12));
      expect(token.scopes).toEqual([...EXTENSION_DEFAULT_SCOPES]);
      expect(token.revokedAt).toBeNull();
      expect(token.lastUsedAt).toBeNull();
      expect('tokenHash' in token).toBe(false);
      expect('plainToken' in token).toBe(false);

      // Default 90-day TTL check
      const ttlDeltaDays =
        (new Date(String(token.expiresAt)).getTime() -
          new Date(String(token.createdAt)).getTime()) /
        86_400_000;
      expect(ttlDeltaDays).toBeGreaterThan(EXTENSION_DEFAULT_TTL_DAYS - 0.01);
      expect(ttlDeltaDays).toBeLessThan(EXTENSION_DEFAULT_TTL_DAYS + 0.01);

      // DB stores SHA-256 hash only
      expect(extensionTokens).toHaveLength(1);
      expect(extensionTokens[0]!.tokenHash).toBe(
        createHash('sha256').update(plainToken, 'utf8').digest('hex'),
      );
      expect(extensionTokens[0]!.tokenHash).not.toBe(plainToken);

      // Seed tenant B token to confirm list isolation
      createExtensionTokenRow('tenant_b', 'user_b', { label: 'Tenant B Browser' });

      const listRes = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        headers: { Authorization: `Bearer ${jwtTenantA}` },
      });
      expect(listRes.status).toBe(200);
      const listText = await listRes.text();
      expect(listText).not.toContain(plainToken);
      expect(listText).not.toContain(extensionTokens[0]!.tokenHash);
      expect(listText).not.toContain('Tenant B Browser');
      const listJson = JSON.parse(listText) as {
        code: number;
        data: { items: Array<Record<string, unknown>> };
      };
      expect(listJson.data.items).toHaveLength(1);
      expect(listJson.data.items[0]!.id).toBe(token.id);

      // Cross-tenant DELETE -> 404, token remains active
      const crossDel = await fetch(`${baseUrl}/api/v2/extension/tokens/${String(token.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtTenantB}` },
      });
      expect(crossDel.status).toBe(404);
      expect(((await crossDel.json()) as { code: number }).code).toBe(AUTH_ERROR.NOT_FOUND);
      expect(extensionTokens[0]!.revokedAt).toBeNull();

      // Token works on /me before revoke
      const meOk = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(meOk.status).toBe(200);

      // Revoke own token -> 200
      const delRes1 = await fetch(`${baseUrl}/api/v2/extension/tokens/${String(token.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtTenantA}` },
      });
      expect(delRes1.status).toBe(200);
      const delBody1 = (await delRes1.json()) as {
        code: number;
        data: { id: string; revoked: boolean; revokedAt: string };
      };
      expect(delBody1.code).toBe(0);
      expect(delBody1.data.revoked).toBe(true);
      expect(delBody1.data.revokedAt).toBeTruthy();

      // Immediate 401 on /me after revoke
      const meRevoked = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(meRevoked.status).toBe(401);
      expect(((await meRevoked.json()) as { code: number }).code).toBe(AUTH_ERROR.UNAUTHORIZED);

      // Idempotent second DELETE preserves original revokedAt
      const delRes2 = await fetch(`${baseUrl}/api/v2/extension/tokens/${String(token.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtTenantA}` },
      });
      expect(delRes2.status).toBe(200);
      const delBody2 = (await delRes2.json()) as { data: { revokedAt: string; revoked: boolean } };
      expect(delBody2.data.revoked).toBe(true);
      expect(delBody2.data.revokedAt).toBe(delBody1.data.revokedAt);

      // Unknown ID -> 404; malformed ID -> 400
      const unknownDel = await fetch(`${baseUrl}/api/v2/extension/tokens/nonexistent_id`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtTenantA}` },
      });
      expect(unknownDel.status).toBe(404);

      const badIdDel = await fetch(`${baseUrl}/api/v2/extension/tokens/bad!id`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtTenantA}` },
      });
      expect(badIdDel.status).toBe(400);
    });

    it('validates createToken inputs and rejects unauthenticated requests', async () => {
      const noAuth = await fetch(`${baseUrl}/api/v2/extension/tokens`);
      expect(noAuth.status).toBe(401);

      const invalidPayloads = [
        { label: '   ' },
        { label: 'a'.repeat(65) },
        { label: 'Valid', ttlDays: 0 },
        { label: 'Valid', ttlDays: 366 },
        { label: 'Valid', ttlDays: 1.5 },
      ];
      for (const payload of invalidPayloads) {
        const res = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwtTenantA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: number }).code).toBe(API_ERROR.BAD_REQUEST);
      }
    });

    it('enforces extension_token_issue rate limit per tenant with 429 and Retry-After', async () => {
      process.env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX = '2';

      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwtTenantA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ label: `Chrome ${i}` }),
        });
        expect(res.status).toBe(200);
      }

      const throttled = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwtTenantA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'Chrome 3' }),
      });
      expect(throttled.status).toBe(429);
      expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(((await throttled.json()) as { code: number }).code).toBe(
        AUTH_ERROR.TOO_MANY_REQUESTS,
      );

      // Tenant B has independent bucket
      const tenantBOk = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwtTenantB}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'Tenant B Chrome' }),
      });
      expect(tenantBOk.status).toBe(200);
    });

    it('enforces TenantActiveGuard on POST and DELETE while allowing expired tenant GET', async () => {
      const { row: expToken } = createExtensionTokenRow('tenant_expired', 'user_exp');

      const getExp = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        headers: { Authorization: `Bearer ${jwtExpiredTenant}` },
      });
      expect(getExp.status).toBe(200);

      const postExp = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwtExpiredTenant}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'Blocked' }),
      });
      expect(postExp.status).toBe(403);
      expect(((await postExp.json()) as { code: number }).code).toBe(API_ERROR.TENANT_EXPIRED);

      const delExp = await fetch(`${baseUrl}/api/v2/extension/tokens/${expToken.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtExpiredTenant}` },
      });
      expect(delExp.status).toBe(403);
      expect(((await delExp.json()) as { code: number }).code).toBe(API_ERROR.TENANT_EXPIRED);

      const postInact = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwtInactiveTenant}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'Blocked Inactive' }),
      });
      expect(postInact.status).toBe(403);
      expect(((await postInact.json()) as { code: number }).code).toBe(API_ERROR.TENANT_EXPIRED);
    });
  });

  describe('Suite 2: ExtensionAuthGuard HTTP Rejection Matrix & lastUsedAt Tolerance', () => {
    it('rejects console JWT, missing/malformed/unknown/expired/missing-scope tokens with 401 and inactive/expired tenants with 403', async () => {
      const { plainToken: expiredToken } = createExtensionTokenRow('tenant_a', 'user_a', {
        expiresAt: new Date(Date.now() - 10_000),
      });
      const { plainToken: noScopeToken } = createExtensionTokenRow('tenant_a', 'user_a', {
        scopes: ['other:scope'],
      });
      const { plainToken: inactiveTenantToken } = createExtensionTokenRow(
        'tenant_inactive',
        'user_inact',
      );
      const { plainToken: expiredTenantToken } = createExtensionTokenRow(
        'tenant_expired',
        'user_exp',
      );

      const cases401: Array<[string, Record<string, string>]> = [
        ['missing header', {}],
        ['console JWT', { Authorization: `Bearer ${jwtTenantA}` }],
        ['wrong prefix', { Authorization: `Bearer gmx_${'a'.repeat(43)}` }],
        ['short gmext', { Authorization: 'Bearer gmext_short' }],
        ['unknown hash', { Authorization: `Bearer gmext_${'z'.repeat(43)}` }],
        ['expired token', { Authorization: `Bearer ${expiredToken}` }],
        ['missing scope', { Authorization: `Bearer ${noScopeToken}` }],
      ];

      for (const [label, headers] of cases401) {
        const res = await fetch(`${baseUrl}/api/v2/extension/me`, { headers });
        expect(res.status, label).toBe(401);
        expect(((await res.json()) as { code: number }).code, label).toBe(AUTH_ERROR.UNAUTHORIZED);
      }

      for (const [label, token] of [
        ['inactive tenant', inactiveTenantToken],
        ['expired tenant', expiredTenantToken],
      ] as const) {
        const res = await fetch(`${baseUrl}/api/v2/extension/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status, label).toBe(403);
        expect(((await res.json()) as { code: number }).code, label).toBe(API_ERROR.TENANT_EXPIRED);
      }
    });

    it('updates lastUsedAt on happy path and tolerates transient DB errors during lastUsedAt update', async () => {
      const { plainToken, row } = createExtensionTokenRow('tenant_a', 'user_a');
      expect(row.lastUsedAt).toBeNull();

      const res1 = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(res1.status).toBe(200);
      expect(row.lastUsedAt).toBeInstanceOf(Date);

      failLastUsedAtUpdate = true;
      const res2 = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(res2.status).toBe(200);
    });
  });

  describe('Suite 3: Cross-Route Privilege Boundary (Real NestJS Controllers)', () => {
    it('rejects valid active gmext_ token with 401 across all non-bridge v1 and v2 routes with zero mutations', async () => {
      const { plainToken, row } = createExtensionTokenRow('tenant_a', 'user_a');

      // Confirm token is genuinely valid on bridge
      const bridgeOk = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(bridgeOk.status).toBe(200);

      const forbiddenTargets: Array<{ method: string; path: string; body?: unknown }> = [
        { method: 'GET', path: '/api/v2/brands' },
        { method: 'DELETE', path: '/api/v2/brands/brand_a_cn' },
        { method: 'GET', path: '/api/v1/billing/wallet' },
        { method: 'GET', path: '/api/v1/billing/ledger' },
        { method: 'GET', path: '/api/v1/billing/quotas' },
        { method: 'GET', path: '/api/v1/admin/tenants' },
        { method: 'GET', path: '/api/v2/brands/brand_a_cn/connections' },
        { method: 'GET', path: '/api/v2/articles/art_a1/distributions' },
        {
          method: 'PATCH',
          path: '/api/v2/distributions/task_l2_zhihu',
          body: { status: 'ARCHIVED' },
        },
        { method: 'GET', path: '/api/v2/extension/tokens' },
        { method: 'POST', path: '/api/v2/extension/tokens', body: { label: 'Escalation' } },
        { method: 'DELETE', path: `/api/v2/extension/tokens/${row.id}` },
        { method: 'GET', path: '/api/v1/account' },
        { method: 'GET', path: '/api/v1/me/points' },
      ];

      for (const target of forbiddenTargets) {
        const res = await fetch(`${baseUrl}${target.path}`, {
          method: target.method,
          headers: {
            Authorization: `Bearer ${plainToken}`,
            ...(target.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(target.body ? { body: JSON.stringify(target.body) } : {}),
        });
        expect(res.status, `${target.method} ${target.path}`).toBe(401);
        expect(
          ((await res.json()) as { code: number }).code,
          `${target.method} ${target.path}`,
        ).toBe(AUTH_ERROR.UNAUTHORIZED);
      }

      // Verify zero mutations occurred
      expect(brands.has('brand_a_cn')).toBe(true);
      expect(distributionTasks.get('task_l2_zhihu')!.status).toBe('READY_TO_PUBLISH');
      expect(row.revokedAt).toBeNull();
    });
  });

  describe('Suite 4: 3 Thin Bridge Endpoints & Real Side Effects', () => {
    it('GET /api/v2/extension/me returns exact 6-key DTO with CN brands only, zero leakage, and enforces extension_sync rate limit', async () => {
      const { plainToken, row } = createExtensionTokenRow('tenant_a', 'user_a', {
        label: 'Office Chrome',
      });

      const res = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(res.status).toBe(200);
      const rawText = await res.text();
      const body = JSON.parse(rawText) as { code: number; data: Record<string, unknown> };
      expect(body.code).toBe(0);
      expect(Object.keys(body.data).sort()).toEqual([
        'brands',
        'bridgeVersion',
        'expiresAt',
        'tokenLabel',
        'tokenPrefix',
        'userDisplayName',
      ]);
      expect(body.data).toMatchObject({
        bridgeVersion: EXTENSION_BRIDGE_VERSION,
        userDisplayName: '林小美',
        tokenLabel: 'Office Chrome',
        tokenPrefix: row.tokenPrefix,
        brands: [
          {
            id: 'brand_a_cn',
            name: 'Aurelia',
            localBrandName: '奥瑞利亚空气净化',
            category: '家用空气净化器',
            market: 'CN',
          },
        ],
      });

      // Strict anti-leakage check
      for (const forbidden of [
        plainToken,
        row.tokenHash,
        'hash_a',
        'GlobalOnly',
        'tenant_b',
        'Boreal',
        'wallet',
        'billing',
        'balance',
        'points',
      ]) {
        expect(rawText).not.toContain(forbidden);
      }

      // Rate limit extension_sync
      rateLimiter.reset();
      process.env.EXTENSION_SYNC_RATE_LIMIT_MAX = '2';
      expect(
        (
          await fetch(`${baseUrl}/api/v2/extension/me`, {
            headers: { Authorization: `Bearer ${plainToken}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${baseUrl}/api/v2/extension/me`, {
            headers: { Authorization: `Bearer ${plainToken}` },
          })
        ).status,
      ).toBe(200);
      const limited = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(((await limited.json()) as { code: number }).code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    });

    it('GET /api/v2/extension/me masks username when nickname is null and lists a dual-market brand once as CN', async () => {
      // Clear nickname on user_a and add a GLOBAL market to brand_a_cn
      users.get('user_a')!.nickname = null;
      brandMarkets.push({
        id: 'bm_a_cn_global',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        market: 'GLOBAL',
        localBrandName: 'Aurelia Global',
        localCategory: 'Air Purifiers',
        ownedDomains: ['aurelia.example'],
        createdAt: new Date(),
      });

      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');
      const res = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(res.status).toBe(200);
      const rawText = await res.text();
      expect(rawText).not.toContain('"alice"');
      expect(rawText).not.toContain('Aurelia Global');

      const body = JSON.parse(rawText) as {
        code: number;
        data: {
          userDisplayName: string;
          brands: Array<{ id: string; market: string }>;
        };
      };
      expect(body.data.userDisplayName).toBe('al***e');
      expect(body.data.brands).toHaveLength(1);
      expect(body.data.brands[0]).toMatchObject({ id: 'brand_a_cn', market: 'CN' });
    });

    it('GET /api/v2/extension/tasks filters strictly to tenant L2 tasks, signs brand media URLs, and validates query params', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');

      // Default pending queue: excludes L1, L3, ARCHIVED, PUBLISHED, and tenant B
      const res = await fetch(`${baseUrl}/api/v2/extension/tasks`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        code: number;
        data: {
          bridgeVersion: string;
          items: Array<{
            taskId: string;
            provider: string;
            brandName: string;
            mediaAssets: Array<{ id: string; url: string; title: string }>;
            antiBanChecklist: string[];
          }>;
        };
      };
      expect(body.code).toBe(0);
      expect(body.data.bridgeVersion).toBe('v1');
      expect(body.data.items.map((i) => i.taskId)).toEqual(['task_l2_zhihu', 'task_l2_toutiao']);

      // Custom antiBanChecklist on zhihu + default fallback on toutiao
      expect(body.data.items[0]!.antiBanChecklist).toEqual([
        '人工复核后再发布',
        '如实标注实测样本来源',
      ]);
      expect(body.data.items[1]!.antiBanChecklist.length).toBeGreaterThanOrEqual(3);
      expect(body.data.items[0]!.brandName).toBe('奥瑞利亚空气净化');

      // Signed brand media URL verifiable by real BrandMediaService
      expect(body.data.items[0]!.mediaAssets).toHaveLength(1);
      const signedUrl = new URL(body.data.items[0]!.mediaAssets[0]!.url, 'http://localhost');
      expect(
        brandMediaSvc.verifyMediaVariant(
          signedUrl.searchParams.get('tid') ?? '',
          'brand_a_cn',
          'media_a1',
          'file',
          signedUrl.searchParams.get('sig'),
          signedUrl.searchParams.get('exp'),
        ),
      ).toBe(true);

      // Query filters: provider, status=PUBLISHED, brandId, limit
      const byProvider = await fetch(`${baseUrl}/api/v2/extension/tasks?provider=TOUTIAO_EXT`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(
        (
          (await byProvider.json()) as { data: { items: Array<{ taskId: string }> } }
        ).data.items.map((i) => i.taskId),
      ).toEqual(['task_l2_toutiao']);

      const byPublished = await fetch(`${baseUrl}/api/v2/extension/tasks?status=PUBLISHED`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(
        (
          (await byPublished.json()) as { data: { items: Array<{ taskId: string }> } }
        ).data.items.map((i) => i.taskId),
      ).toEqual(['task_l2_smzdm_pub']);

      const byMultiStatus = await fetch(
        `${baseUrl}/api/v2/extension/tasks?status=DRAFT_VARIANT,READY_TO_PUBLISH`,
        {
          headers: { Authorization: `Bearer ${plainToken}` },
        },
      );
      expect(byMultiStatus.status).toBe(200);
      expect(
        (
          (await byMultiStatus.json()) as { data: { items: Array<{ taskId: string }> } }
        ).data.items.map((i) => i.taskId),
      ).toEqual(['task_l2_zhihu', 'task_l2_toutiao']);

      const byLimit = await fetch(`${baseUrl}/api/v2/extension/tasks?limit=1`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(((await byLimit.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(1);

      // Cross-tenant brandId returns empty
      const otherBrand = await fetch(`${baseUrl}/api/v2/extension/tasks?brandId=brand_b_cn`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(((await otherBrand.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);

      // Invalid query params -> 400
      const invalidQueries = [
        'provider=SHOPIFY',
        'provider=REDDIT',
        'status=ARCHIVED',
        'status=DRAFT_VARIANT,ARCHIVED',
        'status=FAILED',
        'limit=0',
        'limit=51',
        'limit=abc',
        'provider=ZHIHU_EXT&provider=TOUTIAO_EXT',
      ];
      for (const qs of invalidQueries) {
        const badRes = await fetch(`${baseUrl}/api/v2/extension/tasks?${qs}`, {
          headers: { Authorization: `Bearer ${plainToken}` },
        });
        expect(badRes.status, qs).toBe(400);
        expect(((await badRes.json()) as { code: number }).code, qs).toBe(API_ERROR.BAD_REQUEST);
      }
    });

    it('GET /api/v2/extension/tasks signs query-bearing internal URLs cleanly, leaves external URLs unsigned, and handles malformed variantExtrasJson', async () => {
      brandMediaAssets.push(
        {
          id: 'media_qs',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          title: '带版本参数内链图',
          url: '/api/v2/brands/brand_a_cn/media/media_qs/file?v=1',
          mime: 'image/png',
          createdAt: new Date(),
        },
        {
          id: 'media_ext_1',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          title: '外部 CDN 图片',
          url: 'https://cdn.example.com/hero.png',
          mime: 'image/png',
          createdAt: new Date(),
        },
        {
          id: 'media_ext_2',
          tenantId: 'tenant_a',
          brandId: 'brand_a_cn',
          title: '带参数外部 CDN 图片',
          url: 'https://cdn.example.com/hero2.png?v=1',
          mime: 'image/png',
          createdAt: new Date(),
        },
      );

      // Non-object / array variantExtrasJson on task_l2_toutiao -> falls back to default CN L2 checklist
      distributionTasks.get('task_l2_toutiao')!.variantExtrasJson = ['not-an-object'];

      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');
      const res = await fetch(`${baseUrl}/api/v2/extension/tasks`, {
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          items: Array<{
            taskId: string;
            mediaAssets: Array<{ id: string; url: string }>;
            antiBanChecklist: string[];
          }>;
        };
      };

      const zhihuTask = body.data.items.find((i) => i.taskId === 'task_l2_zhihu')!;
      const toutiaoTask = body.data.items.find((i) => i.taskId === 'task_l2_toutiao')!;
      expect(toutiaoTask.antiBanChecklist.length).toBeGreaterThanOrEqual(3);

      const mediaQs = zhihuTask.mediaAssets.find((m) => m.id === 'media_qs')!;
      expect(mediaQs.url).toContain('/api/v2/brands/brand_a_cn/media/media_qs/file?v=1&tid=');
      expect(mediaQs.url.split('?')).toHaveLength(2);
      const parsedQs = new URL(mediaQs.url, 'http://localhost');
      expect(parsedQs.searchParams.get('v')).toBe('1');
      expect(
        brandMediaSvc.verifyMediaVariant(
          parsedQs.searchParams.get('tid') ?? '',
          'brand_a_cn',
          'media_qs',
          'file',
          parsedQs.searchParams.get('sig'),
          parsedQs.searchParams.get('exp'),
        ),
      ).toBe(true);

      // Verify the signed ?v=1&tid=...&exp=...&sig=... URL succeeds against real BrandMediaPublicController
      const readSpy = vi.spyOn(brandMediaSvc, 'readAssetBytes').mockResolvedValueOnce({
        body: Buffer.from('fake-png-bytes'),
        contentType: 'image/png',
      });
      const mediaFetch = await fetch(`${baseUrl}${mediaQs.url}`);
      expect(mediaFetch.status).toBe(200);
      expect(readSpy).toHaveBeenCalledWith('tenant_a', 'brand_a_cn', 'media_qs', 'file');
      readSpy.mockRestore();

      // External URLs must NEVER leak tid / exp / sig
      const ext1 = zhihuTask.mediaAssets.find((m) => m.id === 'media_ext_1')!;
      const ext2 = zhihuTask.mediaAssets.find((m) => m.id === 'media_ext_2')!;
      expect(ext1.url).toBe('https://cdn.example.com/hero.png');
      expect(ext2.url).toBe('https://cdn.example.com/hero2.png?v=1');
      expect(ext1.url).not.toContain('tid=');
      expect(ext1.url).not.toContain('sig=');
      expect(ext2.url).not.toContain('tid=');
      expect(ext2.url).not.toContain('sig=');
    });

    it('POST confirm-published rejects SSRF/unsafe URLs, cross-tenant, non-L2, and archived tasks', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');

      const unsafeUrls = [
        'http://127.0.0.1/post',
        'http://127.0.0.1:3001/api/v1/health',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost/admin',
        'http://10.0.0.1/internal',
        'http://172.16.0.1/internal',
        'http://192.168.1.1/router',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'https://user:pass@zhuanlan.zhihu.com/p/123',
        'ftp://zhuanlan.zhihu.com/p/123',
        '   ',
        `https://zhuanlan.zhihu.com/p/${'a'.repeat(2040)}`,
      ];

      for (const publishedUrl of unsafeUrls) {
        const res = await fetch(
          `${baseUrl}/api/v2/extension/tasks/task_l2_zhihu/confirm-published`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${plainToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publishedUrl }),
          },
        );
        expect(res.status, publishedUrl).toBe(400);
        expect(((await res.json()) as { code: number }).code, publishedUrl).toBe(
          API_ERROR.BAD_REQUEST,
        );
      }
      expect(publishRecords).toHaveLength(0);
      expect(distributionTasks.get('task_l2_zhihu')!.status).toBe('READY_TO_PUBLISH');

      // Unknown & cross-tenant -> 404
      for (const id of ['nonexistent_task', 'task_b_zhihu']) {
        const res = await fetch(`${baseUrl}/api/v2/extension/tasks/${id}/confirm-published`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: 'https://zhuanlan.zhihu.com/p/999' }),
        });
        expect(res.status, id).toBe(404);
      }

      // L1, L3, and ARCHIVED tasks -> 400
      for (const id of ['task_l1_shopify', 'task_l3_reddit', 'task_l2_archived']) {
        const res = await fetch(`${baseUrl}/api/v2/extension/tasks/${id}/confirm-published`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: 'https://zhuanlan.zhihu.com/p/888' }),
        });
        expect(res.status, id).toBe(400);
        expect(((await res.json()) as { code: number }).code, id).toBe(API_ERROR.BAD_REQUEST);
      }
      expect(publishRecords).toHaveLength(0);
    });

    it('POST confirm-published executes real GeoDeliveryService + RetestSchedulerService + T+1 CrawlProbe sweep + sequential & concurrent idempotency', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');
      const zhihuUrl = 'https://zhuanlan.zhihu.com/p/778899';

      // 1. First confirm
      const res1 = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_zhihu/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: zhihuUrl, note: '人工核对发布完成' }),
        },
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        code: number;
        data: {
          accepted: boolean;
          taskId: string;
          publishRecordId: string;
          publishedUrl: string;
          status: string;
          alreadyRecorded: boolean;
          retestScheduledCount: number;
        };
      };
      expect(body1.code).toBe(0);
      expect(body1.data).toMatchObject({
        accepted: true,
        taskId: 'task_l2_zhihu',
        publishedUrl: zhihuUrl,
        status: 'PUBLISHED',
        alreadyRecorded: false,
        retestScheduledCount: 3,
      });

      // Verify real DB side effects
      expect(publishRecords).toHaveLength(1);
      expect(publishRecords[0]).toMatchObject({
        id: body1.data.publishRecordId,
        tenantId: 'tenant_a',
        distributionTaskId: 'task_l2_zhihu',
        publishedUrl: zhihuUrl,
        crawlStatus: 'PENDING',
      });
      expect(geoArticles.get('art_a1')!.status).toBe('PUBLISHED');
      expect(retestSchedules.map((s) => s.milestoneDay)).toEqual([7, 14, 30]);
      expect(retestSchedules.every((s) => s.status === 'PENDING')).toBe(true);

      const updatedTask = distributionTasks.get('task_l2_zhihu')!;
      expect(updatedTask.status).toBe('PUBLISHED');
      expect(updatedTask.remotePublishedUrl).toBe(zhihuUrl);
      expect(updatedTask.lastError).toBeNull();
      expect(updatedTask.variantExtrasJson).toMatchObject({
        antiBanChecklist: ['人工复核后再发布', '如实标注实测样本来源'],
        extensionConfirmNote: '人工核对发布完成',
      });

      // 2. Real T+1 CrawlProbeService.runSweep picks up the newly created PENDING record
      const probeSpy = vi.spyOn(crawlProbeSvc, 'probePublishRecord').mockResolvedValueOnce({
        id: publishRecords[0]!.id,
      } as never);
      const sweep = await crawlProbeSvc.runSweep({
        now: new Date(Date.now() + 25 * 3_600_000),
      });
      expect(sweep).toEqual({ scanned: 1, probed: 1, failed: 0 });
      expect(probeSpy).toHaveBeenCalledWith(
        publishRecords[0]!.id,
        expect.objectContaining({ tenantId: 'tenant_a' }),
      );
      probeSpy.mockRestore();

      // 3. Sequential idempotent retry with same URL
      const res2 = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_zhihu/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: zhihuUrl }),
        },
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        data: { publishRecordId: string; alreadyRecorded: boolean; retestScheduledCount: number };
      };
      expect(body2.data.publishRecordId).toBe(body1.data.publishRecordId);
      expect(body2.data.alreadyRecorded).toBe(true);
      expect(body2.data.retestScheduledCount).toBe(3);
      expect(publishRecords).toHaveLength(1);
      expect(retestSchedules).toHaveLength(3);

      // 4. Conflicting different URL on already-PUBLISHED task -> 409 CONFLICT
      const conflictRes = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_zhihu/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: 'https://zhuanlan.zhihu.com/p/different' }),
        },
      );
      expect(conflictRes.status).toBe(409);
      expect(((await conflictRes.json()) as { code: number }).code).toBe(BILLING_ERROR.CONFLICT);

      // 5. Concurrent duplicate confirms on fresh TOUTIAO_EXT task -> single publishRecord + 3 retests
      const toutiaoUrl = 'https://www.toutiao.com/article/7456123456/';
      const [c1, c2] = await Promise.all([
        fetch(`${baseUrl}/api/v2/extension/tasks/task_l2_toutiao/confirm-published`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: toutiaoUrl }),
        }),
        fetch(`${baseUrl}/api/v2/extension/tasks/task_l2_toutiao/confirm-published`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: toutiaoUrl }),
        }),
      ]);
      expect(c1.status).toBe(200);
      expect(c2.status).toBe(200);
      const b1 = (await c1.json()) as {
        data: { publishRecordId: string; alreadyRecorded: boolean; retestScheduledCount: number };
      };
      const b2 = (await c2.json()) as {
        data: { publishRecordId: string; alreadyRecorded: boolean; retestScheduledCount: number };
      };
      expect(b1.data.publishRecordId).toBe(b2.data.publishRecordId);
      expect([b1.data.alreadyRecorded, b2.data.alreadyRecorded].sort()).toEqual([false, true]);
      expect(b1.data.retestScheduledCount).toBe(3);
      expect(b2.data.retestScheduledCount).toBe(3);

      const toutiaoRecords = publishRecords.filter(
        (r) => r.distributionTaskId === 'task_l2_toutiao',
      );
      expect(toutiaoRecords).toHaveLength(1);
      const toutiaoRetests = retestSchedules.filter(
        (s) => s.publishRecordId === toutiaoRecords[0]!.id,
      );
      expect(toutiaoRetests.map((s) => s.milestoneDay)).toEqual([7, 14, 30]);
    });

    it('POST confirm-published enforces multi-channel 409 conflict isolation and adopts unlinked manual GeoPublishRecord', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');
      const now = new Date();

      // Seed a third unpublished L2 task sharing article art_a1
      distributionTasks.set('task_l2_art1_unpub', {
        id: 'task_l2_art1_unpub',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_a1',
        provider: 'TOUTIAO_EXT',
        mode: 'L2_EXTENSION',
        channelLabel: '头条号（同文多渠道）',
        targetUrlHint: 'https://mp.toutiao.com/profile_v4/graphic/publish',
        variantTitle: '同文头条变体',
        variantMarkdown: '正文',
        variantHtml: '<p>正文</p>',
        variantExtrasJson: { antiBanChecklist: ['人工复核'] },
        status: 'READY_TO_PUBLISH',
        remotePublishedUrl: null,
        publishedAt: null,
        lastError: null,
        updatedAt: now,
      });

      // Seed an existing publish record owned by sibling task_l2_smzdm_pub (art_a1)
      const smzdmUrl = 'https://post.smzdm.com/p/already-1';
      publishRecords.push({
        id: 'pr_smzdm_owned',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_a1',
        publishedUrl: smzdmUrl,
        channel: '什么值得买（Chrome 扩展）',
        publishedAt: new Date(now.getTime() - 10_000),
        baselineRunId: null,
        latestRetestRunId: null,
        beforeMetrics: null,
        afterMetrics: null,
        distributionTaskId: 'task_l2_smzdm_pub',
        crawlStatus: 'PENDING',
        crawlCheckedAt: null,
        crawlReportJson: null,
        indexNowSubmitted: false,
        createdAt: now,
      });

      // Confirm task_l2_zhihu first with its own URL
      const zhihuUrl = 'https://zhuanlan.zhihu.com/p/multi-1';
      const firstConfirm = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_zhihu/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: zhihuUrl }),
        },
      );
      expect(firstConfirm.status).toBe(200);

      // Case A: Already-PUBLISHED task_l2_zhihu receiving sibling task_l2_smzdm_pub's URL -> 409 CONFLICT
      const conflictPublished = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_zhihu/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: smzdmUrl }),
        },
      );
      expect(conflictPublished.status).toBe(409);
      expect(((await conflictPublished.json()) as { code: number }).code).toBe(
        BILLING_ERROR.CONFLICT,
      );
      expect(distributionTasks.get('task_l2_zhihu')!.remotePublishedUrl).toBe(zhihuUrl);

      // Case B: Unpublished sibling task receiving task_l2_zhihu's already-bound URL -> 409 CONFLICT
      const conflictHijack = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_art1_unpub/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: zhihuUrl }),
        },
      );
      expect(conflictHijack.status).toBe(409);
      expect(((await conflictHijack.json()) as { code: number }).code).toBe(BILLING_ERROR.CONFLICT);
      expect(distributionTasks.get('task_l2_art1_unpub')!.status).toBe('READY_TO_PUBLISH');
      expect(distributionTasks.get('task_l2_art1_unpub')!.remotePublishedUrl).toBeNull();

      // Case C: Unpublished task confirming a URL with an existing manual unlinked GeoPublishRecord (distributionTaskId === null)
      const manualUrl = 'https://www.toutiao.com/article/manual-unlinked/';
      publishRecords.push({
        id: 'pr_manual_unlinked',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_a1',
        publishedUrl: manualUrl,
        channel: '头条号',
        publishedAt: new Date(now.getTime() - 5000),
        baselineRunId: null,
        latestRetestRunId: null,
        beforeMetrics: null,
        afterMetrics: null,
        distributionTaskId: null,
        crawlStatus: 'PENDING',
        crawlCheckedAt: null,
        crawlReportJson: null,
        indexNowSubmitted: false,
        createdAt: now,
      });
      retestSchedules.push({
        id: 'rs_manual_7',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        publishRecordId: 'pr_manual_unlinked',
        milestoneDay: 7,
        sampleCount: 1,
        includeControlPrompts: false,
        dueAt: new Date(now.getTime() + 7 * 86_400_000),
        status: 'PENDING',
        visibilityRunId: null,
        lastError: null,
        triggeredAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const adoptRes = await fetch(
        `${baseUrl}/api/v2/extension/tasks/task_l2_art1_unpub/confirm-published`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publishedUrl: manualUrl, note: '关联已有手动发布记录' }),
        },
      );
      expect(adoptRes.status).toBe(200);
      const adoptBody = (await adoptRes.json()) as {
        code: number;
        data: {
          accepted: boolean;
          taskId: string;
          publishRecordId: string;
          publishedUrl: string;
          status: string;
          alreadyRecorded: boolean;
          retestScheduledCount: number;
        };
      };
      expect(adoptBody.code).toBe(0);
      expect(adoptBody.data).toEqual({
        accepted: true,
        taskId: 'task_l2_art1_unpub',
        publishRecordId: 'pr_manual_unlinked',
        publishedUrl: manualUrl,
        status: 'PUBLISHED',
        alreadyRecorded: true,
        retestScheduledCount: 1,
      });

      const adoptedRecord = publishRecords.find((r) => r.id === 'pr_manual_unlinked')!;
      expect(adoptedRecord.distributionTaskId).toBe('task_l2_art1_unpub');
      const adoptedTask = distributionTasks.get('task_l2_art1_unpub')!;
      expect(adoptedTask.status).toBe('PUBLISHED');
      expect(adoptedTask.remotePublishedUrl).toBe(manualUrl);
      expect(adoptedTask.variantExtrasJson).toMatchObject({
        antiBanChecklist: ['人工复核'],
        extensionConfirmNote: '关联已有手动发布记录',
      });
    });

    it('Tier 5 regression: serializes concurrent confirm-published across different L2 tasks on same articleId+URL (1 record + 1 409) and cleans up orphans on concurrent ARCHIVED transition', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');
      const now = new Date();

      // Seed two unpublished L2 tasks sharing article art_a1
      distributionTasks.set('task_l2_race_a', {
        id: 'task_l2_race_a',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_a1',
        provider: 'ZHIHU_EXT',
        mode: 'L2_EXTENSION',
        channelLabel: '知乎专栏',
        status: 'READY_TO_PUBLISH',
        variantTitle: '竞态测试 A',
        variantMarkdown: '# A',
        variantHtml: '<h1>A</h1>',
        targetUrlHint: 'https://zhuanlan.zhihu.com/write',
        variantExtrasJson: null,
        remotePublishedUrl: null,
        publishedAt: null,
        lastError: null,
        updatedAt: now,
      });
      distributionTasks.set('task_l2_race_b', {
        id: 'task_l2_race_b',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_a1',
        provider: 'TOUTIAO_EXT',
        mode: 'L2_EXTENSION',
        channelLabel: '头条号',
        status: 'READY_TO_PUBLISH',
        variantTitle: '竞态测试 B',
        variantMarkdown: '# B',
        variantHtml: '<h1>B</h1>',
        targetUrlHint: 'https://mp.toutiao.com/profile_v4/graphic/publish',
        variantExtrasJson: null,
        remotePublishedUrl: null,
        publishedAt: null,
        lastError: null,
        updatedAt: now,
      });

      const prismaSvc = app.get(PrismaService) as unknown as {
        scoped: {
          geoPublishRecord: {
            findFirst: (...args: unknown[]) => Promise<unknown>;
            create: (...args: unknown[]) => Promise<unknown>;
          };
        };
      };

      // Inject 25ms DB latency on geoPublishRecord.findFirst to maximize overlap between task A & B
      const origFindFirst = prismaSvc.scoped.geoPublishRecord.findFirst;
      prismaSvc.scoped.geoPublishRecord.findFirst = async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, 25));
        return origFindFirst(...args);
      };

      const sharedUrl = 'https://zhuanlan.zhihu.com/p/concurrent-race-999';
      let rA!: Response;
      let rB!: Response;
      try {
        [rA, rB] = await Promise.all([
          fetch(`${baseUrl}/api/v2/extension/tasks/task_l2_race_a/confirm-published`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${plainToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publishedUrl: sharedUrl }),
          }),
          fetch(`${baseUrl}/api/v2/extension/tasks/task_l2_race_b/confirm-published`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${plainToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publishedUrl: sharedUrl }),
          }),
        ]);
      } finally {
        prismaSvc.scoped.geoPublishRecord.findFirst = origFindFirst;
      }

      const statuses = [rA.status, rB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const matchingRecords = publishRecords.filter((r) => r.publishedUrl === sharedUrl);
      expect(matchingRecords).toHaveLength(1);
      const matchingRetests = retestSchedules.filter(
        (s) => s.publishRecordId === matchingRecords[0]!.id,
      );
      expect(matchingRetests).toHaveLength(3);

      // Part 2: Concurrent ARCHIVED transition mid-flight inside createPublishRecord -> 409 & ZERO orphaned records
      distributionTasks.set('task_l2_archive_race', {
        id: 'task_l2_archive_race',
        tenantId: 'tenant_a',
        brandId: 'brand_a_cn',
        brandMarketId: 'bm_a_cn',
        articleId: 'art_a1',
        provider: 'SMZDM_EXT',
        mode: 'L2_EXTENSION',
        channelLabel: '什么值得买',
        status: 'READY_TO_PUBLISH',
        variantTitle: '归档竞态测试',
        variantMarkdown: '# Archive Race',
        variantHtml: '<h1>Archive Race</h1>',
        targetUrlHint: 'https://post.smzdm.com/tougao/',
        variantExtrasJson: null,
        remotePublishedUrl: null,
        publishedAt: null,
        lastError: null,
        updatedAt: now,
      });

      const origCreate = prismaSvc.scoped.geoPublishRecord.create;
      prismaSvc.scoped.geoPublishRecord.create = async (...args: unknown[]) => {
        const created = await origCreate(...args);
        // Simulate concurrent archive occurring after GeoPublishRecord insert, before task update
        distributionTasks.get('task_l2_archive_race')!.status = 'ARCHIVED';
        return created;
      };

      const archiveRaceUrl = 'https://post.smzdm.com/p/archive-race-777/';
      let archiveRes!: Response;
      try {
        archiveRes = await fetch(
          `${baseUrl}/api/v2/extension/tasks/task_l2_archive_race/confirm-published`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${plainToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publishedUrl: archiveRaceUrl }),
          },
        );
      } finally {
        prismaSvc.scoped.geoPublishRecord.create = origCreate;
      }

      expect(archiveRes.status).toBe(409);
      expect(distributionTasks.get('task_l2_archive_race')!.status).toBe('ARCHIVED');
      expect(publishRecords.filter((r) => r.publishedUrl === archiveRaceUrl)).toHaveLength(0);
      expect(
        retestSchedules.filter((s) => !publishRecords.some((r) => r.id === s.publishRecordId)),
      ).toHaveLength(0);
    });
  });

  describe('Suite 5: Controlled chrome-extension:// CORS, Raw TCP Traversal & rawBody Preservation', () => {
    it('allows valid 32-char a-p chrome-extension:// origin on the 3 bridge routes without ACAC', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');

      for (const path of [
        '/api/v2/extension/me',
        '/api/v2/extension/tasks',
        '/api/v2/extension/tasks/task_l2_zhihu/confirm-published',
      ]) {
        const preflight = await fetch(`${baseUrl}${path}`, {
          method: 'OPTIONS',
          headers: {
            Origin: VALID_EXT_ORIGIN,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers':
              'Authorization, Content-Type, Idempotency-Key, X-GeoMix-Extension-Version',
          },
        });
        expect(preflight.status, path).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin'), path).toBe(VALID_EXT_ORIGIN);
        expect(preflight.headers.get('access-control-allow-methods'), path).toBe(
          'GET, POST, OPTIONS',
        );
        expect(preflight.headers.get('access-control-allow-headers'), path).toBe(
          'Authorization, Content-Type, Idempotency-Key, X-GeoMix-Extension-Version',
        );
        expect(preflight.headers.get('access-control-allow-credentials'), path).toBeNull();
        expect(preflight.headers.get('vary')?.toLowerCase()).toContain('origin');
      }

      const getMe = await fetch(`${baseUrl}/api/v2/extension/me`, {
        headers: {
          Origin: VALID_EXT_ORIGIN,
          Authorization: `Bearer ${plainToken}`,
        },
      });
      expect(getMe.status).toBe(200);
      expect(getMe.headers.get('access-control-allow-origin')).toBe(VALID_EXT_ORIGIN);
      expect(getMe.headers.get('access-control-allow-credentials')).toBeNull();
      expect(getMe.headers.get('vary')?.toLowerCase()).toContain('origin');
    });

    it('rejects invalid origins on bridge routes and valid extension origin on non-bridge routes with zero Access-Control-* headers', async () => {
      const badOrigins = [
        'https://evil.example.com',
        'chrome-extension://*',
        'chrome-extension://AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq',
        `${VALID_EXT_ORIGIN}/popup.html`,
        `${VALID_EXT_ORIGIN}:8080`,
        'null',
      ];

      for (const origin of badOrigins) {
        const preflight = await fetch(`${baseUrl}/api/v2/extension/me`, {
          method: 'OPTIONS',
          headers: { Origin: origin },
        });
        expect(preflight.status, origin).toBe(403);
        expect(preflight.headers.get('access-control-allow-origin'), origin).toBeNull();
        expect(preflight.headers.get('access-control-allow-credentials'), origin).toBeNull();
        expect(preflight.headers.get('access-control-allow-methods'), origin).toBeNull();
      }

      const nonBridgeRoutes = [
        '/api/v2/extension/tokens',
        '/api/v2/brands',
        '/api/v1/billing/wallet',
        '/api/v1/admin/tenants',
        '/api/v2/extension/me/extra',
        '/api/v2/extension/tasks/task_l2_zhihu/other',
      ];

      for (const path of nonBridgeRoutes) {
        const opt = await fetch(`${baseUrl}${path}`, {
          method: 'OPTIONS',
          headers: { Origin: VALID_EXT_ORIGIN },
        });
        expect(opt.status, `OPTIONS ${path}`).toBe(403);
        expect(opt.headers.get('access-control-allow-origin'), `OPTIONS ${path}`).toBeNull();
        expect(opt.headers.get('access-control-allow-credentials'), `OPTIONS ${path}`).toBeNull();

        const getRes = await fetch(`${baseUrl}${path}`, {
          method: 'GET',
          headers: { Origin: VALID_EXT_ORIGIN },
        });
        expect(getRes.headers.get('access-control-allow-origin'), `GET ${path}`).toBeNull();
        expect(getRes.headers.get('access-control-allow-credentials'), `GET ${path}`).toBeNull();
      }
    });

    it('blocks unnormalized path traversal bypasses over raw TCP node:http', async () => {
      const traversalCases: Array<[string, string]> = [
        ['OPTIONS', '/api/v2/extension/tasks/../tokens'],
        ['GET', '/api/v2/extension/tasks/%2e%2e/tokens'],
        ['GET', '/api/v2/extension/tasks/..%2ftokens'],
        ['POST', '/api/v2/extension/tasks/foo/../../brands/confirm-published'],
      ];

      for (const [method, path] of traversalCases) {
        const res = await rawHttpRequest(port, method, path, {
          Origin: VALID_EXT_ORIGIN,
        });
        if (method === 'OPTIONS') {
          expect(res.statusCode, `${method} ${path}`).toBe(403);
        }
        expect(res.headers['access-control-allow-origin'], `${method} ${path}`).toBeUndefined();
        expect(
          res.headers['access-control-allow-credentials'],
          `${method} ${path}`,
        ).toBeUndefined();
      }
    });

    it('rejects raw TCP #fragment preflight with 403 and rejects raw TCP double-space / HTAB Bearer headers with 401', async () => {
      const { plainToken } = createExtensionTokenRow('tenant_a', 'user_a');

      const fragRes = await rawTcpHttpRequest(
        port,
        `OPTIONS /api/v2/extension/me#frag HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${VALID_EXT_ORIGIN}\r\nConnection: close\r\n\r\n`,
      );
      expect(fragRes.statusCode).toBe(403);
      for (const headerName of Object.keys(fragRes.headers)) {
        expect(headerName.startsWith('access-control-')).toBe(false);
      }

      // Raw TCP valid OPTIONS 204 omits Content-Length
      const okOptRes = await rawTcpHttpRequest(
        port,
        `OPTIONS /api/v2/extension/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${VALID_EXT_ORIGIN}\r\nConnection: close\r\n\r\n`,
      );
      expect(okOptRes.statusCode).toBe(204);
      expect(okOptRes.headers['access-control-allow-origin']).toBe(VALID_EXT_ORIGIN);
      expect(okOptRes.headers['content-length']).toBeUndefined();

      // Raw TCP double space and HTAB in Authorization header -> 401
      const doubleSpaceRes = await rawTcpHttpRequest(
        port,
        `GET /api/v2/extension/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer  ${plainToken}\r\nConnection: close\r\n\r\n`,
      );
      expect(doubleSpaceRes.statusCode).toBe(401);
      expect((JSON.parse(doubleSpaceRes.body) as { code: number }).code).toBe(
        AUTH_ERROR.UNAUTHORIZED,
      );

      const htabRes = await rawTcpHttpRequest(
        port,
        `GET /api/v2/extension/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer\t${plainToken}\r\nConnection: close\r\n\r\n`,
      );
      expect(htabRes.statusCode).toBe(401);
      expect((JSON.parse(htabRes.body) as { code: number }).code).toBe(AUTH_ERROR.UNAUTHORIZED);
    });

    it('preserves WEB_ORIGIN CORS with credentials and NestJS rawBody: true', async () => {
      const optWeb = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        method: 'OPTIONS',
        headers: {
          Origin: WEB_ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(optWeb.status).toBe(204);
      expect(optWeb.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
      expect(optWeb.headers.get('access-control-allow-credentials')).toBe('true');

      const getWeb = await fetch(`${baseUrl}/api/v2/extension/tokens`, {
        headers: {
          Origin: WEB_ORIGIN,
          Authorization: `Bearer ${jwtTenantA}`,
        },
      });
      expect(getWeb.status).toBe(200);
      expect(getWeb.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
      expect(getWeb.headers.get('access-control-allow-credentials')).toBe('true');

      // rawBody preservation check via real Shopify uninstall webhook route
      const webhookPayload = JSON.stringify({ id: 123, domain: 'demo.myshopify.com' });
      const badHmacRes = await fetch(
        `${baseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Shop-Domain': 'demo.myshopify.com',
            'X-Shopify-Hmac-Sha256': 'invalid-hmac',
          },
          body: webhookPayload,
        },
      );
      expect(badHmacRes.status).toBe(401);

      const validHmac = createHmac('sha256', 'test_shopify_oauth_secret')
        .update(webhookPayload, 'utf8')
        .digest('base64');
      const goodHmacRes = await fetch(
        `${baseUrl}/api/v2/integrations/shopify/webhooks/app-uninstalled`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Shop-Domain': 'demo.myshopify.com',
            'X-Shopify-Hmac-Sha256': validHmac,
          },
          body: webhookPayload,
        },
      );
      expect(goodHmacRes.status).toBe(200);
    });
  });
});
