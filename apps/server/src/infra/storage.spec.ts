import { describe, expect, it } from 'vitest';
import { StorageService } from './storage';

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
});
