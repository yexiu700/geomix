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

  it('sends aspect_ratio alongside size in upstream openai-compatible request (#312)', async () => {
    const sharp = (await import('sharp')).default;
    const samplePng = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: { r: 30, g: 40, b: 50 } },
    })
      .png()
      .toBuffer();

    let capturedBody: Record<string, unknown> | null = null;
    const service = ImageService.fromEnv(
      {
        IMAGE_PROVIDER: 'openai',
        IMAGE_BASE_URL: 'https://api.example.com/v1',
        IMAGE_API_KEY: 'sk-test',
        IMAGE_MODEL: 'grok-imagine-image-2.0',
      },
      {
        storage: StorageService.fromEnv({ STORAGE_DRIVER: 'memory' }),
        compliance: new ComplianceService(),
        resolver: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
        transport: async (req) => {
          capturedBody = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(
              JSON.stringify({ data: [{ b64_json: samplePng.toString('base64') }] }),
            ),
          };
        },
      },
    );

    const raw = await service.generateRaw({
      tenantId: 'tenant_demo',
      prompt: '简约现代商业办公桌面实拍图',
      ratio: '16:9',
      count: 1,
    });

    expect(raw.items).toHaveLength(1);
    expect(capturedBody).toMatchObject({
      model: 'grok-imagine-image-2.0',
      size: '1280x720',
      aspect_ratio: '16:9',
    });
  });
});
