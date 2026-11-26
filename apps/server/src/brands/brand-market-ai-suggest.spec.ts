import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_MAX_CONTROL_PROMPTS,
  BRAND_SEED_PROMPT_INTENTS,
  parseEnv,
  validateControlPromptsAgainstSeeds,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { PrismaAuthStore } from '../auth/prisma-auth.store';
import { signToken } from '../auth/token';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { PublicFetchService } from '../infra/adapters.module';
import { LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

type StoredMarket = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale: string;
  region: string;
  localBrandName: string;
  localCategory: string | null;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  seedPrompts: string[];
  supportedLocales: string[];
  controlPrompts: string[];
};

type StoredBrand = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  markets: StoredMarket[];
};

type StoredFact = {
  id: string;
  tenantId: string;
  brandId: string;
  slot: string;
  title: string;
  content: string;
  updatedAt: Date;
};

function createSuggestTestStore(getTenantId: () => string | undefined) {
  const brands: StoredBrand[] = [];
  const facts: StoredFact[] = [];
  const auditLogs: Array<{ tenantId?: string; userId?: string; action: string }> = [];

  const brandUpdateSpy = vi.fn();
  const marketUpdateSpy = vi.fn();
  const factUpdateSpy = vi.fn();

  const scoped = {
    brand: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const tid = getTenantId();
        return brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid)) ?? null;
      }),
      update: brandUpdateSpy,
      updateMany: brandUpdateSpy,
    },
    brandMarket: {
      update: marketUpdateSpy,
      updateMany: marketUpdateSpy,
    },
    brandFact: {
      findMany: vi.fn(async (args: { where: { brandId: string } }) => {
        const tid = getTenantId();
        return facts.filter(
          (f) => f.brandId === args.where.brandId && (!tid || f.tenantId === tid),
        );
      }),
      update: factUpdateSpy,
      updateMany: factUpdateSpy,
    },
  };

  const base = {
    auditLog: {
      create: vi.fn(
        async (args: { data: { tenantId?: string; userId?: string; action: string } }) => {
          auditLogs.push(args.data);
          return { id: `audit_${auditLogs.length}`, ...args.data };
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  };

  return {
    brands,
    facts,
    auditLogs,
    brandUpdateSpy,
    marketUpdateSpy,
    factUpdateSpy,
    prisma: {
      scoped,
      base,
      healthCheck: async () => true,
    },
  };
}

describe('POST /api/v2/brands/:id/markets/:market/ai-suggest (#405)', () => {
  const store = createSuggestTestStore(() => currentTenantId());
  const llmCompleteSpy = vi.fn();
  const publicFetchSpy = vi.fn();
  const hasFakeFallbackSpy = vi.fn(() => true);

  const users = new Map([
    [
      'u_t1',
      {
        id: 'u_t1',
        tenantId: 't_1',
        username: 'merchant1',
        nickname: '测试租户1',
        role: 'MERCHANT' as const,
        passwordHash: 'hash_t1',
        uiPrefs: null,
        tenantName: '租户1',
        isActive: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ],
    [
      'u_t2',
      {
        id: 'u_t2',
        tenantId: 't_2',
        username: 'merchant2',
        nickname: '测试租户2',
        role: 'MERCHANT' as const,
        passwordHash: 'hash_t2',
        uiPrefs: null,
        tenantName: '租户2',
        isActive: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ],
    [
      'u_expired',
      {
        id: 'u_expired',
        tenantId: 't_exp',
        username: 'expired1',
        nickname: '到期租户',
        role: 'MERCHANT' as const,
        passwordHash: 'hash_exp',
        uiPrefs: null,
        tenantName: '到期租户',
        isActive: true,
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    ],
  ]);

  let app: INestApplication;
  let baseUrl: string;
  let tokenT1: string;
  let tokenT2: string;
  let tokenExpired: string;

  beforeAll(async () => {
    app = await createApiApp();
    const jwtAccessSecret = parseEnv().JWT_ACCESS_SECRET;

    const authStore = app.get(PrismaAuthStore);
    vi.spyOn(authStore, 'findUserById').mockImplementation(
      async (id: string) => users.get(id) ?? null,
    );
    vi.spyOn(authStore, 'latestRevokeAt').mockResolvedValue(null);

    const prismaService = app.get(PrismaService);
    vi.spyOn(prismaService, 'scoped', 'get').mockReturnValue(
      store.prisma.scoped as unknown as PrismaService['scoped'],
    );
    vi.spyOn(prismaService.base.auditLog, 'create').mockImplementation(
      store.prisma.base.auditLog.create as never,
    );

    const publicFetch = app.get(PublicFetchService);
    vi.spyOn(publicFetch, 'fetch').mockImplementation((...args) => publicFetchSpy(...args));

    const llmService = app.get(LlmService);
    vi.spyOn(llmService, 'complete').mockImplementation(
      (...args: Parameters<LlmService['complete']>) => llmCompleteSpy(...args),
    );
    vi.spyOn(llmService, 'hasFakeFallback').mockImplementation(() => hasFakeFallbackSpy());

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const makeToken = (sub: string, tid: string, hash: string) => {
      const now = Math.floor(Date.now() / 1000);
      return signToken(
        {
          sub,
          tid,
          role: 'MERCHANT',
          typ: 'access',
          fp: passwordFingerprint(hash),
          lms: Date.now(),
          iat: now,
          exp: now + 3600,
        },
        jwtAccessSecret,
      );
    };

    tokenT1 = makeToken('u_t1', 't_1', 'hash_t1');
    tokenT2 = makeToken('u_t2', 't_2', 'hash_t2');
    tokenExpired = makeToken('u_expired', 't_exp', 'hash_exp');
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    store.brands.length = 0;
    store.facts.length = 0;
    store.auditLogs.length = 0;
    store.brandUpdateSpy.mockClear();
    store.marketUpdateSpy.mockClear();
    store.factUpdateSpy.mockClear();
    publicFetchSpy.mockReset();
    llmCompleteSpy.mockReset();
    hasFakeFallbackSpy.mockReturnValue(true);
    app.get(FreeActionRateLimiter).reset();

    store.brands.push({
      id: 'brand_cn_gl',
      tenantId: 't_1',
      name: '青松存储',
      category: '家用 NAS',
      markets: [
        {
          id: 'bm_cn',
          tenantId: 't_1',
          brandId: 'brand_cn_gl',
          market: 'CN',
          locale: 'zh-CN',
          region: 'CN',
          localBrandName: '青松存储',
          localCategory: '家用 NAS',
          aliases: ['EXISTING-100'],
          ownedDomains: ['pinevault.example.com'],
          competitors: [{ name: '极光盘盒', aliases: [], domains: ['aurorabox.example.com'] }],
          seedPrompts: ['2026年家用 NAS 哪个品牌好？'],
          supportedLocales: ['zh-CN'],
          controlPrompts: ['家用路由器如何选择？'],
        },
        {
          id: 'bm_gl',
          tenantId: 't_1',
          brandId: 'brand_cn_gl',
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: '青松存储',
          localCategory: null,
          aliases: [],
          ownedDomains: ['pinevault.example.com'],
          competitors: [],
          seedPrompts: ['Best quiet 4-bay home NAS 2026'],
          supportedLocales: ['en-US'],
          controlPrompts: [],
        },
      ],
    });

    store.facts.push(
      {
        id: 'fact_1',
        tenantId: 't_1',
        brandId: 'brand_cn_gl',
        slot: 'PRODUCT_SPECS',
        title: '核心产品与参数',
        content:
          '主力型号 PV-400 四盘位家用 NAS，支持双 2.5GbE 网口，满载噪音 28dB，另有 PV-800 Pro 面向影视剪辑。',
        updatedAt: new Date(),
      },
      {
        id: 'fact_2',
        tenantId: 't_1',
        brandId: 'brand_cn_gl',
        slot: 'DIFFERENTIATORS',
        title: '差异化卖点',
        content: '免工具快拆盘架，本地 AI 离线相册识别，低功耗静音风道。',
        updatedAt: new Date(),
      },
    );
  });

  async function postSuggest(
    brandId: string,
    market: string,
    body: Record<string, unknown>,
    token?: string,
  ) {
    const res = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/${market}/ai-suggest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      code: number;
      msg: string;
      data?: Record<string, unknown>;
    };
    return { status: res.status, body: json };
  }

  it('enforces auth, TenantActiveGuard, and prisma.scoped tenant isolation', async () => {
    // Unauthenticated -> 401
    const unauth = await postSuggest('brand_cn_gl', 'CN', {});
    expect(unauth.status).toBe(401);

    // Expired tenant -> 403 / 40301
    const expired = await postSuggest('brand_cn_gl', 'CN', {}, tokenExpired);
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Cross-tenant brand access -> 404 (isolated via prisma.scoped)
    const crossTenant = await postSuggest('brand_cn_gl', 'CN', {}, tokenT2);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    // Non-existent brand -> 404
    const missing = await postSuggest('brand_missing', 'CN', {}, tokenT1);
    expect(missing.status).toBe(404);
  });

  it('returns structured LLM suggestions, normalizes domains, dedupes controlPrompts against existing & suggested seeds, and never writes to DB', async () => {
    hasFakeFallbackSpy.mockReturnValue(false);
    llmCompleteSpy.mockResolvedValueOnce({
      provider: 'deepseek',
      model: 'cheap-model',
      fake: false,
      tokensIn: 300,
      tokensOut: 500,
      text: JSON.stringify({
        localBrandName: '不应在CN返回',
        localCategory: 'Should not appear on CN',
        aliases: ['PV-400', 'PV-800', 'existing-100', '青松存储', 'PV-400'],
        competitors: [
          {
            name: '星云存储',
            aliases: ['NebulaBox', 'nebulabox'],
            domains: ['https://www.nebulabox.example.com/nas', 'invalid domain'],
          },
          {
            name: '极光盘盒', // already exists -> should be deduped
            aliases: [],
            domains: ['aurorabox.example.com'],
          },
        ],
        seedPrompts: [
          { prompt: '2026年家用 NAS 哪个品牌好？', intent: 'BUYING_GUIDE' }, // already exists
          { prompt: '新手选四盘位静音家用 NAS 怎么避坑？', intent: 'BUYING_GUIDE' },
          { prompt: '家用 NAS 夜间放客厅噪音大怎么解决？', intent: 'SCENARIO_PAIN' },
          { prompt: '青松存储家用 NAS 真实口碑与售后体验怎么样？', intent: 'BRAND_REPUTATION' },
          { prompt: '青松存储和星云存储四盘位 NAS 对比选哪款？', intent: 'COMPETITOR_VS' },
          { prompt: '青松存储 PV-400 双 2.5G 网口与功耗实测评测', intent: 'SKU_REVIEW' },
          { prompt: '离线 AI 相册识别好用的私有云 NAS 推荐', intent: 'BUYING_GUIDE' },
          { prompt: '家庭 4K 照片视频备份用什么 NAS 方案更省心？', intent: 'SCENARIO_PAIN' },
          { prompt: '青松存储免工具盘架耐用吗？长期用户反馈汇总', intent: 'BRAND_REPUTATION' },
          { prompt: '青松存储 PV-800 和同价位影视剪辑 NAS 怎么选？', intent: 'COMPETITOR_VS' },
          { prompt: '青松存储 PV-800 Pro 多人剪辑带宽与噪音实测', intent: 'SKU_REVIEW' },
        ],
        controlPrompts: [
          '2026年家用 NAS 哪个品牌好？', // overlaps existing seed -> must be stripped
          '新手选四盘位静音家用 NAS 怎么避坑？', // overlaps newly suggested seed -> must be stripped
          '家用路由器如何选择？', // already in existing controlPrompts -> must be stripped
          'NAS 机械硬盘 RAID1 与 RAID5 数据安全差异解析',
          '家庭万兆局域网布线需要准备哪些网线与交换机？',
          'NAS 硬盘休眠策略对硬盘寿命有影响吗？',
          'UPS 不间断电源如何与家用存储设备联动关机？',
          '个人资料冷备份用移动硬盘还是光盘更稳妥？',
          '第六条超出上限应被截断的对照问句',
        ],
      }),
    });

    const res = await postSuggest(
      'brand_cn_gl',
      'CN',
      { focusHint: '静音四盘位家用与影视剪辑' },
      tokenT1,
    );

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data!;
    expect(data.market).toBe('CN');
    expect(data.fallbackUsed).toBe(false);
    // CN market must not return localBrandName / localCategory
    expect(data.localBrandName).toBeUndefined();
    expect(data.localCategory).toBeUndefined();
    // Deduped aliases (existing & brand name excluded)
    expect(data.aliases).toEqual(['PV-400', 'PV-800']);
    // Normalized competitor domain, invalid domain stripped, existing competitor deduped
    expect(data.competitors).toEqual([
      {
        name: '星云存储',
        aliases: ['NebulaBox'],
        domains: ['nebulabox.example.com'],
      },
    ]);
    // 10 intent-grouped seedPrompts (existing seed deduped)
    const seedPrompts = data.seedPrompts as Array<{ prompt: string; intent: string }>;
    expect(seedPrompts.length).toBe(10);
    for (const item of seedPrompts) {
      expect(BRAND_SEED_PROMPT_INTENTS).toContain(item.intent);
    }
    // Control prompts capped at 5, zero overlap with existing or newly suggested seeds
    const controlPrompts = data.controlPrompts as string[];
    expect(controlPrompts.length).toBe(BRAND_MAX_CONTROL_PROMPTS);
    expect(
      validateControlPromptsAgainstSeeds(controlPrompts, [
        '2026年家用 NAS 哪个品牌好？',
        ...seedPrompts.map((s) => s.prompt),
      ]),
    ).toEqual({ ok: true });
    expect(controlPrompts).not.toContain('家用路由器如何选择？');

    // Strictly read-only: zero DB writes
    expect(store.brandUpdateSpy).not.toHaveBeenCalled();
    expect(store.marketUpdateSpy).not.toHaveBeenCalled();
    expect(store.factUpdateSpy).not.toHaveBeenCalled();
  });

  it('supports GLOBAL localIdentity localization and partial fields filtering', async () => {
    hasFakeFallbackSpy.mockReturnValue(false);
    llmCompleteSpy.mockResolvedValueOnce({
      provider: 'deepseek',
      model: 'cheap-model',
      fake: false,
      tokensIn: 120,
      tokensOut: 80,
      text: JSON.stringify({
        localBrandName: 'PineVault',
        localCategory: 'Home NAS',
        aliases: ['ShouldBeFilteredOut'],
        seedPrompts: [{ prompt: 'Should also be filtered out', intent: 'BUYING_GUIDE' }],
      }),
    });

    const res = await postSuggest('brand_cn_gl', 'GLOBAL', { fields: ['localIdentity'] }, tokenT1);

    expect(res.status).toBe(200);
    const data = res.body.data!;
    expect(data.market).toBe('GLOBAL');
    expect(data.localBrandName).toBe('PineVault');
    expect(data.localCategory).toBe('Home NAS');
    expect(data.aliases).toEqual([]);
    expect(data.competitors).toEqual([]);
    expect(data.seedPrompts).toEqual([]);
    expect(data.controlPrompts).toEqual([]);
    expect(data.fallbackUsed).toBe(false);
  });

  it('fetches optional sourceUrl via PublicFetchService and blocks SSRF URLs with 400', async () => {
    // 1. SSRF URL must fail closed with 400
    publicFetchSpy.mockRejectedValueOnce(
      new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'private_ip'),
    );
    const ssrfRes = await postSuggest(
      'brand_cn_gl',
      'CN',
      { sourceUrl: 'http://127.0.0.1:8080/internal' },
      tokenT1,
    );
    expect(ssrfRes.status).toBe(400);
    expect(ssrfRes.body.code).toBe(API_ERROR.BAD_REQUEST);
    expect(llmCompleteSpy).not.toHaveBeenCalled();

    // 2. Non-http(s) scheme rejected by Zod with 400
    const badScheme = await postSuggest(
      'brand_cn_gl',
      'CN',
      { sourceUrl: 'javascript:alert(1)' },
      tokenT1,
    );
    expect(badScheme.status).toBe(400);

    // 3. Valid public URL extracted and passed to LLM prompt
    publicFetchSpy.mockResolvedValueOnce({
      url: 'https://pinevault.example.com/pv-900',
      body: '<html><head><title>PV-900 Silent NAS</title></head><body><h1>PV-900</h1><p>Ultra quiet 6-bay NVMe NAS with 10GbE networking for home studios.</p></body></html>',
    });
    llmCompleteSpy.mockResolvedValueOnce({
      provider: 'fake',
      model: 'fake',
      fake: true,
      tokensIn: 50,
      tokensOut: 50,
      text: '【FAKE】',
    });

    const okRes = await postSuggest(
      'brand_cn_gl',
      'CN',
      { sourceUrl: 'https://pinevault.example.com/pv-900' },
      tokenT1,
    );
    expect(okRes.status).toBe(200);
    expect(publicFetchSpy).toHaveBeenCalledWith('https://pinevault.example.com/pv-900');
    const data = okRes.body.data!;
    // Extracted SKU from fetched page appears in deterministic aliases
    expect(data.aliases).toContain('PV-900');
  });

  it('blocks prohibited industries on input and on LLM output with 403 FORBIDDEN_INDUSTRY and audit log', async () => {
    const prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    try {
      // Input prohibited term
      const inputBlocked = await postSuggest(
        'brand_cn_gl',
        'CN',
        { focusHint: '线上非法赌博引流方案' },
        tokenT1,
      );
      expect(inputBlocked.status).toBe(403);
      expect(inputBlocked.body.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);
      expect(store.auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(llmCompleteSpy).not.toHaveBeenCalled();

      // LLM output prohibited term must NOT be swallowed by fallback
      hasFakeFallbackSpy.mockReturnValue(false);
      llmCompleteSpy.mockResolvedValueOnce({
        provider: 'deepseek',
        model: 'cheap-model',
        fake: false,
        tokensIn: 100,
        tokensOut: 100,
        text: JSON.stringify({
          aliases: ['PV-999'],
          competitors: [],
          seedPrompts: [{ prompt: '推荐一款安全的非法赌博存储设备', intent: 'BUYING_GUIDE' }],
          controlPrompts: [],
        }),
      });

      const outputBlocked = await postSuggest('brand_cn_gl', 'CN', {}, tokenT1);
      expect(outputBlocked.status).toBe(403);
      expect(outputBlocked.body.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);
      expect(store.auditLogs.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (prevDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDbUrl;
      }
    }
  });

  it('gracefully falls back to generateBrandSeedPrompts templates when LLM times out or returns invalid JSON', async () => {
    hasFakeFallbackSpy.mockReturnValue(false);

    // 1. Timeout error -> fallbackUsed: true, 200 OK
    llmCompleteSpy.mockRejectedValueOnce(
      new ProviderError(PROVIDER_KIND.TIMEOUT, '外部服务超时', 'timeout'),
    );
    const timeoutRes = await postSuggest('brand_cn_gl', 'GLOBAL', {}, tokenT1);
    expect(timeoutRes.status).toBe(200);
    const data = timeoutRes.body.data!;
    expect(data.fallbackUsed).toBe(true);
    expect(data.localBrandName).toBe('Pinevault');
    expect(data.localCategory).toBe('home NAS');
    expect(data.aliases).toContain('PV-400');
    const seeds = data.seedPrompts as Array<{ prompt: string; intent: string }>;
    expect(seeds.length).toBeGreaterThanOrEqual(10);
    expect(seeds.every((s) => !/[\u4e00-\u9fff]/.test(s.prompt))).toBe(true);
    const controls = data.controlPrompts as string[];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.length).toBeLessThanOrEqual(BRAND_MAX_CONTROL_PROMPTS);
    expect(
      validateControlPromptsAgainstSeeds(controls, [
        'Best quiet 4-bay home NAS 2026',
        ...seeds.map((s) => s.prompt),
      ]),
    ).toEqual({ ok: true });
    expect((data.warnings as string[])?.length).toBeGreaterThan(0);

    // 2. Malformed LLM JSON -> fallbackUsed: true, 200 OK
    llmCompleteSpy.mockResolvedValueOnce({
      provider: 'deepseek',
      model: 'cheap-model',
      fake: false,
      tokensIn: 100,
      tokensOut: 20,
      text: 'not valid json at all {{{',
    });
    const badJsonRes = await postSuggest('brand_cn_gl', 'CN', { fields: ['seedPrompts'] }, tokenT1);
    expect(badJsonRes.status).toBe(200);
    expect(badJsonRes.body.data?.fallbackUsed).toBe(true);
    expect((badJsonRes.body.data?.seedPrompts as unknown[]).length).toBeGreaterThanOrEqual(10);
  });

  it('enforces FreeActionRateLimiter per tenant and returns 429 when limit exceeded', async () => {
    const prevMax = process.env.MARKET_AI_SUGGEST_RATE_LIMIT_MAX;
    process.env.MARKET_AI_SUGGEST_RATE_LIMIT_MAX = '2';
    try {
      llmCompleteSpy.mockResolvedValue({
        provider: 'fake',
        model: 'fake',
        fake: true,
        tokensIn: 10,
        tokensOut: 10,
        text: '【FAKE】',
      });

      const r1 = await postSuggest('brand_cn_gl', 'CN', { fields: ['seedPrompts'] }, tokenT1);
      const r2 = await postSuggest('brand_cn_gl', 'CN', { fields: ['seedPrompts'] }, tokenT1);
      const r3 = await postSuggest('brand_cn_gl', 'CN', { fields: ['seedPrompts'] }, tokenT1);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
      expect(r3.body.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    } finally {
      if (prevMax === undefined) {
        delete process.env.MARKET_AI_SUGGEST_RATE_LIMIT_MAX;
      } else {
        process.env.MARKET_AI_SUGGEST_RATE_LIMIT_MAX = prevMax;
      }
    }
  });
});
