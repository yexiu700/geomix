import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_FACT_CORE_SLOTS,
  BRAND_FACT_FULL_INJECT_MAX,
  parseEnv,
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
import { FACT_INDEX_ENQUEUER } from './brand-fact-index.runner';
import { extractDeterministicFactsFromSource } from './brand-facts.service';

type StoredBrand = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  truthAgreementIp: string | null;
};

type StoredFact = {
  id: string;
  tenantId: string;
  brandId: string;
  slot: string;
  title: string;
  content: string;
  sourceType: string;
  sourceUrl: string | null;
  indexStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

function createFactsStore(getTenantId: () => string | undefined) {
  const brands: StoredBrand[] = [];
  const facts: StoredFact[] = [];
  const chunks: Array<{ brandId: string; tenantId: string }> = [];
  let seq = 1;

  const makeDelegates = () => ({
    brand: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const tid = getTenantId();
        return brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid)) ?? null;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id: string };
          data: { truthAgreementSignedAt?: Date; truthAgreementIp?: string | null };
        }) => {
          const tid = getTenantId();
          const b = brands.find((x) => x.id === args.where.id && (!tid || x.tenantId === tid));
          if (!b) return { count: 0 };
          if (args.data.truthAgreementSignedAt !== undefined) {
            b.truthAgreementSignedAt = args.data.truthAgreementSignedAt;
          }
          if (args.data.truthAgreementIp !== undefined) {
            b.truthAgreementIp = args.data.truthAgreementIp;
          }
          return { count: 1 };
        },
      ),
    },
    brandFact: {
      findMany: vi.fn(async (args: { where: { brandId: string } }) => {
        const tid = getTenantId();
        return facts.filter(
          (f) => f.brandId === args.where.brandId && (!tid || f.tenantId === tid),
        );
      }),
      create: vi.fn(async (args: { data: Omit<StoredFact, 'id' | 'createdAt' | 'updatedAt'> }) => {
        const now = new Date();
        const row: StoredFact = {
          id: `fact_${seq++}`,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        facts.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id?: string | { in: string[] }; brandId: string; indexStatus?: string };
          data: Partial<StoredFact>;
        }) => {
          const tid = getTenantId();
          let count = 0;
          for (const f of facts) {
            if (f.brandId !== args.where.brandId) continue;
            if (tid && f.tenantId !== tid) continue;
            if (args.where.indexStatus && f.indexStatus !== args.where.indexStatus) continue;
            if (typeof args.where.id === 'string' && f.id !== args.where.id) continue;
            if (
              args.where.id &&
              typeof args.where.id === 'object' &&
              !args.where.id.in.includes(f.id)
            ) {
              continue;
            }
            Object.assign(f, args.data, { updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
    },
    brandFactChunk: {
      deleteMany: vi.fn(async (args: { where: { brandId: string } }) => {
        const tid = getTenantId();
        let count = 0;
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
          if (chunks[i]!.brandId === args.where.brandId && (!tid || chunks[i]!.tenantId === tid)) {
            chunks.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
  });

  const delegates = makeDelegates();
  const scoped = {
    ...delegates,
    $transaction: vi.fn(async <T>(fn: (tx: typeof delegates) => Promise<T>) => fn(delegates)),
  };

  return {
    scoped,
    brands,
    facts,
    chunks,
    seedBrand: (b: StoredBrand) => brands.push(b),
    clear: () => {
      brands.splice(0, brands.length);
      facts.splice(0, facts.length);
      chunks.splice(0, chunks.length);
    },
  };
}

describe('BrandFactsController & BrandFactsService (F7 HTTP & Unit)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let jwtAccessSecret: string;
  const store = createFactsStore(() => currentTenantId());
  const enqueueMock = vi.fn(async () => undefined);

  beforeAll(async () => {
    app = await createApiApp();
    jwtAccessSecret = parseEnv().JWT_ACCESS_SECRET;

    const authStore = app.get(PrismaAuthStore);
    vi.spyOn(authStore, 'findUserById').mockImplementation(async (userId: string) => {
      if (userId === 'u_a') {
        return {
          id: 'u_a',
          tenantId: 'tenant_a',
          username: 'a',
          passwordHash: 'hash',
          nickname: 'A',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant A',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
      }
      if (userId === 'u_b') {
        return {
          id: 'u_b',
          tenantId: 'tenant_b',
          username: 'b',
          passwordHash: 'hash',
          nickname: 'B',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant B',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
      }
      if (userId === 'u_exp') {
        return {
          id: 'u_exp',
          tenantId: 'tenant_exp',
          username: 'exp',
          passwordHash: 'hash',
          nickname: 'Exp',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Expired',
          isActive: true,
          expiresAt: new Date(Date.now() - 86_400_000),
        };
      }
      return null;
    });
    vi.spyOn(authStore, 'latestRevokeAt').mockResolvedValue(null);

    const prismaService = app.get(PrismaService);
    vi.spyOn(prismaService, 'scoped', 'get').mockReturnValue(
      store.scoped as unknown as PrismaService['scoped'],
    );

    const enqueuer = app.get<{ enqueueFactIndex: (j: unknown) => Promise<void> }>(
      FACT_INDEX_ENQUEUER,
    );
    vi.spyOn(enqueuer, 'enqueueFactIndex').mockImplementation(enqueueMock);

    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    store.clear();
    enqueueMock.mockClear();
    app.get(FreeActionRateLimiter).reset();
    store.seedBrand({
      id: 'brand_a1',
      tenantId: 'tenant_a',
      name: '青松存储',
      category: '家用NAS',
      truthAgreementSignedAt: null,
      truthAgreementIp: null,
    });
    store.seedBrand({
      id: 'brand_exp1',
      tenantId: 'tenant_exp',
      name: '过期品牌',
      category: '家用NAS',
      truthAgreementSignedAt: new Date(),
      truthAgreementIp: '127.0.0.1',
    });
  });

  function makeToken(userId: string, tenantId: string): string {
    const now = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: userId,
        tid: tenantId,
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hash'),
        lms: Date.now(),
        iat: now,
        exp: now + 3600,
      },
      jwtAccessSecret,
    );
  }

  it('enforces lightweight compliance attestation, prohibited industry check, >6000-char pgvector trigger, and expired tenant guards', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const headersA = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' };

    // 1. Unsigned brand without checkbox -> 400
    const unsignedRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({
        facts: [{ slot: 'PRODUCT_SPECS', content: '四盘位 NAS，28dB 静音' }],
      }),
    });
    expect(unsignedRes.status).toBe(400);

    // 2. Signed via agreeTruthTerms=true succeeds & persists truthAgreementSignedAt + IP
    const signedRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({
        facts: [
          { slot: 'PRODUCT_SPECS', content: '四盘位 NAS，满载噪音 28dB，待机功耗 14W' },
          { slot: 'CREDENTIALS', content: 'ISO9001 质量体系认证与国家 3C 认证' },
        ],
        agreeTruthTerms: true,
      }),
    });
    expect(signedRes.status).toBe(200);
    const signedBody = (await signedRes.json()) as {
      code: number;
      data: {
        truthAgreementSignedAt: string | null;
        vectorIndexRequired: boolean;
        items: Array<{ slot: string; indexStatus: string }>;
      };
    };
    expect(signedBody.code).toBe(0);
    expect(signedBody.data.truthAgreementSignedAt).not.toBeNull();
    expect(signedBody.data.vectorIndexRequired).toBe(false);
    expect(signedBody.data.items.every((f) => f.indexStatus === 'NONE')).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();

    // 3. Subsequent save on already-signed brand succeeds without re-sending checkbox, and >6000 chars enqueues fact-index
    const longDoc = '青松 DXP4800 静音散热结构与实测数据白皮书说明。'.repeat(300);
    expect(longDoc.length).toBeGreaterThan(BRAND_FACT_FULL_INJECT_MAX);
    const longRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({
        facts: [{ slot: 'EXTRA_DOC', title: '完整技术白皮书', content: longDoc }],
      }),
    });
    expect(longRes.status).toBe(200);
    const longBody = (await longRes.json()) as {
      data: { vectorIndexRequired: boolean; items: Array<{ indexStatus: string }> };
    };
    expect(longBody.data.vectorIndexRequired).toBe(true);
    expect(longBody.data.items.every((f) => f.indexStatus === 'INDEXING')).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith({ tenantId: 'tenant_a', brandId: 'brand_a1' });

    // 4. Shrinking back <= 6000 clears stale chunks and resets indexStatus to NONE
    store.chunks.push({ brandId: 'brand_a1', tenantId: 'tenant_a' });
    const shrinkRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({
        facts: [{ slot: 'EXTRA_DOC', title: '精简说明', content: '精简后的 20 字说明文档' }],
      }),
    });
    expect(shrinkRes.status).toBe(200);
    expect(store.chunks).toHaveLength(0);
    expect(
      (
        (await shrinkRes.json()) as { data: { items: Array<{ indexStatus: string }> } }
      ).data.items.every((f) => f.indexStatus === 'NONE'),
    ).toBe(true);

    // 5. Prohibited industry content -> 403 / 40302
    const forbiddenRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({
        facts: [{ slot: 'DIFFERENTIATORS', content: '提供线上赌博代理分润方案' }],
      }),
    });
    expect(forbiddenRes.status).toBe(403);
    expect(((await forbiddenRes.json()) as { code: number }).code).toBe(
      API_ERROR.FORBIDDEN_INDUSTRY,
    );

    // 6. Cross-tenant GET/PUT -> 404
    const tokenB = makeToken('u_b', 'tenant_b');
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts`, {
          headers: { authorization: `Bearer ${tokenB}` },
        })
      ).status,
    ).toBe(404);

    // 7. Expired tenant: GET -> 200, PUT & POST /extract -> 403 / 40301
    const tokenExp = makeToken('u_exp', 'tenant_exp');
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands/brand_exp1/facts`, {
          headers: { authorization: `Bearer ${tokenExp}` },
        })
      ).status,
    ).toBe(200);
    const expPut = await fetch(`${baseUrl}/api/v2/brands/brand_exp1/facts`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokenExp}`, 'content-type': 'application/json' },
      body: JSON.stringify({ facts: [{ slot: 'PRODUCT_SPECS', content: 'test' }] }),
    });
    expect(expPut.status).toBe(403);
    expect(((await expPut.json()) as { code: number }).code).toBe(API_ERROR.TENANT_EXPIRED);
  });

  it('extracts 4 structured fact slots from text, SSRF-guarded URL, and .txt/.md/.pdf uploads, enforces rate limits & #321', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const authOnly = { authorization: `Bearer ${tokenA}` };
    const jsonHeaders = { ...authOnly, 'content-type': 'application/json' };

    // 1. Pasted text extraction
    const textRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        text: [
          '核心产品参数：Intel N100 四核，16GB DDR5，满载噪音 28dB，待机功耗 14W。',
          '差异化卖点：免工具快拆盘架，静音降低 35%，本地 AI 离线相册识别。',
          '权威资质：通过 ISO9001 质量认证与国家 3C 认证，获得 2025 红点奖。',
          '真实客户案例：服务 12,000+ 家庭与影视工作室，4K 剪辑回传耗时缩短 42%。',
        ].join('\n'),
      }),
    });
    expect(textRes.status).toBe(200);
    const textBody = (await textRes.json()) as {
      code: number;
      data: { facts: Array<{ slot: string; content: string }> };
    };
    expect(textBody.code).toBe(0);
    expect(textBody.data.facts.map((f) => f.slot)).toEqual([...BRAND_FACT_CORE_SLOTS]);
    expect(textBody.data.facts[0]?.content).toContain('28dB');
    expect(textBody.data.facts[2]?.content).toContain('ISO9001');

    // 2. URL extraction via PublicFetchService
    const publicFetch = app.get(PublicFetchService);
    const fetchSpy = vi.spyOn(publicFetch, 'fetch').mockImplementation(async (url: string) => {
      if (url.includes('127.0.0.1') || url.includes('169.254.169.254')) {
        throw new ProviderError(PROVIDER_KIND.SSRF, '禁止访问内网地址', 'private_ip');
      }
      return {
        url,
        status: 200,
        contentType: 'text/html',
        body: '<article><h1>DXP4800 Specs</h1><p>16GB DDR5, Dual 2.5GbE, 28dB quiet NAS. Certified ISO9001 and Red Dot Award. Deployed by 12,000 studios.</p></article>',
        bytes: 200,
      };
    });

    const urlRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ url: 'https://example.com/dxp4800' }),
    });
    expect(urlRes.status).toBe(200);
    const urlBody = (await urlRes.json()) as { data: { sourceType: string; sourceUrl: string } };
    expect(urlBody.data.sourceType).toBe('URL_EXTRACT');
    expect(urlBody.data.sourceUrl).toBe('https://example.com/dxp4800');

    // 3. SSRF private IP blocked -> 400
    const ssrfRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    expect(ssrfRes.status).toBe(400);
    fetchSpy.mockRestore();

    // 4. Multipart .md and .pdf uploads succeed; disguised PNG-as-.md and .exe rejected with 400
    const mdForm = new FormData();
    mdForm.append(
      'file',
      new Blob(['# 产品参数\n16GB DDR5，双 2.5GbE 网口，ISO9001 认证，服务 1000 家工作室。'], {
        type: 'text/markdown',
      }),
      'specs.md',
    );
    const mdRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: authOnly,
      body: mdForm,
    });
    expect(mdRes.status).toBe(200);

    const pdfBytes = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Length 90 >>\nstream\nBT /F1 12 Tf (NordVault X400 Pro 16GB ECC DDR5 Dual 10GbE ISO9001 Certified) Tj ET\nendstream\nendobj\n%%EOF',
      'latin1',
    );
    const pdfForm = new FormData();
    pdfForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'brochure.pdf');
    const pdfRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: authOnly,
      body: pdfForm,
    });
    expect(pdfRes.status).toBe(200);

    // Disguised PNG renamed to .md -> 400
    const disguisedForm = new FormData();
    disguisedForm.append(
      'file',
      new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])], {
        type: 'text/markdown',
      }),
      'fake.md',
    );
    const disguisedRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: authOnly,
      body: disguisedForm,
    });
    expect(disguisedRes.status).toBe(400);

    // Unsupported extension .exe -> 400
    const exeForm = new FormData();
    exeForm.append(
      'file',
      new Blob(['hello world long text here'], { type: 'application/octet-stream' }),
      'bad.exe',
    );
    const exeRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: authOnly,
      body: exeForm,
    });
    expect(exeRes.status).toBe(400);

    // 5. #321: when real primary route degrades to fake under STRICT, reject with 503 (never return fake draft)
    const llm = app.get(LlmService);
    const usesFakeSpy = vi.spyOn(llm, 'usesFakePrimary').mockReturnValue(false);
    const fallbackSpy = vi.spyOn(llm, 'hasFakeFallback').mockReturnValue(false);
    const strictRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ text: '真实模型降级拦截测试文本内容超过十个字。' }),
    });
    expect(strictRes.status).toBe(503);
    usesFakeSpy.mockRestore();
    fallbackSpy.mockRestore();

    // 6. Rate limiter -> 429 / 42901 + Retry-After header once quota of 10/min is exceeded
    const limiter = app.get(FreeActionRateLimiter);
    limiter.reset();
    let hit429 = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ text: `限流测试文本第 ${i + 1} 次提交，满足最少十个字要求。` }),
      });
      if (r.status === 429) {
        hit429 = true;
        expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(((await r.json()) as { code: number }).code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
        break;
      }
    }
    expect(hit429).toBe(true);
  });

  it('prefers explicit H2 section headings over generic line regexes and does not match on-device as CE', () => {
    const structured = [
      'Product Specifications',
      '16GB ECC DDR5 memory and 26 dBA acoustic noise rating at $599 MSRP.',
      'Key Differentiators',
      'Zero-subscription local AI indexing runs 100% on-device with no cloud lock-in.',
      'Certifications & Credentials',
      'Certified to UL, CE, and FCC Class B standards with SOC 2 Type II audit.',
      'Customer Case Studies',
      'Trusted by 8,500+ creative agencies across North America.',
    ].join('\n');

    const drafts = extractDeterministicFactsFromSource(structured, 'NordVault', 'X400 Pro');
    const bySlot = new Map(drafts.map((d) => [d.slot, d.content]));
    expect(bySlot.get('PRODUCT_SPECS')).toContain('16GB ECC DDR5');
    expect(bySlot.get('DIFFERENTIATORS')).toContain('100% on-device');
    expect(bySlot.get('CREDENTIALS')).not.toContain('on-device');
    expect(bySlot.get('CREDENTIALS')).toContain('UL, CE, and FCC');
    expect(bySlot.get('CASE_STUDIES')).toContain('8,500+ creative agencies');
  });

  it('preserves CN Markdown bullet facts without swallowing bullets as headings or leaking ## headings into slots', () => {
    const cnMarkdown = [
      '## 核心产品参数',
      '- 16GB ECC DDR5 内存',
      '- Intel N100 处理器，满载噪音 24dBA',
      '## 权威资质与背书',
      '- 通过 CE、FCC、ISO9001 质量体系认证',
      '- 拥有 18 项国家发明专利',
      '- 荣获 2025 德国红点设计奖项',
      '## 真实客户案例',
      '- 服务 120 家影视后期工作室',
    ].join('\n');

    const drafts = extractDeterministicFactsFromSource(cnMarkdown, '青松存储', '');
    const bySlot = new Map(drafts.map((d) => [d.slot, d.content]));

    expect(bySlot.get('PRODUCT_SPECS')).toContain('16GB ECC DDR5 内存');
    expect(bySlot.get('PRODUCT_SPECS')).toContain('Intel N100 处理器，满载噪音 24dBA');

    expect(bySlot.get('CREDENTIALS')).toContain('通过 CE、FCC、ISO9001 质量体系认证');
    expect(bySlot.get('CREDENTIALS')).toContain('拥有 18 项国家发明专利');
    expect(bySlot.get('CREDENTIALS')).toContain('荣获 2025 德国红点设计奖项');

    expect(bySlot.get('CASE_STUDIES')).toContain('服务 120 家影视后期工作室');

    for (const draft of drafts) {
      expect(draft.content).not.toMatch(/^#+\s/m);
      expect(draft.content).not.toContain('核心产品参数');
      expect(draft.content).not.toContain('权威资质与背书');
      expect(draft.content).not.toContain('真实客户案例');
    }
  });

  it('preserves EN Markdown bullet facts without swallowing bullets as headings or leaking ## headings into slots', () => {
    const enMarkdown = [
      '## Technical Specs',
      '- 16GB DDR5 hardware platform',
      '- 14.5W idle power consumption',
      '## Certifications',
      '- ISO 27001 certified',
      '- SOC 2 Type II compliance',
      '- Red Dot Design Award 2025',
      '## Customer Case Studies',
      '- Deployed across 200 media studios',
    ].join('\n');

    const drafts = extractDeterministicFactsFromSource(enMarkdown, 'NordVault', '');
    const bySlot = new Map(drafts.map((d) => [d.slot, d.content]));

    expect(bySlot.get('PRODUCT_SPECS')).toContain('16GB DDR5 hardware platform');
    expect(bySlot.get('PRODUCT_SPECS')).toContain('14.5W idle power consumption');

    expect(bySlot.get('CREDENTIALS')).toContain('ISO 27001 certified');
    expect(bySlot.get('CREDENTIALS')).toContain('SOC 2 Type II compliance');
    expect(bySlot.get('CREDENTIALS')).toContain('Red Dot Design Award 2025');

    expect(bySlot.get('CASE_STUDIES')).toContain('Deployed across 200 media studios');

    for (const draft of drafts) {
      expect(draft.content).not.toMatch(/^#+\s/m);
      expect(draft.content).not.toContain('Technical Specs');
      expect(draft.content).not.toContain('Certifications');
      expect(draft.content).not.toContain('Customer Case Studies');
    }
  });

  it('preserves leading decimal specs verbatim in direct extraction and strips valid numbered/+ bullet markers', () => {
    const decimalSpecs = [
      '## 核心产品参数',
      '14.5W idle power consumption',
      '2.5GbE 双网口配置',
      '3.5英寸四盘位全金属机身',
      '99.9% 企业级可用性 SLA',
      '0.5ms 极速响应延迟',
      '## 差异化卖点',
      '1. 免工具快拆金属盘架',
      '2) 低噪音风道架构',
      '3、离线本地 AI 相册索引',
      '4）无强制云端订阅锁死',
      '+ 模块化热插拔冗余电源',
    ].join('\n');

    const drafts = extractDeterministicFactsFromSource(decimalSpecs, '青松存储', '');
    const bySlot = new Map(drafts.map((d) => [d.slot, d.content]));

    const specsLines = (bySlot.get('PRODUCT_SPECS') ?? '').split('\n');
    expect(specsLines).toEqual([
      '14.5W idle power consumption',
      '2.5GbE 双网口配置',
      '3.5英寸四盘位全金属机身',
      '99.9% 企业级可用性 SLA',
      '0.5ms 极速响应延迟',
    ]);

    const diffLines = (bySlot.get('DIFFERENTIATORS') ?? '').split('\n');
    expect(diffLines).toEqual([
      '免工具快拆金属盘架',
      '低噪音风道架构',
      '离线本地 AI 相册索引',
      '无强制云端订阅锁死',
      '模块化热插拔冗余电源',
    ]);
  });

  it('preserves leading decimal specs and concise same-slot HTML <li> facts during end-to-end URL extraction', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const jsonHeaders = {
      authorization: `Bearer ${tokenA}`,
      'content-type': 'application/json',
    };
    const publicFetch = app.get(PublicFetchService);

    const fetchSpy = vi.spyOn(publicFetch, 'fetch').mockImplementation(async (url: string) => {
      if (url.includes('/cn')) {
        return {
          url,
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: [
            '<article>',
            '<h2>核心产品参数</h2>',
            '<ul>',
            '<li>2.5GbE 双网口配置</li>',
            '<li>3.5英寸四盘位全金属机身</li>',
            '<li>99.9% 企业级可用性 SLA</li>',
            '<li>0.5ms 极速响应延迟</li>',
            '</ul>',
            '<h2>权威资质与背书</h2>',
            '<ul>',
            '<li>国家发明专利</li>',
            '<li>德国红点奖项</li>',
            '</ul>',
            '</article>',
          ].join(''),
          bytes: 360,
        };
      }
      return {
        url,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: [
          '<article>',
          '<h2>Technical Specs</h2>',
          '<ul>',
          '<li>16GB ECC DDR5 hardware platform</li>',
          '<li>14.5W idle power consumption</li>',
          '</ul>',
          '<h2>Certifications</h2>',
          '<ul>',
          '<li>Red Dot Design Award</li>',
          '<li>ISO Certified</li>',
          '</ul>',
          '</article>',
        ].join(''),
        bytes: 320,
      };
    });

    try {
      const enRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ url: 'https://example.com/en-specs' }),
      });
      expect(enRes.status).toBe(200);
      const enBody = (await enRes.json()) as {
        code: number;
        data: { facts: Array<{ slot: string; content: string }> };
      };
      const enBySlot = new Map(enBody.data.facts.map((f) => [f.slot, f.content]));
      expect((enBySlot.get('PRODUCT_SPECS') ?? '').split('\n')).toEqual([
        '16GB ECC DDR5 hardware platform',
        '14.5W idle power consumption',
      ]);
      expect((enBySlot.get('CREDENTIALS') ?? '').split('\n')).toEqual([
        'Red Dot Design Award',
        'ISO Certified',
      ]);
      expect(enBySlot.get('CREDENTIALS')).not.toContain('Certifications');

      const cnRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ url: 'https://example.com/cn-specs' }),
      });
      expect(cnRes.status).toBe(200);
      const cnBody = (await cnRes.json()) as {
        code: number;
        data: { facts: Array<{ slot: string; content: string }> };
      };
      const cnBySlot = new Map(cnBody.data.facts.map((f) => [f.slot, f.content]));
      expect((cnBySlot.get('PRODUCT_SPECS') ?? '').split('\n')).toEqual([
        '2.5GbE 双网口配置',
        '3.5英寸四盘位全金属机身',
        '99.9% 企业级可用性 SLA',
        '0.5ms 极速响应延迟',
      ]);
      expect((cnBySlot.get('CREDENTIALS') ?? '').split('\n')).toEqual([
        '国家发明专利',
        '德国红点奖项',
      ]);
      expect(cnBySlot.get('CREDENTIALS')).not.toContain('权威资质与背书');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves decimals, M.2, prices, and URLs intact in >220-char EN & CN paragraphs (direct and HTML URL extraction)', async () => {
    const enLongParagraph =
      'AuroraNAS DXP4800 Pro is an enterprise desktop storage appliance engineered for creative studios requiring 14.5W idle power consumption, 2.5GbE dual Ethernet throughput, 3.5-inch quad drive bays, dual M.2 NVMe cache slots, 99.9% uptime SLA, 0.5ms response latency, and $499.99 launch pricing. Full engineering documentation is published at https://docs.auroranas.com/dxp4800-pro-specs for verification.';
    expect(enLongParagraph.length).toBeGreaterThan(220);

    const cnLongParagraph =
      '极光存储 DXP4800 旗舰款面向专业影音后期工作室、设计机构与成长型中小企业打造，整机采用全金属航空级铝合金机身与低噪贯穿式风道散热设计，在连续满载与日常待机实测环境中均表现卓越，支持 14.5W 超低待机功耗与 2.5GbE 双网口链路聚合高速传输，全面兼容 3.5英寸四盘位大容量企业级机械硬盘与双 M.2 NVMe 固态缓存加速，提供 99.9% 企业级高可用性保障及 0.5ms 极速缓存响应延迟，配套 3.x 固件生态持续在线更新。官方原装减震支架扩展配件套装统一零售价为 100.00元';
    expect(cnLongParagraph.length).toBeGreaterThan(220);

    const cnTrailingPriceLine =
      '极光存储 DXP4800 旗舰款面向专业影音后期工作室、设计机构与成长型中小企业打造，整机采用全金属航空级铝合金机身与低噪贯穿式风道散热设计，在连续满载与日常待机实测环境中均表现卓越，支持 14.5W 超低待机功耗与 2.5GbE 双网口链路聚合高速传输，全面兼容 3.5英寸四盘位大容量企业级机械硬盘与双 M.2 NVMe 固态缓存加速，提供 99.9% 企业级高可用性保障及 0.5ms 极速缓存响应延迟，官方原装减震支架扩展配件套装统一零售价为 100.00元';
    expect(cnTrailingPriceLine.length).toBeGreaterThan(220);

    // 1. Direct extraction (EN + URL)
    const enDrafts = extractDeterministicFactsFromSource(
      `## Technical Specs\n${enLongParagraph}`,
      'AuroraNAS',
      '',
    );
    const enSpecs = enDrafts.find((d) => d.slot === 'PRODUCT_SPECS')?.content ?? '';
    expect(enSpecs).toContain('14.5W');
    expect(enSpecs).toContain('2.5GbE');
    expect(enSpecs).toContain('3.5-inch');
    expect(enSpecs).toContain('M.2 NVMe');
    expect(enSpecs).toContain('99.9%');
    expect(enSpecs).toContain('0.5ms');
    expect(enSpecs).toContain('$499.99');
    expect(enSpecs).toContain('https://docs.auroranas.com/dxp4800-pro-specs');
    expect(enSpecs.split('\n')).toHaveLength(2);

    // 2. Direct extraction (CN + trailing 100.00元 without period)
    const cnDrafts = extractDeterministicFactsFromSource(
      `## 核心产品参数\n${cnLongParagraph}`,
      '极光存储',
      '',
    );
    const cnSpecs = cnDrafts.find((d) => d.slot === 'PRODUCT_SPECS')?.content ?? '';
    expect(cnSpecs).toContain('14.5W');
    expect(cnSpecs).toContain('2.5GbE');
    expect(cnSpecs).toContain('3.5英寸');
    expect(cnSpecs).toContain('M.2 NVMe');
    expect(cnSpecs).toContain('99.9%');
    expect(cnSpecs).toContain('0.5ms');
    expect(cnSpecs).toContain('3.x 固件');
    expect(cnSpecs).toContain('100.00元');
    expect(cnSpecs.split('\n')).toHaveLength(2);

    const trailingDrafts = extractDeterministicFactsFromSource(
      `## 核心产品参数\n${cnTrailingPriceLine}`,
      '极光存储',
      '',
    );
    const trailingSpecs = trailingDrafts.find((d) => d.slot === 'PRODUCT_SPECS')?.content ?? '';
    expect(trailingSpecs).toContain('100.00元');
    expect(trailingSpecs.endsWith('100.')).toBe(false);

    // 3. End-to-end HTML <p> URL extraction for both EN & CN long paragraphs
    const tokenA = makeToken('u_a', 'tenant_a');
    const jsonHeaders = {
      authorization: `Bearer ${tokenA}`,
      'content-type': 'application/json',
    };
    const publicFetch = app.get(PublicFetchService);
    const fetchSpy = vi.spyOn(publicFetch, 'fetch').mockImplementation(async (url: string) => {
      if (url.includes('/cn-long')) {
        return {
          url,
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<article><h2>核心产品参数</h2><p>${cnLongParagraph}</p></article>`,
          bytes: Buffer.byteLength(cnLongParagraph),
        };
      }
      return {
        url,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<article><h2>Technical Specs</h2><p>${enLongParagraph}</p></article>`,
        bytes: Buffer.byteLength(enLongParagraph),
      };
    });

    try {
      const enRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ url: 'https://example.com/en-long' }),
      });
      expect(enRes.status).toBe(200);
      const enBody = (await enRes.json()) as {
        data: { facts: Array<{ slot: string; content: string }> };
      };
      const enHtmlSpecs = enBody.data.facts.find((f) => f.slot === 'PRODUCT_SPECS')?.content ?? '';
      for (const token of [
        '14.5W',
        '2.5GbE',
        '3.5-inch',
        'M.2 NVMe',
        '99.9%',
        '0.5ms',
        '$499.99',
        'https://docs.auroranas.com/dxp4800-pro-specs',
      ]) {
        expect(enHtmlSpecs).toContain(token);
      }

      const cnRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/facts/extract`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ url: 'https://example.com/cn-long' }),
      });
      expect(cnRes.status).toBe(200);
      const cnBody = (await cnRes.json()) as {
        data: { facts: Array<{ slot: string; content: string }> };
      };
      const cnHtmlSpecs = cnBody.data.facts.find((f) => f.slot === 'PRODUCT_SPECS')?.content ?? '';
      for (const token of [
        '14.5W',
        '2.5GbE',
        '3.5英寸',
        'M.2 NVMe',
        '99.9%',
        '0.5ms',
        '3.x 固件',
        '100.00元',
      ]) {
        expect(cnHtmlSpecs).toContain(token);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('completes in linear time (<200ms) on 50,000-char adversarial ReDoS inputs and still matches spec tokens', () => {
    const adversarialInputs = [
      '1'.repeat(50_000),
      ' '.repeat(50_000),
      'a'.repeat(50_000),
      '.'.repeat(50_000),
    ];

    for (const payload of adversarialInputs) {
      const start = performance.now();
      const drafts = extractDeterministicFactsFromSource(payload, 'Brand', '');
      const elapsedMs = performance.now() - start;
      expect(drafts).toHaveLength(4);
      expect(elapsedMs).toBeLessThan(200);
    }

    // Verify single-digit lookahead still classifies common spec formats accurately without headings
    const unlabeledSpecs = [
      '14.5W standby draw with 16 GB DDR5 memory',
      'Dual 2.5GbE ports and 24 dBA acoustic noise',
      'Launch price $499.99 or 100.00元 accessory kit',
    ].join('\n');
    const drafts = extractDeterministicFactsFromSource(unlabeledSpecs, 'AuroraNAS', '');
    const specs = drafts.find((d) => d.slot === 'PRODUCT_SPECS')?.content ?? '';
    expect(specs).toContain('14.5W');
    expect(specs).toContain('2.5GbE');
    expect(specs).toContain('$499.99');
  });

  it('cleanly ignores bare marker-only empty bullet lines without dropping valid signed/decimal specs', () => {
    const input = [
      '## 核心产品参数',
      '- ',
      '* ',
      '+ ',
      '• ',
      '1. ',
      '2) ',
      '3、',
      '4） ',
      '14.5W 低功耗待机',
      '-20°C 宽温运行支持',
      '+3dB 声压余量冗余',
    ].join('\n');

    const drafts = extractDeterministicFactsFromSource(input, '青松存储', '');
    const specsLines = (drafts.find((d) => d.slot === 'PRODUCT_SPECS')?.content ?? '').split('\n');
    expect(specsLines).toEqual(['14.5W 低功耗待机', '-20°C 宽温运行支持', '+3dB 声压余量冗余']);

    for (const draft of drafts) {
      const lines = draft.content.split('\n').map((l) => l.trim());
      for (const bare of ['-', '*', '+', '•', '1.', '2)', '3、', '4）']) {
        expect(lines).not.toContain(bare);
      }
    }
  });
});
