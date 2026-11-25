import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  AUTH_ERROR,
  parseEnv,
  type GeoBriefListResponse,
  type GeoBriefRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { PublicFetchService } from '../infra/adapters.module';
import { LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { QueueRuntime } from '../queue/queue.runtime';
import { currentTenantId } from '../tenant/tenant-context';
import { VisibilityRunRunner } from '../visibility/visibility-run.runner';
import { WorkerModule } from '../worker.module';
import { BriefsAutoGeneratorService } from './briefs-auto-generator.service';
import { BriefsService } from './briefs.service';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type TenantRow = {
  id: string;
  name: string;
  expiresAt: Date;
  isActive: boolean;
  billingMode: 'SHADOW' | 'STRICT' | null;
};

type UserRow = {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  nickname: string | null;
  role: 'MERCHANT' | 'ADMIN';
};

type BrandMarketRow = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale: string;
  region: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  seedPrompts: string[];
  createdAt: Date;
  updatedAt: Date;
};

type BrandRow = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type BrandFactRow = {
  id: string;
  tenantId: string;
  brandId: string;
  slot: string;
  title: string;
  content: string;
  indexStatus: string;
  updatedAt: Date;
};

type ObservationRow = {
  id: string;
  tenantId: string;
  runId: string;
  brandId: string;
  brandMarketId: string;
  promptText: string;
  engine: string;
  status: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: unknown;
  fanOutQueries: string[];
  createdAt: Date;
  citations: Array<{
    id: string;
    tenantId: string;
    observationId: string;
    url: string;
    domain: string;
    title: string | null;
    sourceKind: string;
    position: number;
  }>;
};

type BriefRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  sourceType: string;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  targetPrompt: string;
  priorityScore: number;
  diagnosisSummary: string;
  recommendedRecipe: string;
  targetFormat: string;
  suggestedTitle: string;
  outlineH2: unknown;
  targetFanOuts: string[];
  competitorFocus: string[];
  matchedFactIds: string[];
  missingFactHints: string[];
  recommendedChannels: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function createFakeStore() {
  const now = new Date('2026-11-20T00:00:00.000Z');
  const future = new Date(Date.now() + 86_400_000 * 30);
  const past = new Date(Date.now() - 86_400_000);

  const tenants: TenantRow[] = [
    { id: 't_a', name: 'Tenant A', expiresAt: future, isActive: true, billingMode: 'SHADOW' },
    { id: 't_b', name: 'Tenant B', expiresAt: future, isActive: true, billingMode: 'SHADOW' },
    { id: 't_exp', name: 'Expired Tenant', expiresAt: past, isActive: true, billingMode: 'SHADOW' },
  ];

  const users: UserRow[] = [
    {
      id: 'u_a',
      tenantId: 't_a',
      username: 'merchant_a',
      passwordHash: 'hash_a',
      nickname: 'A',
      role: 'MERCHANT',
    },
    {
      id: 'u_b',
      tenantId: 't_b',
      username: 'merchant_b',
      passwordHash: 'hash_b',
      nickname: 'B',
      role: 'MERCHANT',
    },
    {
      id: 'u_exp',
      tenantId: 't_exp',
      username: 'merchant_exp',
      passwordHash: 'hash_exp',
      nickname: 'Exp',
      role: 'MERCHANT',
    },
  ];

  const brands: BrandRow[] = [
    {
      id: 'brand_dual',
      tenantId: 't_a',
      name: '星云存储',
      category: '家用 NAS',
      truthAgreementSignedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'brand_b',
      tenantId: 't_b',
      name: '竞对品牌B',
      category: '家用 NAS',
      truthAgreementSignedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'brand_exp',
      tenantId: 't_exp',
      name: '到期品牌',
      category: '家用 NAS',
      truthAgreementSignedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const brandMarkets: BrandMarketRow[] = [
    {
      id: 'bm_a_cn',
      tenantId: 't_a',
      brandId: 'brand_dual',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '星云存储',
      aliases: ['星云NAS'],
      ownedDomains: ['xingyun.example'],
      competitors: [{ name: '竞品甲', aliases: [], domains: ['compa.example'] }],
      seedPrompts: ['2026 四盘位家用 NAS 推荐'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'bm_a_global',
      tenantId: 't_a',
      brandId: 'brand_dual',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'NebulaNAS',
      aliases: ['Nebula Pro'],
      ownedDomains: ['nebulanas.example'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.example'] }],
      seedPrompts: ['Best quiet 4-bay home NAS 2026'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'bm_b_cn',
      tenantId: 't_b',
      brandId: 'brand_b',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '竞对品牌B',
      aliases: [],
      ownedDomains: ['brandb.example'],
      competitors: [],
      seedPrompts: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'bm_exp_cn',
      tenantId: 't_exp',
      brandId: 'brand_exp',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '到期品牌',
      aliases: [],
      ownedDomains: ['exp.example'],
      competitors: [],
      seedPrompts: [],
      createdAt: now,
      updatedAt: now,
    },
  ];

  const brandFacts: BrandFactRow[] = [
    {
      id: 'fact_a_1',
      tenantId: 't_a',
      brandId: 'brand_dual',
      slot: 'PRODUCT_SPECS',
      title: '核心硬件参数',
      content: '四盘位铝合金机身，满载噪音 21dB，待机功耗 9W，双 2.5GbE 网口。',
      indexStatus: 'NONE',
      updatedAt: now,
    },
  ];

  const observations: ObservationRow[] = [
    {
      id: 'obs_a_cn_nocite',
      tenantId: 't_a',
      runId: 'run_a_cn',
      brandId: 'brand_dual',
      brandMarketId: 'bm_a_cn',
      promptText: '2026 安静四盘位家用 NAS 推荐',
      engine: 'deepseek',
      status: 'SUCCESS',
      answerText: '多数评测推荐竞品甲与竞品乙，静音与扩展性表现较好。',
      brandMentioned: false,
      brandPosition: null,
      brandSentiment: null,
      competitorHits: [{ name: '竞品甲', mentioned: true, position: 1 }],
      fanOutQueries: ['安静NAS噪音', '四盘位NAS功耗'],
      createdAt: now,
      citations: [],
    },
    {
      id: 'obs_a_cn_lowrank',
      tenantId: 't_a',
      runId: 'run_a_cn',
      brandId: 'brand_dual',
      brandMarketId: 'bm_a_cn',
      promptText: '四盘位家用 NAS 性价比排行',
      engine: 'doubao',
      status: 'SUCCESS',
      answerText: '1. 竞品甲 2. 竞品乙 3. 竞品丙 4. 星云存储',
      brandMentioned: true,
      brandPosition: 4,
      brandSentiment: 'neutral',
      competitorHits: [{ name: '竞品甲', mentioned: true, position: 1 }],
      fanOutQueries: ['四盘位性价比NAS'],
      createdAt: now,
      citations: [
        {
          id: 'cite_1',
          tenantId: 't_a',
          observationId: 'obs_a_cn_lowrank',
          url: 'https://review.example/nas-2026',
          domain: 'review.example',
          title: '2026 四盘位 NAS 横向评测',
          sourceKind: 'AUTHORITY',
          position: 1,
        },
      ],
    },
    {
      id: 'obs_b_cn',
      tenantId: 't_b',
      runId: 'run_b_cn',
      brandId: 'brand_b',
      brandMarketId: 'bm_b_cn',
      promptText: '租户 B 私有问题',
      engine: 'deepseek',
      status: 'SUCCESS',
      answerText: '租户 B 的观测内容',
      brandMentioned: false,
      brandPosition: null,
      brandSentiment: null,
      competitorHits: [],
      fanOutQueries: [],
      createdAt: now,
      citations: [],
    },
  ];

  let briefSeq = 1;
  const briefs: BriefRow[] = [
    {
      id: 'brief_exp_1',
      tenantId: 't_exp',
      brandId: 'brand_exp',
      brandMarketId: 'bm_exp_cn',
      sourceType: 'AUTO_GAP',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: null,
      targetPrompt: '到期租户可读意见',
      priorityScore: 92,
      diagnosisSummary: '竞品露出占优。',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      suggestedTitle: '2026 到期品牌选购指南',
      outlineH2: [
        { heading: '一、核心结论', intent: '首段直答' },
        { heading: '二、参数对比', intent: '对比表' },
        { heading: '三、常见问题', intent: 'FAQ' },
      ],
      targetFanOuts: [],
      competitorFocus: [],
      matchedFactIds: [],
      missingFactHints: ['建议补充实测数据'],
      recommendedChannels: [{ channel: '知乎', reason: '高权重问答社区' }],
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    },
  ];

  function requireTenant(): string {
    const tid = currentTenantId();
    if (!tid) throw new Error('missing tenant context');
    return tid;
  }

  function matchBriefWhere(
    row: BriefRow,
    where: Record<string, unknown>,
    tenantId: string,
  ): boolean {
    if (row.tenantId !== tenantId) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.brandId && row.brandId !== where.brandId) return false;
    if (where.brandMarketId && row.brandMarketId !== where.brandMarketId) return false;
    if (where.sourceType && row.sourceType !== where.sourceType) return false;
    if (where.sourceRunId && row.sourceRunId !== where.sourceRunId) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (
      where.status &&
      typeof where.status === 'object' &&
      'not' in (where.status as Record<string, unknown>) &&
      row.status === (where.status as { not: string }).not
    ) {
      return false;
    }
    return true;
  }

  function withMarket(row: BriefRow) {
    const bm = brandMarkets.find((m) => m.id === row.brandMarketId);
    return { ...row, brandMarket: bm ? { market: bm.market } : null };
  }

  const scoped = {
    brand: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const tid = requireTenant();
        const brand = brands.find((b) => b.id === where.id && b.tenantId === tid);
        if (!brand) return null;
        return {
          ...brand,
          markets: brandMarkets.filter((m) => m.brandId === brand.id && m.tenantId === tid),
          _count: {
            facts: brandFacts.filter((f) => f.brandId === brand.id && f.tenantId === tid).length,
            mediaAssets: 0,
          },
        };
      },
    },
    brandFact: {
      findMany: async ({ where }: { where: { brandId: string } }) => {
        const tid = requireTenant();
        return brandFacts.filter((f) => f.brandId === where.brandId && f.tenantId === tid);
      },
    },
    visibilityObservation: {
      findMany: async ({
        where,
      }: {
        where: { id: { in: string[] }; brandId: string; brandMarketId: string };
      }) => {
        const tid = requireTenant();
        return observations.filter(
          (o) =>
            o.tenantId === tid &&
            o.brandId === where.brandId &&
            o.brandMarketId === where.brandMarketId &&
            where.id.in.includes(o.id),
        );
      },
    },
    visibilityCitation: {
      findMany: async ({
        where,
      }: {
        where: { url: string; observation: { brandId: string; brandMarketId: string } };
      }) => {
        const tid = requireTenant();
        const out: Array<ObservationRow['citations'][number] & { observation: ObservationRow }> =
          [];
        for (const obs of observations) {
          if (
            obs.tenantId !== tid ||
            obs.brandId !== where.observation.brandId ||
            obs.brandMarketId !== where.observation.brandMarketId
          ) {
            continue;
          }
          for (const cite of obs.citations) {
            if (cite.url === where.url) {
              out.push({ ...cite, observation: obs });
            }
          }
        }
        return out;
      },
    },
    geoBrief: {
      findMany: async ({
        where,
        skip = 0,
        take = 50,
      }: {
        where: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) => {
        const tid = requireTenant();
        return briefs
          .filter((row) => matchBriefWhere(row, where, tid))
          .sort(
            (a, b) =>
              b.priorityScore - a.priorityScore ||
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(skip, skip + take)
          .map(withMarket);
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        const tid = requireTenant();
        return briefs.filter((row) => matchBriefWhere(row, where, tid)).length;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const tid = requireTenant();
        const hit = briefs.find((row) => matchBriefWhere(row, where, tid));
        return hit ? withMarket(hit) : null;
      },
      create: async ({ data }: { data: Omit<BriefRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
        const tid = requireTenant();
        const ts = new Date(Date.now() + briefSeq * 1000);
        const row: BriefRow = {
          ...data,
          tenantId: tid,
          id: `brief_${briefSeq++}`,
          createdAt: ts,
          updatedAt: ts,
        };
        briefs.push(row);
        return withMarket(row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<BriefRow> }) => {
        const tid = requireTenant();
        const idx = briefs.findIndex((b) => b.id === where.id && b.tenantId === tid);
        if (idx < 0) throw Object.assign(new Error('not found'), { code: 'P2025' });
        briefs[idx] = {
          ...briefs[idx]!,
          ...data,
          updatedAt: new Date(),
        };
        return withMarket(briefs[idx]!);
      },
    },
  };

  const base = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; username?: string } }) => {
        const user = users.find((u) =>
          where.id ? u.id === where.id : u.username === where.username,
        );
        if (!user) return null;
        const tenant = tenants.find((t) => t.id === user.tenantId)!;
        return { ...user, tenant };
      },
    },
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants.find((t) => t.id === where.id) ?? null,
    },
    brandFact: {
      findMany: async ({ where }: { where: { tenantId: string; brandId: string } }) =>
        brandFacts.filter((f) => f.tenantId === where.tenantId && f.brandId === where.brandId),
    },
    auditLog: {
      create: async () => ({ id: 'audit_1' }),
      findMany: async () => [],
    },
    $disconnect: async () => undefined,
  };

  return {
    prisma: { scoped, base } as unknown as PrismaService,
    users,
    briefs,
  };
}

