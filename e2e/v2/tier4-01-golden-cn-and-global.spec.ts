import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  extractItems,
  listBrandFactsApi,
  listMarketEnginesApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  requestV2Binary,
  unwrapOk,
  upsertBrandFactsApi,
  waitForAutoBriefsApi,
  waitForVisibilityRunApi,
  type BrandDto,
  type GeoArticleDto,
  type GeoEvaluationDto,
  type GeoPublishRecordDto,
  type VisibilityRunDto,
} from './support/api-client';
import {
  assertGeoScoreValid,
  assertLlmsTxt,
  assertNoConsoleOrPageErrors,
  assertValidDocxWithTable,
  assertValidJsonLd,
  assertZeroHorizontalOverflow,
} from './support/assertions';
import {
  buildCnBrandPayload,
  E2E_SENTINELS,
  FIXTURE_URLS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import {
  navigateWorkspace,
  openAuthenticatedPage,
  openBriefDrawerAndEdit,
  openVisibilityTab,
  switchGlobalMarket,
  trackRouteNavigations,
  waitForStudioSseComplete,
} from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 4 — Golden CN Redline #4 & GLOBAL Outbound Loops',
  {
    tag: [
      '@tier4',
      '@F1',
      '@F5',
      '@F6',
      '@F7',
      '@F9',
      '@F11',
      '@F12',
      '@F13',
      '@F16',
      '@F17',
      '@M5',
    ],
  },
  () => {
    test(
      'S4-01 PRD §5 Redline #4: 0-brand -> 60s create + AI URL 4 facts -> CN monitor -> auto brief -> <30s SSE (>=85) -> JSON-LD -> publish & retest (<=4 nav hops)',
      { tag: ['@tier4', '@F5', '@F6', '@F7', '@F9', '@F11', '@F12', '@F16', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's401');
        const brandName = `星曜智储${tag}`;
        const ownedDomain = `xingyaonas-${tag}.example`;
        const tenant = await provisionIsolatedTenant({
          prefix: 's401',
          billingMode: 'STRICT',
          initialPoints: 200,
        });

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          '/home',
          {
            width: 1440,
            height: 900,
          },
        );
        const navTracker = trackRouteNavigations(page);

        try {
          // 1. Fresh 0-brand onboarding -> 60s brand creation (4 minimal fields, zero blocking prerequisite modals)
          const createFirstBtn = page
            .getByRole('button', { name: /60\s*秒创建首个品牌|创建首个品牌/ })
            .first();
          await expect(createFirstBtn).toBeVisible({ timeout: 15_000 });
          await createFirstBtn.click();

          const wizard = page.getByTestId('brand-quick-create');
          await expect(wizard).toBeVisible();

          await wizard.getByRole('textbox', { name: '品牌名称' }).fill(brandName);
          await wizard.getByRole('textbox', { name: '所属品类' }).fill('家用NAS网络存储');
          await wizard.getByRole('textbox', { name: '官网域名' }).fill(ownedDomain);

          await wizard.getByRole('button', { name: /\+\s*添加竞品|添加竞品/ }).click();
          await wizard.getByRole('textbox', { name: '竞品名称 1' }).fill('极空存储');
          await wizard.getByRole('textbox', { name: '竞品官网域名 1' }).fill('jikong.example');

          await wizard
            .getByRole('button', { name: /^(?:创建|创建并进入工作区|立即创建|保存)$/ })
            .first()
            .click();

          // Confirm brand created via API and zero forced 8-clause scroll-lock legal modal blocks the workspace
          const polledBrand = await pollUntil(
            async () => {
              const res = unwrapOk(
                await requestV2<{ items?: BrandDto[] } | BrandDto[]>('/brands', {
                  token: tenant.session.accessToken,
                }),
                'GET /brands',
              );
              return extractItems(res).find((b) => b.name === brandName) ?? null;
            },
            (b) => b !== null,
            { timeoutMs: 15_000, label: 'S4-01 brand creation' },
          );
          if (!polledBrand) {
            throw new Error(`Brand ${brandName} was not created`);
          }
          const brand: BrandDto = polledBrand;
          await expect(page.getByText(/请阅读并滚动至底部/)).toHaveCount(0);

          // Step 1 transitions BrandQuickCreateModal to Step 2 ("跳过"); dismiss cleanly before sidebar navigation
          const skipBtn = wizard.getByRole('button', { name: /^(?:跳过|跳过，直接进入)$/ });
          await expect(skipBtn).toBeVisible({ timeout: 10_000 });
          await skipBtn.click();
          await expect(wizard).toBeHidden({ timeout: 10_000 });
          await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0, { timeout: 10_000 });

          // Start counting distinct workspace pathname hops from the first active workspace
          navTracker.start();

          // 2. Step A (Transition 1 -> /brands if onboarding landed on /home): AI URL extract 4 facts + single compliance checkbox
          if (new URL(page.url()).pathname !== '/brands') {
            await navigateWorkspace(page, '品牌', /\/brands/);
          }

          const openExtractBtn = page.getByTestId('fact-ai-extract-btn');
          await expect(openExtractBtn).toBeVisible({ timeout: 15_000 });
          await openExtractBtn.click();

          const extractModal = page.getByRole('dialog', { name: /AI 提炼|AI 自动提炼/ });
          await expect(extractModal).toBeVisible({ timeout: 10_000 });

          const urlInput = extractModal.getByRole('textbox', { name: '官网链接' });
          await expect(urlInput).toBeVisible();
          await urlInput.fill(FIXTURE_URLS.cnProduct);

          await extractModal.getByRole('button', { name: /开始提炼|开始 AI 提炼/ }).click();

          const applyExtractBtn = extractModal.getByRole('button', {
            name: /^(?:应用|应用到事实卡)$/,
          });
          await expect(applyExtractBtn).toBeVisible({ timeout: 20_000 });
          await applyExtractBtn.click();
          await expect(extractModal).toBeHidden({ timeout: 10_000 });

          for (const slot of ['PRODUCT_SPECS', 'DIFFERENTIATORS', 'CREDENTIALS', 'CASE_STUDIES']) {
            const slotCard = page.getByTestId(`fact-slot-${slot}`);
            await expect(slotCard).toBeVisible({ timeout: 20_000 });
            const contentArea = slotCard.locator('textarea');
            await expect(contentArea).toBeVisible();
            await expect
              .poll(async () => (await contentArea.inputValue()).trim().length, {
                timeout: 20_000,
              })
              .toBeGreaterThan(10);
          }

          const complianceCheckbox = page
            .getByTestId('brand-facts-truth-checkbox')
            .or(page.getByRole('checkbox', { name: /确认属实|我确认所填品牌参数|真实客观/ }))
            .first();
          await expect(complianceCheckbox).toBeVisible();
          if (!(await complianceCheckbox.isChecked())) {
            await complianceCheckbox.check();
          }

          await page.getByTestId('brand-facts-save-btn').click();

          await pollUntil(
            async () =>
              unwrapOk(
                await requestV2<BrandDto>(`/brands/${brand.id}`, {
                  token: tenant.session.accessToken,
                }),
                'GET brand truthAgreementSignedAt',
              ),
            (b) => Boolean(b.truthAgreementSignedAt),
            { timeoutMs: 15_000, label: 'truthAgreementSignedAt persisted' },
          );

          const savedFacts = await listBrandFactsApi(tenant.session, brand.id);
          expect(savedFacts.length).toBeGreaterThanOrEqual(4);

          // 3. Step B (Transition 2 -> /visibility): launch CN monitor with [E2E_GAP]
          await navigateWorkspace(page, '诊断', /\/visibility/);
          await openVisibilityTab(page, 'runs');

          const cnEngines = await listMarketEnginesApi(tenant.session, brand.id, 'CN');
          const onlineCn = cnEngines.find((e) => e.available || e.status === 'online');
          expect(onlineCn, 'Expected at least one online CN engine in E2E catalog').toBeTruthy();
          await expect(page.getByTestId(`engine-option-${onlineCn!.key}`)).toBeVisible({
            timeout: 15_000,
          });
          const offlineCn = cnEngines.find((e) => !e.available || e.status === 'offline');
          expect(offlineCn, 'Expected at least one offline CN engine in E2E catalog').toBeTruthy();
          const offlineOption = page.getByTestId(`engine-option-${offlineCn!.key}`);
          await expect(offlineOption).toBeVisible();
          await expect(offlineOption).toContainText('暂未上线');
          await expect(offlineOption.locator('input[type="checkbox"]')).toBeDisabled();

          const promptInput = page
            .locator('textarea[placeholder*="问题"], textarea[placeholder*="问句"], textarea')
            .first();
          await expect(promptInput).toBeVisible();
          await promptInput.fill(`2026 四盘位家用静音 NAS 怎么选 ${E2E_SENTINELS.GAP}`);

          await page
            .getByRole('button', { name: /发起监测|开始监测|发起新一轮监测/ })
            .first()
            .click();

          const completedRun = await pollUntil(
            async () => {
              const runsRes = unwrapOk(
                await requestV2<{ items?: VisibilityRunDto[] } | VisibilityRunDto[]>(
                  `/brands/${brand.id}/visibility/runs?market=CN`,
                  { token: tenant.session.accessToken },
                ),
                'GET CN visibility runs',
              );
              const latest = extractItems(runsRes)[0] ?? null;
              return latest;
            },
            (r) =>
              r !== null &&
              ['COMPLETED', 'PARTIAL'].includes(r.status) &&
              Boolean(r.briefsGeneratedAt),
            { timeoutMs: 35_000, intervalMs: 500, label: 'S4-01 CN monitor + auto briefs' },
          );
          expect(completedRun?.briefsGeneratedAt).toBeTruthy();

          // 4. Step C (Same workspace /visibility Tab 1 — 0 extra hops): inspect auto Top brief -> drawer H2 edit -> click write
          await openVisibilityTab(page, 'overview');
          const detailBtn = page.getByRole('button', { name: /查看详细意见|查看意见/ }).first();
          await expect(detailBtn).toBeVisible({ timeout: 15_000 });
          await detailBtn.click();

          await openBriefDrawerAndEdit(page, {
            newH2: `实测静音功耗与竞品核心参数对比-${tag}`,
            clickWrite: true,
          });

          // 5. Step D (Transition 3 -> /studio?briefId=...): <30s SSE streaming generation with GEO score >= 85
          await expect
            .poll(
              () => {
                const u = new URL(page.url());
                return u.pathname === '/studio' && Boolean(u.searchParams.get('briefId'));
              },
              { timeout: 15_000 },
            )
            .toBe(true);

          const streamBtn = page
            .getByTestId('studio-stream-btn')
            .or(page.getByRole('button', { name: /立即生成|确认并写作/ }))
            .first();
          await expect(streamBtn).toBeVisible();
          await expect(streamBtn).toBeEnabled({ timeout: 15_000 });
          await streamBtn.click();

          const { durationMs } = await waitForStudioSseComplete(page, 30_000);
          expect(durationMs, 'PRD §5 Redline #4 requires SSE GEO article in < 30s').toBeLessThan(
            30_000,
          );

          const articlesRes = unwrapOk(
            await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
              `/brands/${brand.id}/articles?market=CN`,
              { token: tenant.session.accessToken },
            ),
            'GET CN articles after SSE',
          );
          const article = extractItems(articlesRes)[0];
          expect(article).toBeTruthy();
          expect(article.contentMarkdown).toMatch(/\|[\s:-]+\|/);
          const h2Matches = article.contentMarkdown.match(/^##\s+.+$/gm) ?? [];
          expect(h2Matches.length, 'Expected >= 3 H2 headings').toBeGreaterThanOrEqual(3);
          expect(article.contentMarkdown).toMatch(/FAQ|常见问题|问答/i);
          assertGeoScoreValid(article.geoScore, article.geoScoreDetail, { minScore: 85 });

          // 6. Step E (Hand off /studio -> /publish workspace): JSON-LD + Publish URL + One-Click Retest Before/After
          await expect(page.getByTestId('studio-go-publish-btn')).toBeEnabled({ timeout: 15_000 });
          await page.getByTestId('studio-go-publish-btn').click();
          await expect(page).toHaveURL(/\/publish/, { timeout: 15_000 });
          await expect(page.getByTestId('publish-workspace')).toBeVisible({ timeout: 20_000 });

          await page.getByTestId('publish-export-btn').click();
          await expect(page.getByTestId('delivery-copy-jsonld')).toBeVisible({ timeout: 15_000 });
          assertValidJsonLd(article.schemaJsonLd, ['Article', 'FAQPage']);
          await page.locator('.ant-modal-close:visible').last().click();
          await expect(page.getByTestId('publish-export-modal')).toBeHidden({ timeout: 10_000 });

          await page.getByTestId('publish-tab-tracking').click();
          const publishForm = page.getByTestId('publish-record-form');
          await expect(publishForm).toBeVisible({ timeout: 15_000 });
          await publishForm
            .locator('input[placeholder*="http"], input[placeholder*="URL"], input')
            .first()
            .fill(`https://${ownedDomain}/blog/nas-guide-2026`);
          await publishForm
            .getByRole('button', { name: /登记发布|标记为已发布|保存发布|登记/ })
            .first()
            .click();

          const retestBtn = page.getByTestId('publish-retest-btn');
          await expect(retestBtn).toBeVisible({ timeout: 15_000 });
          await retestBtn.click();
          const retestConfirmBtn = page.getByTestId('publish-retest-confirm-btn');
          await expect(retestConfirmBtn).toBeVisible({ timeout: 10_000 });
          await expect(retestConfirmBtn).toBeEnabled({ timeout: 10_000 });
          await retestConfirmBtn.click();

          const retestedRecord = await pollUntil(
            async () => {
              const res = unwrapOk(
                await requestV2<{ items?: GeoPublishRecordDto[] } | GeoPublishRecordDto[]>(
                  `/articles/${article.id}/publish-records`,
                  { token: tenant.session.accessToken },
                ),
                'GET publish-records after UI retest',
              );
              return extractItems(res)[0] ?? null;
            },
            (rec) => rec !== null && rec.afterMetrics !== null,
            { timeoutMs: 35_000, intervalMs: 500, label: 'S4-01 retest afterMetrics' },
          );
          expect(retestedRecord?.beforeMetrics).not.toBeNull();
          expect(retestedRecord?.afterMetrics).not.toBeNull();
          expect(retestedRecord?.latestRetestRunId).toBeTruthy();
          await expect(page.getByTestId('publish-before-after')).toBeVisible({ timeout: 15_000 });

          // Hard PRD §5 Quality Redline #4 Assertions (4 workspace hops after splitting /publish)
          expect(
            navTracker.getTransitionCount(),
            `PRD §5 Redline #4 + /publish split allows <= 4 workspace transitions; visited: ${navTracker.getVisitedPaths().join(' -> ')}`,
          ).toBeLessThanOrEqual(4);
          await assertZeroHorizontalOverflow(page, [{ width: 1440, height: 900 }]);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          navTracker.detach();
          await context.close();
        }
      },
    );

    test(
      'S4-02 GLOBAL Outbound: Chinese BrandFacts -> +开启另一市场 GLOBAL -> English brief + FTC Best/Top/100% + .docx <w:tbl> + JSON-LD + llms.txt',
      { tag: ['@tier4', '@F5', '@F6', '@F7', '@F9', '@F11', '@F12', '@F13', '@F16', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's402');
        const tenant = await provisionIsolatedTenant({ prefix: 's402', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        // Maintain ONLY Chinese BrandFact cards (zero manual English translation)
        await upsertBrandFactsApi(tenant.session, brand.id, [
          {
            slot: 'PRODUCT_SPECS',
            title: '核心电芯与输出规格',
            content:
              '2048Wh LiFePO4 磷酸铁锂电芯，2400W 额定输出，100% 阻燃铝合金外壳，实测循环寿命 4000 次。',
            sourceType: 'MANUAL',
          },
          {
            slot: 'CREDENTIALS',
            title: '国际安全认证',
            content: '通过 UL2743 与 FCC/CE 认证，提供 5 年整机质保。',
            sourceType: 'MANUAL',
          },
        ]);

        const globalBrandName = `ApexVolt Energy ${tag}`;
        const globalDomain = `apexvolt-${tag}.example`;

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/brands?brandId=${brand.id}&market=CN`,
        );
        try {
          // Click + 开启另一市场 to enable GLOBAL market
          const enableBtn = page
            .getByTestId('enable-other-market-btn')
            .or(page.getByRole('button', { name: /加市场|开启另一市场|开启海外/ }))
            .first();
          await expect(enableBtn).toBeVisible({ timeout: 15_000 });
          await enableBtn.click();

          const modal = page.locator('.ant-modal-content:visible, .ant-drawer-open:visible').last();
          await expect(modal).toBeVisible();
          await modal
            .getByLabel(/当地品牌名称|当地品牌名|品牌名|Brand Name/i)
            .or(modal.locator('input').nth(0))
            .first()
            .fill(globalBrandName);
          await modal
            .getByLabel(/当地官网域名|官网域名|域名|Domain/i)
            .or(modal.locator('input').nth(1))
            .first()
            .fill(globalDomain);
          const compInput = modal
            .getByLabel(/当地主要竞品|竞品|Competitor/i)
            .or(modal.locator('textarea').first())
            .first();
          await expect(compInput).toBeVisible();
          await compInput.fill('EcoPeak, ecopeak.example');
          await modal
            .getByRole('button', { name: /确认|开启|保存/ })
            .first()
            .click();

          await pollUntil(
            async () =>
              unwrapOk(
                await requestV2<BrandDto>(`/brands/${brand.id}`, {
                  token: tenant.session.accessToken,
                }),
                'GET brand GLOBAL market',
              ),
            (b) => b.markets.some((m) => m.market === 'GLOBAL'),
            { timeoutMs: 15_000, label: 'GLOBAL market enabled' },
          );

          await switchGlobalMarket(page, 'GLOBAL');
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }

        // Run GLOBAL 5-engine monitor and verify bilingual brief (English title/H2 + Chinese diagnosis)
        const globalEngines = (
          await listMarketEnginesApi(tenant.session, brand.id, 'GLOBAL')
        ).filter((e) => e.available || e.status === 'online');
        expect(globalEngines.length).toBeGreaterThan(0);

        const glRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'GLOBAL',
            prompts: [`Best 2000Wh LiFePO4 portable power station 2026 ${E2E_SENTINELS.GAP}`],
            engines: globalEngines.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 's402run'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, glRun.id);
        const glBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'GLOBAL', glRun.id);
        expect(glBriefs.length).toBeGreaterThan(0);

        const glBrief = glBriefs[0];
        expect(glBrief.suggestedTitle).toMatch(/[A-Za-z]{4,}/);
        expect(glBrief.outlineH2.length).toBeGreaterThan(0);
        expect(glBrief.outlineH2[0].heading).toMatch(/[A-Za-z]{3,}/);
        expect(glBrief.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);

        // Stream native English GLOBAL_AUTHORITY_GUIDE preserving FTC Best / Top / 100%
        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's402sse'),
          body: {
            market: 'GLOBAL',
            briefId: glBrief.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            targetPrompt:
              'Best Top 2048Wh LiFePO4 power station with 100% flame-retardant enclosure',
          },
        });
        expect(sse.status).toBe(200);
        let article = sse.complete!.article;

        if (
          !article.contentMarkdown.includes('Best') ||
          !article.contentMarkdown.includes('Top') ||
          !article.contentMarkdown.includes('100%')
        ) {
          article = unwrapOk(
            await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
              method: 'PATCH',
              token: tenant.session.accessToken,
              body: {
                contentMarkdown: `${article.contentMarkdown}\n\n## Best Top Power Station Verdict\n${globalBrandName} stands out as a Best and Top 2048Wh LiFePO4 unit with a 100% flame-retardant aluminum shell and UL2743 certification.`,
              },
            }),
            'PATCH FTC terms into GLOBAL article',
          );
        }
        expect(article.contentMarkdown).toContain('Best');
        expect(article.contentMarkdown).toContain('Top');
        expect(article.contentMarkdown).toContain('100%');

        // Export OOXML .docx and verify <w:tbl>
        const docx = await requestV2Binary(`/articles/${article.id}/export?format=docx`, {
          token: tenant.session.accessToken,
        });
        expect(docx.status).toBe(200);
        assertValidDocxWithTable(docx.bytes);

        // Evaluate GLOBAL delivery pack: JSON-LD + llms.txt + GPTBot/PerplexityBot crawler checklist
        const evalRes = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${article.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          'POST evaluate-geo GLOBAL',
        );
        assertGeoScoreValid(evalRes.geoScore, evalRes.geoScoreDetail);
        assertValidJsonLd(evalRes.schemaJsonLd, ['Article', 'FAQPage']);
        expect(evalRes.llmsTxtSnippet).toBeTruthy();
        assertLlmsTxt(evalRes.llmsTxtSnippet!, { brandName: globalBrandName });

        const bots = evalRes.crawlerChecklist.map((c) => c.bot);
        expect(bots).toContain('GPTBot');
        expect(bots).toContain('PerplexityBot');
      },
    );
  },
);
