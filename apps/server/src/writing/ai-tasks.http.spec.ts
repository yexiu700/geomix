import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  AUTH_ERROR,
  type AiTaskDetailRecord,
  type AiTaskListResponse,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../billing/billing.service';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import { LlmService } from '../infra/llm';
import { ProviderError } from '../infra/provider-error';
import { hasLiveActiveWork } from '../queue/active-work';
import { WorkerModule } from '../worker.module';

describe('ai-tasks routes without a database', () => {
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

  it('rejects anonymous list, detail, create, pause, resume, and cancel calls', async () => {
    const listRes = await httpCall(base, 'GET', '/api/v1/ai-tasks');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const detailRes = await httpCall(base, 'GET', '/api/v1/ai-tasks/task_123');
    expect(detailRes.status).toBe(401);

    const createRes = await httpCall(base, 'POST', '/api/v1/ai-tasks', { body: {} });
    expect(createRes.status).toBe(401);

    const pauseRes = await httpCall(base, 'POST', '/api/v1/ai-tasks/task_123/pause');
    expect(pauseRes.status).toBe(401);

    const resumeRes = await httpCall(base, 'POST', '/api/v1/ai-tasks/task_123/resume');
    expect(resumeRes.status).toBe(401);

    const cancelRes = await httpCall(base, 'POST', '/api/v1/ai-tasks/task_123/cancel');
    expect(cancelRes.status).toBe(401);
  });
});

