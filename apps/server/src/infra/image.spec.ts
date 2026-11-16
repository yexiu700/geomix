import { describe, expect, it } from 'vitest';
import { FAKE_MARK } from '@geomix/shared';
import { ComplianceService } from './compliance';
import { ImageService } from './image';
import { StorageService } from './storage';

describe('image provider', () => {
  it('stores a marked fake image and does not generate a forbidden prompt', async () => {
    const storage = StorageService.fromEnv({ STORAGE_DRIVER: 'memory' });
    const service = ImageService.fromEnv(
      { IMAGE_PROVIDER: 'fake' },
      { storage, compliance: new ComplianceService() },
    );
    const result = await service.generate({
      tenantId: 'tenant_demo',
      prompt: '一张 GeoMix 的纯色占位图',
      count: 2,
      ratio: '1:1',
      idempotencyKey: 'idem-image-01',
    });
    expect(result.fake).toBe(true);
    expect(result.images).toHaveLength(2);
    for (const image of result.images) {
      expect(image.note.startsWith(FAKE_MARK)).toBe(true);
      expect(image.stored.key.startsWith('tenants/tenant_demo/')).toBe(true);
      expect(image.stored.bytes).toBeLessThanOrEqual(1024 * 1024);
      const loaded = await storage.get('tenant_demo', image.stored.key.split('/').at(-1) ?? '');
      expect(loaded?.body.length).toBe(image.stored.bytes);
    }
    const replay = await service.generate({
      tenantId: 'tenant_demo',
      prompt: '一张 GeoMix 的纯色占位图',
      count: 2,
      ratio: '1:1',
      idempotencyKey: 'idem-image-01',
    });
    expect(replay.images[0]?.stored.key).toBe(result.images[0]?.stored.key);
    expect(replay.images[0]?.stored.sha256).toBe(result.images[0]?.stored.sha256);

    await expect(
      service.generate({
        tenantId: 'tenant_demo',
        prompt: '制作赌博海报',
        count: 1,
        idempotencyKey: 'idem-image-02',
      }),
    ).rejects.toMatchObject({ code: 40302 });
    expect(await storage.get('tenant_demo', 'image-forbidden.jpg')).toBeNull();
  });
});
