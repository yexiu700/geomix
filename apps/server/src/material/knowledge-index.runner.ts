import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  EMBEDDING_MAX_BATCH,
  KB_CHUNK_OVERLAP,
  KB_CHUNK_SIZE,
  KB_TOP_K_CHUNKS,
  chunkKnowledgeText,
  requiresKbVectorIndex,
} from '@geomix/shared';
import { EmbeddingService } from '../infra/embedding';
import { PrismaService } from '../prisma/prisma.service';

export const KB_INDEX_HANDLER = Symbol('KB_INDEX_HANDLER');

export interface KbIndexHandler {
  process(payload: { tenantId: string; kbId: string }): Promise<{ chunkCount: number }>;
}

function makeChunkId(idx: number): string {
  return `kbc_${idx}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

@Injectable()
export class KnowledgeIndexRunner implements KbIndexHandler {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmbeddingService) private readonly embedding: EmbeddingService,
  ) {}

  async process(payload: { tenantId: string; kbId: string }): Promise<{ chunkCount: number }> {
    const kb = await this.prisma.base.knowledgeBase.findFirst({
      where: { id: payload.kbId, tenantId: payload.tenantId },
      select: { id: true, tenantId: true, mode: true, summaryText: true },
    });
    if (!kb) {
      return { chunkCount: 0 };
    }
    if (!requiresKbVectorIndex(kb.mode, kb.summaryText)) {
      await this.prisma.base.$transaction([
        this.prisma.base.knowledgeChunk.deleteMany({ where: { kbId: kb.id } }),
        this.prisma.base.knowledgeBase.update({
          where: { id: kb.id },
          data: { indexStatus: 'NONE' },
        }),
      ]);
      return { chunkCount: 0 };
    }

    const chunks = chunkKnowledgeText(kb.summaryText ?? '', KB_CHUNK_SIZE, KB_CHUNK_OVERLAP);
    if (chunks.length === 0) {
      await this.prisma.base.knowledgeBase.update({
        where: { id: kb.id },
        data: { indexStatus: 'NONE' },
      });
      return { chunkCount: 0 };
    }

    try {
      const allVectors: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += EMBEDDING_MAX_BATCH) {
        const batch = chunks.slice(offset, offset + EMBEDDING_MAX_BATCH);
        const result = await this.embedding.embed({ texts: batch });
        allVectors.push(...result.vectors);
      }

      await this.prisma.base.$transaction(async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { kbId: kb.id } });
        for (let idx = 0; idx < chunks.length; idx += 1) {
          const content = chunks[idx]!;
          const vector = allVectors[idx]!;
          const literal = `[${vector.join(',')}]`;
          const chunkId = makeChunkId(idx);
          await tx.$executeRaw`
            INSERT INTO "KnowledgeChunk" ("id", "kbId", "idx", "content", "embedding")
            VALUES (${chunkId}, ${kb.id}, ${idx}, ${content}, ${literal}::vector)
          `;
        }
        await tx.knowledgeBase.update({
          where: { id: kb.id },
          data: { indexStatus: 'READY' },
        });
      });

      return { chunkCount: chunks.length };
    } catch (error) {
      await this.prisma.base.knowledgeBase
        .updateMany({
          where: { id: kb.id, tenantId: payload.tenantId },
          data: { indexStatus: 'FAILED' },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * 向量余弦相似度 Top-K 检索，并按原始段落顺序（idx 升序）返回片段（F04a §3.2）。
   * 访问前严格校验父 KnowledgeBase 归属当前 tenantId。
   */
  async searchTopChunks(input: {
    tenantId: string;
    kbId: string;
    queryText: string;
    topK?: number;
  }): Promise<Array<{ idx: number; content: string; distance: number }>> {
    const owned = await this.prisma.base.knowledgeBase.findFirst({
      where: { id: input.kbId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!owned) return [];
    const topK = Math.max(1, Math.min(20, input.topK ?? KB_TOP_K_CHUNKS));
    const embedded = await this.embedding.embed({ texts: [input.queryText] });
    const vec = embedded.vectors[0];
    if (!vec) return [];
    const literal = `[${vec.join(',')}]`;
    const rows = await this.prisma.base.$queryRaw<
      Array<{ idx: number; content: string; distance: number }>
    >`
      SELECT "idx", "content", ("embedding" <=> ${literal}::vector)::float8 AS "distance"
      FROM "KnowledgeChunk"
      WHERE "kbId" = ${owned.id} AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${literal}::vector ASC
      LIMIT ${topK}
    `;
    return [...rows].sort((a, b) => a.idx - b.idx);
  }
}
