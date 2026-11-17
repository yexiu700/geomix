import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  PROMPT_MISSING_CONVERSION_WARN,
  PROMPT_REWRITE_BRAND_SWAP_WARN,
  PROMPT_SYSTEM_READONLY_MSG,
  type PromptListResponse,
  type PromptOptionsResponse,
  type PromptTemplateRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';

describe('prompts routes without a database', () => {
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

  it('rejects anonymous list, system, options, and clone calls', async () => {
    const listRes = await httpCall(base, 'GET', '/api/v1/prompts');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const sysRes = await httpCall(base, 'GET', '/api/v1/prompts/system');
    expect(sysRes.status).toBe(401);

    const cloneRes = await httpCall(base, 'POST', '/api/v1/prompts/sys_article_01/clone');
    expect(cloneRes.status).toBe(401);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'prompts CRUD, system read-only & clone, manual slot randomPool guard, and strict kind filtering against isolated Postgres',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('prm');
    }, 120_000);

    afterAll(async () => {
      if (ctx) await ctx.close();
    }, 60_000);

    it('filters ARTICLE/TITLE/REWRITE cleanly, guards system templates, clones & edits manual-slot templates, and blocks active task delete', async () => {
      const tenantA = await ctx.createTenantUser({ prefix: 'pa' });
      const tenantB = await ctx.createTenantUser({ prefix: 'pb' });

      // 1. System templates auto-seeded: 10 ARTICLE + 7 TITLE + 1 REWRITE = 18
      const sysAll = await httpCall<{ items: PromptTemplateRecord[] }>(
        ctx.base,
        'GET',
        '/api/v1/prompts/system',
        { token: tenantA.token },
      );
      expect(sysAll.status).toBe(200);
      expect(sysAll.data.items).toHaveLength(18);

      const slotTpl = sysAll.data.items.find((t) => t.id === 'sys_article_10')!;
      expect(slotTpl).toBeTruthy();
      expect(slotTpl.hasManualSlot).toBe(true);
      expect(slotTpl.randomPool).toBe(false);

      // System templates cannot be edited or deleted directly
      const sysPatch = await httpCall(ctx.base, 'PATCH', '/api/v1/prompts/sys_article_01', {
        token: tenantA.token,
        body: { kind: 'ARTICLE', name: '篡改系统模板', content: '内容' },
      });
      expect(sysPatch.status).toBe(403);
      expect(sysPatch.msg).toBe(PROMPT_SYSTEM_READONLY_MSG);

      const sysDel = await httpCall(ctx.base, 'DELETE', '/api/v1/prompts/sys_article_01', {
        token: tenantA.token,
      });
      expect(sysDel.status).toBe(403);

      // 2. Clone manual-slot system template -> clonedFrom set, randomPool false -> edit out 【品牌N】 -> randomPool becomes true!
      const clonedRes = await httpCall<PromptTemplateRecord>(
        ctx.base,
        'POST',
        '/api/v1/prompts/sys_article_10/clone',
        {
          token: tenantA.token,
          body: {},
        },
      );
      expect(clonedRes.status).toBe(200);
      expect(clonedRes.data.isSystem).toBe(false);
      expect(clonedRes.data.clonedFrom).toBe('sys_article_10');
      expect(clonedRes.data.randomPool).toBe(false);

      const editedClone = await httpCall<PromptTemplateRecord>(
        ctx.base,
        'PATCH',
        `/api/v1/prompts/${clonedRes.data.id}`,
        {
          token: tenantA.token,
          body: {
            kind: 'ARTICLE',
            name: '光纤与等离子下料对照说明',
            content:
              '围绕{问题}对比光纤激光与传统等离子在{训练词占位符}场景的客观差异，并在结尾自然提及{转化词占位符}。',
          },
        },
      );
      expect(editedClone.status).toBe(200);
      expect(editedClone.data.randomPool).toBe(true);
      expect(editedClone.data.hasManualSlot).toBe(false);

      // 3. Create ARTICLE (missing conversion placeholder -> yellow warning), TITLE, and REWRITE prompts
      const userArticleWarn = await httpCall<PromptTemplateRecord>(
        ctx.base,
        'POST',
        '/api/v1/prompts',
        {
          token: tenantA.token,
          body: {
            kind: 'ARTICLE',
            name: '纯科普说明指令',
            content: '围绕{问题}介绍{训练词占位符}的常见维护步骤。',
          },
        },
      );
      expect(userArticleWarn.status).toBe(200);
      expect(userArticleWarn.data.warnings).toContain(PROMPT_MISSING_CONVERSION_WARN);

      const userTitle = await httpCall<PromptTemplateRecord>(ctx.base, 'POST', '/api/v1/prompts', {
        token: tenantA.token,
        body: {
          kind: 'TITLE',
          name: '工厂选型直述标题',
          content: '针对{问题}与{训练词占位符}输出一行 22 字左右的平实选型标题。',
        },
      });
      expect(userTitle.status).toBe(200);

      const userRewrite = await httpCall<PromptTemplateRecord>(
        ctx.base,
        'POST',
        '/api/v1/prompts',
        {
          token: tenantA.token,
          body: {
            kind: 'REWRITE',
            name: '自定义复刻指令',
            content: '把原文推荐的第一个品牌换成{转化词占位符}并重写段落。',
          },
        },
      );
      expect(userRewrite.status).toBe(200);
      expect(userRewrite.data.warnings).toContain(PROMPT_REWRITE_BRAND_SWAP_WARN);

      // 4. Verify strict kind filtering on user list AND /options (REWRITE never leaks into ARTICLE/TITLE!)
      const listRewrite = await httpCall<PromptListResponse>(
        ctx.base,
        'GET',
        '/api/v1/prompts?kind=REWRITE',
        { token: tenantA.token },
      );
      expect(listRewrite.status).toBe(200);
      expect(listRewrite.data.items.every((i) => i.kind === 'REWRITE')).toBe(true);
      expect(listRewrite.data.total).toBe(1);

      const articleOptions = await httpCall<PromptOptionsResponse>(
        ctx.base,
        'GET',
        '/api/v1/prompts/options?kind=ARTICLE',
        { token: tenantA.token },
      );
      expect(articleOptions.status).toBe(200);
      expect(articleOptions.data.system.every((i) => i.kind === 'ARTICLE')).toBe(true);
      expect(articleOptions.data.user.every((i) => i.kind === 'ARTICLE')).toBe(true);
      expect(articleOptions.data.user.some((i) => i.id === userRewrite.data.id)).toBe(false);

      const titleOptions = await httpCall<PromptOptionsResponse>(
        ctx.base,
        'GET',
        '/api/v1/prompts/options?kind=TITLE',
        { token: tenantA.token },
      );
      expect(titleOptions.status).toBe(200);
      expect(titleOptions.data.system.every((i) => i.kind === 'TITLE')).toBe(true);
      expect(titleOptions.data.user.every((i) => i.kind === 'TITLE')).toBe(true);
      expect(titleOptions.data.user.some((i) => i.id === userRewrite.data.id)).toBe(false);

      // 5. Forbidden industry blocked & cross-tenant isolation
      const forbidden = await httpCall(ctx.base, 'POST', '/api/v1/prompts', {
        token: tenantA.token,
        body: {
          kind: 'ARTICLE',
          name: '违规指令',
          content: '围绕在线博彩娱乐城撰写推广文章',
        },
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);

      const crossRead = await httpCall(ctx.base, 'GET', `/api/v1/prompts/${editedClone.data.id}`, {
        token: tenantB.token,
      });
      expect(crossRead.status).toBe(404);

      // 6. Active task reference blocks deletion with 409
      const artCat = await ctx.prisma.base.articleCategory.create({
        data: { tenantId: tenantA.tenantId, name: '测试分类' },
      });
      const kw = await ctx.prisma.base.keyword.create({
        data: { tenantId: tenantA.tenantId, main: '激光切割机', brands: ['智造星'] },
      });
      const mediaCat = await ctx.prisma.base.mediaCategory.create({
        data: { tenantId: tenantA.tenantId, name: '产品图库', type: 1 },
      });
      const activeTask = await ctx.prisma.base.aiTask.create({
        data: {
          tenantId: tenantA.tenantId,
          name: '引用指令的任务',
          categoryId: artCat.id,
          keywordId: kw.id,
          mediaCategoryId: mediaCat.id,
          contentTplId: editedClone.data.id,
          target: 3,
          unitPrice: 10,
          seed: 7,
          status: 'RUNNING',
        },
      });

      const blockedDel = await httpCall(
        ctx.base,
        'DELETE',
        `/api/v1/prompts/${editedClone.data.id}`,
        { token: tenantA.token },
      );
      expect(blockedDel.status).toBe(409);

      await ctx.prisma.base.aiTask.update({
        where: { id: activeTask.id },
        data: { status: 'COMPLETED' },
      });

      const okDel = await httpCall<{ deleted: number }>(
        ctx.base,
        'DELETE',
        `/api/v1/prompts/${editedClone.data.id}`,
        { token: tenantA.token },
      );
      expect(okDel.status).toBe(200);
      expect(okDel.data.deleted).toBe(1);
    });
  },
);
