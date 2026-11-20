import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createScopedClient } from './tenant-scope';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')('tenant scope against Postgres', () => {
  const als = new AsyncLocalStorage<{ tenantId: string }>();
  const { base, scoped } = createScopedClient(() => als.getStore()?.tenantId, databaseUrl);
  const suffix = randomBytes(4).toString('hex');
  const tenantA = `scope_a_${suffix}`;
  const tenantB = `scope_b_${suffix}`;
  const brandA = `scope_br_a_${suffix}`;
  const brandB = `scope_br_b_${suffix}`;

  afterAll(async () => {
    await base.brand.deleteMany({ where: { id: { in: [brandA, brandB] } } });
    await base.quota.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await base.wallet.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await base.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await base.$disconnect();
  });

  it('filters reads and blocks cross-tenant writes', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    await base.tenant.create({ data: { id: tenantA, name: '范围甲', expiresAt } });
    await base.tenant.create({ data: { id: tenantB, name: '范围乙', expiresAt } });
    await base.wallet.create({ data: { tenantId: tenantA, points: 3 } });
    await base.wallet.create({ data: { tenantId: tenantB, points: 9 } });
    await base.quota.create({
      data: { tenantId: tenantB, key: 'MAIN_KEYWORD', limit: 10n, used: 1n },
    });
    await base.brand.create({
      data: { id: brandA, tenantId: tenantA, name: '品牌甲', category: 'NAS' },
    });
    await base.brand.create({
      data: { id: brandB, tenantId: tenantB, name: '品牌乙', category: 'NAS' },
    });

    const unscoped = await scoped.brand.findMany({
      where: { id: { in: [brandA, brandB] } },
      orderBy: { id: 'asc' },
    });
    expect(unscoped.map((row) => row.id).sort()).toEqual([brandA, brandB].sort());

    await als.run({ tenantId: tenantA }, async () => {
      const visible = await scoped.brand.findMany({
        where: { id: { in: [brandA, brandB] } },
      });
      expect(visible.map((row) => row.id)).toEqual([brandA]);
      expect(await scoped.brand.findUnique({ where: { id: brandB } })).toBeNull();
      expect((await scoped.brand.findUnique({ where: { id: brandA } }))?.name).toBe('品牌甲');

      const created = await scoped.brand.create({
        data: { tenantId: tenantB, name: `被改写的租户${suffix}`, category: 'NAS' },
      });
      expect(created.tenantId).toBe(tenantA);
      await base.brand.delete({ where: { id: created.id } });

      const updated = await scoped.brand.updateMany({
        where: { id: brandB },
        data: { name: '不该写成功', tenantId: tenantA },
      });
      expect(updated.count).toBe(0);
      await expect(scoped.brand.delete({ where: { id: brandB } })).rejects.toThrow(/not found/i);

      expect(await scoped.wallet.findUnique({ where: { tenantId: tenantB } })).toBeNull();
      expect((await scoped.wallet.findUnique({ where: { tenantId: tenantA } }))?.points).toBe(3);
      expect(
        await scoped.quota.findUnique({
          where: { tenantId_key: { tenantId: tenantB, key: 'MAIN_KEYWORD' } },
        }),
      ).toBeNull();
    });

    expect((await base.brand.findUnique({ where: { id: brandB } }))?.name).toBe('品牌乙');
  });
});
