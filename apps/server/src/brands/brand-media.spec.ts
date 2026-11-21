import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { API_ERROR, parseEnv } from '@geomix/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { PrismaAuthStore } from '../auth/prisma-auth.store';
import { signToken } from '../auth/token';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { StorageService } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { BrandMediaService } from './brand-media.service';

type StoredMedia = {
  id: string;
  tenantId: string;
  brandId: string;
  origin: string;
  title: string;
  objectKey: string;
  thumbKey: string | null;
  url: string;
  thumbUrl: string | null;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  aiPrompt: string | null;
  aiModel: string | null;
  usedCount: number;
  createdAt: Date;
};

function createMediaStore(getTenantId: () => string | undefined) {
  const brands = [
    { id: 'brand_a1', tenantId: 'tenant_a' },
    { id: 'brand_a2', tenantId: 'tenant_a' },
    { id: 'brand_b1', tenantId: 'tenant_b' },
    { id: 'brand_exp1', tenantId: 'tenant_exp' },
  ];
  const assets: StoredMedia[] = [];

  const scoped = {
    brand: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const tid = getTenantId();
        return brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid)) ?? null;
      }),
    },
    brandMediaAsset: {
      findMany: vi.fn(async (args: { where: { brandId: string } }) => {
        const tid = getTenantId();
        return assets.filter(
          (a) => a.brandId === args.where.brandId && (!tid || a.tenantId === tid),
        );
      }),
      findFirst: vi.fn(async (args: { where: { id: string; brandId: string } }) => {
        const tid = getTenantId();
        return (
          assets.find(
            (a) =>
              a.id === args.where.id &&
              a.brandId === args.where.brandId &&
              (!tid || a.tenantId === tid),
          ) ?? null
        );
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { title: string } }) => {
        const tid = getTenantId();
        const found = assets.find((a) => a.id === args.where.id && (!tid || a.tenantId === tid));
        if (!found) throw new Error('not found');
        found.title = args.data.title;
        return found;
      }),
    },
  };

  const base = {
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => {
      const tx = {
        brandMediaAsset: {
          create: async (args: {
            data: Omit<StoredMedia, 'aiPrompt' | 'aiModel' | 'usedCount' | 'createdAt'>;
          }) => {
            const row: StoredMedia = {
              ...args.data,
              aiPrompt: null,
              aiModel: null,
              usedCount: 0,
              createdAt: new Date(),
            };
            assets.push(row);
            return row;
          },
          deleteMany: async (args: {
            where: { id: string; brandId: string; tenantId: string };
          }) => {
            const idx = assets.findIndex(
              (a) =>
                a.id === args.where.id &&
                a.brandId === args.where.brandId &&
                a.tenantId === args.where.tenantId,
            );
            if (idx === -1) return { count: 0 };
            assets.splice(idx, 1);
            return { count: 1 };
          },
        },
      };
      return fn(tx);
    }),
  };

  return {
    scoped,
    base,
    assets,
    clear: () => assets.splice(0, assets.length),
  };
}

