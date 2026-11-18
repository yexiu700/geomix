import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import {
  AUTH_ERROR,
  GALLERY_CATEGORY_EMPTY_MSG,
  GALLERY_FILE_TOO_LARGE_MSG,
  IMAGE_MAX_INPUT_BYTES,
  type MediaAssetListResponse,
  type MediaCategoryListResponse,
  type MediaCategoryRecord,
  type MediaUploadResponse,
  type RightsCard,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';

async function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .png()
    .toBuffer();
}

describe('gallery routes without a database', () => {
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

  it('rejects anonymous category, asset, and unsigned file access', async () => {
    const catRes = await httpCall(base, 'GET', '/api/v1/media-categories');
    expect(catRes.status).toBe(401);
    expect(catRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const assetRes = await httpCall(base, 'GET', '/api/v1/media-assets');
    expect(assetRes.status).toBe(401);
    expect(assetRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const unsignedThumb = await fetch(`${base}/api/v1/media-assets/med_demo1/thumb`);
    expect(unsignedThumb.status).toBe(401);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'gallery categories, multi-upload compression, 3-thumb preview, reference guard, and STORAGE_BYTES quota against isolated Postgres',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('gal');
    }, 120_000);

    afterAll(async () => {
      delete process.env.GALLERY_MAX_INPUT_BYTES;
      if (ctx) await ctx.close();
    }, 60_000);

    it('enforces single-field category validation, <500px warning, >100MB rejection, 3-thumb preview, reference guards, and STORAGE_BYTES release', async () => {
      const tenantA = await ctx.createTenantUser({ prefix: 'ga' });
      const tenantB = await ctx.createTenantUser({ prefix: 'gb' });

      // 1. Empty category name rejected
      const emptyCat = await httpCall(ctx.base, 'POST', '/api/v1/media-categories', {
        token: tenantA.token,
        body: { name: '   ' },
      });
      expect(emptyCat.status).toBe(400);
      expect(emptyCat.msg).toContain(GALLERY_CATEGORY_EMPTY_MSG);

      // 2. Create category & verify rename + duplicate check + cross-tenant isolation
      const catCreate = await httpCall(ctx.base, 'POST', '/api/v1/media-categories', {
        token: tenantA.token,
        body: { name: '车间实拍' },
      });
      expect(catCreate.status).toBe(200);
      const catId = (catCreate.data as MediaCategoryRecord).id;

      const dupCat = await httpCall(ctx.base, 'POST', '/api/v1/media-categories', {
        token: tenantA.token,
        body: { name: '车间实拍' },
      });
      expect(dupCat.status).toBe(409);

      const renameCat = await httpCall(ctx.base, 'PATCH', `/api/v1/media-categories/${catId}`, {
        token: tenantA.token,
        body: { name: '智能工厂实拍' },
      });
      expect(renameCat.status).toBe(200);
      expect((renameCat.data as MediaCategoryRecord).name).toBe('智能工厂实拍');

      const crossCat = await httpCall(ctx.base, 'PATCH', `/api/v1/media-categories/${catId}`, {
        token: tenantB.token,
        body: { name: '越权修改' },
      });
      expect(crossCat.status).toBe(404);

      // 3. Reject > 100MB declared upload on multipart endpoint and configured input byte ceiling
      const formTooBig = new FormData();
      formTooBig.set('categoryId', catId);
      const tinyPng = await solidPng(600, 400, [30, 90, 180]);
      formTooBig.append(
        'files',
        new Blob([new Uint8Array(tinyPng)], { type: 'image/png' }),
        'oversize.png',
      );
      const declaredTooBigRes = await fetch(`${ctx.base}/api/v1/media-assets/upload`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tenantA.token}`,
          'x-declared-file-bytes': String(IMAGE_MAX_INPUT_BYTES + 1024),
        },
        body: formTooBig,
      });
      expect(declaredTooBigRes.status).toBe(400);
      const declaredTooBigJson = (await declaredTooBigRes.json()) as { msg: string };
      expect(declaredTooBigJson.msg).toBe(GALLERY_FILE_TOO_LARGE_MSG);

      process.env.GALLERY_MAX_INPUT_BYTES = '1024';
      const actualTooBig = await httpCall(ctx.base, 'POST', '/api/v1/media-assets', {
        token: tenantA.token,
        body: {
          categoryId: catId,
          files: [{ filename: 'big.png', contentBase64: Buffer.alloc(2048, 7).toString('base64') }],
        },
      });
      expect(actualTooBig.status).toBe(400);
      expect(actualTooBig.msg).toBe(GALLERY_FILE_TOO_LARGE_MSG);
      delete process.env.GALLERY_MAX_INPUT_BYTES;

      // 4. Multi-upload via multipart: 1 narrow (<500px) + 3 wide (including >1600px) images = 4 total
      const narrowImg = await solidPng(360, 260, [200, 80, 60]);
      const wideImg1 = await solidPng(2000, 1400, [40, 120, 210]);
      const wideImg2 = await solidPng(900, 600, [50, 160, 90]);
      const wideImg3 = await solidPng(800, 600, [140, 90, 190]);

      const uploadForm = new FormData();
      uploadForm.set('categoryId', catId);
      uploadForm.append(
        'files',
        new Blob([new Uint8Array(narrowImg)], { type: 'image/png' }),
        'narrow.png',
      );
      uploadForm.append(
        'files',
        new Blob([new Uint8Array(wideImg1)], { type: 'image/png' }),
        'wide-2000.png',
      );
      uploadForm.append(
        'files',
        new Blob([new Uint8Array(wideImg2)], { type: 'image/png' }),
        'wide-900.png',
      );
      uploadForm.append(
        'files',
        new Blob([new Uint8Array(wideImg3)], { type: 'image/png' }),
        'wide-800.png',
      );

      const multipartRes = await fetch(`${ctx.base}/api/v1/media-assets/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tenantA.token}` },
        body: uploadForm,
      });
      expect(multipartRes.status).toBe(200);
      const multipartJson = (await multipartRes.json()) as { data: MediaUploadResponse };
      expect(multipartJson.data.items).toHaveLength(4);
      expect(multipartJson.data.warnings).toHaveLength(1);
      expect(multipartJson.data.warnings[0]).toContain('小于建议值 500px');

      // Large 2000x1400 was compressed down to <= 1600px JPEG
      const compressedWide = multipartJson.data.items[1]?.asset;
      expect(compressedWide?.width).toBe(1600);
      expect(compressedWide?.mime).toBe('image/jpeg');
      expect(compressedWide?.originalName).toBe('wide-2000.png');
      expect(compressedWide?.displayName).toBe('wide-2000.png');

      const totalUploadedBytes = multipartJson.data.items.reduce(
        (acc, item) => acc + item.asset.bytes,
        0,
      );
      expect(multipartJson.data.storage.used).toBe(String(totalUploadedBytes));

      // Verify /me/rights STORAGE_BYTES matches exact uploaded bytes
      const rightsAfterUpload = await httpCall(ctx.base, 'GET', '/api/v1/me/rights', {
        token: tenantA.token,
      });
      const storageCard1 = (rightsAfterUpload.data as { cards: RightsCard[] }).cards.find(
        (c) => c.key === 'STORAGE_BYTES',
      );
      expect(storageCard1?.used).toBe(String(totalUploadedBytes));

      // 5. Category list shows assetCount = 4 and previewAssets = first 3 thumbnails, and signed thumb serves JPEG
      const catList = await httpCall(ctx.base, 'GET', '/api/v1/media-categories', {
        token: tenantA.token,
      });
      expect(catList.status).toBe(200);
      const catRow = (catList.data as MediaCategoryListResponse).items[0];
      expect(catRow?.assetCount).toBe(4);
      expect(catRow?.previewAssets).toHaveLength(3);

      const thumbFetch = await fetch(`${ctx.base}${catRow?.previewAssets[0]?.thumbUrl}`);
      expect(thumbFetch.status).toBe(200);
      expect(thumbFetch.headers.get('content-type')).toBe('image/jpeg');
      const thumbBytes = Buffer.from(await thumbFetch.arrayBuffer());
      expect(thumbBytes[0]).toBe(0xff);
      expect(thumbBytes[1]).toBe(0xd8);

      // Tampered signature rejected
      const tamperedUrl = (catRow?.previewAssets[0]?.thumbUrl ?? '').replace(
        /sig=[0-9a-f]+/,
        'sig=00000000000000000000000000000000',
      );
      const tamperedRes = await fetch(`${ctx.base}${tamperedUrl}`);
      expect(tamperedRes.status).toBe(401);

      // 6. Deleting non-empty category blocked
      const delNonEmptyCat = await httpCall(
        ctx.base,
        'DELETE',
        `/api/v1/media-categories/${catId}`,
        { token: tenantA.token },
      );
      expect(delNonEmptyCat.status).toBe(409);

      // 7. Deleting live-referenced asset blocked (409), while orphaned usedCount > 0 with 0 live articles deletes & releases STORAGE_BYTES (#94)
      const firstAsset = multipartJson.data.items[0]!.asset;
      const secondAsset = multipartJson.data.items[1]!.asset;
      const refArtCat = await ctx.prisma.base.articleCategory.create({
        data: { tenantId: tenantA.tenantId, name: '关联测试分类' },
      });
      await ctx.prisma.base.article.create({
        data: {
          tenantId: tenantA.tenantId,
          categoryId: refArtCat.id,
          title: '引用图库素材的测试文章',
          contentHtml: `<p>正文配图</p><img src="${firstAsset.url}" alt="测试图" />`,
          contentText: '正文配图',
          coverUrl: firstAsset.url,
          status: 'NORMAL',
          source: 'MANUAL',
        },
      });
      await ctx.prisma.base.mediaAsset.update({
        where: { id: secondAsset.id },
        data: { usedCount: 2 },
      });

      const delUsedAsset = await httpCall(
        ctx.base,
        'DELETE',
        `/api/v1/media-assets/${firstAsset.id}`,
        { token: tenantA.token },
      );
      expect(delUsedAsset.status).toBe(409);

      const delFreeAsset = await httpCall(
        ctx.base,
        'DELETE',
        `/api/v1/media-assets/${secondAsset.id}`,
        { token: tenantA.token },
      );
      expect(delFreeAsset.status).toBe(200);

      const expectedRemainingBytes = totalUploadedBytes - secondAsset.bytes;
      const rightsAfterDelete = await httpCall(ctx.base, 'GET', '/api/v1/me/rights', {
        token: tenantA.token,
      });
      const storageCard2 = (rightsAfterDelete.data as { cards: RightsCard[] }).cards.find(
        (c) => c.key === 'STORAGE_BYTES',
      );
      expect(storageCard2?.used).toBe(String(expectedRemainingBytes));

      // Asset list filtered by categoryId shows remaining 3 assets
      const assetList = await httpCall(
        ctx.base,
        'GET',
        `/api/v1/media-assets?categoryId=${catId}`,
        { token: tenantA.token },
      );
      expect(assetList.status).toBe(200);
      expect((assetList.data as MediaAssetListResponse).total).toBe(3);
      expect((assetList.data as MediaAssetListResponse).category?.name).toBe('智能工厂实拍');

      // 8. Empty category referenced by AiTask is ALSO blocked from deletion
      const taskCatRes = await httpCall(ctx.base, 'POST', '/api/v1/media-categories', {
        token: tenantA.token,
        body: { name: '任务引用分类' },
      });
      const taskCatId = (taskCatRes.data as MediaCategoryRecord).id;
      const artCat = await ctx.prisma.base.articleCategory.create({
        data: { tenantId: tenantA.tenantId, name: '默认文章分类' },
      });
      const kw = await ctx.prisma.base.keyword.create({
        data: { tenantId: tenantA.tenantId, main: '激光焊接设备', brands: ['智造星'] },
      });
      await ctx.prisma.base.aiTask.create({
        data: {
          tenantId: tenantA.tenantId,
          name: '引用测试任务',
          categoryId: artCat.id,
          keywordId: kw.id,
          mediaCategoryId: taskCatId,
          target: 1,
          unitPrice: 10,
          seed: 42,
        },
      });
      const delRefCat = await httpCall(
        ctx.base,
        'DELETE',
        `/api/v1/media-categories/${taskCatId}`,
        { token: tenantA.token },
      );
      expect(delRefCat.status).toBe(409);
      expect(delRefCat.msg).toContain('引用');
    });
  },
);
