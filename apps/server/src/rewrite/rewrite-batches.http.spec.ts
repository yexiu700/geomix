import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  type RewriteBatchDetailResponse,
  type RewriteBatchListResponse,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../billing/billing.service';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import { PublicFetchService } from '../infra/adapters.module';
import type { TransportRequest, TransportResponse } from '../infra/guarded-request';
import { fetchPublicPage, resetRobotsCache } from '../infra/public-fetch';
import { WorkerModule } from '../worker.module';

function buildFixtureArticleHtml(title: string, topic: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><title>${title}</title></head>
<body>
  <article>
    <h1>${title}</h1>
    <p>围绕${topic}的产线选型与长期服役稳定性，工程技术部门需要从床身退火工艺、导轨防尘密封、气路干燥过滤和数控系统动态前瞻四个维度建立量化评估矩阵。</p>
    <p>在实际批量生产现场，高负荷连续切割不仅考验激光发生器光电转换效率，更直接检验交换工作台同步精度与排烟除尘负压通道设计合理性，规范的班前点检能够显著压缩非计划停机时间。</p>
    <p>建议工艺团队结合板材厚度分布建立分层参数库，定期核查保护镜片洁净度与喷嘴同轴度，确保批量交付件切缝垂直度与表面粗糙度长期处于受控区间。</p>
    <img src="https://cdn.origin-source.example/watermark.jpg" />
  </article>
</body>
</html>`;
}

function forwardToLocalFixture(
  localPort: number,
  req: TransportRequest,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: localPort,
        method: req.method,
        path: `${req.url.pathname}${req.url.search}`,
        headers: {
          ...req.headers,
          host: req.url.host,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > req.maxBytes) {
            outgoing.destroy(new Error('max_bytes'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 500,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    const onAbort = () => {
      outgoing.destroy(new Error('aborted'));
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    outgoing.on('close', () => {
      req.signal?.removeEventListener('abort', onAbort);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function waitForBatchTerminal(
  base: string,
  token: string,
  batchId: string,
  maxWaitMs = 15_000,
): Promise<RewriteBatchDetailResponse> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await httpCall<RewriteBatchDetailResponse>(
      base,
      'GET',
      `/api/v1/rewrite-batches/${batchId}`,
      { token },
    );
    if (
      res.status === 200 &&
      res.data &&
      ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(res.data.batch.status)
    ) {
      return res.data;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Batch ${batchId} did not reach terminal state within ${maxWaitMs}ms`);
}

describe('rewrite-batches routes without a database', () => {
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

  it('rejects anonymous list, detail, create, pause, resume, cancel, and delete calls', async () => {
    expect((await httpCall(base, 'GET', '/api/v1/rewrite-batches')).status).toBe(401);
    expect((await httpCall(base, 'GET', '/api/v1/rewrite-batches/batch_1')).status).toBe(401);
    expect((await httpCall(base, 'POST', '/api/v1/rewrite-batches', { body: {} })).status).toBe(
      401,
    );
    expect((await httpCall(base, 'POST', '/api/v1/rewrite-batches/batch_1/pause')).status).toBe(
      401,
    );
    expect((await httpCall(base, 'POST', '/api/v1/rewrite-batches/batch_1/resume')).status).toBe(
      401,
    );
    expect((await httpCall(base, 'POST', '/api/v1/rewrite-batches/batch_1/cancel')).status).toBe(
      401,
    );
    expect((await httpCall(base, 'DELETE', '/api/v1/rewrite-batches/batch_1')).status).toBe(401);
  });
});

