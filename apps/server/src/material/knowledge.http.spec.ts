import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  AUTH_ERROR,
  KB_UNSIGNED_ERROR_MSG,
  type AgreementStatusView,
  type KnowledgeBaseListResponse,
  type KnowledgeBaseRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import { WorkerModule } from '../worker.module';
import { KnowledgeIndexRunner } from './knowledge-index.runner';

describe('knowledge-bases & agreements routes without a database', () => {
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

  it('rejects anonymous agreement status/sign and knowledge base calls', async () => {
    const statusRes = await httpCall(base, 'GET', '/api/v1/agreements/status');
    expect(statusRes.status).toBe(401);
    expect(statusRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const signRes = await httpCall(base, 'POST', '/api/v1/agreements/sign', { body: {} });
    expect(signRes.status).toBe(401);
    expect(signRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const listRes = await httpCall(base, 'GET', '/api/v1/knowledge-bases');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const postRes = await httpCall(base, 'POST', '/api/v1/knowledge-bases', {
      body: { name: '测试知识库', mode: 'SUMMARY', summaryText: '企业简介' },
    });
    expect(postRes.status).toBe(401);
    expect(postRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'knowledge-bases agreement gate, dual-mode CRUD, compliance, and delete guard against isolated Postgres',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('kb');
    }, 120_000);

    afterAll(async () => {
      if (ctx) await ctx.close();
    }, 60_000);

    it('blocks unsigned save with 400, records signature with userId/ip, isolates tenants, and guards active task references', async () => {
      const tenantA = await ctx.createTenantUser({ prefix: 'kba' });
      const tenantB = await ctx.createTenantUser({ prefix: 'kbb' });

      // 1. Initial agreement status is unsigned
      const initStatus = await httpCall<AgreementStatusView>(
        ctx.base,
        'GET',
        '/api/v1/agreements/status',
        { token: tenantA.token },
      );
      expect(initStatus.status).toBe(200);
      expect(initStatus.data.signed).toBe(false);
      expect(initStatus.data.signatureId).toBeNull();

      // 2. Saving DETAIL or SUMMARY before signing is rejected with 400
      const unsignedDetail = await httpCall(ctx.base, 'POST', '/api/v1/knowledge-bases', {
        token: tenantA.token,
        body: {
          name: '激光装备知识库',
          mode: 'DETAIL',
          companyName: '苏州智造装备有限公司',
          brandShort: '智造星',
          directions: ['需求痛点', '价格说明'],
          copyTypes: ['说明文', '指南'],
          fields: {
            productService: '主营光纤激光切割设备及自动化上下料产线。',
            productFeature: '分段焊接退火床身，双驱龙门结构。',
          },
        },
      });
      expect(unsignedDetail.status).toBe(400);
      expect(unsignedDetail.code).toBe(API_ERROR.BAD_REQUEST);
      expect(unsignedDetail.msg).toBe(KB_UNSIGNED_ERROR_MSG);

      const unsignedSummary = await httpCall(ctx.base, 'POST', '/api/v1/knowledge-bases', {
        token: tenantA.token,
        body: {
          name: '汇总资料库',
          mode: 'SUMMARY',
          summaryText: '主营工业自动化装配线与检测工站集成交付。',
        },
      });
      expect(unsignedSummary.status).toBe(400);
      expect(unsignedSummary.msg).toBe(KB_UNSIGNED_ERROR_MSG);

      // 3. Sign truthfulness agreement
      const signedRes = await httpCall<AgreementStatusView>(
        ctx.base,
        'POST',
        '/api/v1/agreements/sign',
        {
          token: tenantA.token,
          body: { kind: 'kb_truthfulness', version: 'v1.0' },
        },
      );
      expect(signedRes.status).toBe(200);
      expect(signedRes.data.signed).toBe(true);
      expect(signedRes.data.signatureId).toBeTruthy();

      const sigRow = await ctx.prisma.base.agreementSignature.findUnique({
        where: { id: signedRes.data.signatureId! },
      });
      expect(sigRow?.userId).toBe(tenantA.userId);
      expect(sigRow?.version).toBe('v1.0');
      expect(sigRow?.ip).toBeTruthy();

      // Tenant B remains unsigned
      const bStatus = await httpCall<AgreementStatusView>(
        ctx.base,
        'GET',
        '/api/v1/agreements/status',
        { token: tenantB.token },
      );
      expect(bStatus.data.signed).toBe(false);

      // 4. Create DETAIL mode KB and verify companyName is stored
      const detailCreate = await httpCall<KnowledgeBaseRecord>(
        ctx.base,
        'POST',
        '/api/v1/knowledge-bases',
        {
          token: tenantA.token,
          body: {
            name: '激光装备知识库',
            mode: 'DETAIL',
            companyName: '苏州智造装备有限公司',
            brandShort: '智造星',
            directions: ['需求痛点', '价格说明'],
            copyTypes: ['说明文', '指南'],
            fields: {
              productService: '主营光纤激光切割设备及自动化上下料产线。',
              productFeature: '分段焊接退火床身，双驱龙门结构。',
              cases: '为华东某农机零部件制造厂交付 12kW 激光下料单元。',
            },
          },
        },
      );
      expect(detailCreate.status).toBe(200);
      expect(detailCreate.data.mode).toBe('DETAIL');
      expect(detailCreate.data.companyName).toBe('苏州智造装备有限公司');
      expect(detailCreate.data.indexStatus).toBe('NONE');

      // 5. Create short SUMMARY mode KB (<= 6000 chars) -> companyName is null, indexStatus NONE
      const summaryCreate = await httpCall<KnowledgeBaseRecord>(
        ctx.base,
        'POST',
        '/api/v1/knowledge-bases',
        {
          token: tenantA.token,
          body: {
            name: '企业综合白皮书摘要',
            mode: 'SUMMARY',
            summaryText: '本公司专注于中厚板钣金柔性加工产线集成，拥有标准化车间与驻点售后团队。',
          },
        },
      );
      expect(summaryCreate.status).toBe(200);
      expect(summaryCreate.data.mode).toBe('SUMMARY');
      expect(summaryCreate.data.companyName).toBeNull();
      expect(summaryCreate.data.indexStatus).toBe('NONE');

      // 6. Reject >1000 char detail field & forbidden industry content
      const overLimitDetail = await httpCall(ctx.base, 'POST', '/api/v1/knowledge-bases', {
        token: tenantA.token,
        body: {
          name: '超长字段测试',
          mode: 'DETAIL',
          companyName: '测试公司',
          brandShort: '测试',
          directions: ['需求痛点'],
          copyTypes: ['说明文'],
          fields: {
            productService: '品'.repeat(1001),
          },
        },
      });
      expect(overLimitDetail.status).toBe(400);

      const forbiddenRes = await httpCall(ctx.base, 'POST', '/api/v1/knowledge-bases', {
        token: tenantA.token,
        body: {
          name: '违规资料',
          mode: 'SUMMARY',
          summaryText: '主营在线博彩娱乐城系统搭建服务',
        },
      });
      expect(forbiddenRes.status).toBe(403);
      expect(forbiddenRes.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);

      // 7. List returns both items; DETAIL has companyName, SUMMARY has companyName = null
      const listRes = await httpCall<KnowledgeBaseListResponse>(
        ctx.base,
        'GET',
        '/api/v1/knowledge-bases',
        { token: tenantA.token },
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data.total).toBe(2);
      expect(listRes.data.agreement.signed).toBe(true);
      const foundDetail = listRes.data.items.find((i) => i.id === detailCreate.data.id);
      const foundSummary = listRes.data.items.find((i) => i.id === summaryCreate.data.id);
      expect(foundDetail?.companyName).toBe('苏州智造装备有限公司');
      expect(foundSummary?.companyName).toBeNull();

      // 8. Tenant isolation: Tenant B cannot access Tenant A's KB
      const crossRead = await httpCall(
        ctx.base,
        'GET',
        `/api/v1/knowledge-bases/${detailCreate.data.id}`,
        { token: tenantB.token },
      );
      expect(crossRead.status).toBe(404);

      // 9. Active AiTask reference blocks deletion with 409, then allows deletion once finished
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
          name: '测试任务',
          categoryId: artCat.id,
          keywordId: kw.id,
          mediaCategoryId: mediaCat.id,
          kbId: detailCreate.data.id,
          target: 5,
          unitPrice: 15,
          seed: 42,
          status: 'RUNNING',
        },
      });

      const blockedDel = await httpCall(
        ctx.base,
        'DELETE',
        `/api/v1/knowledge-bases/${detailCreate.data.id}`,
        { token: tenantA.token },
      );
      expect(blockedDel.status).toBe(409);

      await ctx.prisma.base.aiTask.update({
        where: { id: activeTask.id },
        data: { status: 'COMPLETED' },
      });

      const okDel = await httpCall<{ deleted: number }>(
        ctx.base,
        'POST',
        '/api/v1/knowledge-bases/bulk-delete',
        {
          token: tenantA.token,
          body: { ids: [detailCreate.data.id, summaryCreate.data.id] },
        },
      );
      expect(okDel.status).toBe(200);
      expect(okDel.data.deleted).toBe(2);
    });
  },
);

