import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BRAND_FACT_CHUNK_OVERLAP,
  BRAND_FACT_CHUNK_SIZE,
  BRAND_FACT_FULL_INJECT_MAX,
  BRAND_FACT_SLOTS,
  BRAND_FACT_TOP_K_CHUNKS,
  EMBEDDING_MAX_BATCH,
  EMBEDDING_MAX_CHARS,
  chunkBrandFactText,
  requiresBrandFactVectorIndex,
  type BrandFactSlot,
} from '@geomix/shared';
import { EmbeddingService, assertEmbeddingWidth } from '../infra/embedding';
import { PrismaService } from '../prisma/prisma.service';

export const FACT_INDEX_HANDLER = Symbol('FACT_INDEX_HANDLER');
export const FACT_INDEX_ENQUEUER = Symbol('FACT_INDEX_ENQUEUER');

export type FactIndexJobData = {
  tenantId: string;
  brandId: string;
};

export interface FactIndexHandler {
  process(payload: FactIndexJobData): Promise<{ chunkCount: number }>;
}

export interface FactIndexEnqueuer {
  enqueueFactIndex(job: FactIndexJobData): Promise<void>;
}

export type RetrievedBrandFactSnippet = {
  factId: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
  productLineId?: string | null;
  source: 'direct' | 'vector';
  distance?: number;
};

const SLOT_ORDER: Readonly<Record<BrandFactSlot, number>> = {
  PRODUCT_SPECS: 0,
  DIFFERENTIATORS: 1,
  CREDENTIALS: 2,
  CASE_STUDIES: 3,
  EXTRA_DOC: 4,
};

function slotPriority(slot: string): number {
  return slot in SLOT_ORDER ? SLOT_ORDER[slot as BrandFactSlot] : 99;
}

function toBrandFactSlot(raw: string): BrandFactSlot {
  return (BRAND_FACT_SLOTS as readonly string[]).includes(raw)
    ? (raw as BrandFactSlot)
    : 'EXTRA_DOC';
}

type VectorChunkRow = {
  factId: string;
  slot: string;
  title: string;
  productLineId?: string | null;
  seq: number;
  content: string;
  distance: number;
};

/**
 * 品牌长事实后台切片向量化与检索执行器（vector(1024) + HNSW cosine）。
 * 所有写入与查询均显式携带 tenantId + brandId 隔离。
 */
