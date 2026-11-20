import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { UserRole } from '@prisma/client';
import { createPrismaClient } from './client';
import { applySeed, DEMO_TENANT_ID, DEMO_USER_ID, PLATFORM_TENANT_ID } from './seed';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')('seed against Postgres', () => {
  const prisma = createPrismaClient(databaseUrl);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is idempotent, cleans legacy pricing rows, and enforces ledger checks & HNSW index', async () => {
    const migrated = spawnSync('node', ['scripts/prisma-cli.mjs', 'migrate', 'deploy'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(0);

    const first = await applySeed(prisma, { now: new Date('2026-11-16T00:00:00.000Z') });
    expect(first).toEqual({
      pricing: 3,
      tenants: 2,
      wallets: 2,
      quotas: 12,
      users: 2,
    });

    const seededWallet = await prisma.wallet.findUniqueOrThrow({
      where: { tenantId: DEMO_TENANT_ID },
    });
    expect(seededWallet.points).toBe(1000);
    const seededTenant = await prisma.tenant.findUniqueOrThrow({ where: { id: DEMO_TENANT_ID } });
    expect(seededTenant.billingMode).toBeNull();
    const seededUser = await prisma.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } });

    await prisma.wallet.update({
      where: { tenantId: DEMO_TENANT_ID },
      data: { points: 42 },
    });
    await prisma.quota.update({
      where: { tenantId_key: { tenantId: DEMO_TENANT_ID, key: 'MAIN_KEYWORD' } },
      data: { used: 7n, limit: 5n },
    });
    await prisma.tenant.update({
      where: { id: DEMO_TENANT_ID },
      data: { billingMode: 'STRICT', isActive: false, name: '临时名称' },
    });
    await prisma.user.update({
      where: { id: DEMO_USER_ID },
      data: { passwordHash: 'replaced-hash', username: 'demo2' },
    });
    await prisma.pricingItem.update({
      where: { action: 'geo_write' },
      data: { unitPoints: 99, enabled: false },
    });
    await prisma.pricingItem.create({
      data: { action: 'kb_addon', unitPoints: 5, enabled: true },
    });

    expect(await applySeed(prisma)).toEqual(first);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: DEMO_TENANT_ID } });
    expect(wallet.points).toBe(42);
    const quota = await prisma.quota.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: DEMO_TENANT_ID, key: 'MAIN_KEYWORD' } },
    });
    expect(quota.used).toBe(7n);
    expect(quota.limit).toBe(5n);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: DEMO_TENANT_ID } });
    expect(tenant.billingMode).toBe('STRICT');
    expect(tenant.isActive).toBe(false);
    expect(tenant.name).toBe('GeoMix 演示');
    expect(tenant.expiresAt.toISOString()).toBe(seededTenant.expiresAt.toISOString());
    const user = await prisma.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } });
    expect(user.passwordHash).toBe('replaced-hash');
    expect(user.passwordHash).not.toBe(seededUser.passwordHash);
    expect(user.username).toBe('demo');
    expect(user.role).toBe(UserRole.MERCHANT);

    const price = await prisma.pricingItem.findUniqueOrThrow({ where: { action: 'geo_write' } });
    expect(price.unitPoints).toBe(10);
    expect(price.enabled).toBe(true);
    expect(await prisma.pricingItem.findUnique({ where: { action: 'kb_addon' } })).toBeNull();
    expect(await prisma.pricingItem.count()).toBe(3);
    expect(await prisma.user.count()).toBe(2);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { tenantId: PLATFORM_TENANT_ID } })).points,
    ).toBe(0);

    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('chk_wallet_nonneg', 'chk_quota_nonneg', 'chk_resv')
      ORDER BY conname
    `;
    expect(constraints.map((row) => row.conname)).toEqual([
      'chk_quota_nonneg',
      'chk_resv',
      'chk_wallet_nonneg',
    ]);
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_brand_fact_chunk_embedding'
    `;
    expect(indexes[0]?.indexdef.toLowerCase()).toContain('hnsw');
    expect(indexes[0]?.indexdef.toLowerCase()).toContain('vector_cosine_ops');
    const columns = await prisma.$queryRaw<Array<{ typ: string }>>`
      SELECT format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'BrandFactChunk'
        AND a.attname = 'embedding'
    `;
    expect(columns[0]?.typ).toBe('vector(1024)');

    await expect(
      prisma.$executeRaw`UPDATE "Wallet" SET points = -1 WHERE "tenantId" = ${DEMO_TENANT_ID}`,
    ).rejects.toThrow(/chk_wallet_nonneg/);
    await expect(
      prisma.$executeRaw`UPDATE "Wallet" SET points = 10, "pointsReserved" = 11 WHERE "tenantId" = ${DEMO_TENANT_ID}`,
    ).rejects.toThrow(/chk_wallet_nonneg/);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { tenantId: DEMO_TENANT_ID } })).points,
    ).toBe(42);
    await expect(
      prisma.$executeRaw`UPDATE "Quota" SET used = -1 WHERE "tenantId" = ${DEMO_TENANT_ID} AND key = 'MAIN_KEYWORD'::"QuotaKey"`,
    ).rejects.toThrow(/chk_quota_nonneg/);
    await expect(
      prisma.$executeRaw`
        INSERT INTO "PointReservation"
          ("id", "tenantId", "refType", "refId", "frozen", "settled", "released", "status")
        VALUES
          ('seed_chk_resv', ${DEMO_TENANT_ID}, 'geo_article', 'seed-chk', 1, 1, 1, 'OPEN'::"ReservationStatus")
      `,
    ).rejects.toThrow(/chk_resv/);
  });
});
