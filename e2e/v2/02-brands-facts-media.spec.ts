import { expect, test, v2Describe } from './support/v2-test';
import {
  apiRequest,
  apiV2Base,
  createBrand,
  deleteBrandMedia,
  extractItems,
  getBrand,
  getWallet,
  listBrandFacts,
  pollUntil,
  provisionTenant,
  saveBrandFacts,
  streamOversizedMultipartUpload,
  uploadBrandMedia,
  uploadV2Multipart,
  type BrandData,
  type BrandFactData,
  type BrandMediaData,
} from './support/api-client';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFactsPayload,
  buildSizedFactText,
  buildTestJpegWithExifBuffer,
  buildTestPngBuffer,
  FAKE_EXIF_MARKER,
  FIXTURE_URLS,
  SSRF_BLOCKED_URLS,
  uniqueTag,
} from './support/fixtures';
import {
  createAuthenticatedContext,
  switchGlobalBrand,
  switchGlobalMarket,
} from './support/ui-actions';

// ============================================================================
// Spec 02 — M2 Brand Assets: F6–F8 (15 Tier 1 + 17 Tier 2 = 32 tests)
// Progressive rule: ZERO calls to /visibility, /briefs, /articles, /batch-jobs,
// /publish-records, /home, or /media/ai-gen.
// ============================================================================

