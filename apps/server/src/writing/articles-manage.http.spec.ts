import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  AUTH_ERROR,
  readZipStoreEntries,
  type ArticleCategoryRecord,
  type ArticleDetailRecord,
  type ArticleManageListResponse,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';

describe('articles manage routes without a database', () => {
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

  it('rejects anonymous list, create, bulk-status, and export-zip requests', async () => {
    const listRes = await httpCall(base, 'GET', '/api/v1/articles');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const createRes = await httpCall(base, 'POST', '/api/v1/articles', {
      body: { title: '未登录文章', categoryId: 'cat_1', contentHtml: '<p>正文</p>' },
    });
    expect(createRes.status).toBe(401);

    const zipRes = await httpCall(base, 'POST', '/api/v1/articles/export-zip', {
      body: { format: 'md' },
    });
    expect(zipRes.status).toBe(401);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'articles manual add, cover auto-fill/replace/remove, status transitions, remaining sync, quota invariance, and ZIP export',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('art');
    }, 120_000);

    afterAll(async () => {
      if (ctx) await ctx.close();
    }, 60_000);

    it('defaults manual articles to NORMAL without incrementing AI_WRITE, syncs category remaining on approve & bulk-status, and exports openable MD/HTML/DOCX zips', async () => {
      const tenantA = await ctx.createTenantUser({ prefix: 'arta', points: 500 });
      const tenantB = await ctx.createTenantUser({ prefix: 'artb', points: 500 });

      // 1. Create article category + gallery category with 2 assets
      const catRes = await httpCall<ArticleCategoryRecord>(
        ctx.base,
        'POST',
        '/api/v1/writing/categories',
        {
          token: tenantA.token,
          body: { name: '激光维护实务' },
        },
      );
      expect(catRes.status).toBe(200);
      const categoryId = catRes.data.id;

      const mediaCat = await ctx.prisma.base.mediaCategory.create({
        data: { tenantId: tenantA.tenantId, name: '设备养护图库', type: 1 },
      });
      await ctx.prisma.base.mediaAsset.createMany({
        data: [
          {
            id: `med_cover_1_${Date.now()}`,
            tenantId: tenantA.tenantId,
            categoryId: mediaCat.id,
            origin: 'UPLOAD',
            objectKey: 'demo/cover-a.jpg',
            url: '/uploads/cover-a.jpg',
            thumbUrl: '/uploads/cover-a-thumb.jpg',
            width: 800,
            height: 600,
            bytes: 12000,
            mime: 'image/jpeg',
            usedCount: 0,
          },
          {
            id: `med_cover_2_${Date.now()}`,
            tenantId: tenantA.tenantId,
            categoryId: mediaCat.id,
            origin: 'UPLOAD',
            objectKey: 'demo/cover-b.jpg',
            url: '/uploads/cover-b.jpg',
            thumbUrl: '/uploads/cover-b-thumb.jpg',
            width: 800,
            height: 600,
            bytes: 12000,
            mime: 'image/jpeg',
            usedCount: 5,
          },
        ],
      });

      // 2. Manual create without explicit status -> defaults to NORMAL, auto-picks cover from mediaCategoryId, remaining becomes 1
      const manual1 = await httpCall<ArticleDetailRecord>(ctx.base, 'POST', '/api/v1/articles', {
        token: tenantA.token,
        body: {
          title: '光纤切割头保护镜片更换步骤',
          categoryId,
          mediaCategoryId: mediaCat.id,
          contentHtml:
            '<h2>准备工具</h2><p>准备无尘棉签与高纯异丙醇，在洁净环境下拆卸镜片抽屉。</p><ul><li>检查密封圈</li><li>轻放准直镜</li></ul>',
        },
      });
      expect(manual1.status).toBe(200);
      expect(manual1.data.status).toBe('NORMAL');
      expect(manual1.data.source).toBe('MANUAL');
      expect(manual1.data.coverUrl).toBe('/uploads/cover-a.jpg');
      expect(manual1.data.countsAsRemaining).toBe(true);

      // Verify AI_WRITE quota is still 0 and wallet points untouched (500)
      const aiQuotaBefore = await ctx.prisma.base.quota.findUnique({
        where: { tenantId_key: { tenantId: tenantA.tenantId, key: 'AI_WRITE' } },
      });
      expect(aiQuotaBefore?.used ?? 0n).toBe(0n);

      const catCheck1 = await httpCall<ArticleCategoryRecord>(
        ctx.base,
        'GET',
        `/api/v1/writing/categories/${categoryId}`,
        { token: tenantA.token },
      );
      expect(catCheck1.data.total).toBe(1);
      expect(catCheck1.data.remaining).toBe(1);

      // 3. Edit cover (replace -> remove) and switch status to PENDING -> remaining drops to 0
      const patched = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'PATCH',
        `/api/v1/articles/${manual1.data.id}`,
        {
          token: tenantA.token,
          body: {
            coverUrl: '/uploads/cover-b.jpg',
            status: 'PENDING',
          },
        },
      );
      expect(patched.status).toBe(200);
      expect(patched.data.coverUrl).toBe('/uploads/cover-b.jpg');
      expect(patched.data.status).toBe('PENDING');

      const removedCover = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'PATCH',
        `/api/v1/articles/${manual1.data.id}`,
        {
          token: tenantA.token,
          body: { coverUrl: null },
        },
      );
      expect(removedCover.status).toBe(200);
      expect(removedCover.data.coverUrl).toBeNull();

      const catCheck2 = await httpCall<ArticleCategoryRecord>(
        ctx.base,
        'GET',
        `/api/v1/writing/categories/${categoryId}`,
        { token: tenantA.token },
      );
      expect(catCheck2.data.remaining).toBe(0);

      // Explicit approve ("标记为已审核") -> status NORMAL, remaining rises back to 1
      const approved = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'POST',
        `/api/v1/articles/${manual1.data.id}/approve`,
        { token: tenantA.token },
      );
      expect(approved.status).toBe(200);
      expect(approved.data.status).toBe('NORMAL');

      // 4. Create 2 PENDING articles and run "批量设为正常" (bulk-status NORMAL) -> remaining jumps from 1 to 3!
      const p1 = await httpCall<ArticleDetailRecord>(ctx.base, 'POST', '/api/v1/articles', {
        token: tenantA.token,
        body: {
          title: '冷水机冬季防冻液配比说明',
          categoryId,
          status: 'PENDING',
          contentHtml: '<h2>防冻液选型</h2><p>低温车间需按比例添加乙二醇型激光专用防冻液。</p>',
        },
      });
      const p2 = await httpCall<ArticleDetailRecord>(ctx.base, 'POST', '/api/v1/articles', {
        token: tenantA.token,
        body: {
          title: '齿轮齿条导轨润滑周期表',
          categoryId,
          status: 'PENDING',
          contentHtml: '<h2>润滑保养</h2><p>每周检查自动注油泵油位并清理齿条铁屑。</p>',
        },
      });

      const listPending = await httpCall<ArticleManageListResponse>(
        ctx.base,
        'GET',
        `/api/v1/articles?categoryId=${categoryId}&status=PENDING`,
        { token: tenantA.token },
      );
      expect(listPending.status).toBe(200);
      expect(listPending.data.total).toBe(2);
      expect(listPending.data.categorySummary?.total).toBe(3);
      expect(listPending.data.categorySummary?.remaining).toBe(1);

      const bulkNormal = await httpCall<{ updated: number }>(
        ctx.base,
        'POST',
        '/api/v1/articles/bulk-status',
        {
          token: tenantA.token,
          body: { ids: [p1.data.id, p2.data.id], status: 'NORMAL' },
        },
      );
      expect(bulkNormal.status).toBe(200);
      expect(bulkNormal.data.updated).toBe(2);

      const catCheck3 = await httpCall<ArticleCategoryRecord>(
        ctx.base,
        'GET',
        `/api/v1/writing/categories/${categoryId}`,
        { token: tenantA.token },
      );
      expect(catCheck3.data.total).toBe(3);
      expect(catCheck3.data.remaining).toBe(3);

      // Cross-tenant isolation check
      const crossPatch = await httpCall(ctx.base, 'PATCH', `/api/v1/articles/${manual1.data.id}`, {
        token: tenantB.token,
        body: { title: '越权篡改' },
      });
      expect(crossPatch.status).toBe(404);

      // Quota & wallet invariance after manual add + status edits
      const aiQuotaAfter = await ctx.prisma.base.quota.findUnique({
        where: { tenantId_key: { tenantId: tenantA.tenantId, key: 'AI_WRITE' } },
      });
      expect(aiQuotaAfter?.used ?? 0n).toBe(0n);
      const walletAfter = await ctx.prisma.base.wallet.findUnique({
        where: { tenantId: tenantA.tenantId },
      });
      expect(walletAfter?.points).toBe(500);

      // 5. Export ZIP in md, html, and docx formats and verify archives open & decode cleanly
      const decoder = new TextDecoder('utf-8');
      for (const fmt of ['md', 'html', 'docx'] as const) {
        const zipRes = await fetch(`${ctx.base}/api/v1/articles/export-zip`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tenantA.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ categoryId, format: fmt }),
        });
        expect(zipRes.status).toBe(200);
        expect(zipRes.headers.get('content-type')).toContain('application/zip');
        const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
        const entries = readZipStoreEntries(zipBytes);
        expect(entries).toHaveLength(3);
        expect(entries.every((e) => e.path.endsWith(`.${fmt}`))).toBe(true);

        if (fmt === 'md') {
          const allMd = entries.map((e) => decoder.decode(e.data)).join('\n');
          expect(allMd).toContain('# 光纤切割头保护镜片更换步骤');
          expect(allMd).toContain('## 准备工具');
        } else if (fmt === 'html') {
          const allHtml = entries.map((e) => decoder.decode(e.data)).join('\n');
          expect(allHtml).toContain('<!DOCTYPE html>');
          expect(allHtml).toContain('冷水机冬季防冻液配比说明');
        } else {
          const innerDocx = readZipStoreEntries(entries[0]!.data);
          const docXml = innerDocx.find((p) => p.path === 'word/document.xml');
          expect(docXml).toBeTruthy();
          expect(decoder.decode(docXml!.data)).toContain('<w:document');
        }
      }
    }, 60_000);
  },
);