@Injectable()
export class BrandFactIndexRunner implements FactIndexHandler {
  private readonly logger = new Logger(BrandFactIndexRunner.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmbeddingService) private readonly embedding: EmbeddingService,
  ) {}

  async process(payload: FactIndexJobData): Promise<{ chunkCount: number }> {
    const { tenantId, brandId } = payload;

    try {
      const brand = await this.prisma.base.brand.findFirst({
        where: { id: brandId, tenantId },
        select: {
          id: true,
          facts: {
            select: {
              id: true,
              slot: true,
              title: true,
              content: true,
            },
            orderBy: [{ slot: 'asc' }, { updatedAt: 'desc' }],
          },
        },
      });

      if (!brand) {
        return { chunkCount: 0 };
      }

      const totalChars = brand.facts.reduce((sum, item) => sum + item.content.length, 0);
      const maxSingleChars = brand.facts.reduce(
        (max, item) => Math.max(max, item.content.length),
        0,
      );

      const chunkItems: Array<{ factId: string; seq: number; content: string }> = [];
      const nonEmptyFactIds: string[] = [];

      for (const fact of brand.facts) {
        const trimmed = fact.content.trim();
        if (!trimmed) continue;
        nonEmptyFactIds.push(fact.id);
        const pieces = chunkBrandFactText(trimmed, BRAND_FACT_CHUNK_SIZE, BRAND_FACT_CHUNK_OVERLAP);
        pieces.forEach((piece, seq) => {
          const clean = piece.trim();
          if (clean.length > 0) {
            chunkItems.push({ factId: fact.id, seq, content: clean });
          }
        });
      }

      const needsIndex =
        requiresBrandFactVectorIndex(totalChars) || requiresBrandFactVectorIndex(maxSingleChars);

      if (!needsIndex || chunkItems.length === 0) {
        await this.prisma.base.$transaction(async (tx) => {
          await tx.brandFactChunk.deleteMany({ where: { tenantId, brandId } });
          await tx.brandFact.updateMany({
            where: { tenantId, brandId },
            data: { indexStatus: 'NONE' },
          });
        });
        return { chunkCount: 0 };
      }

      const allVectors: number[][] = [];
      for (let offset = 0; offset < chunkItems.length; offset += EMBEDDING_MAX_BATCH) {
        const batch = chunkItems.slice(offset, offset + EMBEDDING_MAX_BATCH);
        const embedded = await this.embedding.embed({
          texts: batch.map((item) => item.content.slice(0, EMBEDDING_MAX_CHARS)),
        });
        allVectors.push(...embedded.vectors);
      }

      if (allVectors.length !== chunkItems.length) {
        throw new Error(
          `embedding count mismatch: expected ${chunkItems.length}, got ${allVectors.length}`,
        );
      }

      const nonEmptyIdSet = new Set(nonEmptyFactIds);
      const emptyFactIds = brand.facts
        .filter((fact) => !nonEmptyIdSet.has(fact.id))
        .map((fact) => fact.id);

      await this.prisma.base.$transaction(async (tx) => {
        await tx.brandFactChunk.deleteMany({ where: { tenantId, brandId } });

        const stamp = Date.now().toString(36);
        for (let idx = 0; idx < chunkItems.length; idx += 1) {
          const item = chunkItems[idx]!;
          const vector = allVectors[idx]!;
          assertEmbeddingWidth(vector);
          const literal = `[${vector.join(',')}]`;
          const chunkId = `bfc_${idx}_${stamp}_${randomBytes(5).toString('hex')}`;
          await tx.$executeRaw`
            INSERT INTO "BrandFactChunk" ("id", "tenantId", "brandId", "factId", "seq", "content", "embedding")
            VALUES (${chunkId}, ${tenantId}, ${brandId}, ${item.factId}, ${item.seq}, ${item.content}, ${literal}::vector)
          `;
        }

        if (nonEmptyFactIds.length > 0) {
          await tx.brandFact.updateMany({
            where: { tenantId, brandId, id: { in: nonEmptyFactIds } },
            data: { indexStatus: 'READY' },
          });
        }
        if (emptyFactIds.length > 0) {
          await tx.brandFact.updateMany({
            where: { tenantId, brandId, id: { in: emptyFactIds } },
            data: { indexStatus: 'NONE' },
          });
        }
      });

      return { chunkCount: chunkItems.length };
    } catch (error) {
      this.logger.warn(
        `fact-index failed for brand=${brandId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      await this.prisma.base.brandFact
        .updateMany({
          where: { tenantId, brandId, indexStatus: 'INDEXING' },
          data: { indexStatus: 'FAILED' },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * 供 M3（BriefsService）与 M4（StudioService）复用的事实检索入口：
   * - 已向量化（READY）且 query 非空时走 pgvector 余弦相似度检索 Top-K；
   * - 否则（≤6,000 字直注 / 后台索引中 / 检索异常降级）按规范槽位顺序直接注入。
   */
  async retrieveRelevantBrandFacts(
    tenantId: string,
    brandId: string,
    query: string,
    topK: number = BRAND_FACT_TOP_K_CHUNKS,
    productLineId?: string | null,
  ): Promise<RetrievedBrandFactSnippet[]> {
    const normalizedProductLineId = productLineId?.trim() || null;

    const facts = await this.prisma.base.brandFact.findMany({
      where: normalizedProductLineId
        ? {
            tenantId,
            brandId,
            OR: [{ productLineId: null }, { productLineId: normalizedProductLineId }],
          }
        : { tenantId, brandId },
      select: {
        id: true,
        slot: true,
        title: true,
        content: true,
        productLineId: true,
        indexStatus: true,
        updatedAt: true,
      },
      orderBy: [{ slot: 'asc' }, { updatedAt: 'desc' }],
    });

    const scopedFacts = normalizedProductLineId
      ? facts.filter(
          (fact) => fact.productLineId == null || fact.productLineId === normalizedProductLineId,
        )
      : facts;

    if (scopedFacts.length === 0) {
      return [];
    }

    const sortedFacts = [...scopedFacts].sort((a, b) => {
      if (normalizedProductLineId) {
        const aScope = a.productLineId === normalizedProductLineId ? 0 : 1;
        const bScope = b.productLineId === normalizedProductLineId ? 0 : 1;
        if (aScope !== bScope) return aScope - bScope;
      }
      const slotDiff = slotPriority(a.slot) - slotPriority(b.slot);
      if (slotDiff !== 0) return slotDiff;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    const trimmedQuery = query.trim();
    const hasReadyVector = sortedFacts.some((fact) => fact.indexStatus === 'READY');

    if (hasReadyVector && trimmedQuery.length > 0) {
      try {
        const embedded = await this.embedding.embed({
          texts: [trimmedQuery.slice(0, EMBEDDING_MAX_CHARS)],
        });
        const vector = embedded.vectors[0];
        if (vector) {
          assertEmbeddingWidth(vector);
          const literal = `[${vector.join(',')}]`;
          const safeTopK = Math.max(1, Math.min(20, Math.floor(topK)));
          const rows = await this.prisma.base.$queryRaw<VectorChunkRow[]>`
            SELECT c."factId", f."slot"::text AS "slot", f."title", f."productLineId", c."seq", c."content",
                   (c."embedding" <=> ${literal}::vector)::float8 AS "distance"
            FROM "BrandFactChunk" c
            INNER JOIN "BrandFact" f ON f."id" = c."factId"
            WHERE c."tenantId" = ${tenantId}
              AND c."brandId" = ${brandId}
              AND f."tenantId" = ${tenantId}
              AND f."brandId" = ${brandId}
              AND c."embedding" IS NOT NULL
              AND (${normalizedProductLineId}::text IS NULL OR f."productLineId" IS NULL OR f."productLineId" = ${normalizedProductLineId}::text)
            ORDER BY
              ((c."embedding" <=> ${literal}::vector)::float8 - CASE WHEN ${normalizedProductLineId}::text IS NOT NULL AND f."productLineId" = ${normalizedProductLineId}::text THEN 0.08 ELSE 0.0 END) ASC,
              (c."embedding" <=> ${literal}::vector)::float8 ASC
            LIMIT ${safeTopK}
          `;
          const scopedRows = normalizedProductLineId
            ? rows.filter(
                (row) => row.productLineId == null || row.productLineId === normalizedProductLineId,
              )
            : rows;
          if (scopedRows.length > 0) {
            return [...scopedRows]
              .sort((a, b) => {
                if (normalizedProductLineId) {
                  const aScope = a.productLineId === normalizedProductLineId ? 0 : 1;
                  const bScope = b.productLineId === normalizedProductLineId ? 0 : 1;
                  if (aScope !== bScope) return aScope - bScope;
                }
                const slotDiff = slotPriority(a.slot) - slotPriority(b.slot);
                if (slotDiff !== 0) return slotDiff;
                return a.seq - b.seq;
              })
              .map((row) => ({
                factId: row.factId,
                slot: toBrandFactSlot(row.slot),
                title: row.title,
                content: row.content,
                productLineId: row.productLineId ?? null,
                source: 'vector' as const,
                distance: Number(row.distance),
              }));
          }
        }
      } catch (error) {
        this.logger.warn(
          `vector retrieval fallback to direct facts for brand=${brandId}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    return buildDirectFallbackSnippets(sortedFacts);
  }
}

function buildDirectFallbackSnippets(
  facts: ReadonlyArray<{
    id: string;
    slot: string;
    title: string;
    content: string;
    productLineId?: string | null;
  }>,
): RetrievedBrandFactSnippet[] {
  const out: RetrievedBrandFactSnippet[] = [];
  let remaining = BRAND_FACT_FULL_INJECT_MAX;

  for (const fact of facts) {
    if (remaining <= 0) break;
    const text = fact.content.trim();
    if (!text) continue;
    const clipped = text.length > remaining ? text.slice(0, remaining).trim() : text;
    if (!clipped) continue;
    out.push({
      factId: fact.id,
      slot: toBrandFactSlot(fact.slot),
      title: fact.title,
      content: clipped,
      productLineId: fact.productLineId ?? null,
      source: 'direct',
    });
    remaining -= clipped.length;
  }

  return out;
}
