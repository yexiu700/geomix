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
  const keywordA = `scope_kw_a_${suffix}`;
  const keywordB = `scope_kw_b_${suffix}`;
  const systemPrompt = `scope_sys_${suffix}`;
  const promptB = `scope_pb_${suffix}`;

  afterAll(async () => {
    await base.promptTemplate.deleteMany({ where: { id: { in: [systemPrompt, promptB] } } });
    await base.keyword.deleteMany({ where: { id: { in: [keywordA, keywordB] } } });
    await base.quota.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await base.wallet.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await base.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await base.$disconnect();
  });

  it('filters reads, blocks cross-tenant writes, and keeps system templates visible', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    await base.tenant.create({ data: { id: tenantA, name: '范围甲', expiresAt } });
    await base.tenant.create({ data: { id: tenantB, name: '范围乙', expiresAt } });
    await base.wallet.create({ data: { tenantId: tenantA, points: 3 } });
    await base.wallet.create({ data: { tenantId: tenantB, points: 9 } });
    await base.quota.create({
      data: { tenantId: tenantB, key: 'MAIN_KEYWORD', limit: 10n, used: 1n },
    });
    await base.keyword.create({ data: { id: keywordA, tenantId: tenantA, main: '甲' } });
    await base.keyword.create({ data: { id: keywordB, tenantId: tenantB, main: '乙' } });
    await base.promptTemplate.create({
      data: {
        id: systemPrompt,
        kind: 'ARTICLE',
        name: '系统',
        content: '系统模板',
        tenantId: null,
      },
    });
    await base.promptTemplate.create({
      data: { id: promptB, tenantId: tenantB, kind: 'ARTICLE', name: '乙的指令', content: '乙' },
    });

    const unscoped = await scoped.keyword.findMany({
      where: { id: { in: [keywordA, keywordB] } },
      orderBy: { id: 'asc' },
    });
    expect(unscoped.map((row) => row.id).sort()).toEqual([keywordA, keywordB].sort());

    await als.run({ tenantId: tenantA }, async () => {
      const visible = await scoped.keyword.findMany({
        where: { id: { in: [keywordA, keywordB] } },
      });
      expect(visible.map((row) => row.id)).toEqual([keywordA]);
      expect(await scoped.keyword.findUnique({ where: { id: keywordB } })).toBeNull();
      expect((await scoped.keyword.findUnique({ where: { id: keywordA } }))?.main).toBe('甲');

      const created = await scoped.keyword.create({
        data: { tenantId: tenantB, main: `被改写的租户${suffix}` },
      });
      expect(created.tenantId).toBe(tenantA);
      await base.keyword.delete({ where: { id: created.id } });

      const updated = await scoped.keyword.updateMany({
        where: { id: keywordB },
        data: { main: '不该写成功', tenantId: tenantA },
      });
      expect(updated.count).toBe(0);
      await expect(scoped.keyword.delete({ where: { id: keywordB } })).rejects.toThrow(
        /not found/i,
      );

      expect(await scoped.wallet.findUnique({ where: { tenantId: tenantB } })).toBeNull();
      expect((await scoped.wallet.findUnique({ where: { tenantId: tenantA } }))?.points).toBe(3);
      expect(
        await scoped.quota.findUnique({
          where: { tenantId_key: { tenantId: tenantB, key: 'MAIN_KEYWORD' } },
        }),
      ).toBeNull();

      const prompts = await scoped.promptTemplate.findMany({
        where: { id: { in: [systemPrompt, promptB] } },
      });
      expect(prompts.map((row) => row.id)).toEqual([systemPrompt]);
      await expect(
        scoped.promptTemplate.update({
          where: { id: systemPrompt },
          data: { content: '改系统模板' },
        }),
      ).rejects.toThrow(/not found/i);
    });

    expect((await base.keyword.findUnique({ where: { id: keywordB } }))?.main).toBe('乙');
    expect((await base.promptTemplate.findUnique({ where: { id: systemPrompt } }))?.content).toBe(
      '系统模板',
    );
  });
});
