import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { FAKE_MARK } from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { EmbeddingService } from './embedding';
import { LlmService } from './llm';

describe('adapter smoke without external calls', () => {
  let app: INestApplication;
  let base = '';
  const previous: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of [
      'LLM_PROVIDERS',
      'EMBEDDING_PROVIDER',
      'EMBEDDING_DIMENSIONS',
      'IMAGE_PROVIDER',
      'SEARCH_PROVIDER',
      'STORAGE_DRIVER',
      'BILLING_MODE',
    ]) {
      previous[key] = process.env[key];
    }
    process.env.LLM_PROVIDERS = '{}';
    process.env.EMBEDDING_PROVIDER = 'fake';
    process.env.EMBEDDING_DIMENSIONS = '1024';
    process.env.IMAGE_PROVIDER = 'fake';
    process.env.SEARCH_PROVIDER = 'link_list';
    process.env.STORAGE_DRIVER = 'memory';
    process.env.BILLING_MODE = 'SHADOW';
    app = await createApiApp();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps health on shadow billing and runs the fake llm cost record', async () => {
    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      code: 0,
      data: { service: 'api', name: 'GeoMix', billingMode: 'SHADOW' },
    });
    const llm = app.get(LlmService);
    const result = await llm.complete({
      tenantId: 'tenant_demo',
      scene: 'rewrite',
      messages: [{ role: 'user', content: '请重写一段占位说明' }],
      idempotencyKey: 'idem-smoke-0001',
    });
    expect(result.fake).toBe(true);
    expect(result.text.startsWith(FAKE_MARK)).toBe(true);
    expect(result.cost.costBasis).toBe('placeholder');
    expect(result.cost.costMicro).toBeGreaterThan(0);
    const vectors = await app.get(EmbeddingService).embed({ texts: ['GeoMix'] });
    expect(vectors.vectors[0]).toHaveLength(1024);
    const again = await fetch(`${base}/api/v1/health`);
    await expect(again.json()).resolves.toMatchObject({ data: { billingMode: 'SHADOW' } });
  });
});
