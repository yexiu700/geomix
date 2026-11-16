import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_EMBEDDING_DIMENSIONS, FAKE_MARK } from '@geomix/shared';
import type { HttpTransport } from './guarded-request';
import { EmbeddingService, embeddingColumnIs1024, fakeEmbedding } from './embedding';

describe('embedding', () => {
  it('stays on 1024 dimensions for the existing vector column', async () => {
    const schema = resolve(process.cwd(), '../../packages/db/prisma/schema.prisma');
    expect(embeddingColumnIs1024(schema)).toBe(true);
    const service = EmbeddingService.fromEnv({});
    const result = await service.embed({ texts: ['GeoMix 占位', 'GeoMix 占位', '另一段'] });
    expect(result.fake).toBe(true);
    expect(result.note.startsWith(FAKE_MARK)).toBe(true);
    expect(result.dimensions).toBe(DB_EMBEDDING_DIMENSIONS);
    for (const vector of result.vectors) {
      expect(vector).toHaveLength(1024);
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
    expect(result.vectors[0]).toEqual(result.vectors[1]);
    expect(result.vectors[0]).not.toEqual(result.vectors[2]);
    expect(fakeEmbedding('GeoMix 占位')).toEqual(result.vectors[0]);
  });

  it('rejects a short upstream vector and does not call out without a key', async () => {
    let calls = 0;
    const transport: HttpTransport = async () => {
      calls += 1;
      return {
        status: 200,
        headers: {},
        body: Buffer.from('{"data":[{"index":0,"embedding":[0.1]}]}'),
      };
    };
    const missing = EmbeddingService.fromEnv(
      { EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'https://192.0.2.10/v1' },
      {
        transport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
      },
    );
    await expect(missing.embed({ texts: ['GeoMix'] })).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toBe(0);

    const keyed = EmbeddingService.fromEnv(
      {
        EMBEDDING_PROVIDER: 'openai',
        EMBEDDING_BASE_URL: 'https://192.0.2.10/v1',
        EMBEDDING_API_KEY: 'test-key',
      },
      {
        transport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
      },
    );
    await expect(keyed.embed({ texts: ['GeoMix'] })).rejects.toMatchObject({
      reason: 'dimensions',
    });
    expect(calls).toBe(1);
    expect(() => EmbeddingService.fromEnv({ EMBEDDING_DIMENSIONS: '512' })).toThrow(/1024/);
  });
});
