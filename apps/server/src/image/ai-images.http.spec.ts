import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  type AiImageJobItem,
  type AiImageJobListResponse,
  type AiImageOptimizePromptResponse,
  type AiTaskDetailRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../billing/billing.service';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import { WorkerModule } from '../worker.module';

async function waitForImageJobTerminal(
  base: string,
  token: string,
  jobId: string,
  maxWaitMs = 15_000,
): Promise<AiImageJobItem> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await httpCall<AiImageJobItem>(base, 'GET', `/api/v1/image-jobs/${jobId}`, {
      token,
    });
    if (
      res.status === 200 &&
      res.data &&
      ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(res.data.status)
    ) {
      return res.data;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Image job ${jobId} did not reach terminal state within ${maxWaitMs}ms`);
}

async function waitForAiTaskTerminal(
  base: string,
  token: string,
  taskId: string,
  maxWaitMs = 15_000,
): Promise<AiTaskDetailRecord> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await httpCall<AiTaskDetailRecord>(base, 'GET', `/api/v1/ai-tasks/${taskId}`, {
      token,
    });
    if (
      res.status === 200 &&
      res.data &&
      ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(res.data.status)
    ) {
      return res.data;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`AiTask ${taskId} did not reach terminal state within ${maxWaitMs}ms`);
}

describe.skipIf(
  process.env.GEOMIX_DB_INTEGRATION !== '1' || process.env.GEOMIX_REDIS_INTEGRATION !== '1',
)('AI image generation end-to-end HTTP + BullMQ integration', () => {
  let ctx: IsolatedTestContext;
  let workerApp: INestApplication;
  let savedPrefix: string | undefined;
  let savedImageProvider: string | undefined;
  let savedLlmProviders: string | undefined;
  let savedFeatureFlag: string | undefined;
  let savedDbUrl: string | undefined;

  beforeAll(async () => {
    savedPrefix = process.env.QUEUE_PREFIX;
    savedImageProvider = process.env.IMAGE_PROVIDER;
    savedLlmProviders = process.env.LLM_PROVIDERS;
    savedFeatureFlag = process.env.FEATURE_AI_IMAGE;
    savedDbUrl = process.env.DATABASE_URL;

    process.env.QUEUE_PREFIX = `geomix-test-img-${randomBytes(4).toString('hex')}`;
    process.env.IMAGE_PROVIDER = 'fake';
    process.env.LLM_PROVIDERS = '{}';
    process.env.FEATURE_AI_IMAGE = 'true';

    ctx = await createIsolatedTestContext('ai_images');
    process.env.DATABASE_URL = ctx.databaseUrl;

    await ctx.prisma.base.pricingItem.upsert({
      where: { action: 'image_gen' },
      update: { unitPoints: 5, enabled: true },
      create: { action: 'image_gen', unitPoints: 5, enabled: true },
    });
    await ctx.prisma.base.pricingItem.upsert({
      where: { action: 'ai_write' },
      update: { unitPoints: 10, enabled: true },
      create: { action: 'ai_write', unitPoints: 10, enabled: true },
    });

    workerApp = await NestFactory.create(WorkerModule, { logger: false });
    await workerApp.init();
  });

  afterAll(async () => {
    process.env.FEATURE_AI_IMAGE = savedFeatureFlag;
    await workerApp?.close();
    await ctx?.close();
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    if (savedPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = savedPrefix;
    if (savedImageProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = savedImageProvider;
    if (savedLlmProviders === undefined) delete process.env.LLM_PROVIDERS;
    else process.env.LLM_PROVIDERS = savedLlmProviders;
  });

  it('generates 2 fake images, saves zero-copy to gallery, and lets AI writing tasks draw them into articles', async () => {
    const actor = await ctx.createTenantUser({
      role: 'MERCHANT',
      points: 100,
      billingMode: 'STRICT',
    });
    await ctx.prisma.base.quota.upsert({
      where: {
        tenantId_key: { tenantId: actor.tenantId, key: 'STORAGE_BYTES' },
      },
      update: { used: 0n, limit: 50n * 1024n * 1024n },
      create: {
        tenantId: actor.tenantId,
        key: 'STORAGE_BYTES',
        used: 0n,
        limit: 50n * 1024n * 1024n,
      },
    });
    await ctx.prisma.base.quota.upsert({
      where: {
        tenantId_key: { tenantId: actor.tenantId, key: 'AI_WRITE' },
      },
      update: { used: 0n, limit: 100n },
      create: {
        tenantId: actor.tenantId,
        key: 'AI_WRITE',
        used: 0n,
        limit: 100n,
      },
    });

    // 1. Create gallery category & keyword + question for writing task
    const mediaCategory = await ctx.prisma.base.mediaCategory.create({
      data: {
        tenantId: actor.tenantId,
        type: 1,
        name: 'AI生图测试图库',
      },
    });
    const keyword = await ctx.prisma.base.keyword.create({
      data: {
        tenantId: actor.tenantId,
        main: '工业视觉检测设备',
        brands: ['智检科技'],
      },
    });
    await ctx.prisma.base.question.create({
      data: {
        tenantId: actor.tenantId,
        keywordId: keyword.id,
        text: '工业视觉检测设备在产线质检中有哪些核心选型要点',
        source: 'MANUAL',
      },
    });

    // 2. Free prompt optimization costs 0 points
    const optRes = await httpCall<AiImageOptimizePromptResponse>(
      ctx.base,
      'POST',
      '/api/v1/image-jobs/optimize-prompt',
      {
        token: actor.token,
        body: {
          prompt: '现代产线光学检测工作站特写',
          style: '商务科技',
          keywordId: keyword.id,
        },
      },
    );
    expect(optRes.status).toBe(200);
    expect(optRes.code).toBe(0);
    expect(optRes.data?.optimizedPrompt.length).toBeGreaterThanOrEqual(20);

    // 3. Forbidden industry prompt is blocked upfront (40302) with 0 points charged
    const forbiddenRes = await httpCall(ctx.base, 'POST', '/api/v1/image-jobs', {
      token: actor.token,
      body: {
        prompt: '制作网络赌博博彩宣传海报',
        ratio: '21:9',
        count: 2,
      },
    });
    expect(forbiddenRes.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);

    const billing = ctx.app.get(BillingService);
    const walletBefore = await billing.wallet(actor.tenantId);
    expect(walletBefore.points).toBe(100);
    expect(walletBefore.pointsReserved).toBe(0);

    // 4. Submit AI image job (count=2, ratio='21:9', initially unsaved to category)
    const createRes = await httpCall<AiImageJobItem>(ctx.base, 'POST', '/api/v1/image-jobs', {
      token: actor.token,
      body: {
        prompt: optRes.data?.optimizedPrompt ?? '现代自动化工厂光学精密检测平台实景图',
        style: '商务科技',
        ratio: '21:9',
        count: 2,
      },
    });
    expect(createRes.status).toBe(200);
    expect(createRes.code).toBe(0);
    const jobId = createRes.data!.id;
    expect(createRes.data!.reservedPoints).toBe(10);

    const finishedJob = await waitForImageJobTerminal(ctx.base, actor.token, jobId);
    expect(finishedJob.status).toBe('COMPLETED');
    expect(finishedJob.successCount).toBe(2);
    expect(finishedJob.settledPoints).toBe(10);
    expect(finishedJob.releasedPoints).toBe(0);
    expect(finishedJob.assets).toHaveLength(2);
    expect(finishedJob.assets[0]?.width).toBe(1260);
    expect(finishedJob.assets[0]?.height).toBe(540);
    expect(finishedJob.assets[0]?.categoryId).toBeNull();

    const walletAfterImage = await billing.wallet(actor.tenantId);
    expect(walletAfterImage.points).toBe(90);
    expect(walletAfterImage.pointsReserved).toBe(0);

    const quotaAfterGen = await ctx.prisma.base.quota.findUniqueOrThrow({
      where: {
        tenantId_key: { tenantId: actor.tenantId, key: 'STORAGE_BYTES' },
      },
    });
    const expectedBytes = BigInt(finishedJob.assets.reduce((sum, item) => sum + item.bytes, 0));
    expect(quotaAfterGen.used).toBe(expectedBytes);
    expect(expectedBytes).toBeGreaterThan(0n);

    // 5. Save generated images to gallery category (zero-copy D21: STORAGE_BYTES unchanged!)
    const saveRes = await httpCall<{
      savedCount: number;
      categoryId: string;
      job: AiImageJobItem;
    }>(ctx.base, 'POST', `/api/v1/image-jobs/${jobId}/save-to-gallery`, {
      token: actor.token,
      body: {
        categoryId: mediaCategory.id,
      },
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.data?.savedCount).toBe(2);
    expect(saveRes.data?.job.saveCategoryId).toBe(mediaCategory.id);
    expect(saveRes.data?.job.assets.every((asset) => asset.categoryId === mediaCategory.id)).toBe(
      true,
    );

    const quotaAfterSave = await ctx.prisma.base.quota.findUniqueOrThrow({
      where: {
        tenantId_key: { tenantId: actor.tenantId, key: 'STORAGE_BYTES' },
      },
    });
    expect(quotaAfterSave.used).toBe(expectedBytes);

    // Signed URL is publicly readable for <img src="..."> rendering
    const signedPath = saveRes.data!.job.assets[0]!.url;
    const rawImgRes = await fetch(`${ctx.base}${signedPath}`);
    expect(rawImgRes.status).toBe(200);
    const rawBytes = Buffer.from(await rawImgRes.arrayBuffer());
    expect(rawBytes.length).toBeGreaterThan(100);

    // 6. Create an AI writing task referencing that gallery category and verify generated images are injected!
    const taskRes = await httpCall<{ id: string }>(ctx.base, 'POST', '/api/v1/ai-tasks', {
      token: actor.token,
      body: {
        name: '抽用AI生图素材任务',
        categoryId: 'AUTO',
        keywordId: keyword.id,
        mediaCategoryId: mediaCategory.id,
        imageCount: 2,
        resultStatus: 'NORMAL',
        target: 1,
      },
    });
    expect(taskRes.status).toBe(200);
    expect(taskRes.code).toBe(0);

    const finishedTask = await waitForAiTaskTerminal(ctx.base, actor.token, taskRes.data!.id);
    expect(finishedTask.status).toBe('COMPLETED');
    expect(finishedTask.doneCount).toBe(1);

    const articleId = finishedTask.items[0]?.articleId;
    expect(articleId).toBeTruthy();
    const article = await ctx.prisma.base.article.findUniqueOrThrow({
      where: { id: articleId! },
    });
    for (const asset of finishedJob.assets) {
      expect(article.contentHtml).toContain(`/api/v1/media-assets/${asset.id}/file`);
    }

    const updatedAssets = await ctx.prisma.base.mediaAsset.findMany({
      where: { id: { in: finishedJob.assets.map((a) => a.id) } },
    });
    expect(updatedAssets.every((a) => a.usedCount === 1)).toBe(true);

    // List endpoint works cleanly
    const listRes = await httpCall<AiImageJobListResponse>(ctx.base, 'GET', '/api/v1/image-jobs', {
      token: actor.token,
    });
    expect(listRes.status).toBe(200);
    expect(listRes.data?.total).toBe(1);
    expect(listRes.data?.items[0]?.orderNo).toMatch(/^IMG\d{8}-/);
  });

  it('refunds unsettleable image points when storage quota overflows and blocks endpoints when FEATURE_AI_IMAGE=false', async () => {
    const actor = await ctx.createTenantUser({
      role: 'MERCHANT',
      points: 50,
      billingMode: 'STRICT',
    });
    // Tight storage limit: 1 byte -> both generated images exceed quota and get refunded!
    await ctx.prisma.base.quota.upsert({
      where: {
        tenantId_key: { tenantId: actor.tenantId, key: 'STORAGE_BYTES' },
      },
      update: { used: 0n, limit: 1n },
      create: {
        tenantId: actor.tenantId,
        key: 'STORAGE_BYTES',
        used: 0n,
        limit: 1n,
      },
    });

    const createRes = await httpCall<AiImageJobItem>(ctx.base, 'POST', '/api/v1/image-jobs', {
      token: actor.token,
      body: {
        prompt: '精密自动化车间仓储物流全景图',
        ratio: '16:9',
        count: 2,
      },
    });
    expect(createRes.status).toBe(200);

    const failedJob = await waitForImageJobTerminal(ctx.base, actor.token, createRes.data!.id);
    expect(failedJob.status).toBe('FAILED');
    expect(failedJob.successCount).toBe(0);
    expect(failedJob.settledPoints).toBe(0);
    expect(failedJob.releasedPoints).toBe(10);

    const billing = ctx.app.get(BillingService);
    const walletAfter = await billing.wallet(actor.tenantId);
    expect(walletAfter.points).toBe(50);
    expect(walletAfter.pointsReserved).toBe(0);

    // Turn off FEATURE_AI_IMAGE and verify /account & /image-jobs gate
    process.env.FEATURE_AI_IMAGE = 'false';
    try {
      const accountRes = await httpCall<{ features?: { aiImage?: boolean } }>(
        ctx.base,
        'GET',
        '/api/v1/account',
        { token: actor.token },
      );
      expect(accountRes.status).toBe(200);
      expect(accountRes.data?.features?.aiImage).toBe(false);

      const blockedList = await httpCall(ctx.base, 'GET', '/api/v1/image-jobs', {
        token: actor.token,
      });
      expect(blockedList.status).toBe(403);
      expect(blockedList.code).toBe(API_ERROR.BAD_REQUEST);
    } finally {
      process.env.FEATURE_AI_IMAGE = 'true';
    }
  });
});
