import { DB_EMBEDDING_DIMENSIONS } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingService, fakeEmbedding } from '../infra/embedding';
import type { PrismaService } from '../prisma/prisma.service';
import { BrandFactIndexRunner } from './brand-fact-index.runner';

describe('BrandFactIndexRunner', () => {
  it('chunks and embeds >6000-char facts into vector(1024) chunks with explicit tenantId+brandId and marks READY', async () => {
    const longContent =
      '青松 DXP4800 四盘位私有云搭载 Intel N100 处理器与双 2.5GbE 网口，满载噪音 28dB。'.repeat(
        180,
      );
    const executeRaw = vi.fn(async () => 1);
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));

    const prisma = {
      base: {
        brand: {
          findFirst: vi.fn(async () => ({
            id: 'brand_1',
            facts: [
              { id: 'fact_1', slot: 'EXTRA_DOC', title: '完整白皮书', content: longContent },
              { id: 'fact_2', slot: 'CASE_STUDIES', title: '案例', content: '   ' },
            ],
          })),
        },
        brandFact: { updateMany: vi.fn(async () => ({ count: 1 })) },
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            brandFactChunk: { deleteMany },
            brandFact: { updateMany },
            $executeRaw: executeRaw,
          }),
        ),
      },
    } as unknown as PrismaService;

    const embedding = EmbeddingService.fromEnv({ EMBEDDING_PROVIDER: 'fake' });
    const runner = new BrandFactIndexRunner(prisma, embedding);

    const result = await runner.process({ tenantId: 'tenant_1', brandId: 'brand_1' });
    expect(result.chunkCount).toBeGreaterThan(5);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', brandId: 'brand_1' },
    });
    expect(executeRaw).toHaveBeenCalledTimes(result.chunkCount);
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', brandId: 'brand_1', id: { in: ['fact_1'] } },
      data: { indexStatus: 'READY' },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', brandId: 'brand_1', id: { in: ['fact_2'] } },
      data: { indexStatus: 'NONE' },
    });
  });

  it('clears stale chunks and sets indexStatus=NONE when facts shrink <= 6000 chars', async () => {
    const deleteMany = vi.fn(async () => ({ count: 4 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));

    const prisma = {
      base: {
        brand: {
          findFirst: vi.fn(async () => ({
            id: 'brand_1',
            facts: [{ id: 'fact_1', slot: 'PRODUCT_SPECS', title: '参数', content: '四盘位 NAS' }],
          })),
        },
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            brandFactChunk: { deleteMany },
            brandFact: { updateMany },
          }),
        ),
      },
    } as unknown as PrismaService;

    const runner = new BrandFactIndexRunner(
      prisma,
      EmbeddingService.fromEnv({ EMBEDDING_PROVIDER: 'fake' }),
    );
    const result = await runner.process({ tenantId: 'tenant_1', brandId: 'brand_1' });
    expect(result).toEqual({ chunkCount: 0 });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', brandId: 'brand_1' },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', brandId: 'brand_1' },
      data: { indexStatus: 'NONE' },
    });
  });

  it('marks INDEXING facts as FAILED and rethrows when embedding fails', async () => {
    const longContent = '实测参数说明。'.repeat(1200);
    const failUpdateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      base: {
        brand: {
          findFirst: vi.fn(async () => ({
            id: 'brand_1',
            facts: [{ id: 'fact_1', slot: 'EXTRA_DOC', title: '长文档', content: longContent }],
          })),
        },
        brandFact: { updateMany: failUpdateMany },
      },
    } as unknown as PrismaService;

    const brokenEmbedding = {
      embed: vi.fn(async () => {
        throw new Error('embedding upstream down');
      }),
    } as unknown as EmbeddingService;

    const runner = new BrandFactIndexRunner(prisma, brokenEmbedding);
    await expect(runner.process({ tenantId: 'tenant_1', brandId: 'brand_1' })).rejects.toThrow(
      'embedding upstream down',
    );
    expect(failUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', brandId: 'brand_1', indexStatus: 'INDEXING' },
      data: { indexStatus: 'FAILED' },
    });
  });

  it('retrieves vector chunks when READY and falls back cleanly to direct facts when NONE or embedding fails', async () => {
    const queryRaw = vi.fn(async () => [
      {
        factId: 'fact_2',
        slot: 'CREDENTIALS',
        title: '权威资质',
        seq: 0,
        content: 'ISO9001 与红点奖认证',
        distance: 0.12,
      },
      {
        factId: 'fact_1',
        slot: 'PRODUCT_SPECS',
        title: '核心参数',
        seq: 1,
        content: '满载噪音 28dB，待机功耗 14W',
        distance: 0.08,
      },
    ]);

    const prisma = {
      base: {
        brandFact: {
          findMany: vi.fn(async () => [
            {
              id: 'fact_2',
              slot: 'CREDENTIALS',
              title: '权威资质',
              content: 'ISO9001 与红点奖认证',
              indexStatus: 'READY',
              updatedAt: new Date(),
            },
            {
              id: 'fact_1',
              slot: 'PRODUCT_SPECS',
              title: '核心参数',
              content: '满载噪音 28dB，待机功耗 14W',
              indexStatus: 'READY',
              updatedAt: new Date(),
            },
          ]),
        },
        $queryRaw: queryRaw,
      },
    } as unknown as PrismaService;

    const embedding = {
      embed: vi.fn(async () => ({
        provider: 'fake',
        model: 'fake-bge-m3',
        fake: true,
        dimensions: DB_EMBEDDING_DIMENSIONS,
        vectors: [fakeEmbedding('安静低功耗 NAS')],
        note: '',
      })),
    } as unknown as EmbeddingService;

    const runner = new BrandFactIndexRunner(prisma, embedding);
    const vectorHits = await runner.retrieveRelevantBrandFacts(
      'tenant_1',
      'brand_1',
      '安静 NAS',
      5,
    );
    expect(vectorHits).toHaveLength(2);
    expect(vectorHits[0]).toMatchObject({ slot: 'PRODUCT_SPECS', source: 'vector' });
    expect(vectorHits[1]).toMatchObject({ slot: 'CREDENTIALS', source: 'vector' });

    // Fallback to direct facts if embedding throws
    (embedding.embed as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('timeout'));
    const fallbackHits = await runner.retrieveRelevantBrandFacts('tenant_1', 'brand_1', '安静 NAS');
    expect(fallbackHits).toHaveLength(2);
    expect(fallbackHits.every((item) => item.source === 'direct')).toBe(true);
  });

  it('isolates product-line facts with zero cross-line bleed and prioritizes line-specific facts ahead of general facts (direct + vector)', async () => {
    const now = new Date();
    const findMany = vi.fn(async () => [
      {
        id: 'fact_general_specs',
        slot: 'PRODUCT_SPECS',
        title: '通用参数',
        content: 'Brand-wide UL2743 certification',
        productLineId: null,
        indexStatus: 'NONE',
        updatedAt: now,
      },
      {
        id: 'fact_lineA_case',
        slot: 'CASE_STUDIES',
        title: 'Line A Case',
        content: 'HeliosPower 2048Wh camping runtime',
        productLineId: 'pl_lineA',
        indexStatus: 'NONE',
        updatedAt: now,
      },
      {
        id: 'fact_lineB_secret',
        slot: 'PRODUCT_SPECS',
        title: 'Line B Secret',
        content: 'LINEB_SECRET_NAS_4BAY_NEVER_LEAK',
        productLineId: 'pl_lineB',
        indexStatus: 'NONE',
        updatedAt: now,
      },
    ]);

    const queryRaw = vi.fn(async (..._args: unknown[]) => [
      {
        factId: 'fact_general_cred',
        slot: 'CREDENTIALS',
        title: 'Brand Cert',
        productLineId: null,
        seq: 0,
        content: 'General ISO9001 cert',
        distance: 0.09,
      },
      {
        factId: 'fact_lineA_doc',
        slot: 'EXTRA_DOC',
        title: 'Line A Doc',
        productLineId: 'pl_lineA',
        seq: 0,
        content: 'Line A solar inverter efficiency 95%',
        distance: 0.11,
      },
      {
        factId: 'fact_lineB_vector',
        slot: 'EXTRA_DOC',
        title: 'Line B Vector Doc',
        productLineId: 'pl_lineB',
        seq: 0,
        content: 'LINEB_VECTOR_SECRET_MUST_BE_FILTERED',
        distance: 0.05,
      },
    ]);

    const prisma = {
      base: {
        brandFact: { findMany },
        $queryRaw: queryRaw,
      },
    } as unknown as PrismaService;

    const embedding = {
      embed: vi.fn(async () => ({
        provider: 'fake',
        model: 'fake-bge-m3',
        fake: true,
        dimensions: DB_EMBEDDING_DIMENSIONS,
        vectors: [fakeEmbedding('portable power station')],
        note: '',
      })),
    } as unknown as EmbeddingService;

    const runner = new BrandFactIndexRunner(prisma, embedding);

    // 1. Direct fallback path: Line A prioritized ahead of general even if general has earlier slot, 0 Line B bleed
    const directHits = await runner.retrieveRelevantBrandFacts(
      'tenant_1',
      'brand_1',
      'portable power station',
      5,
      'pl_lineA',
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_1',
          brandId: 'brand_1',
          OR: [{ productLineId: null }, { productLineId: 'pl_lineA' }],
        },
      }),
    );
    expect(directHits.map((h) => h.factId)).toEqual(['fact_lineA_case', 'fact_general_specs']);
    expect(directHits.some((h) => h.content.includes('LINEB_SECRET'))).toBe(false);

    // 2. Vector pgvector path: SQL includes productLineId filter + boost, defensive JS filter strips Line B, Line A sorted first
    findMany.mockResolvedValueOnce([
      {
        id: 'fact_general_cred',
        slot: 'CREDENTIALS',
        title: 'Brand Cert',
        content: 'General ISO9001 cert',
        productLineId: null,
        indexStatus: 'READY',
        updatedAt: now,
      },
      {
        id: 'fact_lineA_doc',
        slot: 'EXTRA_DOC',
        title: 'Line A Doc',
        content: 'Line A solar inverter efficiency 95%',
        productLineId: 'pl_lineA',
        indexStatus: 'READY',
        updatedAt: now,
      },
    ]);

    const vectorHits = await runner.retrieveRelevantBrandFacts(
      'tenant_1',
      'brand_1',
      'portable power station',
      5,
      'pl_lineA',
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sqlStrings =
      (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join(' ') ?? '';
    expect(sqlStrings).toContain('f."productLineId"');
    expect(sqlStrings).toContain('0.08');
    expect(vectorHits.map((h) => h.factId)).toEqual(['fact_lineA_doc', 'fact_general_cred']);
    expect(vectorHits.some((h) => h.content.includes('LINEB_VECTOR_SECRET'))).toBe(false);
  });
});