describe('BrandMediaController, BrandMediaPublicController & BrandMediaService (F8 HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let jwtAccessSecret: string;
  let storageUsed = 0n;
  let storageLimit = 100n * 1024n * 1024n;
  const store = createMediaStore(() => currentTenantId());

  beforeAll(async () => {
    app = await createApiApp();
    jwtAccessSecret = parseEnv().JWT_ACCESS_SECRET;

    const authStore = app.get(PrismaAuthStore);
    vi.spyOn(authStore, 'findUserById').mockImplementation(async (userId: string) => {
      if (userId === 'u_a') {
        return {
          id: 'u_a',
          tenantId: 'tenant_a',
          username: 'a',
          passwordHash: 'hash',
          nickname: 'A',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant A',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
      }
      if (userId === 'u_b') {
        return {
          id: 'u_b',
          tenantId: 'tenant_b',
          username: 'b',
          passwordHash: 'hash',
          nickname: 'B',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant B',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
      }
      if (userId === 'u_exp') {
        return {
          id: 'u_exp',
          tenantId: 'tenant_exp',
          username: 'exp',
          passwordHash: 'hash',
          nickname: 'Exp',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Expired',
          isActive: true,
          expiresAt: new Date(Date.now() - 86_400_000),
        };
      }
      return null;
    });
    vi.spyOn(authStore, 'latestRevokeAt').mockResolvedValue(null);

    const prismaService = app.get(PrismaService);
    vi.spyOn(prismaService, 'scoped', 'get').mockReturnValue(
      store.scoped as unknown as PrismaService['scoped'],
    );
    vi.spyOn(prismaService, 'base', 'get').mockReturnValue(
      store.base as unknown as PrismaService['base'],
    );

    const quotaService = app.get(QuotaService);
    vi.spyOn(quotaService, 'consume').mockImplementation(async (_tid, _key, amount) => {
      const delta = BigInt(amount);
      if (storageUsed + delta > storageLimit) {
        throw new ApiError(409, API_ERROR.QUOTA_EXCEEDED, '配额不足');
      }
      storageUsed += delta;
      return { used: storageUsed, limit: storageLimit };
    });
    vi.spyOn(quotaService, 'release').mockImplementation(async (_tid, _key, amount) => {
      const delta = BigInt(amount);
      storageUsed = storageUsed >= delta ? storageUsed - delta : 0n;
      return { used: storageUsed, limit: storageLimit };
    });
    vi.spyOn(quotaService, 'read').mockImplementation(async () => [
      { key: 'STORAGE_BYTES', used: storageUsed, limit: storageLimit, measure: 'stock' },
    ]);

    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    store.clear();
    storageUsed = 0n;
    storageLimit = 100n * 1024n * 1024n;
  });

  function makeToken(userId: string, tenantId: string): string {
    const now = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: userId,
        tid: tenantId,
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hash'),
        lms: Date.now(),
        iat: now,
        exp: now + 3600,
      },
      jwtAccessSecret,
    );
  }

  it('uploads product photo with EXIF stripping, 240x240 thumbnail, signed serving, Alt edit, quota tracking, and cross-brand/tenant 404', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const tokenB = makeToken('u_b', 'tenant_b');
    const tokenExp = makeToken('u_exp', 'tenant_exp');

    // Create synthetic JPEG containing EXIF metadata
    const jpegWithExif = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 28, g: 120, b: 196 } },
    })
      .withMetadata({ exif: { IFD0: { Artist: 'SecretCameraOwner', Copyright: 'EXIF-TEST' } } })
      .jpeg({ quality: 90 })
      .toBuffer();

    const uploadForm = new FormData();
    uploadForm.append(
      'file',
      new Blob([new Uint8Array(jpegWithExif)], { type: 'image/jpeg' }),
      'dxp4800-front.jpg',
    );
    uploadForm.append('title', 'DXP4800 正面实拍图');

    const uploadRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
      body: uploadForm,
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      code: number;
      data: {
        items: Array<{ id: string; title: string; url: string; thumbUrl: string; bytes: number }>;
        item: { id: string; title: string; url: string; thumbUrl: string; bytes: number };
        storage: { used: string };
      };
    };
    expect(uploadBody.code).toBe(0);
    expect(uploadBody.data.items).toHaveLength(1);
    const asset = uploadBody.data.item;
    expect(asset.title).toBe('DXP4800 正面实拍图');
    expect(BigInt(uploadBody.data.storage.used)).toBe(BigInt(asset.bytes));
    expect(asset.url).toContain('exp=');
    expect(asset.url).toContain('sig=');
    expect(asset.thumbUrl).toContain('exp=');
    expect(asset.thumbUrl).toContain('sig=');

    const parsedFileUrl = new URL(`${baseUrl}${asset.url}`);
    const issuedExp = Number(parsedFileUrl.searchParams.get('exp'));
    const issuedSig = parsedFileUrl.searchParams.get('sig') ?? '';
    expect(Number.isSafeInteger(issuedExp)).toBe(true);
    expect(issuedExp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Signed URL serves /file without Authorization header, EXIF stripped, nosniff header set
    const fileRes = await fetch(`${baseUrl}${asset.url}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
    const downloadedBuf = Buffer.from(await fileRes.arrayBuffer());
    const downloadedMeta = await sharp(downloadedBuf).metadata();
    expect(downloadedMeta.exif).toBeUndefined();

    // Signed URL serves 240x240 thumbnail
    const thumbRes = await fetch(`${baseUrl}${asset.thumbUrl}`);
    expect(thumbRes.status).toBe(200);
    const thumbMeta = await sharp(Buffer.from(await thumbRes.arrayBuffer())).metadata();
    expect(thumbMeta.width).toBe(240);
    expect(thumbMeta.height).toBe(240);

    // Tampered HMAC signature -> 401
    const badSigRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&exp=${issuedExp}&sig=00000000000000000000000000000000`,
    );
    expect(badSigRes.status).toBe(401);

    // Missing exp -> 401
    const missingExpRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&sig=${issuedSig}`,
    );
    expect(missingExpRes.status).toBe(401);

    // Expired exp=1 (even with freshly computed HMAC for exp=1) -> 401
    const mediaService = app.get(BrandMediaService);
    const expiredSig = mediaService.signMediaVariant('tenant_a', 'brand_a1', asset.id, 'file', 1);
    const expiredRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&exp=1&sig=${expiredSig}`,
    );
    expect(expiredRes.status).toBe(401);

    // Expired exp=1 paired with valid sig -> 401
    const expiredOldSigRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&exp=1&sig=${issuedSig}`,
    );
    expect(expiredOldSigRes.status).toBe(401);

    // Tampered exp (extended TTL with original sig) -> 401
    const tamperedExpRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&exp=${issuedExp + 3600}&sig=${issuedSig}`,
    );
    expect(tamperedExpRes.status).toBe(401);

    // Malformed exp -> 401
    const malformedExpRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/thumb?tid=tenant_a&exp=not-a-timestamp&sig=${issuedSig}`,
    );
    expect(malformedExpRes.status).toBe(401);

    // Duplicate query params (?exp=, ?tid=, ?sig=) parsed as arrays by Express -> 401 (never 500)
    const dupExpFileRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&exp=1&exp=${issuedExp}&sig=${issuedSig}`,
    );
    expect(dupExpFileRes.status).toBe(401);

    const dupExpThumbRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/thumb?tid=tenant_a&exp=1&exp=${issuedExp}&sig=${issuedSig}`,
    );
    expect(dupExpThumbRes.status).toBe(401);

    const dupTidRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&tid=tenant_b&exp=${issuedExp}&sig=${issuedSig}`,
    );
    expect(dupTidRes.status).toBe(401);

    const dupSigRes = await fetch(
      `${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}/file?tid=tenant_a&exp=${issuedExp}&sig=${issuedSig}&sig=00000000000000000000000000000000`,
    );
    expect(dupSigRes.status).toBe(401);

    // Deterministic unit check on BrandMediaService.verifyMediaVariant boundary & non-string guards
    const fixedNowMs = 1_800_000_000_000;
    const fixedExp = mediaService.computeMediaExpiry(fixedNowMs, 60);
    const fixedSig = mediaService.signMediaVariant(
      'tenant_a',
      'brand_a1',
      asset.id,
      'file',
      fixedExp,
    );
    expect(
      mediaService.verifyMediaVariant(
        'tenant_a',
        'brand_a1',
        asset.id,
        'file',
        fixedSig,
        fixedExp,
        fixedNowMs + 59_000,
      ),
    ).toBe(true);
    expect(
      mediaService.verifyMediaVariant(
        'tenant_a',
        'brand_a1',
        asset.id,
        'file',
        fixedSig,
        fixedExp,
        fixedNowMs + 60_000,
      ),
    ).toBe(false);
    expect(
      mediaService.verifyMediaVariant(
        'tenant_a',
        'brand_a1',
        asset.id,
        'file',
        fixedSig,
        ['1', String(fixedExp)],
        fixedNowMs,
      ),
    ).toBe(false);
    expect(
      mediaService.verifyMediaVariant(
        'tenant_a',
        'brand_a1',
        asset.id,
        'file',
        [fixedSig, fixedSig],
        fixedExp,
        fixedNowMs,
      ),
    ).toBe(false);
    expect(
      mediaService.verifyMediaVariant(
        ['tenant_a'] as unknown as string,
        'brand_a1',
        asset.id,
        'file',
        fixedSig,
        fixedExp,
        fixedNowMs,
      ),
    ).toBe(false);

    // GET /media returns fresh exp-bound signed URLs
    const listRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { items: Array<{ url: string; thumbUrl: string | null }> };
    };
    expect(listBody.data.items[0]?.url).toContain('exp=');
    expect(listBody.data.items[0]?.thumbUrl).toContain('exp=');

    // PATCH Alt text succeeds and returns fresh signed URL; prohibited Alt text -> 403 / 40302
    const patchRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'DXP4800 静音四盘位正面细节图' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      data: { title: string; url: string; thumbUrl: string | null };
    };
    expect(patchBody.data.title).toBe('DXP4800 静音四盘位正面细节图');
    expect(patchBody.data.url).toContain('exp=');
    expect(patchBody.data.thumbUrl).toContain('exp=');

    const badAltRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '线上赌博实拍' }),
    });
    expect(badAltRes.status).toBe(403);
    expect(((await badAltRes.json()) as { code: number }).code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);

    // Cross-brand & cross-tenant isolation -> 404
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands/brand_a2/media/${asset.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokenA}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokenB}` },
        })
      ).status,
    ).toBe(404);

    // Expired tenant: GET media -> 200, DELETE -> 403/40301
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands/brand_exp1/media`, {
          headers: { authorization: `Bearer ${tokenExp}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands/brand_exp1/media/${asset.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokenExp}` },
        })
      ).status,
    ).toBe(403);

    // Reject disguised SVG renamed to .jpg -> 400
    const badForm = new FormData();
    badForm.append(
      'file',
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/jpeg' }),
      'evil.jpg',
    );
    const badRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
      body: badForm,
    });
    expect(badRes.status).toBe(400);

    // Quota exceeded -> 409 / 40901 and rolls back stored objects
    storageLimit = storageUsed + 10n;
    const storageDeleteSpy = vi.spyOn(app.get(StorageService), 'delete');
    const quotaForm = new FormData();
    quotaForm.append(
      'file',
      new Blob([new Uint8Array(jpegWithExif)], { type: 'image/jpeg' }),
      'over-quota.jpg',
    );
    const quotaRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
      body: quotaForm,
    });
    expect(quotaRes.status).toBe(409);
    expect(((await quotaRes.json()) as { code: number }).code).toBe(API_ERROR.QUOTA_EXCEEDED);
    expect(storageDeleteSpy).toHaveBeenCalled();

    // DELETE releases quota back to 0
    const delRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/${asset.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as {
      data: { deleted: number; id: string; releasedBytes: number; storage: { used: string } };
    };
    expect(delBody.data).toMatchObject({
      deleted: 1,
      id: asset.id,
      releasedBytes: asset.bytes,
    });
    expect(delBody.data.storage.used).toBe('0');
  });
});
