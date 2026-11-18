import { describe, expect, it } from 'vitest';
import { createS3ObjectClient, StorageService } from './storage';

describe('storage', () => {
  it('keeps objects inside the tenant prefix and replays the same body once', async () => {
    const puts: string[] = [];
    const service = new StorageService(
      { driver: 'memory', maxObjectBytes: 1024 },
      {
        async put(key) {
          puts.push(key);
        },
        async get() {
          return null;
        },
        async delete() {
          return undefined;
        },
      },
      true,
    );
    const body = Buffer.from('image-bytes');
    const stored = await service.put({
      tenantId: 'tenant_demo',
      name: 'cover.jpg',
      body,
      contentType: 'image/jpeg',
      idempotencyKey: 'idem-store-01',
    });
    expect(stored.key).toBe('tenants/tenant_demo/cover.jpg');
    expect(stored.replayed).toBe(false);
    const again = await service.put({
      tenantId: 'tenant_demo',
      name: 'cover.jpg',
      body,
      contentType: 'image/jpeg',
      idempotencyKey: 'idem-store-01',
    });
    expect(again.replayed).toBe(true);
    expect(puts).toEqual(['tenants/tenant_demo/cover.jpg']);
    const loaded = await service.get('tenant_demo', 'cover.jpg');
    expect(loaded?.body.equals(body)).toBe(true);
    await expect(
      service.put({
        tenantId: 'tenant_demo',
        name: '../other.jpg',
        body,
        contentType: 'image/jpeg',
        idempotencyKey: 'idem-store-02',
      }),
    ).rejects.toMatchObject({ reason: 'name' });
    await expect(
      service.put({
        tenantId: 'tenant_demo',
        name: 'other.jpg',
        body: Buffer.from('different'),
        contentType: 'image/jpeg',
        idempotencyKey: 'idem-store-01',
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      service.put({
        tenantId: 'tenant_demo',
        name: 'big.jpg',
        body: Buffer.alloc(2048),
        contentType: 'image/jpeg',
        idempotencyKey: 'idem-store-03',
      }),
    ).rejects.toMatchObject({ reason: 'object' });
  });

  it('wraps S3 put and delete failures into ProviderError(upstream)', async () => {
    const client = createS3ObjectClient({
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'geomix',
      S3_ACCESS_KEY_ID: 'geomix',
      S3_SECRET_ACCESS_KEY: 'geomix-dev-only',
      S3_FORCE_PATH_STYLE: 'true',
    });
    await expect(
      client.put('tenants/t1/test.jpg', Buffer.from('abc'), 'image/jpeg'),
    ).rejects.toMatchObject({ kind: 'upstream', reason: 's3' });
    await expect(client.delete('tenants/t1/test.jpg')).rejects.toMatchObject({
      kind: 'upstream',
      reason: 's3',
    });
  });
});
