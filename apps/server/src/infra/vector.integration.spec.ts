import { describe, expect, it } from 'vitest';
import { createPrismaClient } from '@geomix/db';
import { DB_EMBEDDING_DIMENSIONS } from '@geomix/shared';
import { fakeEmbedding } from './embedding';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'embedding width against pgvector',
  () => {
    it('accepts a 1024-dimension vector and rejects a shorter one', async () => {
      const prisma = createPrismaClient(databaseUrl);
      try {
        const vector = fakeEmbedding('GeoMix 占位');
        expect(vector).toHaveLength(DB_EMBEDDING_DIMENSIONS);
        const literal = `[${vector.join(',')}]`;
        const accepted = await prisma.$queryRaw<Array<{ dims: number }>>`
        SELECT vector_dims(${literal}::vector) AS dims
      `;
        expect(Number(accepted[0]?.dims)).toBe(1024);
        await expect(prisma.$queryRaw`SELECT ${'[0.1,0.2]'}::vector(1024)`).rejects.toThrow();
      } finally {
        await prisma.$disconnect();
      }
    });
  },
);