function makeAccessToken(user: UserRow): string {
  const env = parseEnv(process.env);
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

describe('Briefs HTTP API & ApiModule/WorkerModule DI boot checks', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: ReturnType<typeof createFakeStore>;
  let tokenA: string;
  let tokenB: string;
  let tokenExp: string;
  let rateLimiter: FreeActionRateLimiter;

  beforeAll(async () => {
    process.env.LLM_PROVIDERS = '{}';
    process.env.BILLING_MODE = 'SHADOW';
    process.env.BRIEF_GENERATE_RATE_LIMIT_MAX = '5';
    process.env.BRIEF_GENERATE_RATE_LIMIT_WINDOW_SECONDS = '60';

    store = createFakeStore();
    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as {
      base: unknown;
      scoped: unknown;
    };
    prismaSvc.base = (store.prisma as unknown as { base: unknown }).base;
    prismaSvc.scoped = (store.prisma as unknown as { scoped: unknown }).scoped;
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    rateLimiter = app.get(FreeActionRateLimiter);
    tokenA = makeAccessToken(store.users[0]!);
    tokenB = makeAccessToken(store.users[1]!);
    tokenExp = makeAccessToken(store.users[2]!);
  });

  beforeEach(() => {
    rateLimiter.reset();
  });

  afterAll(async () => {
    delete process.env.BRIEF_GENERATE_RATE_LIMIT_MAX;
    delete process.env.BRIEF_GENERATE_RATE_LIMIT_WINDOW_SECONDS;
    await app.close();
  });

  async function req<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; body: Envelope<T> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as Envelope<T>;
    return { status: res.status, headers: res.headers, body: json };
  }

  it('boots BOTH ApiModule and WorkerModule with geo-brief-auto-generator hook registered', async () => {
    // ApiModule check
    expect(app.get(BriefsService)).toBeInstanceOf(BriefsService);
    expect(app.get(BriefsAutoGeneratorService)).toBeInstanceOf(BriefsAutoGeneratorService);
    const apiRunner = app.get(VisibilityRunRunner) as unknown as {
      completeHooks: Array<{ name: string }>;
    };
    expect(apiRunner.completeHooks.map((h) => h.name)).toContain('geo-brief-auto-generator');

    // WorkerModule check (stub QueueRuntime.start/stop so no Redis connection is opened)
    const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
    const workerCtx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });

    try {
      const workerRunner = workerCtx.get(VisibilityRunRunner) as unknown as {
        completeHooks: Array<{ name: string }>;
      };
      expect(workerRunner.completeHooks.map((h) => h.name)).toContain('geo-brief-auto-generator');
      expect(workerCtx.get(BrandFactIndexRunner)).toBeDefined();
      expect(workerCtx.get(BriefsAutoGeneratorService)).toBeInstanceOf(BriefsAutoGeneratorService);
    } finally {
      await workerCtx.close();
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('generates briefs across signal types (including D16 empty citations & GLOBAL language), lists, fetches, and patches', async () => {
    // 1. D16 AUTO_GAP with empty citations
    const gapRes = await req<GeoBriefRecord>(
      'POST',
      '/api/v2/brands/brand_dual/briefs/generate',
      tokenA,
      {
        market: 'CN',
        sourceType: 'AUTO_GAP',
        observationIds: ['obs_a_cn_nocite'],
      },
    );
    expect(gapRes.status).toBe(200);
    expect(gapRes.body.code).toBe(0);
    const gapBrief = gapRes.body.data;
    expect(gapBrief.market).toBe('CN');
    expect(gapBrief.sourceType).toBe('AUTO_GAP');
    expect(gapBrief.sourceRunId).toBe('run_a_cn');
    expect(gapBrief.sourceObservationIds).toEqual(['obs_a_cn_nocite']);
    expect(gapBrief.outlineH2.length).toBeGreaterThanOrEqual(3);
    expect(gapBrief.matchedFactIds).toEqual(['fact_a_1']);
    expect(gapBrief.recommendedChannels.length).toBeGreaterThanOrEqual(2);

    // 2. FANOUT_CLUSTER without customPrompt
    const fanRes = await req<GeoBriefRecord>(
      'POST',
      '/api/v2/brands/brand_dual/briefs/generate',
      tokenA,
      {
        market: 'CN',
        sourceType: 'FANOUT_CLUSTER',
        fanOutQueries: ['静音四盘位NAS', '待机功耗实测', '家庭相册备份'],
      },
    );
    expect(fanRes.status).toBe(200);
    expect(fanRes.body.data.targetFanOuts).toEqual(
      expect.arrayContaining(['静音四盘位NAS', '待机功耗实测', '家庭相册备份']),
    );

    // 3. GLOBAL MANUAL brief -> Chinese diagnosis + English title + ALL English H2 + GLOBAL channels
    const globalRes = await req<GeoBriefRecord>(
      'POST',
      '/api/v2/brands/brand_dual/briefs/generate',
      tokenA,
      {
        market: 'GLOBAL',
        sourceType: 'MANUAL',
        customPrompt: 'Best quiet 4-bay home NAS 2026',
      },
    );
    expect(globalRes.status).toBe(200);
    const globalBrief = globalRes.body.data;
    expect(globalBrief.market).toBe('GLOBAL');
    expect(globalBrief.targetFormat).toBe('GLOBAL_AUTHORITY_GUIDE');
    expect(globalBrief.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);
    expect(globalBrief.suggestedTitle).toMatch(/[A-Za-z]{4,}/);
    for (const item of globalBrief.outlineH2) {
      expect(item.heading).toMatch(/[A-Za-z]{3,}/);
    }

    // 4. GET /api/v2/briefs/:id
    const getRes = await req<GeoBriefRecord>('GET', `/api/v2/briefs/${gapBrief.id}`, tokenA);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(gapBrief.id);

    // 5. PATCH /api/v2/briefs/:id
    const patchRes = await req<GeoBriefRecord>('PATCH', `/api/v2/briefs/${gapBrief.id}`, tokenA, {
      suggestedTitle: '2026 家用四盘位静音 NAS 深度实测指南',
      recommendedRecipe: 'COMPARISON_MATRIX',
      competitorFocus: ['竞品甲', '竞品丁'],
      outlineH2: [
        { heading: '一、实测噪音与功耗结论', intent: '首段直答', fanOutRef: '安静NAS噪音' },
        { heading: '二、四盘位参数对比表', intent: '横向对比' },
        { heading: '三、选购避坑 FAQ', intent: '常见答疑' },
      ],
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.suggestedTitle).toBe('2026 家用四盘位静音 NAS 深度实测指南');
    expect(patchRes.body.data.recommendedRecipe).toBe('COMPARISON_MATRIX');
    expect(patchRes.body.data.competitorFocus).toEqual(['竞品甲', '竞品丁']);

    // 6. Dismiss and verify default GET hides DISMISSED while includeDismissed=true returns it
    const dismissRes = await req<GeoBriefRecord>(
      'PATCH',
      `/api/v2/briefs/${fanRes.body.data.id}`,
      tokenA,
      {
        status: 'DISMISSED',
      },
    );
    expect(dismissRes.status).toBe(200);
    expect(dismissRes.body.data.status).toBe('DISMISSED');

    const listDefault = await req<GeoBriefListResponse>(
      'GET',
      '/api/v2/brands/brand_dual/briefs?market=CN',
      tokenA,
    );
    expect(listDefault.status).toBe(200);
    expect(listDefault.body.data.items.some((i) => i.id === fanRes.body.data.id)).toBe(false);
    expect(listDefault.body.data.items.some((i) => i.id === gapBrief.id)).toBe(true);

    const listAll = await req<GeoBriefListResponse>(
      'GET',
      '/api/v2/brands/brand_dual/briefs?market=CN&includeDismissed=true',
      tokenA,
    );
    expect(listAll.status).toBe(200);
    expect(listAll.body.data.items.some((i) => i.id === fanRes.body.data.id)).toBe(true);

    // 7. Reject cross-market targetFormat & invalid recipe
    const badFormat = await req('PATCH', `/api/v2/briefs/${gapBrief.id}`, tokenA, {
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
    });
    expect(badFormat.status).toBe(400);
    const badRecipe = await req('PATCH', `/api/v2/briefs/${gapBrief.id}`, tokenA, {
      recommendedRecipe: 'UNKNOWN_RECIPE',
    });
    expect(badRecipe.status).toBe(400);
  });

  it('hardens nested qs params & array query params (400), cross-tenant access (404), expired tenants (200 GET vs 403/40301 write), and rate limits (429)', async () => {
    // Nested Express qs object -> 400 (never 500)
    const nestedQs = await req('GET', '/api/v2/brands/brand_dual/briefs?market[foo]=CN', tokenA);
    expect(nestedQs.status).toBe(400);
    expect(nestedQs.body.code).toBe(API_ERROR.BAD_REQUEST);

    // Express qs array query parameters -> 400 (never silently collapsed to 200 or 500)
    const arrayQueryPaths = [
      '/api/v2/brands/brand_dual/briefs?market=CN&status[]=OPEN',
      '/api/v2/brands/brand_dual/briefs?market=CN&pageSize[]=50',
      '/api/v2/brands/brand_dual/briefs?market[]=CN&market[]=GLOBAL',
      '/api/v2/brands/brand_dual/briefs?market=CN&status[]=OPEN&status[]=DISMISSED',
    ];
    for (const path of arrayQueryPaths) {
      const arrayRes = await req('GET', path, tokenA);
      expect(arrayRes.status).toBe(400);
      expect(arrayRes.body.code).toBe(API_ERROR.BAD_REQUEST);
    }

    const postArrayMarket = await req(
      'POST',
      '/api/v2/brands/brand_dual/briefs/generate?market[]=CN',
      tokenA,
      {
        sourceType: 'MANUAL',
        customPrompt: '数组查询参数拦截测试',
      },
    );
    expect(postArrayMarket.status).toBe(400);
    expect(postArrayMarket.body.code).toBe(API_ERROR.BAD_REQUEST);

    // Dual-market brand omitting market -> 400
    const missingMarket = await req('GET', '/api/v2/brands/brand_dual/briefs', tokenA);
    expect(missingMarket.status).toBe(400);

    // Cross-tenant isolation -> 404 on brand list, generate, foreign observationIds, get, patch
    const foreignList = await req('GET', '/api/v2/brands/brand_dual/briefs?market=CN', tokenB);
    expect(foreignList.status).toBe(404);
    expect(foreignList.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    const foreignObs = await req('POST', '/api/v2/brands/brand_dual/briefs/generate', tokenA, {
      market: 'CN',
      sourceType: 'LOW_RANK',
      observationIds: ['obs_b_cn'],
    });
    expect(foreignObs.status).toBe(404);

    const foreignGet = await req('GET', '/api/v2/briefs/brief_exp_1', tokenA);
    expect(foreignGet.status).toBe(404);

    const foreignPatch = await req('PATCH', '/api/v2/briefs/brief_exp_1', tokenA, {
      status: 'DISMISSED',
    });
    expect(foreignPatch.status).toBe(404);

    // Expired tenant: GET allowed (200), POST/PATCH blocked (403 / 40301)
    const expList = await req<GeoBriefListResponse>(
      'GET',
      '/api/v2/brands/brand_exp/briefs?market=CN',
      tokenExp,
    );
    expect(expList.status).toBe(200);
    expect(expList.body.data.items).toHaveLength(1);

    const expGet = await req<GeoBriefRecord>('GET', '/api/v2/briefs/brief_exp_1', tokenExp);
    expect(expGet.status).toBe(200);

    const expPost = await req('POST', '/api/v2/brands/brand_exp/briefs/generate', tokenExp, {
      market: 'CN',
      sourceType: 'MANUAL',
      customPrompt: '测试到期拦截',
    });
    expect(expPost.status).toBe(403);
    expect(expPost.body.code).toBe(API_ERROR.TENANT_EXPIRED);

    const expPatch = await req('PATCH', '/api/v2/briefs/brief_exp_1', tokenExp, {
      status: 'DISMISSED',
    });
    expect(expPatch.status).toBe(403);
    expect(expPatch.body.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Rate limit (configured max=5 in beforeAll) -> 6th returns 429 + Retry-After
    for (let i = 0; i < 5; i += 1) {
      const okRes = await req('POST', '/api/v2/brands/brand_dual/briefs/generate', tokenA, {
        market: 'CN',
        sourceType: 'MANUAL',
        customPrompt: `限流测试问题 ${i + 1}`,
      });
      expect(okRes.status).toBe(200);
    }
    const limited = await req('POST', '/api/v2/brands/brand_dual/briefs/generate', tokenA, {
      market: 'CN',
      sourceType: 'MANUAL',
      customPrompt: '超过限流阈值问题',
    });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('supports POST /briefs/from-citation-url with CN/GLOBAL fetch, 422/42201 anti-scrape fallback, pastedContent, SSRF/malformed 400, 403/404/429, and #321 STRICT guard', async () => {
    const publicFetch = app.get(PublicFetchService);
    const fetchSpy = vi.spyOn(publicFetch, 'fetch');

    const cnReviewHtml = `<!doctype html><html lang="zh-CN"><head><title>2026 四盘位家用 NAS 深度对比评测</title></head><body><article><h1>2026 四盘位家用 NAS 深度对比评测</h1><h2>硬件规格与双网口对比</h2><p>主流机型在满载噪音与待机功耗上表现差异明显，需要结合 72 小时实测数据判断。</p><h2>Docker 容器与离线相册体验</h2><p>离线本地 AI 相册检索速度与隐私安全成为家庭用户关注重点。</p></article></body></html>`;
    const globalReviewHtml = `<!doctype html><html lang="en"><head><title>2026 4-Bay Home NAS Benchmark Roundup</title></head><body><article><h1>2026 4-Bay Home NAS Benchmark Roundup</h1><h2>Hardware Architecture and 10GbE Throughput</h2><p>Measured sustained transfer speeds, thermal acoustics, and standby wattage across top four-bay NAS enclosures in real home labs.</p><h2>Local AI Photo Indexing and Docker Reliability</h2><p>Hands-on testing compares local inference speed, snapshot automation, and power draw under heavy load.</p></article></body></html>`;

    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/competitor/nas-review')) {
        return {
          url,
          status: 200,
          contentType: 'text/html',
          body: cnReviewHtml,
          bytes: Buffer.byteLength(cnReviewHtml),
        };
      }
      if (url.includes('/competitor/global-nas')) {
        return {
          url,
          status: 200,
          contentType: 'text/html',
          body: globalReviewHtml,
          bytes: Buffer.byteLength(globalReviewHtml),
        };
      }
      if (url.includes('/anti-scrape/403')) {
        throw new ProviderError(PROVIDER_KIND.NOT_PUBLIC, '无法公开访问', 'status_403');
      }
      if (url.includes('/anti-scrape/login-wall')) {
        throw new ProviderError(PROVIDER_KIND.NOT_PUBLIC, '无法公开访问', 'login_wall');
      }
      if (url.includes('/anti-scrape/slow-timeout')) {
        throw new ProviderError(PROVIDER_KIND.TIMEOUT, '访问超时', 'timeout');
      }
      if (url.includes('/anti-scrape/robots')) {
        throw new ProviderError(PROVIDER_KIND.ROBOTS, '禁止抓取', 'robots_disallow');
      }
      throw new ProviderError(PROVIDER_KIND.UPSTREAM, '上游异常', 'status_502');
    });

    try {
      // 1. Happy path CN live fetch
      const cnRes = await req<GeoBriefRecord>(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-citation-url',
        tokenA,
        {
          market: 'CN',
          citationUrl: 'http://public.e2e.example/competitor/nas-review',
        },
      );
      expect(cnRes.status).toBe(200);
      expect(cnRes.body.data.sourceType).toBe('CITATION_COUNTER');
      expect(cnRes.body.data.recommendedRecipe).toBe('CITATION_COUNTER');
      expect(cnRes.body.data.sourceCitationUrl).toBe(
        'http://public.e2e.example/competitor/nas-review',
      );
      expect(cnRes.body.data.outlineH2.length).toBeGreaterThanOrEqual(3);
      expect(cnRes.body.data.matchedFactIds.length).toBeGreaterThan(0);

      // 2. Happy path GLOBAL live fetch (English headings + Chinese diagnosis + global channels)
      const globalRes = await req<GeoBriefRecord>(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-citation-url',
        tokenA,
        {
          market: 'GLOBAL',
          citationUrl: 'https://reviews.example.com/competitor/global-nas',
        },
      );
      expect(globalRes.status).toBe(200);
      expect(globalRes.body.data.market).toBe('GLOBAL');
      expect(globalRes.body.data.recommendedRecipe).toBe('CITATION_COUNTER');
      expect(/[\u4e00-\u9fa5]/.test(globalRes.body.data.diagnosisSummary)).toBe(true);
      expect(globalRes.body.data.outlineH2.every((h) => /[A-Za-z]{3,}/.test(h.heading))).toBe(true);

      // 3. Anti-scrape 403 / login-wall / timeout / robots -> 422 / 42201
      for (const path of [
        '/anti-scrape/403',
        '/anti-scrape/login-wall',
        '/anti-scrape/slow-timeout',
        '/anti-scrape/robots',
      ]) {
        const blocked = await req(
          'POST',
          '/api/v2/brands/brand_dual/briefs/from-citation-url',
          tokenA,
          {
            market: 'CN',
            citationUrl: `http://public.e2e.example${path}`,
          },
        );
        expect(blocked.status).toBe(422);
        expect(blocked.body.code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
        expect(blocked.body.msg).toContain('粘贴参考正文');
        rateLimiter.reset();
      }

      // 4. Pasted content fallback bypasses remote fetch even with 403 citationUrl
      fetchSpy.mockClear();
      const pasteRes = await req<GeoBriefRecord>(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-citation-url',
        tokenA,
        {
          market: 'CN',
          citationUrl: 'http://public.e2e.example/anti-scrape/403',
          pastedTitle: '2026 家用四盘位 NAS 实测参考稿',
          pastedContent:
            '## 硬件参数对比\n竞品机型噪音 32dB、待机功耗 24W，缺少双 2.5GbE 接口。\n## 家庭隐私与离线相册\n部分竞品相册依赖云端处理，不支持纯本地离线识别。',
        },
      );
      expect(pasteRes.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(pasteRes.body.data.sourceType).toBe('CITATION_COUNTER');
      expect(pasteRes.body.data.recommendedRecipe).toBe('CITATION_COUNTER');
      expect(pasteRes.body.data.sourceCitationUrl).toBe(
        'http://public.e2e.example/anti-scrape/403',
      );
      expect(pasteRes.body.data.matchedFactIds.length).toBeGreaterThan(0);

      // 5. Malformed, non-HTTP, SSRF, and nested qs -> 400 / 40001
      for (const badUrl of [
        '',
        'not-a-url',
        'ftp://example.com/a',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'http://127.0.0.1:3001/api/v1/health',
        'http://localhost:3000/',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/secret',
        'http://192.168.1.1/admin',
        'http://sonargate/v1/collect',
        'http://sonargate:8080/v1/collect',
      ]) {
        const badRes = await req(
          'POST',
          '/api/v2/brands/brand_dual/briefs/from-citation-url',
          tokenA,
          {
            market: 'CN',
            citationUrl: badUrl,
          },
        );
        expect(badRes.status).toBe(400);
        expect(badRes.body.code).toBe(API_ERROR.BAD_REQUEST);
      }

      const nestedQs = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-citation-url?market[foo]=CN',
        tokenA,
        {
          market: 'CN',
          citationUrl: 'http://public.e2e.example/competitor/nas-review',
        },
      );
      expect(nestedQs.status).toBe(400);
      expect(nestedQs.body.code).toBe(API_ERROR.BAD_REQUEST);

      // 6. Cross-tenant 404 & expired tenant 403/40301
      const foreign = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-citation-url',
        tokenB,
        {
          market: 'CN',
          citationUrl: 'http://public.e2e.example/competitor/nas-review',
        },
      );
      expect(foreign.status).toBe(404);

      const expired = await req(
        'POST',
        '/api/v2/brands/brand_exp/briefs/from-citation-url',
        tokenExp,
        {
          market: 'CN',
          citationUrl: 'http://public.e2e.example/competitor/nas-review',
        },
      );
      expect(expired.status).toBe(403);
      expect(expired.body.code).toBe(API_ERROR.TENANT_EXPIRED);

      // 7. #321 zero fake-template fallback when real LLM rejects fake output
      rateLimiter.reset();
      const llm = app.get(LlmService);
      const llmSpy = vi
        .spyOn(llm, 'complete')
        .mockRejectedValueOnce(
          new ProviderError(
            PROVIDER_KIND.UPSTREAM,
            '大模型上游暂时不可用',
            'fake_fallback_rejected',
          ),
        );
      const strictFail = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-citation-url',
        tokenA,
        {
          market: 'CN',
          citationUrl: 'http://public.e2e.example/competitor/nas-review',
        },
      );
      expect(strictFail.status).toBe(503);
      expect(strictFail.body.code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
      llmSpy.mockRestore();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POST /api/v2/brands/:brandId/briefs/from-near-miss diagnoses 4 GEO gaps, enforces SSRF 400, rate limits near_miss_boost, and degrades gracefully on non-SSRF fetch errors (#368)', async () => {
    const publicFetch = app.get(PublicFetchService);
    const rateLimiter = app.get(FreeActionRateLimiter);
    rateLimiter.reset();

    const sparseHtml = [
      '<!doctype html><html><head><title>星云存储产品随笔</title></head><body><article>',
      '<h1>星云存储产品随笔</h1>',
      '<p>随着家庭影音娱乐需求不断增长，越来越多用户开始关注家庭私有云存储设备的长期使用体验与数据安全。</p>',
      '<p>本文记录了家庭日常相册备份的基本思路，后续将持续更新更多信息。</p>',
      '</article></body></html>',
    ].join('');

    const globalHtml = [
      '<!doctype html><html><head><title>NebulaNAS Home Storage Notes</title></head><body><article>',
      '<h1>NebulaNAS Home Storage Notes</h1>',
      '<p>In recent years many enthusiasts have explored quiet multi-bay home storage setups for media archives.</p>',
      '<h2>Hardware Overview</h2><p>Compact aluminum chassis designed for living room desks.</p>',
      '</article></body></html>',
    ].join('');

    const fetchSpy = vi.spyOn(publicFetch, 'fetch').mockImplementation(async (url: string) => {
      if (url.includes('/ssrf-redirect-trap')) {
        throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'ipv4_special');
      }
      if (url.includes('/non-ssrf-timeout')) {
        throw new ProviderError(PROVIDER_KIND.TIMEOUT, '抓取超时', 'timeout');
      }
      if (url.includes('/non-ssrf-403')) {
        throw new ProviderError(PROVIDER_KIND.NOT_PUBLIC, '登录墙拦截', 'status_403');
      }
      if (url.includes('/non-ssrf-robots')) {
        throw new ProviderError(PROVIDER_KIND.ROBOTS, 'robots 禁止', 'robots_disallow');
      }
      if (url.includes('/non-ssrf-dns-empty')) {
        throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'dns_empty');
      }
      if (url.includes('nebulanas.example')) {
        return {
          url,
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: globalHtml,
          bytes: Buffer.byteLength(globalHtml),
        };
      }
      return {
        url,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: sparseHtml,
        bytes: Buffer.byteLength(sparseHtml),
      };
    });

    const prevRateMax = process.env.NEAR_MISS_BOOST_RATE_LIMIT_MAX;
    try {
      // 1. CN happy path with sourceUrl -> fetches page, diagnoses gaps, creates NEAR_MISS_BOOST brief
      const cnRes = await req<GeoBriefRecord>(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'CN',
          tier: 'OPENED_NOT_CITED',
          targetPrompt: '2026 四盘位家用静音 NAS 推荐',
          sourceUrl: 'https://xingyun.example/guides/nas-notes?utm_source=ai',
          sourceTitle: '星云存储产品随笔',
        },
      );
      expect(cnRes.status).toBe(200);
      expect(cnRes.body.code).toBe(0);
      expect(cnRes.body.data.sourceType).toBe('NEAR_MISS_BOOST');
      expect(cnRes.body.data.sourceCitationUrl).toBe('https://xingyun.example/guides/nas-notes');
      expect(cnRes.body.data.recommendedRecipe).toBe('AUTHORITY_GUIDE');
      expect(cnRes.body.data.priorityScore).toBeGreaterThanOrEqual(72);
      expect(cnRes.body.data.priorityScore).toBeLessThanOrEqual(88);
      expect(cnRes.body.data.diagnosisSummary).toContain('点开未引用');
      expect(cnRes.body.data.diagnosisSummary).toContain('首段直答缺失');
      expect(cnRes.body.data.missingFactHints.some((h) => h.includes('参数对比表'))).toBe(true);
      expect(cnRes.body.data.outlineH2.length).toBeGreaterThanOrEqual(4);
      expect(cnRes.body.data.matchedFactIds.length).toBeGreaterThan(0);

      // 2. GLOBAL happy path with sourceUrl -> strict EN title/H2 + ZH diagnosis + zero CN channels
      const globalRes = await req<GeoBriefRecord>(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'GLOBAL',
          tier: 'RETRIEVED_NOT_CITED',
          targetPrompt: 'Best quiet 4-bay home NAS 2026',
          sourceUrl: 'https://nebulanas.example/guides/storage-notes',
        },
      );
      expect(globalRes.status).toBe(200);
      expect(globalRes.body.data.market).toBe('GLOBAL');
      expect(globalRes.body.data.sourceType).toBe('NEAR_MISS_BOOST');
      expect(globalRes.body.data.targetFormat).toBe('GLOBAL_AUTHORITY_GUIDE');
      expect(/[\u4e00-\u9fa5]/.test(globalRes.body.data.diagnosisSummary)).toBe(true);
      expect(/[A-Za-z]{4,}/.test(globalRes.body.data.suggestedTitle)).toBe(true);
      expect(globalRes.body.data.outlineH2.every((h) => /[A-Za-z]{3,}/.test(h.heading))).toBe(true);
      expect(
        globalRes.body.data.recommendedChannels.every(
          (c) => !/知乎|小红书|什么值得买|微信公众号/.test(c.channel),
        ),
      ).toBe(true);

      // 3. Omitted sourceUrl (Tier 3B MENTIONED_NOT_OWNED) -> skips publicFetch, succeeds 200
      fetchSpy.mockClear();
      const noUrlRes = await req<GeoBriefRecord>(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '家用四盘位 NAS 哪款最静音',
        },
      );
      expect(noUrlRes.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(noUrlRes.body.data.sourceType).toBe('NEAR_MISS_BOOST');
      expect(noUrlRes.body.data.sourceCitationUrl).toBeNull();
      expect(noUrlRes.body.data.diagnosisSummary).toContain('提及未引官网');

      // 4. Non-SSRF external fetch failures (timeout / 403 / robots / dns_empty) -> graceful 200 fallback
      for (const path of [
        '/non-ssrf-timeout',
        '/non-ssrf-403',
        '/non-ssrf-robots',
        '/non-ssrf-dns-empty',
      ]) {
        const fallbackRes = await req<GeoBriefRecord>(
          'POST',
          '/api/v2/brands/brand_dual/briefs/from-near-miss',
          tokenA,
          {
            market: 'CN',
            tier: 'OPENED_NOT_CITED',
            targetPrompt: '2026 四盘位家用 NAS 推荐',
            sourceUrl: `https://public-site.example${path}`,
          },
        );
        expect(fallbackRes.status).toBe(200);
        expect(fallbackRes.body.data.sourceType).toBe('NEAR_MISS_BOOST');
        expect(fallbackRes.body.data.diagnosisSummary).toContain('未能直连解析');
        if (path === '/non-ssrf-dns-empty') {
          expect(fallbackRes.body.data.diagnosisSummary).toContain('目标域名暂时无法解析');
        }
        rateLimiter.reset();
      }

      // 5. SSRF rejection -> deterministic 400 (sync pre-check BEFORE fetch + dynamic redirect/DNS trap)
      fetchSpy.mockClear();
      for (const badUrl of [
        'http://127.0.0.1/admin',
        'http://localhost:3000/',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/secret',
        'http://192.168.1.1/router',
        'http://sonargate:8080/v1/collect',
        'ftp://example.com/file',
        'javascript:alert(1)',
        'file:///etc/passwd',
      ]) {
        const blocked = await req(
          'POST',
          '/api/v2/brands/brand_dual/briefs/from-near-miss',
          tokenA,
          {
            market: 'CN',
            tier: 'OPENED_NOT_CITED',
            targetPrompt: '2026 四盘位家用 NAS 推荐',
            sourceUrl: badUrl,
          },
        );
        expect(blocked.status).toBe(400);
        expect(blocked.body.code).toBe(API_ERROR.BAD_REQUEST);
      }
      expect(fetchSpy).not.toHaveBeenCalled();

      // Dynamic redirect-to-private / DNS-to-private SSRF from PublicFetchService -> 400
      const redirectTrap = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'CN',
          tier: 'OPENED_NOT_CITED',
          targetPrompt: '2026 四盘位家用 NAS 推荐',
          sourceUrl: 'https://public-site.example/ssrf-redirect-trap',
        },
      );
      expect(redirectTrap.status).toBe(400);
      expect(redirectTrap.body.code).toBe(API_ERROR.BAD_REQUEST);
      expect(redirectTrap.body.msg).toBe('目标地址不允许访问');

      // 6. Rate limiting on near_miss_boost bucket -> 429 with Retry-After, independent of geo_brief
      rateLimiter.reset();
      process.env.NEAR_MISS_BOOST_RATE_LIMIT_MAX = '2';
      for (let i = 0; i < 2; i += 1) {
        const okRes = await req('POST', '/api/v2/brands/brand_dual/briefs/from-near-miss', tokenA, {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: `限流测试问题 ${i + 1}`,
        });
        expect(okRes.status).toBe(200);
      }
      const limitedRes = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '限流测试问题 3',
        },
      );
      expect(limitedRes.status).toBe(429);
      expect(limitedRes.body.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);

      // geo_brief bucket remains unaffected
      const normalGen = await req('POST', '/api/v2/brands/brand_dual/briefs/generate', tokenA, {
        market: 'CN',
        sourceType: 'MANUAL',
        customPrompt: '独立限流桶验证问题',
      });
      expect(normalGen.status).toBe(200);

      // 7. Cross-tenant 404, cross-tenant observationIds 404, expired tenant 403/40301, nested qs 400
      rateLimiter.reset();
      delete process.env.NEAR_MISS_BOOST_RATE_LIMIT_MAX;

      const foreignBrand = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenB,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '跨租户隔离测试',
        },
      );
      expect(foreignBrand.status).toBe(404);

      const foreignObs = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '跨租户观测测试',
          observationIds: ['obs_nonexistent_foreign'],
        },
      );
      expect(foreignObs.status).toBe(404);

      const expired = await req(
        'POST',
        '/api/v2/brands/brand_exp/briefs/from-near-miss',
        tokenExp,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '过期租户拦截测试',
        },
      );
      expect(expired.status).toBe(403);
      expect(expired.body.code).toBe(API_ERROR.TENANT_EXPIRED);

      const nestedQs = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss?market[foo]=CN',
        tokenA,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '嵌套参数拒绝测试',
        },
      );
      expect(nestedQs.status).toBe(400);

      // 8. #321 STRICT LLM fake_fallback_rejected -> 503
      const llm = app.get(LlmService);
      const llmSpy = vi
        .spyOn(llm, 'complete')
        .mockRejectedValueOnce(
          new ProviderError(
            PROVIDER_KIND.UPSTREAM,
            '大模型上游暂时不可用',
            'fake_fallback_rejected',
          ),
        );
      const strictFail = await req(
        'POST',
        '/api/v2/brands/brand_dual/briefs/from-near-miss',
        tokenA,
        {
          market: 'CN',
          tier: 'MENTIONED_NOT_OWNED',
          targetPrompt: '严格模型降级校验测试',
        },
      );
      expect(strictFail.status).toBe(503);
      expect(strictFail.body.code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
      llmSpy.mockRestore();
    } finally {
      if (prevRateMax === undefined) {
        delete process.env.NEAR_MISS_BOOST_RATE_LIMIT_MAX;
      } else {
        process.env.NEAR_MISS_BOOST_RATE_LIMIT_MAX = prevRateMax;
      }
      fetchSpy.mockRestore();
    }
  });
});