describe.skipIf(
  process.env.GEOMIX_DB_INTEGRATION !== '1' || process.env.GEOMIX_REDIS_INTEGRATION !== '1',
)(
  'rewrite-batches full async pipeline: URL-in-keyword guard, 5-links-1-fail = 20 pts, maxCount=3 early stop, and timeout refund via BullMQ + Postgres',
  () => {
    let ctx: IsolatedTestContext;
    let workerApp: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
    let fixtureServer: Server;
    let fixturePort = 0;
    const hitCounts = new Map<string, number>();
    let prevQueuePrefix: string | undefined;
    let prevBatchTimeout: string | undefined;
    let prevItemTimeout: string | undefined;

    beforeAll(async () => {
      resetRobotsCache();
      // 1. Start local fixture HTTP server simulating external public article hosts
      fixtureServer = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        hitCounts.set(path, (hitCounts.get(path) ?? 0) + 1);

        if (path === '/bad-403') {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body>请完成安全验证后继续访问</body></html>');
          return;
        }
        if (path === '/slow-hang') {
          const timer = setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(buildFixtureArticleHtml('慢速页面', '激光焊接'));
          }, 5_000);
          req.on('close', () => clearTimeout(timer));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildFixtureArticleHtml(`工业装备选型实务-${path.slice(1)}`, `数控产线${path}`));
      });
      await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
      fixturePort = (fixtureServer.address() as AddressInfo).port;

      const queuePrefix = `geomix:rwbatch:${randomBytes(4).toString('hex')}`;
      prevQueuePrefix = process.env.QUEUE_PREFIX;
      prevBatchTimeout = process.env.REWRITE_BATCH_TIMEOUT_MS;
      prevItemTimeout = process.env.REWRITE_BATCH_ITEM_TIMEOUT_MS;
      process.env.QUEUE_PREFIX = queuePrefix;

      const testFetch = (url: string, signal?: AbortSignal) => {
        // Map public.batch.example -> local fixture server while keeping SSRF DNS checks active!
        return fetchPublicPage(url, {
          timeoutMs: 4_000,
          maxBytes: 2_000_000,
          maxRedirects: 2,
          robotsCacheMs: 60_000,
          signal,
          resolver: {
            async resolve(hostname: string) {
              if (hostname === 'public.batch.example') {
                return [{ address: '93.184.216.34', family: 4 }];
              }
              return [{ address: '127.0.0.1', family: 4 }];
            },
          },
          transport: (request) => forwardToLocalFixture(fixturePort, request),
        });
      };

      ctx = await createIsolatedTestContext('rwbatch', async (buildApp) => {
        const app = await buildApp();
        app.get(PublicFetchService).fetch = testFetch;
        return app;
      });

      workerApp = await NestFactory.createApplicationContext(WorkerModule, {
        logger: ['error'],
      });
      workerApp.get(PublicFetchService).fetch = testFetch;
    }, 120_000);

    afterAll(async () => {
      if (prevQueuePrefix === undefined) delete process.env.QUEUE_PREFIX;
      else process.env.QUEUE_PREFIX = prevQueuePrefix;
      if (prevBatchTimeout === undefined) delete process.env.REWRITE_BATCH_TIMEOUT_MS;
      else process.env.REWRITE_BATCH_TIMEOUT_MS = prevBatchTimeout;
      if (prevItemTimeout === undefined) delete process.env.REWRITE_BATCH_ITEM_TIMEOUT_MS;
      else process.env.REWRITE_BATCH_ITEM_TIMEOUT_MS = prevItemTimeout;

      await workerApp?.close();
      await ctx?.close();
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    });

    it('validates inputs, settles 20 pts on 5-links-with-1-failure (refunding 5), stops early at maxCount=3, and refunds on timeout without touching AI_WRITE quota', async () => {
      const merchant = await ctx.createTenantUser({
        prefix: 'rwb',
        points: 1000,
        billingMode: 'STRICT',
      });
      const token = merchant.token;
      const billing = ctx.app.get(BillingService);

      // Prepare tenant gallery category + 2 uploaded gallery images
      const mediaCat = await ctx.prisma.base.mediaCategory.create({
        data: { tenantId: merchant.tenantId, name: '批量复刻实拍图库', type: 1 },
      });
      const mediaCategoryId = mediaCat.id;
      for (let idx = 1; idx <= 2; idx += 1) {
        await ctx.prisma.base.mediaAsset.create({
          data: {
            id: `med_rwb_${idx}_${Date.now()}`,
            tenantId: merchant.tenantId,
            categoryId: mediaCategoryId,
            origin: 'UPLOAD',
            objectKey: `rwb/own-${idx}.jpg`,
            url: `/uploads/rwb-own-${idx}.jpg`,
            thumbUrl: `/uploads/rwb-own-${idx}.jpg`,
            width: 900,
            height: 600,
            bytes: 15_000,
            mime: 'image/jpeg',
            usedCount: 0,
          },
        });
      }

      // 1. Reject URL mistakenly typed into keyword search mode
      const urlInKeywordRes = await httpCall(ctx.base, 'POST', '/api/v1/rewrite-batches', {
        token,
        body: {
          name: '误填链接为关键词',
          maxCount: 3,
          sourceType: 'remote',
          keyword: 'https://mp.weixin.qq.com/s/mistaken-link',
          mediaCategoryId,
          templateId: 'sys_rewrite_01',
        },
      });
      expect(urlInKeywordRes.status).toBe(400);
      expect(urlInKeywordRes.code).toBe(API_ERROR.BAD_REQUEST);
      expect(urlInKeywordRes.msg).toContain(REWRITE_BATCH_URL_AS_KEYWORD_MSG);

      // 2. Reject SSRF internal URL in link_list before charging
      const ssrfListRes = await httpCall(ctx.base, 'POST', '/api/v1/rewrite-batches', {
        token,
        body: {
          name: '内网地址拦截测试',
          maxCount: 2,
          sourceType: 'link_list',
          linksText: 'https://public.batch.example/ok-0\nhttp://127.0.0.1/admin',
          mediaCategoryId,
          templateId: 'sys_rewrite_01',
        },
      });
      expect(ssrfListRes.status).toBe(400);
      expect(ssrfListRes.msg).toContain('第 2 行');

      const walletBefore = await billing.wallet(merchant.tenantId);
      expect(walletBefore.points).toBe(1000);
      expect(walletBefore.pointsReserved).toBe(0);

      // 3. Core Acceptance #1: 5 links with 1 failure (maxCount = 5) -> 4 succeed, 20 pts settled, 5 pts refunded -> PARTIAL
      const fiveLinksRes = await httpCall<RewriteBatchDetailResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrite-batches',
        {
          token,
          body: {
            name: '五链一败验收任务',
            maxCount: 5,
            sourceType: 'link_list',
            linksText: [
              'https://public.batch.example/a-1',
              'https://public.batch.example/a-2',
              'https://public.batch.example/bad-403',
              'https://public.batch.example/a-4',
              'https://public.batch.example/a-5',
            ].join('\n'),
            mediaCategoryId,
            templateId: 'sys_rewrite_01',
            brand: '智造装备',
          },
        },
      );
      expect(fiveLinksRes.status).toBe(200);
      const batch1Id = fiveLinksRes.data!.batch.id;

      const batch1Done = await waitForBatchTerminal(ctx.base, token, batch1Id);
      expect(batch1Done.batch.status).toBe('PARTIAL');
      expect(batch1Done.batch.doneCount).toBe(4);
      expect(batch1Done.batch.reservedPoints).toBe(25);
      expect(batch1Done.batch.settledPoints).toBe(20);
      expect(batch1Done.batch.releasedPoints).toBe(5);
      expect(batch1Done.records).toHaveLength(5);
      expect(batch1Done.records.filter((r) => r.status === 'SUCCESS')).toHaveLength(4);
      expect(batch1Done.records.filter((r) => r.status === 'SKIPPED')).toHaveLength(1);

      // Verify zero original images leaked into generated articles
      const batch1Articles = await ctx.prisma.base.article.findMany({
        where: { categoryId: batch1Done.batch.categoryId, tenantId: merchant.tenantId },
      });
      expect(batch1Articles).toHaveLength(4);
      for (const art of batch1Articles) {
        expect(art.contentHtml).not.toContain('origin-source.example');
        expect(art.contentHtml).toContain('<img ');
      }

      const walletAfterBatch1 = await billing.wallet(merchant.tenantId);
      expect(walletAfterBatch1.points).toBe(980);
      expect(walletAfterBatch1.pointsReserved).toBe(0);

      // 4. Core Acceptance #2: maxCount = 3 on 5 valid links -> stops immediately at 3 (15 pts settled, b-4 & b-5 never fetched!)
      hitCounts.clear();
      const maxThreeRes = await httpCall<RewriteBatchDetailResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrite-batches',
        {
          token,
          body: {
            name: '凑满三篇即停任务',
            maxCount: 3,
            sourceType: 'link_list',
            linksText: [
              'https://public.batch.example/b-1',
              'https://public.batch.example/b-2',
              'https://public.batch.example/b-3',
              'https://public.batch.example/b-4',
              'https://public.batch.example/b-5',
            ].join('\n'),
            mediaCategoryId,
            templateId: 'sys_rewrite_01',
          },
        },
      );
      expect(maxThreeRes.status).toBe(200);
      const batch2Id = maxThreeRes.data!.batch.id;

      const batch2Done = await waitForBatchTerminal(ctx.base, token, batch2Id);
      expect(batch2Done.batch.status).toBe('COMPLETED');
      expect(batch2Done.batch.doneCount).toBe(3);
      expect(batch2Done.batch.reservedPoints).toBe(15);
      expect(batch2Done.batch.settledPoints).toBe(15);
      expect(batch2Done.batch.releasedPoints).toBe(0);
      expect(hitCounts.get('/b-4') ?? 0).toBe(0);
      expect(hitCounts.get('/b-5') ?? 0).toBe(0);

      const walletAfterBatch2 = await billing.wallet(merchant.tenantId);
      expect(walletAfterBatch2.points).toBe(965);
      expect(walletAfterBatch2.pointsReserved).toBe(0);

      // 5. Core Acceptance #3: Timeout guard -> never hangs indefinitely and refunds 100% of reserved points
      process.env.REWRITE_BATCH_TIMEOUT_MS = '700';
      process.env.REWRITE_BATCH_ITEM_TIMEOUT_MS = '500';
      const slowRes = await httpCall<RewriteBatchDetailResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrite-batches',
        {
          token,
          body: {
            name: '慢速源站超时退点测试',
            maxCount: 2,
            sourceType: 'link_list',
            linksText: 'https://public.batch.example/slow-hang',
            mediaCategoryId,
            templateId: 'sys_rewrite_01',
          },
        },
      );
      expect(slowRes.status).toBe(200);
      const slowDone = await waitForBatchTerminal(ctx.base, token, slowRes.data!.batch.id, 8_000);
      expect(slowDone.batch.status).toBe('FAILED');
      expect(slowDone.batch.doneCount).toBe(0);
      expect(slowDone.batch.settledPoints).toBe(0);
      expect(slowDone.batch.releasedPoints).toBe(10);
      expect(slowDone.batch.note).toContain('退还');

      const walletAfterSlow = await billing.wallet(merchant.tenantId);
      expect(walletAfterSlow.points).toBe(965);
      expect(walletAfterSlow.pointsReserved).toBe(0);
      expect(await billing.auditTenant(merchant.tenantId)).toEqual([]);

      // 6. Verify AI_WRITE quota remained 0 across all batch rewrites
      const aiWriteQuota = await ctx.prisma.base.quota.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: merchant.tenantId, key: 'AI_WRITE' } },
      });
      expect(Number(aiWriteQuota.used)).toBe(0);

      // 7. Verify list endpoint & CSV export
      const listRes = await httpCall<RewriteBatchListResponse>(
        ctx.base,
        'GET',
        '/api/v1/rewrite-batches?page=1&pageSize=25',
        { token },
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data!.total).toBe(3);

      const csvRes = await fetch(`${ctx.base}/api/v1/rewrite-batches?export=csv`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(csvRes.status).toBe(200);
      const csvText = await csvRes.text();
      expect(csvText).toContain('五链一败验收任务');
      expect(csvText).toContain('凑满三篇即停任务');
    });
  },
);
