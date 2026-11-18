import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  GALLERY_FILE_FORMAT_MSG,
  GALLERY_FILE_TOO_LARGE_MSG,
  GALLERY_UPLOAD_MAX_FILES,
  type MediaAssetListResponse,
  type MediaUploadResponse,
} from '@geomix/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { QuotaService } from '../billing/quota.service';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { ComplianceService } from '../infra/compliance';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { StorageService, type ObjectClient } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { GalleryAssetsController } from './gallery.controller';
import { GALLERY_MAX_INPUT_BYTES_TOKEN, GalleryService } from './gallery.service';

// Valid 67-byte 1x1 grayscale PNG (IHDR + IDAT + IEND)
const VALID_1X1_GRAY_67B_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQIHWP4DwABAQEANl9ngAAAAABJRU5ErkJggg==',
  'base64',
);

// Valid 68-byte 1x1 RGBA PNG
const VALID_1X1_RGBA_68B_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

// 67-byte truncated/corrupted 1x1 PNG: valid PNG signature + IHDR (1x1), truncated IDAT zlib stream
const CORRUPT_1X1_67B_PNG = Buffer.concat([
  VALID_1X1_GRAY_67B_PNG.subarray(0, 45),
  Buffer.from([
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]),
]);

type StoredAssetRow = {
  id: string;
  tenantId: string;
  categoryId: string | null;
  origin: 'UPLOAD' | 'AI_IMAGE';
  objectKey: string;
  originalName?: string | null;
  url: string;
  thumbUrl: string | null;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  usedCount: number;
  createdAt: Date;
  category: { id: string; name: string } | null;
};