v2Describe('F6: 60-Second Brand Creation & Dual-Market Identity', { tag: ['@F6', '@M2'] }, () => {
  test(
    'T1-F06-01 60-second brand creation modal requires only 4 minimal fields and succeeds in 1 step',
    { tag: ['@tier1', '@F6', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06t1');
      const tenant = await provisionTenant({ tag });
      const { context, page } = await createAuthenticatedContext(browser, tenant);
      try {
        await page.goto('/brands', { waitUntil: 'domcontentloaded' });
        const createBtn = page
          .getByTestId('brand-quick-create')
          .or(page.getByRole('button', { name: /60 秒创建首个品牌|新建品牌/ }))
          .first();
        await expect(createBtn).toBeVisible();
        await createBtn.click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.getByLabel(/品牌名称/).fill(`极光智储${tag}`);
        await dialog.getByLabel(/所属品类/).fill('私有云 NAS');
        await dialog.getByLabel(/官网域名/).fill(`jiguang-${tag}.example`);
        await dialog.getByRole('button', { name: /创建并进入工作区|确认创建|创建/ }).click();

        await expect(page.getByTestId('global-brand-switcher')).toContainText(`极光智储${tag}`);
        await expect(
          page
            .getByTestId('fact-ai-extract-btn')
            .or(page.getByRole('button', { name: /AI.*提炼|一键提炼/ }))
            .first(),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T1-F06-02 Competitor entries persist name, aliases, and domains across API and /brands UI',
    { tag: ['@tier1', '@F6', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06t2');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(
        tenant.accessToken,
        buildCnBrandPayload(tag, {
          markets: [
            {
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: `星曜${tag}`,
              aliases: ['XY4800'],
              ownedDomains: [`xy-${tag}.example`],
              competitors: [
                {
                  name: 'Synology',
                  aliases: ['群晖'],
                  domains: ['synology.example', 'synology-cn.example'],
                },
              ],
            },
          ],
        }),
      );
      expect([200, 201]).toContain(created.status);
      const brandId = created.body!.data.id;

      const fetched = await getBrand(tenant.accessToken, brandId);
      const comp = fetched.body!.data.markets[0].competitors[0];
      expect(comp.name).toBe('Synology');
      expect(comp.aliases).toContain('群晖');
      expect(comp.domains).toEqual(
        expect.arrayContaining(['synology.example', 'synology-cn.example']),
      );

      const { context, page } = await createAuthenticatedContext(browser, tenant);
      try {
        await page.goto(`/brands?brandId=${brandId}&market=CN`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toContainText('Synology');
        await expect(page.locator('body')).toContainText('synology.example');
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T1-F06-03 Auto-generated category-aware seedPrompts match CN Chinese and GLOBAL English without raw placeholders',
    { tag: ['@tier1', '@F6', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06t3');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
      expect([200, 201]).toContain(created.status);

      const cn = created.body!.data.markets.find((m) => m.market === 'CN')!;
      const global = created.body!.data.markets.find((m) => m.market === 'GLOBAL')!;

      expect(cn.seedPrompts.length).toBeGreaterThanOrEqual(3);
      expect(global.seedPrompts.length).toBeGreaterThanOrEqual(3);

      for (const p of cn.seedPrompts) {
        expect(p).toMatch(/[\u4e00-\u9fa5]/);
        expect(p).not.toMatch(/\{brand\}|\{\{category\}\}/i);
      }
      for (const p of global.seedPrompts) {
        expect(p).toMatch(/[A-Za-z]{3,}/);
        expect(p).not.toMatch(/\{brand\}|\{\{category\}\}/i);
      }
    },
  );

  test(
    'T1-F06-04 Inline editing of brand identity and competitor radar on /brands persists immediately',
    { tag: ['@tier1', '@F6', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06t4');
      const tenant = await provisionTenant({ tag });
      const brand = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data;

      const patchRes = await apiRequest<BrandData>(
        'v2',
        'PATCH',
        `/brands/${brand.id}/markets/CN`,
        {
          token: tenant.accessToken,
          body: {
            aliases: [`XY-4800-${tag}`, '静音NAS'],
            ownedDomains: [`xingyaonas-${tag}.example`, `docs-${tag}.example`],
            competitors: [
              {
                name: '极空存储',
                aliases: ['极空Z4'],
                domains: ['jikong.example', 'forum.jikong.example'],
              },
            ],
          },
        },
      );
      expect(patchRes.status).toBe(200);
      expect(patchRes.body?.code).toBe(0);

      const { context, page } = await createAuthenticatedContext(browser, tenant);
      try {
        await page.goto(`/brands?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toContainText(`docs-${tag}.example`);
        await expect(page.locator('body')).toContainText('forum.jikong.example');
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T1-F06-05 Two brands isolate identity and competitors when toggled via global switcher',
    { tag: ['@tier1', '@F6', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06t5');
      const tenant = await provisionTenant({ tag });
      const b1 = (await createBrand(tenant.accessToken, buildCnBrandPayload(`${tag}1`))).body!.data;
      const b2 = (
        await createBrand(
          tenant.accessToken,
          buildCnBrandPayload(`${tag}2`, {
            name: `凌云储能${tag}`,
            category: '便携户外电源',
            markets: [
              {
                market: 'CN',
                locale: 'zh-CN',
                region: 'CN',
                localBrandName: `凌云储能${tag}`,
                ownedDomains: [`lingyun-${tag}.example`],
                competitors: [{ name: '正浩', aliases: ['EcoFlow'], domains: ['ecoflow.example'] }],
              },
            ],
          }),
        )
      ).body!.data;

      const { context, page } = await createAuthenticatedContext(browser, tenant);
      try {
        await page.goto(`/brands?brandId=${b1.id}&market=CN`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toContainText(b1.name);
        await expect(page.locator('body')).not.toContainText('ecoflow.example');

        await switchGlobalBrand(page, b2.name);
        await expect(page.locator('body')).toContainText(`lingyun-${tag}.example`);
        await expect(page.locator('body')).toContainText('ecoflow.example');
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T2-F06-01 Missing required fields or malformed domains rejected with 400 / 40001',
    { tag: ['@tier2', '@F6', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06b1');
      const tenant = await provisionTenant({ tag });

      const emptyName = await createBrand(
        tenant.accessToken,
        buildCnBrandPayload(tag, { name: '' }),
      );
      expect(emptyName.status).toBe(400);
      expect(emptyName.body?.code).toBe(40001);

      const blankCat = await createBrand(
        tenant.accessToken,
        buildCnBrandPayload(tag, { category: '   ' }),
      );
      expect(blankCat.status).toBe(400);
      expect(blankCat.body?.code).toBe(40001);

      const badDomain = await createBrand(tenant.accessToken, {
        name: `BadDom-${tag}`,
        category: 'NAS',
        markets: [
          {
            market: 'CN',
            localBrandName: 'BadDom',
            ownedDomains: ['javascript:alert(1)', 'not a domain!!!'],
          },
        ],
      });
      expect(badDomain.status).toBe(400);
      expect(badDomain.body?.code).toBe(40001);
    },
  );

  test(
    'T2-F06-02 Domain normalization strips HTTPS/WWW/path and deduplicates case-insensitively',
    { tag: ['@tier2', '@F6', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06b2');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, {
        name: `NormDom-${tag}`,
        category: 'NAS',
        markets: [
          {
            market: 'CN',
            localBrandName: `NormDom-${tag}`,
            ownedDomains: ['HTTPS://WWW.Example.COM/blog', 'example.com', 'EXAMPLE.com/docs/'],
            competitors: [
              {
                name: 'CompOne',
                aliases: [],
                domains: ['https://www.Comp.io/pricing/', 'COMP.IO'],
              },
            ],
          },
        ],
      });
      expect([200, 201]).toContain(created.status);
      const market = created.body!.data.markets[0];
      expect(market.ownedDomains).toEqual(['example.com']);
      expect(market.competitors[0].domains).toEqual(['comp.io']);
    },
  );

  test(
    'T2-F06-03 Exceeding 10 competitors or 200-char brand name rejected with 400 / 40001',
    { tag: ['@tier2', '@F6', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06b3');
      const tenant = await provisionTenant({ tag });

      const elevenComps = Array.from({ length: 11 }, (_, idx) => ({
        name: `Comp-${idx + 1}`,
        aliases: [],
        domains: [`comp${idx + 1}.example`],
      }));
      const tooManyComps = await createBrand(tenant.accessToken, {
        name: `ManyComps-${tag}`,
        category: 'NAS',
        markets: [
          {
            market: 'CN',
            localBrandName: 'ManyComps',
            ownedDomains: ['many.example'],
            competitors: elevenComps,
          },
        ],
      });
      expect(tooManyComps.status).toBe(400);
      expect(tooManyComps.body?.code).toBe(40001);

      const longName = await createBrand(
        tenant.accessToken,
        buildCnBrandPayload(tag, { name: 'A'.repeat(201) }),
      );
      expect(longName.status).toBe(400);
      expect(longName.body?.code).toBe(40001);
    },
  );

  test(
    'T2-F06-04 Updating CN market competitors leaves GLOBAL market byte-for-byte intact',
    { tag: ['@tier2', '@F6', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06b4');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
      const brandId = created.body!.data.id;
      const globalBefore = created.body!.data.markets.find((m) => m.market === 'GLOBAL')!;

      const patched = await apiRequest('v2', 'PATCH', `/brands/${brandId}/markets/CN`, {
        token: tenant.accessToken,
        body: {
          competitors: [{ name: '新国内竞品', aliases: ['新竞品'], domains: ['newcn.example'] }],
        },
      });
      expect(patched.status).toBe(200);

      const after = await getBrand(tenant.accessToken, brandId);
      const globalAfter = after.body!.data.markets.find((m) => m.market === 'GLOBAL')!;
      expect(globalAfter.localBrandName).toBe(globalBefore.localBrandName);
      expect(globalAfter.ownedDomains).toEqual(globalBefore.ownedDomains);
      expect(globalAfter.competitors).toEqual(globalBefore.competitors);
    },
  );

  test(
    'T2-F06-05 Cross-tenant read/update/delete/market-enable on /api/v2/brands/:id returns 404',
    { tag: ['@tier2', '@F6', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f06b5');
      const tenantA = await provisionTenant({ tag: `${tag}a` });
      const tenantB = await provisionTenant({ tag: `${tag}b` });
      const brandId = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      const responses = await Promise.all([
        getBrand(tenantB.accessToken, brandId),
        apiRequest('v2', 'PATCH', `/brands/${brandId}`, {
          token: tenantB.accessToken,
          body: { category: 'Other' },
        }),
        apiRequest('v2', 'DELETE', `/brands/${brandId}`, { token: tenantB.accessToken }),
        apiRequest('v2', 'POST', `/brands/${brandId}/markets/GLOBAL`, {
          token: tenantB.accessToken,
          body: { localBrandName: 'X', ownedDomains: ['x.example'] },
        }),
      ]);
      for (const r of responses) {
        expect(r.status).toBe(404);
      }
    },
  );
});

v2Describe(
  'F7: 4 Structured BrandFact Cards + AI Extract + pgvector',
  { tag: ['@F7', '@M2'] },
  () => {
    test(
      'T1-F07-01 Save all 4 BrandFact slots with truthAgreed checkbox attestation (zero 8-clause modal)',
      { tag: ['@tier1', '@F7', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07t1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const saveRes = await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );
        expect(saveRes.status).toBe(200);
        expect(saveRes.body?.code).toBe(0);

        const brandAfter = await getBrand(tenant.accessToken, brandId);
        expect(brandAfter.body!.data.truthAgreementSignedAt).toBeTruthy();

        const facts = extractItems((await listBrandFacts(tenant.accessToken, brandId)).body?.data);
        expect(facts).toHaveLength(4);
        const slots = facts.map((f) => f.slot).sort();
        expect(slots).toEqual(['CASE_STUDIES', 'CREDENTIALS', 'DIFFERENTIATORS', 'PRODUCT_SPECS']);
        for (const f of facts) {
          expect(f.indexStatus).toBe('NONE');
        }

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/brands?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.getByText('核心产品与参数').first()).toBeVisible();
          await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F07-02 AI Fact Extraction from pasted text populates 4 structured cards at 0 points in STRICT mode',
      { tag: ['@tier1', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07t2');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const beforePts = (await getWallet(tenant.accessToken)).body!.data.points;
        const res = await apiRequest<{ facts?: BrandFactData[]; items?: BrandFactData[] }>(
          'v2',
          'POST',
          `/brands/${brandId}/facts/extract`,
          {
            token: tenant.accessToken,
            body: {
              sourceType: 'MANUAL',
              rawText:
                '星曜智储 DXP4800 搭载 Intel N100 处理器、16GB DDR5 内存、双 2.5GbE 网口，满载功耗 42W、噪音 18.5dB，通过 ISO9001 与 3C 认证，服务上海 12 人影视后期团队月省云盘成本 68%。',
            },
          },
        );
        expect([200, 201]).toContain(res.status);
        expect(res.body?.code).toBe(0);
        const extracted = res.body!.data.facts ?? res.body!.data.items ?? [];
        expect(extracted.length).toBeGreaterThanOrEqual(4);
        const slots = new Set(extracted.map((f) => f.slot));
        expect(slots.has('PRODUCT_SPECS')).toBe(true);
        expect(slots.has('DIFFERENTIATORS')).toBe(true);
        expect(slots.has('CREDENTIALS')).toBe(true);
        expect(slots.has('CASE_STUDIES')).toBe(true);

        const afterPts = (await getWallet(tenant.accessToken)).body!.data.points;
        expect(afterPts).toBe(beforePts);
      },
    );

    test(
      'T1-F07-03 AI Fact Extraction from public fixture URL succeeds at 0 points',
      { tag: ['@tier1', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07t3');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const res = await apiRequest<{ facts?: BrandFactData[]; items?: BrandFactData[] }>(
          'v2',
          'POST',
          `/brands/${brandId}/facts/extract`,
          {
            token: tenant.accessToken,
            body: {
              sourceType: 'URL_EXTRACT',
              url: FIXTURE_URLS.cnProduct,
            },
          },
        );
        expect([200, 201]).toContain(res.status);
        expect(res.body?.code).toBe(0);
        const extracted = res.body!.data.facts ?? res.body!.data.items ?? [];
        expect(extracted.length).toBeGreaterThanOrEqual(4);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T1-F07-04 AI Fact Extraction from uploaded .md product document succeeds with DOC_UPLOAD sourceType',
      { tag: ['@tier1', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07t4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const mdContent = Buffer.from(
          '# 产品规格书\n- 四盘位铝合金机身，Intel N100，42W 满载功耗\n- 通过 ISO9001 认证\n- 客户案例：连续 420 天零宕机\n',
          'utf8',
        );

        const res = await uploadV2Multipart<{ facts?: BrandFactData[]; items?: BrandFactData[] }>(
          `/brands/${brandId}/facts/extract`,
          {
            token: tenant.accessToken,
            filename: 'specs.md',
            contentType: 'text/markdown',
            buffer: mdContent,
            fields: { sourceType: 'DOC_UPLOAD' },
          },
        );
        expect([200, 201]).toContain(res.status);
        expect(res.envelope.code).toBe(0);
        const extracted = res.envelope.data.facts ?? res.envelope.data.items ?? [];
        expect(extracted.length).toBeGreaterThanOrEqual(4);
      },
    );

    test(
      'T1-F07-05 Shared BrandFacts appear identically when switching between CN and GLOBAL markets',
      { tag: ['@tier1', '@F7', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/brands?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.locator('body')).toContainText('18.5dB');
          await switchGlobalMarket(page, 'GLOBAL');
          await expect(page.locator('body')).toContainText('18.5dB');
          await expect(page.locator('body')).toContainText('ISO9001');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F07-01 BrandFact content >6,000 chars triggers async pgvector indexing (INDEXING -> READY)',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const saveRes = await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true, extraDocChars: 7500 }),
        );
        expect(saveRes.status).toBe(200);
        const saved = extractItems(saveRes.body?.data);
        const extraDoc = saved.find((f) => f.slot === 'EXTRA_DOC');
        expect(extraDoc).toBeTruthy();
        expect(['INDEXING', 'READY']).toContain(extraDoc!.indexStatus);

        const ready = await pollUntil(
          async () => {
            const list = extractItems(
              (await listBrandFacts(tenant.accessToken, brandId)).body?.data,
            );
            return list.find((f) => f.slot === 'EXTRA_DOC');
          },
          (item) => item?.indexStatus === 'READY',
          { timeoutMs: 30_000, intervalMs: 500, label: 'BrandFact EXTRA_DOC READY' },
        );
        expect(ready?.indexStatus).toBe('READY');
      },
    );

    test(
      'T2-F07-02 BrandFact content <=6,000 chars (5,900 chars) stays indexStatus NONE',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const saveRes = await saveBrandFacts(tenant.accessToken, brandId, {
          truthAgreed: true,
          facts: [
            {
              slot: 'EXTRA_DOC',
              title: 'Boundary 5900',
              content: buildSizedFactText(5900, tag),
              sourceType: 'MANUAL',
            },
          ],
        });
        expect(saveRes.status).toBe(200);
        const items = extractItems((await listBrandFacts(tenant.accessToken, brandId)).body?.data);
        expect(items[0].indexStatus).toBe('NONE');
      },
    );

    test(
      'T2-F07-03 Missing truthAgreed checkbox attestation blocks initial fact save with 400 / 40001',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const res = await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: false }),
        );
        expect(res.status).toBe(400);
        expect(res.body?.code).toBe(40001);
      },
    );

    test(
      'T2-F07-04 Unsupported .exe file upload on fact extract rejected cleanly with 400/413',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const mzPayload = Buffer.from('MZ\x90\x00binary-executable-payload', 'binary');
        const res = await uploadV2Multipart(`/brands/${brandId}/facts/extract`, {
          token: tenant.accessToken,
          filename: 'malware.exe',
          contentType: 'application/x-msdownload',
          buffer: mzPayload,
          fields: { sourceType: 'DOC_UPLOAD' },
        });
        expect([400, 413, 415]).toContain(res.status);
        expect(res.envelope.code).not.toBe(0);
      },
    );

    test(
      'T2-F07-05 SSRF private-IP, loopback, metadata IP, and file:// URLs blocked on fact extract',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        for (const blockedUrl of SSRF_BLOCKED_URLS) {
          const res = await apiRequest('v2', 'POST', `/brands/${brandId}/facts/extract`, {
            token: tenant.accessToken,
            body: { sourceType: 'URL_EXTRACT', url: blockedUrl },
          });
          expect(res.status, `Expected SSRF block (400) for ${blockedUrl}`).toBe(400);
          expect(res.body?.code).not.toBe(0);
        }
      },
    );

    test(
      'T2-F07-06 Free-action rate-limiting enforced on brand_fact_extract (429) at 0 points',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b6');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        let hit429 = false;
        for (let i = 0; i < 40; i += 1) {
          const res = await apiRequest('v2', 'POST', `/brands/${brandId}/facts/extract`, {
            token: tenant.accessToken,
            body: {
              sourceType: 'MANUAL',
              rawText: `星曜测试参数段落 ${i}：48TB 容量，18.5dB 静音。`,
            },
          });
          if (res.status === 429) {
            hit429 = true;
            expect(res.body?.code).not.toBe(0);
            break;
          }
        }
        expect(hit429, 'Expected free-action rate limit (429) to trigger on burst').toBe(true);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T2-F07-07 Cross-tenant BrandFact read/write/extract returns 404',
      { tag: ['@tier2', '@F7', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f07b7');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandId = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!
          .data.id;

        const [r1, r2, r3] = await Promise.all([
          listBrandFacts(tenantB.accessToken, brandId),
          saveBrandFacts(
            tenantB.accessToken,
            brandId,
            buildFourBrandFactsPayload(tag, { truthAgreed: true }),
          ),
          apiRequest('v2', 'POST', `/brands/${brandId}/facts/extract`, {
            token: tenantB.accessToken,
            body: { sourceType: 'MANUAL', rawText: 'unauthorized' },
          }),
        ]);
        expect(r1.status).toBe(404);
        expect(r2.status).toBe(404);
        expect(r3.status).toBe(404);
      },
    );
  },
);

v2Describe('F8: Single-Level Real Product Photo Manager', { tag: ['@F8', '@M2'] }, () => {
  test(
    'T1-F08-01 Flat PNG upload succeeds with zero category prerequisite and renders thumbnail in /brands',
    { tag: ['@tier1', '@F8', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08t1');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      let mediaId: string | undefined;
      try {
        const up = await uploadBrandMedia(tenant.accessToken, brandId, {
          buffer: buildTestPngBuffer(320, 240),
          filename: 'nas-front.png',
          mime: 'image/png',
          title: `DXP4800 实拍图 ${tag}`,
        });
        expect([200, 201]).toContain(up.status);
        expect(up.body?.code).toBe(0);
        const asset = up.body!.data;
        mediaId = asset.id;
        expect(asset.origin).toBe('PRODUCT_UPLOAD');
        expect(asset.bytes).toBeGreaterThan(0);
        expect(asset.width).toBeGreaterThan(0);
        expect(asset.height).toBeGreaterThan(0);
        expect(asset.url).toBeTruthy();

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/brands?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.locator(`img[alt*="DXP4800 实拍图 ${tag}"]`).first()).toBeVisible();
        } finally {
          await context.close();
        }
      } finally {
        if (mediaId) {
          await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
        }
      }
    },
  );

  test(
    'T1-F08-02 Uploaded JPEG with EXIF marker is processed, EXIF stripped, and thumbnail generated',
    { tag: ['@tier1', '@F8', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08t2');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const jpegWithExif = buildTestJpegWithExifBuffer(FAKE_EXIF_MARKER);
      expect(jpegWithExif.toString('latin1')).toContain(FAKE_EXIF_MARKER);

      let mediaId: string | undefined;
      try {
        const up = await uploadBrandMedia(tenant.accessToken, brandId, {
          buffer: jpegWithExif,
          filename: 'camera-gps.jpg',
          mime: 'image/jpeg',
          title: 'EXIF Strip Check',
        });
        expect([200, 201]).toContain(up.status);
        const asset = up.body!.data;
        mediaId = asset.id;

        const imgRes = await fetch(new URL(asset.url, apiV2Base()).toString());
        expect(imgRes.status).toBe(200);
        const storedBytes = Buffer.from(await imgRes.arrayBuffer());
        expect(storedBytes.toString('latin1')).not.toContain(FAKE_EXIF_MARKER);
        expect(storedBytes.toString('latin1')).not.toContain('Exif\0\0');

        expect(asset.thumbUrl, 'Expected thumbnail URL to be generated').toBeTruthy();
        const thumbRes = await fetch(new URL(asset.thumbUrl!, apiV2Base()).toString());
        expect(thumbRes.status).toBe(200);
        expect((thumbRes.headers.get('content-type') ?? '').startsWith('image/')).toBe(true);
      } finally {
        if (mediaId) {
          await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
        }
      }
    },
  );

  test(
    'T1-F08-03 Editing product photo Alt text persists via API and renders <img alt="..."> in /brands',
    { tag: ['@tier1', '@F8', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08t3');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      let mediaId: string | undefined;
      try {
        const up = await uploadBrandMedia(tenant.accessToken, brandId, {
          buffer: buildTestPngBuffer(120, 90),
          filename: 'panel.png',
          mime: 'image/png',
          title: 'Initial Alt',
        });
        expect([200, 201]).toContain(up.status);
        mediaId = up.body!.data.id;

        const newAlt = `DXP4800 4-bay NAS aluminum front panel ${tag}`;
        const patch = await apiRequest<BrandMediaData>(
          'v2',
          'PATCH',
          `/brands/${brandId}/media/${mediaId}`,
          {
            token: tenant.accessToken,
            body: { title: newAlt },
          },
        );
        expect(patch.status).toBe(200);
        expect(patch.body?.data.title).toBe(newAlt);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/brands?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.locator(`img[alt="${newAlt}"]`).first()).toBeVisible();
        } finally {
          await context.close();
        }
      } finally {
        if (mediaId) {
          await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
        }
      }
    },
  );

  test(
    'T1-F08-04 Real product photos are shared identically across CN and GLOBAL markets',
    { tag: ['@tier1', '@F8', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08t4');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
        .body!.data.id;

      let mediaId: string | undefined;
      try {
        const alt = `Shared Chassis ${tag}`;
        const up = await uploadBrandMedia(tenant.accessToken, brandId, {
          buffer: buildTestPngBuffer(120, 90),
          filename: 'shared.png',
          mime: 'image/png',
          title: alt,
        });
        expect([200, 201]).toContain(up.status);
        mediaId = up.body!.data.id;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/brands?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.locator(`img[alt="${alt}"]`).first()).toBeVisible();
          await switchGlobalMarket(page, 'GLOBAL');
          await expect(page.locator(`img[alt="${alt}"]`).first()).toBeVisible();
        } finally {
          await context.close();
        }
      } finally {
        if (mediaId) {
          await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
        }
      }
    },
  );

  test(
    'T1-F08-05 Deleting a product photo removes it cleanly from API list and /brands DOM',
    { tag: ['@tier1', '@F8', '@M2'] },
    async ({ browser }, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08t5');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      const alt = `DeleteMe ${tag}`;
      const up = await uploadBrandMedia(tenant.accessToken, brandId, {
        buffer: buildTestPngBuffer(80, 80),
        filename: 'del.png',
        mime: 'image/png',
        title: alt,
      });
      expect([200, 201]).toContain(up.status);
      const mediaId = up.body!.data.id;

      const del = await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
      expect(del.status).toBe(200);
      expect(del.body?.code).toBe(0);

      const listed = await apiRequest<{ items?: BrandMediaData[] } | BrandMediaData[]>(
        'v2',
        'GET',
        `/brands/${brandId}/media`,
        { token: tenant.accessToken },
      );
      expect(extractItems(listed.body?.data).some((m) => m.id === mediaId)).toBe(false);

      const { context, page } = await createAuthenticatedContext(browser, tenant);
      try {
        await page.goto(`/brands?brandId=${brandId}&market=CN`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(`img[alt="${alt}"]`)).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T2-F08-01 Disguised non-image payload (<svg onload=alert(1)>) uploaded as evil.png is rejected',
    { tag: ['@tier2', '@F8', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08b1');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      const res = await uploadBrandMedia(tenant.accessToken, brandId, {
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8'),
        filename: 'evil.png',
        mime: 'image/png',
        title: 'Evil',
      });
      expect(res.status).toBe(400);
      expect(res.body?.code).not.toBe(0);

      const listed = await apiRequest<{ items?: BrandMediaData[] } | BrandMediaData[]>(
        'v2',
        'GET',
        `/brands/${brandId}/media`,
        { token: tenant.accessToken },
      );
      expect(extractItems(listed.body?.data)).toHaveLength(0);
    },
  );

  test(
    'T2-F08-02 Oversized upload (>100MB streamed multipart) rejected cleanly with 413/400',
    { tag: ['@tier2', '@F8', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08b2');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      const res = await streamOversizedMultipartUpload(
        `/brands/${brandId}/media`,
        tenant.accessToken,
        100 * 1024 * 1024 + 4096,
      );
      expect([400, 413]).toContain(res.status);

      const listed = await apiRequest<{ items?: BrandMediaData[] } | BrandMediaData[]>(
        'v2',
        'GET',
        `/brands/${brandId}/media`,
        { token: tenant.accessToken },
      );
      expect(extractItems(listed.body?.data)).toHaveLength(0);
    },
  );

  test(
    'T2-F08-03 Empty multipart payload without file part rejected with 400 / 40001',
    { tag: ['@tier2', '@F8', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08b3');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      const res = await apiRequest('v2', 'POST', `/brands/${brandId}/media`, {
        token: tenant.accessToken,
        body: { title: 'No file here' },
      });
      expect(res.status).toBe(400);
      expect(res.body?.code).toBe(40001);
    },
  );

  test(
    'T2-F08-04 Cross-brand media delete within same tenant returns 404 and leaves Brand 2 intact',
    { tag: ['@tier2', '@F8', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08b4');
      const tenant = await provisionTenant({ tag });
      const b1 = (await createBrand(tenant.accessToken, buildCnBrandPayload(`${tag}1`))).body!.data
        .id;
      const b2 = (await createBrand(tenant.accessToken, buildCnBrandPayload(`${tag}2`))).body!.data
        .id;

      let b2MediaId: string | undefined;
      try {
        const up = await uploadBrandMedia(tenant.accessToken, b2, {
          buffer: buildTestPngBuffer(64, 64),
          filename: 'b2.png',
          mime: 'image/png',
          title: 'B2 Photo',
        });
        expect([200, 201]).toContain(up.status);
        b2MediaId = up.body!.data.id;

        const crossDel = await deleteBrandMedia(tenant.accessToken, b1, b2MediaId);
        expect(crossDel.status).toBe(404);

        const b2List = await apiRequest<{ items?: BrandMediaData[] } | BrandMediaData[]>(
          'v2',
          'GET',
          `/brands/${b2}/media`,
          { token: tenant.accessToken },
        );
        expect(extractItems(b2List.body?.data).some((m) => m.id === b2MediaId)).toBe(true);
      } finally {
        if (b2MediaId) {
          await deleteBrandMedia(tenant.accessToken, b2, b2MediaId);
        }
      }
    },
  );

  test(
    'T2-F08-05 Cross-tenant media upload, list, and delete return 404',
    { tag: ['@tier2', '@F8', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f08b5');
      const tenantA = await provisionTenant({ tag: `${tag}a` });
      const tenantB = await provisionTenant({ tag: `${tag}b` });
      const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;

      let mediaA: string | undefined;
      try {
        const upA = await uploadBrandMedia(tenantA.accessToken, brandA, {
          buffer: buildTestPngBuffer(64, 64),
          filename: 'a.png',
          mime: 'image/png',
          title: 'A Photo',
        });
        mediaA = upA.body!.data.id;

        const listAsB = await apiRequest('v2', 'GET', `/brands/${brandA}/media`, {
          token: tenantB.accessToken,
        });
        const uploadAsB = await uploadBrandMedia(tenantB.accessToken, brandA, {
          buffer: buildTestPngBuffer(64, 64),
          filename: 'b.png',
          mime: 'image/png',
          title: 'B Intruder',
        });
        const delAsB = await deleteBrandMedia(tenantB.accessToken, brandA, mediaA);

        expect(listAsB.status).toBe(404);
        expect(uploadAsB.status).toBe(404);
        expect(delAsB.status).toBe(404);
      } finally {
        if (mediaA) {
          await deleteBrandMedia(tenantA.accessToken, brandA, mediaA);
        }
      }
    },
  );
});
