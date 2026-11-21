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
});