describe('POST /api/v1/media-assets/upload regression suite (#138, #204)', () => {
  let app: INestApplication;
  let base = '';
  let maxInputBytes = 100 * 1024 * 1024;
  let assetsStore: StoredAssetRow[] = [];
  let storagePutImpl: (key: string, body: Buffer, contentType: string) => Promise<void>;
  let storageDeleteCalls: string[] = [];

  const mockObjectClient: ObjectClient = {
    async put(key, body, contentType) {
      await storagePutImpl(key, body, contentType);
    },
    async get() {
      return null;
    },
    async delete(key) {
      storageDeleteCalls.push(key);
    },
  };

  const storageService = new StorageService(
    { driver: 's3', maxObjectBytes: 100 * 1024 * 1024 },
    mockObjectClient,
    false,
  );

  const mockPrisma = {
    scoped: {
      mediaCategory: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'cat_valid' ? { id: 'cat_valid', name: 'ARZOPA便携屏产品图' } : null,
        ),
      },
      mediaAsset: {
        count: vi.fn(async () => assetsStore.length),
        findMany: vi.fn(async () => assetsStore),
      },
    },
    base: {
      $transaction: vi.fn(
        async (
          fn: (tx: {
            mediaAsset: {
              create: (args: { data: Record<string, unknown> }) => Promise<StoredAssetRow>;
            };
          }) => Promise<StoredAssetRow>,
        ) =>
          fn({
            mediaAsset: {
              create: async ({ data }) => {
                const row: StoredAssetRow = {
                  id: String(data.id),
                  tenantId: String(data.tenantId),
                  categoryId: (data.categoryId as string | null) ?? null,
                  origin: (data.origin as 'UPLOAD' | 'AI_IMAGE') ?? 'UPLOAD',
                  objectKey: String(data.objectKey),
                  originalName:
                    typeof data.originalName === 'string' || data.originalName === null
                      ? data.originalName
                      : null,
                  url: String(data.url),
                  thumbUrl: (data.thumbUrl as string | null) ?? null,
                  width: Number(data.width),
                  height: Number(data.height),
                  bytes: Number(data.bytes),
                  mime: String(data.mime),
                  usedCount: 0,
                  createdAt: new Date('2026-11-18T08:00:00.000Z'),
                  category: { id: 'cat_valid', name: 'ARZOPA便携屏产品图' },
                };
                assetsStore.push(row);
                return row;
              },
            },
          }),
      ),
    },
  } as unknown as PrismaService;

  const mockQuota = {
    consume: vi.fn(async () => ({ used: 1024n, limit: 104_857_600n })),
    read: vi.fn(async () => [{ key: 'STORAGE_BYTES', used: 1024n, limit: 104_857_600n }]),
  } as unknown as QuotaService;

  @Module({
    controllers: [GalleryAssetsController],
    providers: [
      AuthGuard,
      TenantActiveGuard,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: QuotaService, useValue: mockQuota },
      { provide: StorageService, useValue: storageService },
      { provide: ComplianceService, useValue: {} as ComplianceService },
      { provide: GALLERY_MAX_INPUT_BYTES_TOKEN, useValue: () => maxInputBytes },
      GalleryService,
    ],
  })
  class TestUploadModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply((req: unknown, _res: unknown, next: () => void) => {
          const http = asHttpRequest(req);
          http.auth = {
            userId: 'usr_1',
            tenantId: 'ten_arzopa',
            username: 'tester',
            nickname: 'Tester',
            role: 'MERCHANT',
            tenantName: 'Test Tenant',
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            isActive: true,
          };
          runInTenant('ten_arzopa', next);
        })
        .forRoutes({ path: '*', method: RequestMethod.ALL });
    }
  }

  beforeAll(async () => {
    app = await NestFactory.create(TestUploadModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    maxInputBytes = 100 * 1024 * 1024;
    assetsStore = [];
    storageDeleteCalls = [];
    storagePutImpl = async () => undefined;
  });

  it('uploads valid 1x1 PNGs (67B grayscale & 68B RGBA) with HTTP 200, <500px warning, and safe originalName metadata', async () => {
    expect(VALID_1X1_GRAY_67B_PNG.length).toBe(67);
    expect(VALID_1X1_RGBA_68B_PNG.length).toBe(68);

    const form = new FormData();
    form.set('categoryId', 'cat_valid');
    form.append(
      'files',
      new Blob([new Uint8Array(VALID_1X1_GRAY_67B_PNG)], { type: 'image/png' }),
      '../../arzopa-1x1-test.png',
    );
    form.append(
      'files',
      new Blob([new Uint8Array(VALID_1X1_RGBA_68B_PNG)], { type: 'image/png' }),
      '便携屏实拍图.png',
    );

    const res = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      code: number;
      msg: string;
      data: MediaUploadResponse;
    };
    expect(json.code).toBe(0);
    expect(json.data.items).toHaveLength(2);
    expect(json.data.warnings).toHaveLength(2);
    expect(json.data.warnings[0]).toContain('小于建议值 500px');

    const first = json.data.items[0]!;
    const second = json.data.items[1]!;
    expect(first.asset.width).toBe(1);
    expect(first.asset.height).toBe(1);
    expect(first.asset.mime).toBe('image/jpeg');
    expect(first.asset.originalName).toBe('arzopa-1x1-test.png');
    expect(first.asset.displayName).toBe('arzopa-1x1-test.png');
    expect(first.originalName).toBe('arzopa-1x1-test.png');

    expect(second.asset.originalName).toBe('便携屏实拍图.png');
    expect(second.asset.displayName).toBe('便携屏实拍图.png');

    // Listing assets also exposes safe displayName/originalName without forcing callers to display tenants/...
    const listRes = await fetch(`${base}/api/v1/media-assets?categoryId=cat_valid`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { code: number; data: MediaAssetListResponse };
    expect(listJson.data.items[0]?.originalName).toBe('arzopa-1x1-test.png');
    expect(listJson.data.items[0]?.displayName).toBe('arzopa-1x1-test.png');
    expect(listJson.data.items[1]?.displayName).toBe('便携屏实拍图.png');
  });

  it('returns 400 with clear Chinese message (never 500) for corrupted/truncated 67B PNG that passes metadata header', async () => {
    expect(CORRUPT_1X1_67B_PNG.length).toBe(67);
    const form = new FormData();
    form.set('categoryId', 'cat_valid');
    form.append(
      'files',
      new Blob([new Uint8Array(CORRUPT_1X1_67B_PNG)], { type: 'image/png' }),
      'corrupt-1x1.png',
    );

    const res = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: number; msg: string };
    expect(json.code).toBe(API_ERROR.BAD_REQUEST);
    expect(json.msg).toContain('图片');
    expect(json.msg).not.toBe('服务器错误');
  });

  it('returns 4xx with clear Chinese messages for empty file, invalid mime/magic, oversized file, >20 files, and wrong field', async () => {
    // 1. Empty 0-byte file
    const emptyForm = new FormData();
    emptyForm.set('categoryId', 'cat_valid');
    emptyForm.append('files', new Blob([], { type: 'image/png' }), 'empty.png');
    const emptyRes = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: emptyForm,
    });
    expect(emptyRes.status).toBe(400);
    const emptyJson = (await emptyRes.json()) as { code: number; msg: string };
    expect(emptyJson.code).toBe(API_ERROR.BAD_REQUEST);
    expect(emptyJson.msg).toContain('为空');

    // 2. Spoofed SVG/text file with .png extension
    const badMimeForm = new FormData();
    badMimeForm.set('categoryId', 'cat_valid');
    badMimeForm.append(
      'files',
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/png' }),
      'fake.png',
    );
    const badMimeRes = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: badMimeForm,
    });
    expect(badMimeRes.status).toBe(400);
    const badMimeJson = (await badMimeRes.json()) as { code: number; msg: string };
    expect(badMimeJson.msg).toBe(GALLERY_FILE_FORMAT_MSG);

    // 3. Exceeds configured max input bytes
    maxInputBytes = 32;
    const bigForm = new FormData();
    bigForm.set('categoryId', 'cat_valid');
    bigForm.append(
      'files',
      new Blob([new Uint8Array(VALID_1X1_GRAY_67B_PNG)], { type: 'image/png' }),
      'too-big.png',
    );
    const bigRes = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: bigForm,
    });
    expect(bigRes.status).toBe(400);
    const bigJson = (await bigRes.json()) as { msg: string };
    expect(bigJson.msg).toBe(GALLERY_FILE_TOO_LARGE_MSG);
    maxInputBytes = 100 * 1024 * 1024;

    // 4. Exceeds GALLERY_UPLOAD_MAX_FILES (21 files)
    const tooManyForm = new FormData();
    tooManyForm.set('categoryId', 'cat_valid');
    for (let i = 0; i < GALLERY_UPLOAD_MAX_FILES + 1; i += 1) {
      tooManyForm.append(
        'files',
        new Blob([new Uint8Array(VALID_1X1_GRAY_67B_PNG)], { type: 'image/png' }),
        `img-${i}.png`,
      );
    }
    const tooManyRes = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: tooManyForm,
    });
    expect(tooManyRes.status).toBe(400);
    const tooManyJson = (await tooManyRes.json()) as { msg: string };
    expect(tooManyJson.msg).toContain(`最多上传 ${GALLERY_UPLOAD_MAX_FILES} 张`);

    // 5. Wrong field name
    const wrongFieldForm = new FormData();
    wrongFieldForm.set('categoryId', 'cat_valid');
    wrongFieldForm.append(
      'file',
      new Blob([new Uint8Array(VALID_1X1_GRAY_67B_PNG)], { type: 'image/png' }),
      'wrong-field.png',
    );
    const wrongFieldRes = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: wrongFieldForm,
    });
    expect(wrongFieldRes.status).toBe(400);
    const wrongFieldJson = (await wrongFieldRes.json()) as { msg: string };
    expect(wrongFieldJson.msg).toContain('files');
  });

  it('handles storage failures gracefully without HTTP 500 and cleans up partial main object on thumb failure', async () => {
    let putCount = 0;
    storagePutImpl = async () => {
      putCount += 1;
      if (putCount === 2) {
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, '对象存储暂时不可用', 's3');
      }
    };

    const validPng = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.set('categoryId', 'cat_valid');
    form.append('files', new Blob([new Uint8Array(validPng)], { type: 'image/png' }), 'test.png');

    const res = await fetch(`${base}/api/v1/media-assets/upload`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: number; msg: string };
    expect(json.code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
    expect(json.msg).toContain('外部服务');
    expect(storageDeleteCalls.length).toBe(1);
    expect(assetsStore).toHaveLength(0);
  });

  it('returns 400 (never 500) when memory storage object cap is reached and builds safe fallback displayName when originalName is null', async () => {
    const smallMemStorage = new StorageService(
      { driver: 'memory', maxObjectBytes: 100 * 1024 * 1024 },
      {
        async put() {
          return undefined;
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
    // Fill memory store to cap (200 objects)
    for (let i = 0; i < 200; i += 1) {
      await smallMemStorage.put({
        tenantId: 'ten_arzopa',
        name: `seed-${i}.jpg`,
        body: Buffer.from('x'),
        contentType: 'image/jpeg',
        idempotencyKey: `seed-idem-${i}`,
      });
    }
    // Temporarily swap StorageService internal call via GalleryService directly
    const service = new GalleryService(
      mockPrisma,
      mockQuota,
      smallMemStorage,
      {} as ComplianceService,
      () => maxInputBytes,
    );
    await expect(
      runInTenant('ten_arzopa', () =>
        service.uploadBuffers('cat_valid', [
          { filename: 'overflow.png', buffer: VALID_1X1_GRAY_67B_PNG },
        ]),
      ),
    ).rejects.toMatchObject({ status: 400, code: API_ERROR.BAD_REQUEST, message: '内存存储已满' });

    // Verify legacy row with originalName = null gets safe displayName without tenant/objectKey
    assetsStore.push({
      id: 'med_mwls9zkp1f644f292f60',
      tenantId: 'ten_arzopa',
      categoryId: 'cat_valid',
      origin: 'UPLOAD',
      objectKey: 'tenants/seed_tenant_platform/media-med_mwls9zkp1f644f292f60.jpg',
      originalName: null,
      url: '/api/v1/media-assets/med_mwls9zkp1f644f292f60/file',
      thumbUrl: '/api/v1/media-assets/med_mwls9zkp1f644f292f60/thumb',
      width: 500,
      height: 300,
      bytes: 4900,
      mime: 'image/jpeg',
      usedCount: 0,
      createdAt: new Date('2026-11-18T08:00:00.000Z'),
      category: { id: 'cat_valid', name: 'ARZOPA便携屏产品图' },
    });
    const listRes = await fetch(`${base}/api/v1/media-assets?categoryId=cat_valid`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { code: number; data: MediaAssetListResponse };
    expect(listJson.data.items[0]?.originalName).toBeNull();
    expect(listJson.data.items[0]?.displayName).toBe('上传图片-292f60.jpg');
    expect(listJson.data.items[0]?.displayName).not.toContain('seed_tenant_platform');
  });
});
