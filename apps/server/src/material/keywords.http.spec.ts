import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR, KEYWORD_EMPTY_MAIN_MSG } from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../billing/billing.service';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import { LlmService } from '../infra/llm';
import { ProviderError, PROVIDER_KIND } from '../infra/provider-error';

describe('keywords routes without a database', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    app = await createApiApp();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects anonymous list and distill calls', async () => {
    const listRes = await httpCall(base, 'GET', '/api/v1/keywords');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const distillRes = await httpCall(base, 'POST', '/api/v1/keywords/distill', {
      body: { main: '工业机器人' },
    });
    expect(distillRes.status).toBe(401);
    expect(distillRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'keywords CRUD, quotas, and AI distill against isolated Postgres',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('kw');
    }, 120_000);

    afterAll(async () => {
      if (ctx) await ctx.close();
    }, 60_000);

    it('validates empty main keyword, blocks forbidden industry without charging, settles valid distill, and refunds failed distill', async () => {
      const strictTenant = await ctx.createTenantUser({
        prefix: 'strict',
        points: 100,
        billingMode: 'STRICT',
      });
      const billing = ctx.app.get(BillingService);
      const llm = ctx.app.get(LlmService);

      const emptyMain = await httpCall(ctx.base, 'POST', '/api/v1/keywords', {
        token: strictTenant.token,
        body: { main: '  ', questionsText: '' },
      });
      expect(emptyMain.status).toBe(400);
      expect(emptyMain.msg).toBe(KEYWORD_EMPTY_MAIN_MSG);

      const forbidden = await httpCall(ctx.base, 'POST', '/api/v1/keywords/distill', {
        token: strictTenant.token,
        headers: { 'idempotency-key': 'idem-forbidden-01' },
        body: { main: '网络赌博系统', brands: '某某' },
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);
      expect((await billing.wallet(strictTenant.tenantId)).points).toBe(100);

      // 1) Distill fails because LLM returns < 5 valid items -> automatic refund!
      const spyTooFew = vi.spyOn(llm, 'complete').mockResolvedValueOnce({
        provider: 'scripted',
        model: 'scripted-cheap',
        fake: false,
        text: JSON.stringify(['工业机器人哪家靠谱？', '无关词条']),
        tokensIn: 20,
        tokensOut: 15,
        cost: {
          recordId: 'r1',
          tenantId: strictTenant.tenantId,
          idempotencyKey: 'distill:idem-toofew-0001',
          scene: 'distill',
          provider: 'scripted',
          model: 'scripted-cheap',
          fake: false,
          tokensIn: 20,
          tokensOut: 15,
          costMicro: 35,
          costBasis: 'placeholder',
          latencyMs: 5,
          fingerprint: 'fp1',
        },
      });
      const tooFew = await httpCall(ctx.base, 'POST', '/api/v1/keywords/distill', {
        token: strictTenant.token,
        headers: { 'idempotency-key': 'idem-toofew-0001' },
        body: { main: '工业机器人', brands: '智造甲' },
      });
      spyTooFew.mockRestore();
      expect(tooFew.status).toBe(422);
      const afterTooFew = await billing.wallet(strictTenant.tenantId);
      expect(afterTooFew.points).toBe(100);
      expect(afterTooFew.pointsReserved).toBe(0);
      expect(await billing.auditTenant(strictTenant.tenantId)).toEqual([]);

      // 2) Distill fails because LLM throws upstream error -> automatic refund!
      const spyThrow = vi
        .spyOn(llm, 'complete')
        .mockRejectedValueOnce(
          new ProviderError(PROVIDER_KIND.UPSTREAM, '上游异常', 'upstream_5xx'),
        );
      const thrown = await httpCall(ctx.base, 'POST', '/api/v1/keywords/distill', {
        token: strictTenant.token,
        headers: { 'idempotency-key': 'idem-throw-00001' },
        body: { main: '工业机器人', brands: '智造甲' },
      });
      spyThrow.mockRestore();
      expect(thrown.status).toBe(502);
      const afterThrow = await billing.wallet(strictTenant.tenantId);
      expect(afterThrow.points).toBe(100);
      expect(afterThrow.pointsReserved).toBe(0);
      expect(await billing.auditTenant(strictTenant.tenantId)).toEqual([]);

      // 3) Distill succeeds with FakeLlm -> settles 10 points and records AI蒸馏拓展-工业机器人
      const okDistill = await httpCall<{
        questions: string[];
        charged: number;
        shadow: boolean;
      }>(ctx.base, 'POST', '/api/v1/keywords/distill', {
        token: strictTenant.token,
        headers: { 'idempotency-key': 'idem-ok-distill-1' },
        body: { main: '工业机器人', brands: '智造甲,智造乙' },
      });
      expect(okDistill.status).toBe(200);
      expect(okDistill.data.questions.length).toBeGreaterThanOrEqual(5);
      expect(okDistill.data.charged).toBe(10);
      expect(okDistill.data.shadow).toBe(false);

      const afterOk = await billing.wallet(strictTenant.tenantId);
      expect(afterOk.points).toBe(90);
      expect(afterOk.pointsReserved).toBe(0);
      expect(await billing.auditTenant(strictTenant.tenantId)).toEqual([]);

      const logs = await billing.ledger(strictTenant.tenantId, 1, 20);
      expect(logs.items.some((l) => l.title === 'AI蒸馏拓展-工业机器人' && l.delta === -10)).toBe(
        true,
      );
    });

    it('synchronizes MAIN_KEYWORD and QUESTION quotas on create, update, and delete, and isolates tenants', async () => {
      const tenantA = await ctx.createTenantUser({ prefix: 'kwa' });
      const tenantB = await ctx.createTenantUser({ prefix: 'kwb' });

      const created = await httpCall<{
        keyword: { id: string; questionCount: number };
        addedQuestions: number;
        skippedDuplicates: number;
      }>(ctx.base, 'POST', '/api/v1/keywords', {
        token: tenantA.token,
        body: {
          main: '智能仓储系统',
          brands: '仓储甲，仓储乙',
          questionsText:
            '智能仓储系统哪家好？\n智能仓储系统哪家好?\n智能仓储系统报价\n定制智能仓储系统方案',
        },
      });
      expect(created.status).toBe(200);
      expect(created.data.addedQuestions).toBe(3);
      expect(created.data.skippedDuplicates).toBe(1);
      expect(created.data.keyword.questionCount).toBe(3);

      const qAfterCreate = await ctx.prisma.base.quota.findMany({
        where: { tenantId: tenantA.tenantId, key: { in: ['MAIN_KEYWORD', 'QUESTION'] } },
      });
      expect(Number(qAfterCreate.find((r) => r.key === 'MAIN_KEYWORD')?.used ?? 0n)).toBe(1);
      expect(Number(qAfterCreate.find((r) => r.key === 'QUESTION')?.used ?? 0n)).toBe(3);

      // Cross-tenant isolation
      const crossRead = await httpCall(
        ctx.base,
        'GET',
        `/api/v1/keywords/${created.data.keyword.id}`,
        { token: tenantB.token },
      );
      expect(crossRead.status).toBe(404);

      // Update questions: remove 1, add 2 -> total 4
      const updated = await httpCall<{
        keyword: { questionCount: number };
        addedQuestions: number;
        removedQuestions: number;
      }>(ctx.base, 'PATCH', `/api/v1/keywords/${created.data.keyword.id}`, {
        token: tenantA.token,
        body: {
          main: '智能仓储系统',
          brands: ['仓储甲'],
          questionsText:
            '智能仓储系统哪家好？\n智能仓储系统报价\n智能仓储系统厂家盘点\n智能仓储系统实施周期',
        },
      });
      expect(updated.status).toBe(200);
      expect(updated.data.keyword.questionCount).toBe(4);

      const qAfterUpdate = await ctx.prisma.base.quota.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: tenantA.tenantId, key: 'QUESTION' } },
      });
      expect(Number(qAfterUpdate.used)).toBe(4);

      // Delete releases both MAIN_KEYWORD and QUESTION quotas
      const deleted = await httpCall<{ affected: number }>(
        ctx.base,
        'POST',
        '/api/v1/keywords/bulk',
        {
          token: tenantA.token,
          body: { action: 'delete', ids: [created.data.keyword.id] },
        },
      );
      expect(deleted.status).toBe(200);
      expect(deleted.data.affected).toBe(1);

      const qAfterDelete = await ctx.prisma.base.quota.findMany({
        where: { tenantId: tenantA.tenantId, key: { in: ['MAIN_KEYWORD', 'QUESTION'] } },
      });
      expect(Number(qAfterDelete.find((r) => r.key === 'MAIN_KEYWORD')?.used ?? 0n)).toBe(0);
      expect(Number(qAfterDelete.find((r) => r.key === 'QUESTION')?.used ?? 0n)).toBe(0);
    });
  },
);