describe.skipIf(
  process.env.GEOMIX_DB_INTEGRATION !== '1' || process.env.GEOMIX_REDIS_INTEGRATION !== '1',
)(
  'ai-tasks full writing pipeline, KB split settlement, partial refund, 3-fail auto-pause & resume, and cancel via BullMQ + Postgres',
  () => {
    let ctx: IsolatedTestContext;
    let workerApp: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
    let previousQueuePrefix: string | undefined;
    let previousRetryDelay: string | undefined;

    beforeAll(async () => {
      const queuePrefix = `geomix:aitask:${randomBytes(4).toString('hex')}`;
      previousQueuePrefix = process.env.QUEUE_PREFIX;
      previousRetryDelay = process.env.AI_TASK_RETRY_DELAY_MS;
      process.env.QUEUE_PREFIX = queuePrefix;
      process.env.AI_TASK_RETRY_DELAY_MS = '5';

      ctx = await createIsolatedTestContext('aitask');
      workerApp = await NestFactory.createApplicationContext(WorkerModule, {
        logger: ['error'],
      });
    }, 120_000);

    afterAll(async () => {
      if (workerApp) await workerApp.close();
      if (ctx) await ctx.close();
      if (previousQueuePrefix === undefined) delete process.env.QUEUE_PREFIX;
      else process.env.QUEUE_PREFIX = previousQueuePrefix;
      if (previousRetryDelay === undefined) delete process.env.AI_TASK_RETRY_DELAY_MS;
      else process.env.AI_TASK_RETRY_DELAY_MS = previousRetryDelay;
    }, 60_000);

    async function waitForTaskStatus(
      token: string,
      taskId: string,
      expected: readonly string[],
      timeoutMs = 25_000,
    ): Promise<AiTaskDetailRecord> {
      const deadline = Date.now() + timeoutMs;
      let latest: AiTaskDetailRecord | undefined;
      while (Date.now() < deadline) {
        const res = await httpCall<AiTaskDetailRecord>(
          ctx.base,
          'GET',
          `/api/v1/ai-tasks/${taskId}`,
          { token },
        );
        expect(res.status).toBe(200);
        latest = res.data;
        if (expected.includes(latest.status)) {
          return latest;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Timed out waiting for task ${taskId} status in [${expected.join(', ')}]; got ${latest?.status ?? 'none'}`,
      );
    }

    async function seedMaterials(tenantId: string, userId: string) {
      const keywordEmpty = await ctx.prisma.base.keyword.create({
        data: {
          tenantId,
          main: '空问题测试词',
          brands: ['测试牌'],
        },
      });

      const keyword = await ctx.prisma.base.keyword.create({
        data: {
          tenantId,
          main: '光纤激光切割机',
          brands: ['华锐精工', '智造星'],
        },
      });

      const questionTexts = [
        '中厚板光纤激光切割机如何评估床身退火稳定性？',
        '批量钣金下料选择多少功率的光纤激光切割机更合适？',
        '光纤激光切割机自动调焦切割头日常维护要注意哪些细节？',
        '工程机械结构件坡口切割对数控系统有什么要求？',
        '高反铝板与黄铜激光下料如何降低镜片热透镜风险？',
      ];
      await ctx.prisma.base.question.createMany({
        data: questionTexts.map((text) => ({
          tenantId,
          keywordId: keyword.id,
          text,
          source: 'MANUAL',
        })),
      });

      const emptyGallery = await ctx.prisma.base.mediaCategory.create({
        data: { tenantId, name: '空图库分类' },
      });

      const gallery = await ctx.prisma.base.mediaCategory.create({
        data: { tenantId, name: '车间实拍图库' },
      });
      await ctx.prisma.base.mediaAsset.createMany({
        data: [1, 2, 3].map((idx) => ({
          tenantId,
          categoryId: gallery.id,
          objectKey: `test/${tenantId}/workshop-${idx}.webp`,
          url: `/api/v1/gallery-assets/public/asset_${idx}.webp`,
          mime: 'image/webp',
          width: 1200,
          height: 800,
          bytes: 48_000,
          origin: 'UPLOAD',
        })),
      });

      const signature = await ctx.prisma.base.agreementSignature.create({
        data: {
          tenantId,
          userId,
          kind: 'kb_truthfulness',
          version: 'v1.0',
          ip: '127.0.0.1',
        },
      });

      const kb = await ctx.prisma.base.knowledgeBase.create({
        data: {
          tenantId,
          name: '智造星激光装备档案',
          mode: 'DETAIL',
          companyName: '苏州智造星激光装备有限公司',
          brandShort: '智造星',
          directions: ['需求痛点', '采购建议', '价格说明'],
          copyTypes: ['指南', '说明文'],
          fields: {
            productService: '主营 6kW-30kW 双驱光纤激光切割设备及自动化料库产线。',
            productFeature: '分段焊接去应力退火床身，轻量化航空铝横梁与总线式数控系统。',
            cases: '服务长三角工程机械、电梯轿厢及配电柜钣金加工工厂。',
          },
          indexStatus: 'READY',
          signatureId: signature.id,
        },
      });

      const indexingKb = await ctx.prisma.base.knowledgeBase.create({
        data: {
          tenantId,
          name: '索引中知识库',
          mode: 'SUMMARY',
          summaryText: '资料正在切片索引中',
          indexStatus: 'INDEXING',
          signatureId: signature.id,
        },
      });

      return { keywordEmpty, keyword, emptyGallery, gallery, kb, indexingKb };
    }

    it('validates preconditions and executes a 10-article KB task with uniform question/image rotation, H2+FAQ structure, quota +10, and 10+5 split settlement', async () => {
      const tenant = await ctx.createTenantUser({
        prefix: 'aiok',
        points: 500,
        billingMode: 'STRICT',
      });
      const seeded = await seedMaterials(tenant.tenantId, tenant.userId);

      // 1. Precondition checks: empty questions, empty gallery, INDEXING KB, insufficient STRICT points
      const noQRes = await httpCall(ctx.base, 'POST', '/api/v1/ai-tasks', {
        token: tenant.token,
        body: {
          name: '无问题拦截',
          keywordId: seeded.keywordEmpty.id,
          mediaCategoryId: seeded.gallery.id,
          imageCount: 1,
          target: 2,
        },
      });
      expect(noQRes.status).toBe(400);

      const noImgRes = await httpCall(ctx.base, 'POST', '/api/v1/ai-tasks', {
        token: tenant.token,
        body: {
          name: '无图片拦截',
          keywordId: seeded.keyword.id,
          mediaCategoryId: seeded.emptyGallery.id,
          imageCount: 1,
          target: 2,
        },
      });
      expect(noImgRes.status).toBe(400);

      const indexingRes = await httpCall(ctx.base, 'POST', '/api/v1/ai-tasks', {
        token: tenant.token,
        body: {
          name: '索引中拦截',
          keywordId: seeded.keyword.id,
          mediaCategoryId: seeded.gallery.id,
          kbId: seeded.indexingKb.id,
          imageCount: 1,
          target: 2,
        },
      });
      expect(indexingRes.status).toBe(400);

      const poorRes = await httpCall(ctx.base, 'POST', '/api/v1/ai-tasks', {
        token: tenant.token,
        body: {
          name: '点数不足拦截',
          keywordId: seeded.keyword.id,
          mediaCategoryId: seeded.gallery.id,
          kbId: seeded.kb.id,
          imageCount: 1,
          target: 40, // 40 * 15 = 600 > 500
        },
      });
      expect(poorRes.status).toBe(402);
      expect(poorRes.code).toBe(API_ERROR.INSUFFICIENT_POINTS);

      // 2. Submit 10-article task with KB (15 pts/article => frozen 150), categoryId omitted -> auto-created!
      const createRes = await httpCall<AiTaskDetailRecord>(ctx.base, 'POST', '/api/v1/ai-tasks', {
        token: tenant.token,
        body: {
          name: '十篇激光选型任务',
          categoryId: null,
          keywordId: seeded.keyword.id,
          mediaCategoryId: seeded.gallery.id,
          imageCount: 2,
          kbId: seeded.kb.id,
          contentTplId: null,
          titleTplId: null,
          resultStatus: 'PENDING',
          target: 10,
        },
      });
      expect(createRes.status).toBe(200);
      expect(createRes.data.unitPrice).toBe(15);
      expect(createRes.data.frozenPoints).toBe(150);
      expect(createRes.data.categoryName).toBe('十篇激光选型任务');
      expect(createRes.data.items).toHaveLength(10);

      const completed = await waitForTaskStatus(tenant.token, createRes.data.id, ['COMPLETED']);
      expect(completed.doneCount).toBe(10);
      expect(completed.failCount).toBe(0);
      expect(completed.settledPoints).toBe(150);
      expect(completed.releasedPoints).toBe(0);

      // Brand rotation: brands[(i + seed) % 2] alternates cleanly with 5 items per brand across 10 articles
      const firstItem = completed.items.find((i) => i.seq === 1)!;
      const secondItem = completed.items.find((i) => i.seq === 2)!;
      expect(['智造星', '华锐精工']).toContain(firstItem.brand);
      expect(secondItem.brand).not.toBe(firstItem.brand);
      expect(completed.items.filter((i) => i.brand === '智造星')).toHaveLength(5);
      expect(completed.items.filter((i) => i.brand === '华锐精工')).toHaveLength(5);

      // Default titleTplId === null -> title matches selected question verbatim
      for (const item of completed.items) {
        expect(item.status).toBe('SUCCESS');
        expect(item.title).toBe(item.questionText);
      }

      // Uniform question coverage: 5 questions across 10 articles => usedCount === 2 each!
      const questions = await ctx.prisma.base.question.findMany({
        where: { tenantId: tenant.tenantId, keywordId: seeded.keyword.id },
      });
      expect(questions).toHaveLength(5);
      for (const q of questions) {
        expect(q.usedCount).toBe(2);
      }

      // Articles check: 10 articles, each >= 500 chars, has <h2> + <h3> + FAQ, exactly 2 <img> tags, and non-null coverUrl
      const articles = await ctx.prisma.base.article.findMany({
        where: { tenantId: tenant.tenantId, aiTaskId: completed.id },
      });
      expect(articles).toHaveLength(10);
      for (const art of articles) {
        expect(art.source).toBe('AI_TASK');
        expect(art.status).toBe('PENDING');
        expect(Array.from(art.contentText).length).toBeGreaterThanOrEqual(500);
        expect(art.contentHtml).toContain('<h2>');
        expect(art.contentHtml).toContain('<h3>');
        expect(art.contentHtml).toContain('常见问题（FAQ）');
        const imgMatches = art.contentHtml.match(/<img\b/g) ?? [];
        expect(imgMatches).toHaveLength(2);
        expect(art.coverUrl).toBeTruthy();
      }

      // Gallery asset usedCount total === 20 (uniform across 3 assets: 7, 7, 6)
      const assets = await ctx.prisma.base.mediaAsset.findMany({
        where: { tenantId: tenant.tenantId, categoryId: seeded.gallery.id },
      });
      const assetCounts = assets.map((a) => a.usedCount).sort((a, b) => a - b);
      expect(assetCounts).toEqual([6, 7, 7]);

      // Quota AI_WRITE incremented by 10
      const aiQuota = await ctx.prisma.base.quota.findUnique({
        where: { tenantId_key: { tenantId: tenant.tenantId, key: 'AI_WRITE' } },
      });
      expect(aiQuota?.used).toBe(10n);

      // Ledger split: 10 * ai_write (-10) + 10 * kb_addon (-5) = 20 settle logs, wallet points 350, reserved 0
      const settleLogs = await ctx.prisma.base.pointLog.findMany({
        where: { tenantId: tenant.tenantId, status: 'SETTLED' },
      });
      expect(settleLogs).toHaveLength(20);
      expect(settleLogs.filter((l) => l.action === 'ai_write' && l.delta === -10)).toHaveLength(10);
      expect(settleLogs.filter((l) => l.action === 'kb_addon' && l.delta === -5)).toHaveLength(10);

      const wallet = await ctx.prisma.base.wallet.findUnique({
        where: { tenantId: tenant.tenantId },
      });
      expect(wallet?.points).toBe(350);
      expect(wallet?.pointsReserved).toBe(0);

      const billing = ctx.app.get(BillingService);
      expect(await billing.auditTenant(tenant.tenantId)).toEqual([]);

      // Also verify list + CSV export endpoint
      const listRes = await httpCall<AiTaskListResponse>(ctx.base, 'GET', '/api/v1/ai-tasks', {
        token: tenant.token,
      });
      expect(listRes.status).toBe(200);
      expect(listRes.data.total).toBe(1);

      const csvRes = await fetch(`${ctx.base}/api/v1/ai-tasks?export=csv`, {
        headers: { authorization: `Bearer ${tenant.token}` },
      });
      expect(csvRes.status).toBe(200);
      const csvText = await csvRes.text();
      expect(csvText).toContain('十篇激光选型任务');
    }, 60_000);

    it('handles single-item failure into PARTIAL refund, 3-consecutive-failures auto-PAUSE + resume, and mid-task CANCEL cleanly', async () => {
      const tenant = await ctx.createTenantUser({
        prefix: 'aifail',
        points: 500,
        billingMode: 'STRICT',
      });
      const seeded = await seedMaterials(tenant.tenantId, tenant.userId);
      const workerLlm = workerApp!.get(LlmService);
      const billing = ctx.app.get(BillingService);

      // Case A: 4-item KB task (frozen = 60) where 2nd body call fails permanently -> PARTIAL (settled=45, released=15)
      const originalComplete = workerLlm.complete.bind(workerLlm);
      let bodyCallSeq = 0;
      const spy = vi.spyOn(workerLlm, 'complete').mockImplementation(async (req) => {
        if (req.scene === 'body') {
          bodyCallSeq += 1;
          if (bodyCallSeq === 2) {
            throw new ProviderError('contract', '模拟上游单篇内容异常');
          }
        }
        return originalComplete(req);
      });

      try {
        const partialCreate = await httpCall<AiTaskDetailRecord>(
          ctx.base,
          'POST',
          '/api/v1/ai-tasks',
          {
            token: tenant.token,
            body: {
              name: '部分成功退款任务',
              keywordId: seeded.keyword.id,
              mediaCategoryId: seeded.gallery.id,
              imageCount: 0, // coverWhenNoImage=true -> coverUrl set, 0 inline <img>
              kbId: seeded.kb.id,
              target: 4,
            },
          },
        );
        expect(partialCreate.status).toBe(200);

        const partialDone = await waitForTaskStatus(tenant.token, partialCreate.data.id, [
          'PARTIAL',
        ]);
        expect(partialDone.doneCount).toBe(3);
        expect(partialDone.failCount).toBe(1);
        expect(partialDone.settledPoints).toBe(45);
        expect(partialDone.releasedPoints).toBe(15);

        // Verify imageCount=0 still assigns coverUrl with 0 <img> in contentHtml
        const zeroImgArticles = await ctx.prisma.base.article.findMany({
          where: { tenantId: tenant.tenantId, aiTaskId: partialDone.id },
        });
        expect(zeroImgArticles).toHaveLength(3);
        for (const art of zeroImgArticles) {
          expect(art.contentHtml).not.toContain('<img');
          expect(art.coverUrl).toBeTruthy();
        }
        expect(await billing.auditTenant(tenant.tenantId)).toEqual([]);
      } finally {
        spy.mockRestore();
      }

      // Case B: 5-item task where LLM fails consecutively (including retryable upstream backoff!) -> auto-PAUSED after 3 failures -> resume succeeds remaining!
      const failSpy = vi.spyOn(workerLlm, 'complete').mockImplementation(async () => {
        throw new ProviderError('upstream', '上游模型网关超时');
      });

      let pauseTaskId = '';
      try {
        const pauseCreate = await httpCall<AiTaskDetailRecord>(
          ctx.base,
          'POST',
          '/api/v1/ai-tasks',
          {
            token: tenant.token,
            body: {
              name: '连续三次失败暂停任务',
              keywordId: seeded.keyword.id,
              mediaCategoryId: seeded.gallery.id,
              imageCount: 1,
              target: 5, // 5 * 10 = 50 pts
            },
          },
        );
        expect(pauseCreate.status).toBe(200);
        pauseTaskId = pauseCreate.data.id;

        const paused = await waitForTaskStatus(tenant.token, pauseTaskId, ['PAUSED']);
        expect(paused.failCount).toBeGreaterThanOrEqual(3);
        expect(paused.failCount).toBeLessThan(5);
        expect(paused.lastError).toContain('模型服务异常');
        expect(paused.lastError).toContain('上游模型网关超时');

        // Reconcile probe treats PAUSED AiTask as live active work (never prematurely closed!)
        const isLive = await hasLiveActiveWork(
          ctx.prisma,
          { tenantId: tenant.tenantId, refType: 'ai_task', refId: pauseTaskId },
          new Date(Date.now() + 4 * 3600_000),
          120_000,
        );
        expect(isLive).toBe(true);
      } finally {
        failSpy.mockRestore();
      }

      // Resume after restoring LLM -> remaining PENDING items finish -> PARTIAL & reservation closed!
      const resumeRes = await httpCall<AiTaskDetailRecord>(
        ctx.base,
        'POST',
        `/api/v1/ai-tasks/${pauseTaskId}/resume`,
        { token: tenant.token },
      );
      expect(resumeRes.status).toBe(200);

      const resumedDone = await waitForTaskStatus(tenant.token, pauseTaskId, ['PARTIAL']);
      expect(resumedDone.doneCount + resumedDone.failCount).toBe(5);
      expect(resumedDone.doneCount).toBeGreaterThanOrEqual(1);
      expect(await billing.auditTenant(tenant.tenantId)).toEqual([]);

      // Case C: Cancel a paused task -> remaining PENDING items become SKIPPED & frozen points released immediately
      const holdSpy = vi.spyOn(workerLlm, 'complete').mockImplementation(async () => {
        throw new ProviderError('auth', '暂停等待取消');
      });

      let cancelTaskId = '';
      try {
        const cancelCreate = await httpCall<AiTaskDetailRecord>(
          ctx.base,
          'POST',
          '/api/v1/ai-tasks',
          {
            token: tenant.token,
            body: {
              name: '中途取消释放冻结任务',
              keywordId: seeded.keyword.id,
              mediaCategoryId: seeded.gallery.id,
              imageCount: 1,
              target: 6, // 60 pts frozen
            },
          },
        );
        expect(cancelCreate.status).toBe(200);
        cancelTaskId = cancelCreate.data.id;

        await waitForTaskStatus(tenant.token, cancelTaskId, ['PAUSED']);
      } finally {
        holdSpy.mockRestore();
      }

      const cancelRes = await httpCall<AiTaskDetailRecord>(
        ctx.base,
        'POST',
        `/api/v1/ai-tasks/${cancelTaskId}/cancel`,
        { token: tenant.token },
      );
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.data.status).toBe('CANCELLED');
      expect(cancelRes.data.skipCount).toBeGreaterThanOrEqual(1);
      expect(cancelRes.data.releasedPoints).toBe(60);

      const finalWallet = await ctx.prisma.base.wallet.findUnique({
        where: { tenantId: tenant.tenantId },
      });
      expect(finalWallet?.pointsReserved).toBe(0);
      expect(await billing.auditTenant(tenant.tenantId)).toEqual([]);
    }, 60_000);
  },
);