describe.skipIf(
  process.env.GEOMIX_DB_INTEGRATION !== '1' || process.env.GEOMIX_REDIS_INTEGRATION !== '1',
)(
  '20,000-char SUMMARY knowledge base slicing & pgvector(1024) indexing via BullMQ kb-index',
  () => {
    let ctx: IsolatedTestContext;
    let workerApp: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
    let previousQueuePrefix: string | undefined;

    beforeAll(async () => {
      const queuePrefix = `geomix:kb:${randomBytes(4).toString('hex')}`;
      previousQueuePrefix = process.env.QUEUE_PREFIX;
      process.env.QUEUE_PREFIX = queuePrefix;

      ctx = await createIsolatedTestContext('kbvec');
      workerApp = await NestFactory.createApplicationContext(WorkerModule, {
        logger: ['error'],
      });
    }, 120_000);

    afterAll(async () => {
      if (workerApp) await workerApp.close();
      if (ctx) await ctx.close();
      if (previousQueuePrefix === undefined) delete process.env.QUEUE_PREFIX;
      else process.env.QUEUE_PREFIX = previousQueuePrefix;
    }, 60_000);

    it('slices a 20,000-char summary text into chunks, writes 1024-dim vectors, transitions status to READY (可用), and supports Top-5 retrieval', async () => {
      const tenant = await ctx.createTenantUser({ prefix: 'kbv' });

      const signRes = await httpCall(ctx.base, 'POST', '/api/v1/agreements/sign', {
        token: tenant.token,
        body: { kind: 'kb_truthfulness', version: 'v1.0' },
      });
      expect(signRes.status).toBe(200);

      // Build exactly <= 20,000 chars (~19,800 chars) of structured industrial technical paragraphs
      const paragraphUnit =
        '第{N}章节：面向中厚板钣金制造与工程机械结构件下料场景，双驱光纤激光切割系统配置分段退火焊接床身、自动调焦切割头、智能防碰撞传感以及板材套料工艺数据库，支持碳钢、不锈钢与铝合金多品种批量稳定排产。\n';
      const blocks: string[] = [];
      let idx = 1;
      while (Array.from(blocks.join('')).length + 120 <= 20_000) {
        blocks.push(paragraphUnit.replace('{N}', String(idx).padStart(3, '0')));
        idx += 1;
      }
      const longSummary = blocks.join('').slice(0, 20_000);
      expect(Array.from(longSummary).length).toBeGreaterThan(19_500);
      expect(Array.from(longSummary).length).toBeLessThanOrEqual(20_000);

      const createRes = await httpCall<KnowledgeBaseRecord>(
        ctx.base,
        'POST',
        '/api/v1/knowledge-bases',
        {
          token: tenant.token,
          body: {
            name: '两万字产线工艺总览',
            mode: 'SUMMARY',
            summaryText: longSummary,
          },
        },
      );
      expect(createRes.status).toBe(200);
      expect(createRes.data.indexStatus).toBe('INDEXING');

      // Poll until BullMQ worker finishes indexing to READY
      let detail = createRes.data;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && detail.indexStatus === 'INDEXING') {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const poll = await httpCall<KnowledgeBaseRecord>(
          ctx.base,
          'GET',
          `/api/v1/knowledge-bases/${createRes.data.id}`,
          { token: tenant.token },
        );
        expect(poll.status).toBe(200);
        detail = poll.data;
      }

      expect(detail.indexStatus).toBe('READY');
      expect(detail.chunkCount).toBeGreaterThanOrEqual(35);

      // Verify Top-5 cosine vector retrieval ordered by original paragraph idx
      const runner = ctx.app.get(KnowledgeIndexRunner);
      const topChunks = await runner.searchTopChunks({
        tenantId: tenant.tenantId,
        kbId: detail.id,
        queryText: '中厚板光纤激光切割机自动调焦与套料工艺如何配置？',
        topK: 5,
      });
      expect(topChunks).toHaveLength(5);
      for (let i = 1; i < topChunks.length; i += 1) {
        expect(topChunks[i]!.idx).toBeGreaterThan(topChunks[i - 1]!.idx);
      }
    });
  },
);
