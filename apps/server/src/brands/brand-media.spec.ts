import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { API_ERROR, BILLING_ERROR, parseEnv } from '@geomix/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { PrismaAuthStore } from '../auth/prisma-auth.store';
import { signToken } from '../auth/token';
import { BillingService, type ReservationView } from '../billing/billing.service';
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
      findFirst: vi.fn(async (args: { where: { id: string; brandId?: string } }) => {
        const tid = getTenantId();
        return (
          assets.find(
            (a) =>
              a.id === args.where.id &&
              (!args.where.brandId || a.brandId === args.where.brandId) &&
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
            data: Omit<StoredMedia, 'aiPrompt' | 'aiModel' | 'usedCount' | 'createdAt'> & {
              aiPrompt?: string | null;
              aiModel?: string | null;
            };
          }) => {
            const row: StoredMedia = {
              ...args.data,
              aiPrompt: args.data.aiPrompt ?? null,
              aiModel: args.data.aiModel ?? null,
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

  it('generates inline AI images via POST /media/ai-gen with STRICT/SHADOW billing, 402, [E2E_IMAGE_FAIL] refund, idempotency, quota rollback, and guards', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const tokenB = makeToken('u_b', 'tenant_b');
    const tokenExp = makeToken('u_exp', 'tenant_exp');

    const wallets = new Map<string, { points: number; reserved: number; strict: boolean }>([
      ['tenant_a', { points: 20, reserved: 0, strict: true }],
      ['tenant_b', { points: 20, reserved: 0, strict: false }],
    ]);
    const reservations = new Map<string, ReservationView>();

    const billing = app.get(BillingService);
    const unitPriceSpy = vi.spyOn(billing, 'unitPrice').mockResolvedValue(5);
    const reserveSpy = vi.spyOn(billing, 'reserve').mockImplementation(async (input) => {
      const key = `${input.tenantId}:${input.refType}:${input.refId}`;
      const existing = reservations.get(key);
      if (existing) return existing;
      const wallet = wallets.get(input.tenantId) ?? { points: 0, reserved: 0, strict: true };
      if (wallet.strict && wallet.points - wallet.reserved < input.amount) {
        throw new ApiError(402, API_ERROR.INSUFFICIENT_POINTS, '点数不足');
      }
      if (wallet.strict) {
        wallet.reserved += input.amount;
      }
      const view: ReservationView = {
        id: `res_${reservations.size + 1}`,
        tenantId: input.tenantId,
        refType: input.refType,
        refId: input.refId,
        shadow: !wallet.strict,
        frozen: input.amount,
        settled: 0,
        released: 0,
        status: 'OPEN',
      };
      reservations.set(key, view);
      return view;
    });
    const settleSpy = vi.spyOn(billing, 'settle').mockImplementation(async (input) => {
      const found = [...reservations.values()].find((r) => r.id === input.reservationId)!;
      const wallet = wallets.get(input.tenantId)!;
      found.settled += input.amount;
      if (wallet.strict) {
        wallet.points -= input.amount;
        wallet.reserved = Math.max(0, wallet.reserved - input.amount);
      }
      return {
        reservation: found,
        lines: [],
        replayed: false,
      };
    });
    const releaseSpy = vi.spyOn(billing, 'releaseUnit').mockImplementation(async (input) => {
      const found = [...reservations.values()].find((r) => r.id === input.reservationId)!;
      const wallet = wallets.get(input.tenantId)!;
      found.released += input.amount;
      if (wallet.strict) {
        wallet.reserved = Math.max(0, wallet.reserved - input.amount);
      }
      return {
        reservation: found,
        lines: [],
        replayed: false,
      };
    });
    const closeSpy = vi.spyOn(billing, 'close').mockImplementation(async (input) => {
      const found = [...reservations.values()].find((r) => r.id === input.reservationId)!;
      found.status = 'CLOSED';
      return { reservation: found, releasedNow: 0 };
    });

    try {
      // 1. STRICT success (5 pts settled, direct BrandMediaAssetRecord in data)
      const idemKey = 'idem_ai_img_0001';
      const genRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({
          prompt: '极简桌面四盘位家用NAS静音散热风道原理示意图',
          title: '  ',
          aspectRatio: '16:9',
        }),
      });
      expect(genRes.status).toBe(200);
      const genBody = (await genRes.json()) as {
        code: number;
        data: {
          id: string;
          brandId: string;
          origin: string;
          title: string;
          url: string;
          thumbUrl: string | null;
          aiPrompt: string | null;
          aiModel: string | null;
          usedCount: number;
        };
      };
      expect(genBody.code).toBe(0);
      expect(genBody.data.origin).toBe('AI_INLINE_GEN');
      expect(genBody.data.aiPrompt).toBe('极简桌面四盘位家用NAS静音散热风道原理示意图');
      expect(genBody.data.aiModel).toBe('fake-image');
      expect(genBody.data.title).toContain('极简桌面四盘位');
      expect(genBody.data.usedCount).toBe(0);
      expect(genBody.data.url).toContain(`/api/v2/brands/brand_a1/media/${genBody.data.id}/file?`);
      expect(wallets.get('tenant_a')).toEqual({ points: 15, reserved: 0, strict: true });

      // 2. Idempotency replay returns same asset ID at 0 additional points
      const replayRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({
          prompt: '极简桌面四盘位家用NAS静音散热风道原理示意图',
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as { data: { id: string } };
      expect(replayBody.data.id).toBe(genBody.data.id);
      expect(wallets.get('tenant_a')).toEqual({ points: 15, reserved: 0, strict: true });

      // 3. Mismatched prompt or brand on same Idempotency-Key -> 409 / 40902
      const conflictRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({ prompt: '完全不同的另一张配图描述内容' }),
      });
      expect(conflictRes.status).toBe(409);
      expect(((await conflictRes.json()) as { code: number }).code).toBe(BILLING_ERROR.CONFLICT);

      // 4. Omitted Idempotency-Key auto-generates cleanly; malformed key -> 400 / 40001
      const badKeyRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': 'bad key!!',
        },
        body: JSON.stringify({ prompt: '极简桌面四盘位NAS产品图' }),
      });
      expect(badKeyRes.status).toBe(400);
      expect(((await badKeyRes.json()) as { code: number }).code).toBe(API_ERROR.BAD_REQUEST);

      // 5. [E2E_IMAGE_FAIL] -> 502 + atomic refund + 0 persisted assets
      const assetCountBeforeFail = store.assets.length;
      const failRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: '[E2E_IMAGE_FAIL] 触发上游故障自动退点' }),
      });
      expect(failRes.status).toBe(502);
      expect(((await failRes.json()) as { code: number }).code).toBe(
        API_ERROR.UPSTREAM_UNAVAILABLE,
      );
      expect(wallets.get('tenant_a')).toEqual({ points: 15, reserved: 0, strict: true });
      expect(store.assets.length).toBe(assetCountBeforeFail);

      // 6. Quota exceeded -> 409 / 40901 + atomic refund + storage cleanup
      storageLimit = storageUsed + 10n;
      const storageDelSpy = vi.spyOn(app.get(StorageService), 'delete');
      const quotaRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: '超出存储配额测试配图生成' }),
      });
      expect(quotaRes.status).toBe(409);
      expect(((await quotaRes.json()) as { code: number }).code).toBe(API_ERROR.QUOTA_EXCEEDED);
      expect(wallets.get('tenant_a')).toEqual({ points: 15, reserved: 0, strict: true });
      expect(storageDelSpy).toHaveBeenCalled();
      storageLimit = 100n * 1024n * 1024n;

      // 7. Prohibited industry prompt -> 403 / 40302 BEFORE reserve
      const reserveCallsBeforeComp = reserveSpy.mock.calls.length;
      const compRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: '制作网络赌博推广宣传海报' }),
      });
      expect(compRes.status).toBe(403);
      expect(((await compRes.json()) as { code: number }).code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);
      expect(reserveSpy.mock.calls.length).toBe(reserveCallsBeforeComp);

      // 8. Insufficient points in STRICT -> 402 / 40201 + 0 persisted assets
      wallets.set('tenant_a', { points: 3, reserved: 0, strict: true });
      const lowBalRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: '点数不足拦截验证测试配图' }),
      });
      expect(lowBalRes.status).toBe(402);
      expect(((await lowBalRes.json()) as { code: number }).code).toBe(
        API_ERROR.INSUFFICIENT_POINTS,
      );
      expect(wallets.get('tenant_a')).toEqual({ points: 3, reserved: 0, strict: true });

      // 9. SHADOW mode succeeds with 0 wallet deduction
      const shadowRes = await fetch(`${baseUrl}/api/v2/brands/brand_b1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenB}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'SHADOW 模式下生成的产品场景示意图' }),
      });
      expect(shadowRes.status).toBe(200);
      expect(wallets.get('tenant_b')).toEqual({ points: 20, reserved: 0, strict: false });

      // 10. Cross-tenant 404 & expired tenant 403 / 40301
      const crossRes = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenB}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: '跨租户越权测试配图提示词' }),
      });
      expect(crossRes.status).toBe(404);

      const expRes = await fetch(`${baseUrl}/api/v2/brands/brand_exp1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenExp}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: '到期租户拦截测试配图提示词' }),
      });
      expect(expRes.status).toBe(403);
      expect(((await expRes.json()) as { code: number }).code).toBe(API_ERROR.TENANT_EXPIRED);
    } finally {
      unitPriceSpy.mockRestore();
      reserveSpy.mockRestore();
      settleSpy.mockRestore();
      releaseSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('preserves paid BrandMediaAsset and returns 200 when billing.close() rejects after billing.settle() succeeds', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const wallet = { points: 50, reserved: 0 };
    const reservation: ReservationView = {
      id: 'res_close_fail_1',
      tenantId: 'tenant_a',
      refType: 'inline_image_gen',
      refId: 'close_fail_idem_0001',
      shadow: false,
      frozen: 5,
      settled: 0,
      released: 0,
      status: 'OPEN',
    };

    const billing = app.get(BillingService);
    const storage = app.get(StorageService);
    const unitPriceSpy = vi.spyOn(billing, 'unitPrice').mockResolvedValue(5);
    const reserveSpy = vi.spyOn(billing, 'reserve').mockImplementation(async (input) => {
      wallet.reserved += input.amount;
      return reservation;
    });
    const settleSpy = vi.spyOn(billing, 'settle').mockImplementation(async (input) => {
      reservation.settled += input.amount;
      wallet.points -= input.amount;
      wallet.reserved = Math.max(0, wallet.reserved - input.amount);
      return { reservation, lines: [], replayed: false };
    });
    const releaseSpy = vi.spyOn(billing, 'releaseUnit').mockImplementation(async () => ({
      reservation,
      lines: [],
      replayed: false,
    }));
    const closeSpy = vi
      .spyOn(billing, 'close')
      .mockRejectedValueOnce(new Error('simulated_db_close_failure'));
    const storageDeleteSpy = vi.spyOn(storage, 'delete');

    try {
      const assetsBefore = store.assets.length;
      const res = await fetch(`${baseUrl}/api/v2/brands/brand_a1/media/ai-gen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': 'close_fail_idem_0001',
        },
        body: JSON.stringify({
          prompt: 'Close failure after settle verification prompt',
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        code: number;
        data: { id: string; origin: string; brandId: string };
      };
      expect(body.code).toBe(0);
      expect(body.data.origin).toBe('AI_INLINE_GEN');
      expect(body.data.brandId).toBe('brand_a1');
      expect(store.assets.length).toBe(assetsBefore + 1);
      expect(store.assets.some((a) => a.id === body.data.id)).toBe(true);
      expect(wallet).toEqual({ points: 45, reserved: 0 });
      expect(settleSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(storageDeleteSpy).not.toHaveBeenCalled();
    } finally {
      unitPriceSpy.mockRestore();
      reserveSpy.mockRestore();
      settleSpy.mockRestore();
      releaseSpy.mockRestore();
      closeSpy.mockRestore();
      storageDeleteSpy.mockRestore();
    }
  });
});
