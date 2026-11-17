import { expect, test } from '@playwright/test';
import {
  activePane,
  buildTestPngBuffer,
  injectSessionBeforeLoad,
  mintSessionTokens,
  openMenuLink,
  saveGeoMixScreenshot,
  selectAntdMultipleOption,
  selectOptionByText,
} from './support/helpers';

test.describe('GeoMix 商户全链路端到端验收 (#23)', () => {
  test('M01–M09: 登录 → 图库 → 主词蒸馏 → 签协议建知识库 → 克隆指令 → 写作任务 → 审核导出 → 复刻 → 明细与权益核对', async ({
    browser,
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    const retryTag =
      testInfo.retry > 0 ? (['二组', '三组', '四组'][testInfo.retry - 1] ?? '复测') : '';
    const galleryName = `工业激光实拍图库${retryTag}`;
    const mainKeyword = `光纤激光切割机${retryTag}`;
    const kbName = `激光事业部知识库${retryTag}`;
    const clonedPromptName = `自定义·激光方案公平对照${retryTag}`;
    const writingTaskName = `春季激光选型科普任务${retryTag}`;
    const batchRewriteName = `钣金保养批量复刻${retryTag}`;
    const urlQuery = testInfo.retry > 0 ? `?retry=${testInfo.retry}` : '';

    // =========================================================================
    // M01: 未登录重定向守卫与登录页结构 -> 注入合法会话进入 /dashboard
    // =========================================================================
    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto('/dashboard');
    await expect(anonymousPage).toHaveURL(/\/login\?next=%2Fdashboard/);
    await expect(anonymousPage.getByText('GeoMix 登录')).toBeVisible();
    await expect(anonymousPage.getByRole('img', { name: '验证码' })).toBeVisible();
    await expect(anonymousPage.getByRole('button', { name: '换一张' })).toBeVisible();
    await saveGeoMixScreenshot(anonymousPage, '01-login.png');
    await anonymousContext.close();

    const demoTokens = mintSessionTokens('demo');
    await injectSessionBeforeLoad(page, demoTokens);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard$/);

    const header = page.locator('header.gm-header');
    await expect(header).toContainText('GeoMix');
    await expect(header.locator('.gm-mode')).toHaveText('多标签');

    const pane = activePane(page);
    await expect(pane.getByTestId('dashboard-trend-svg')).toBeVisible();
    await expect(pane.getByText('AI数据', { exact: false }).first()).toBeVisible();
    await expect(pane.getByText('AI可见度诊断', { exact: false }).first()).toBeVisible();
    await expect(pane.getByText('即将上线').first()).toBeVisible();
    await saveGeoMixScreenshot(page, '02-dashboard.png');

    // =========================================================================
    // M02: 企业画像图库新建分类 -> 上传实拍图 -> 返回上一级实时刷新缩略图与计数 (#71)
    // =========================================================================
    await openMenuLink(page, {
      submenu: '素材源力',
      itemTitle: '企业画像图库',
      expectedUrl: /\/material\/gallery$/,
    });
    await pane.getByRole('button', { name: '添加', exact: true }).click();

    const catDialog = page.getByRole('dialog', { name: '添加素材分类' });
    await expect(catDialog).toBeVisible();
    await catDialog.getByLabel('分类').fill(galleryName);
    await catDialog.getByRole('button', { name: '确定' }).click();
    await expect(catDialog).toBeHidden();

    const galleryCatRow = pane.locator('tbody tr', { hasText: galleryName });
    await expect(galleryCatRow).toBeVisible();
    await galleryCatRow.getByRole('button', { name: '图片列表' }).first().click();
    await expect(page).toHaveURL(/\/material\/gallery\/.+/);

    await pane.getByRole('button', { name: '添加', exact: true }).click();
    const uploadDialog = page.getByRole('dialog', { name: '添加图片素材' });
    await expect(uploadDialog).toBeVisible();
    await uploadDialog.getByLabel('选择图片文件').setInputFiles({
      name: 'laser-bench.png',
      mimeType: 'image/png',
      buffer: buildTestPngBuffer(600, 400),
    });
    await uploadDialog.getByRole('button', { name: '确定' }).click();
    await expect(uploadDialog.getByText('最近上传成功（1 张）：')).toBeVisible();
    await uploadDialog.getByRole('button', { name: '关闭' }).click();
    await expect(uploadDialog).toBeHidden();

    await pane.getByRole('button', { name: '返回上一级' }).click();
    await expect(page).toHaveURL(/\/material\/gallery$/);
    await expect(pane.locator(`img[alt="${galleryName}缩略图"]`)).toBeVisible();
    await expect(pane.locator('tbody tr', { hasText: galleryName })).toContainText('1');
    await saveGeoMixScreenshot(page, '03-gallery-synced.png');

    // =========================================================================
    // M03: 关键词创建、AI 蒸馏拓展与写作标题列表核对 (#70)
    // =========================================================================
    await openMenuLink(page, {
      submenu: '素材源力',
      itemTitle: '关键词',
      expectedUrl: /\/material\/keywords$/,
    });
    await pane.getByRole('button', { name: '添加', exact: true }).click();

    const kwDialog = page.getByRole('dialog', { name: '添加关键词' });
    await expect(kwDialog).toBeVisible();
    await kwDialog.getByLabel('主关键词').fill(mainKeyword);
    await kwDialog.getByLabel('公司或品牌').fill('智造激光，GeoMix激光');
    await kwDialog.getByRole('button', { name: 'AI蒸馏拓展（10点/次）' }).click();

    const distillConfirm = page.getByRole('dialog', { name: '确认执行 AI 蒸馏拓展' });
    await expect(distillConfirm).toBeVisible();
    await distillConfirm.getByRole('button', { name: '确认蒸馏（10点/次）' }).click();

    const distillPreview = page.getByRole('dialog', { name: /AI蒸馏结果预览/ });
    await expect(distillPreview).toBeVisible();
    await distillPreview.getByRole('button', { name: /^添加到问题框/ }).click();

    await expect(kwDialog.getByLabel('一行一个拓展问题')).toHaveValue(new RegExp(mainKeyword));
    await kwDialog.getByRole('button', { name: '确定' }).click();
    await expect(kwDialog).toBeHidden();

    const kwRow = pane.locator('tbody tr', { hasText: mainKeyword });
    await expect(kwRow).toBeVisible();
    await expect(kwRow).toContainText('未优化');

    await openMenuLink(page, {
      submenu: '素材源力',
      itemTitle: '写作标题',
      expectedUrl: /\/material\/questions$/,
    });
    await expect(pane.getByRole('button', { name: '返回上一级' })).toBeVisible();
    await expect(pane.locator('tbody tr', { hasText: mainKeyword }).first()).toBeVisible();
    await saveGeoMixScreenshot(page, '04-keywords-distilled.png');

    // =========================================================================
    // M04: 签署自写必读承诺协议并创建细分模式企业知识库
    // =========================================================================
    await openMenuLink(page, {
      submenu: '素材源力',
      itemTitle: '企业知识库',
      expectedUrl: /\/material\/knowledge$/,
    });
    await pane.getByRole('button', { name: '添加', exact: true }).click();

    const kbDialog = page.getByRole('dialog', { name: '添加企业知识库' });
    await expect(kbDialog).toBeVisible();

    for (const label of ['产品服务', '产品特点', '用户痛点', '信任背书', '客户案例']) {
      await expect(kbDialog.getByRole('button', { name: `查看说明-${label}` })).toBeVisible();
    }
    await expect(kbDialog.getByRole('button', { name: '查看说明-品牌故事' })).toHaveCount(0);
    await expect(kbDialog.getByRole('button', { name: '查看说明-其他信息' })).toHaveCount(0);

    await kbDialog.getByRole('button', { name: '查看说明-产品服务' }).click();
    const kbHelpModal = page.getByRole('dialog', { name: '预览' });
    await expect(kbHelpModal).toBeVisible();
    await expect(kbHelpModal.getByText('内容：')).toBeVisible();
    await expect(kbHelpModal.getByText('说明：')).toBeVisible();
    await expect(kbHelpModal.getByText('实例：')).toBeVisible();
    await kbHelpModal.getByRole('button', { name: '知道了' }).click();
    await expect(kbHelpModal).toBeHidden();

    await kbDialog.getByRole('button', { name: '查看必读承诺协议' }).click();
    const agreeModal = page.getByRole('dialog', { name: /承诺协议/ });
    await expect(agreeModal).toBeVisible();
    await agreeModal.getByTestId('kb-agreement-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const agreeCheckbox = agreeModal.getByRole('checkbox');
    await expect(agreeCheckbox).toBeEnabled();
    await agreeCheckbox.check();
    await agreeModal.getByRole('button', { name: /确认已阅读/ }).click();
    await expect(agreeModal).toBeHidden();
    await expect(kbDialog.getByText('已签署承诺协议')).toBeVisible();

    await kbDialog.getByLabel('知识库名称').fill(kbName);
    await kbDialog.getByLabel('公司名称').fill('苏州智造激光装备有限公司');
    await kbDialog.getByLabel('品牌简称').fill('智造激光');
    await selectAntdMultipleOption(page, kbDialog, '创作方向', '产品说明');
    await selectAntdMultipleOption(page, kbDialog, '文案类型', '说明文');
    await kbDialog
      .getByRole('textbox', { name: '产品服务' })
      .fill('主营中厚板光纤激光切割装备与自动化上下料产线，支持全套工艺打样与驻厂交付。');
    await kbDialog.getByRole('button', { name: '确定' }).click();
    await expect(kbDialog).toBeHidden();

    await expect(pane.locator('tbody tr', { hasText: kbName })).toBeVisible();
    await saveGeoMixScreenshot(page, '05-knowledge-created.png');

    // =========================================================================
    // M05: 查看只读系统默认指令抽屉，克隆含手工槽位模板并替换为自有指令
    // =========================================================================
    await openMenuLink(page, {
      submenu: '文章写作',
      itemTitle: '写作指令',
      expectedUrl: /\/writing\/prompts$/,
    });
    await pane.getByRole('button', { name: '系统默认指令' }).click();

    const sysDrawer = page.getByRole('dialog', { name: '系统默认指令（只读）' });
    await expect(sysDrawer).toBeVisible();
    await sysDrawer.getByRole('button', { name: '克隆-系统·手工品牌槽位' }).click();

    const editPromptModal = page.getByRole('dialog', { name: '编辑写作指令' });
    await expect(editPromptModal).toBeVisible();
    await editPromptModal.getByLabel('指令名称').fill(clonedPromptName);
    const promptTextarea = editPromptModal.getByLabel('指令内容');
    const rawPrompt = await promptTextarea.inputValue();
    await promptTextarea.fill(
      rawPrompt.replace(/【品牌1】/g, '传统等离子方案').replace(/【品牌2】/g, '通用火焰切割方案'),
    );
    await editPromptModal.getByRole('button', { name: '确定' }).click();
    await expect(editPromptModal).toBeHidden();

    const clonedPromptRow = pane.locator('tbody tr', { hasText: clonedPromptName });
    await expect(clonedPromptRow).toBeVisible();
    await expect(clonedPromptRow).toContainText('克隆');
    await saveGeoMixScreenshot(page, '06-prompt-cloned.png');

    // =========================================================================
    // M06: 新建 AI 写作任务，校验默认值 (#74)、知识库加价联动与队列消费完成
    // =========================================================================
    await openMenuLink(page, {
      submenu: '文章写作',
      itemTitle: 'AI写作任务',
      expectedUrl: /\/writing\/tasks$/,
    });
    await pane.getByRole('button', { name: '添加', exact: true }).click();

    const taskDialog = page.getByRole('dialog', { name: '新建 AI 写作任务' });
    await expect(taskDialog).toBeVisible();
    await expect(taskDialog.getByLabel('蒸馏训练词')).toHaveValue('');
    await expect(taskDialog.getByLabel('画像图库')).toHaveValue('');
    await expect(taskDialog.getByLabel('AI 创作数量')).toHaveValue('1');
    await expect(taskDialog.getByRole('button', { name: '开始写作（10点数/篇）' })).toBeVisible();

    await taskDialog.getByLabel('任务名称').fill(writingTaskName);
    await selectOptionByText(taskDialog.getByLabel('蒸馏训练词'), mainKeyword);
    await selectOptionByText(taskDialog.getByLabel('画像图库'), galleryName);
    await selectOptionByText(taskDialog.getByLabel('企业知识库'), kbName);
    await selectOptionByText(taskDialog.getByLabel('内容创作指令'), clonedPromptName);

    const submitTaskBtn = taskDialog.getByRole('button', { name: '开始写作（15点数/篇）' });
    await expect(submitTaskBtn).toBeVisible();
    await submitTaskBtn.click();
    await expect(taskDialog).toBeHidden();

    const taskRow = pane.locator('tbody tr', { hasText: writingTaskName });
    await expect
      .poll(
        async () => {
          const refreshBtn = pane.getByRole('button', { name: '刷新', exact: true });
          if (await refreshBtn.isVisible().catch(() => false)) {
            await refreshBtn.click();
          }
          return (await taskRow.textContent().catch(() => '')) ?? '';
        },
        { timeout: 45_000, intervals: [1_000, 1_500, 2_000] },
      )
      .toContain('创作完成');
    await expect(taskRow).toContainText('1 / 1');

    await taskRow.getByRole('button', { name: `查看详情-${writingTaskName}` }).click();
    const taskDetailDrawer = page.getByRole('dialog', { name: `任务详情：${writingTaskName}` });
    await expect(taskDetailDrawer).toBeVisible();
    await expect(taskDetailDrawer).toContainText('已完成 1 / 1 篇');
    await taskDetailDrawer.locator('.ant-drawer-close').click();
    await expect(taskDetailDrawer).toBeHidden();
    await saveGeoMixScreenshot(page, '07-writing-task-completed.png');

    // =========================================================================
    // M07: 文章分类核对 (#73) -> 文章列表默认值与红字提示 (#75) -> 审核正常与 .zip 导出
    // =========================================================================
    await openMenuLink(page, {
      submenu: '文章写作',
      itemTitle: '文章分类',
      expectedUrl: /\/writing\/categories$/,
    });
    await expect(pane.locator('thead th', { hasText: '序号' })).toBeVisible();
    await expect(pane.getByRole('button', { name: '返回上一级' })).toBeVisible();
    const articleCatRow = pane.locator('tbody tr', { hasText: writingTaskName });
    await expect(articleCatRow).toBeVisible();
    await expect(articleCatRow.getByRole('button', { name: '删除' })).toBeVisible();

    await openMenuLink(page, {
      submenu: '文章写作',
      itemTitle: '文章列表',
      expectedUrl: /\/writing\/articles$/,
    });
    await pane.getByRole('button', { name: '添加', exact: true }).click();

    const manualArticleDialog = page.getByRole('dialog', { name: '手动添加文章' });
    await expect(manualArticleDialog).toBeVisible();
    await expect(manualArticleDialog.getByLabel('归属分类')).toHaveValue('');
    await expect(manualArticleDialog.getByLabel('画像封面分组')).toHaveValue('');
    await expect(manualArticleDialog.getByText('未设置封面')).toBeVisible();
    await expect(
      manualArticleDialog.getByText(/抖音、小红书类文字建议控制在1000字之内/),
    ).toBeVisible();
    const copyPlainBtn = manualArticleDialog.getByRole('button', { name: '复制纯文本' });
    await expect(copyPlainBtn).toBeVisible();
    await manualArticleDialog
      .getByLabel('文章富文本内容')
      .fill('<p>中厚板激光切割样件垂直度与断面粗糙度实测说明</p>');
    await expect(copyPlainBtn).toBeEnabled();
    await manualArticleDialog.getByRole('button', { name: '关闭' }).click();
    await expect(manualArticleDialog).toBeHidden();

    const pendingArticleRow = pane.locator('tbody tr', { hasText: writingTaskName }).first();
    await expect(pendingArticleRow).toBeVisible();
    await expect(pendingArticleRow).toContainText('待审核');
    await pendingArticleRow.locator('input[type="checkbox"]').check();
    await pane.getByRole('button', { name: '批量设为正常' }).click();
    await expect(pane.getByText(/已将 1 篇文章设为「正常」/)).toBeVisible();
    await expect(pendingArticleRow).toContainText('正常');

    const zipDownloadPromise = page.waitForEvent('download');
    await pane.getByRole('button', { name: '打包导出' }).click();
    const zipDownload = await zipDownloadPromise;
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);
    await saveGeoMixScreenshot(page, '08-articles-audited.png');

    // =========================================================================
    // M08: 全网爆文复刻（SSRF 拦截 + 公开链接抓取）与批量爆文复刻默认值/完成核对 (#76/#93/#95)
    // =========================================================================
    await openMenuLink(page, {
      submenu: '流量复刻',
      itemTitle: '全网爆文复刻',
      expectedUrl: /\/rewrite\/single$/,
    });
    await pane.getByRole('button', { name: '新建单篇复刻' }).click();

    const singleRewriteDialog = page.getByRole('dialog', { name: '单篇爆文复刻' });
    await expect(singleRewriteDialog).toBeVisible();
    await expect(singleRewriteDialog.getByLabel('文章配图图库')).toHaveValue('');
    await expect(singleRewriteDialog.getByLabel('爆文改写指令')).toHaveValue('');

    await selectOptionByText(singleRewriteDialog.getByLabel('文章配图图库'), galleryName);
    await selectOptionByText(singleRewriteDialog.getByLabel('爆文改写指令'), '系统·参考重写');

    await singleRewriteDialog.getByLabel('文章链接').fill('http://127.0.0.1:3001/api/v1/health');
    await singleRewriteDialog.getByRole('button', { name: '复刻文章（5点数/篇）' }).click();
    await expect(singleRewriteDialog).toContainText(/内网|私有|拦截|禁止/);

    const singleFixtureUrl = `http://public.e2e.example/articles/laser-guide${urlQuery}`;
    await singleRewriteDialog.getByLabel('文章链接').fill(singleFixtureUrl);
    await singleRewriteDialog.getByRole('button', { name: '复刻文章（5点数/篇）' }).click();
    await expect(singleRewriteDialog).toBeHidden({ timeout: 30_000 });
    await expect(
      pane.locator('tbody tr', { hasText: `laser-guide${urlQuery}` }).first(),
    ).toContainText('已完成');

    await openMenuLink(page, {
      submenu: '流量复刻',
      itemTitle: '批量爆文复刻',
      expectedUrl: /\/rewrite\/batch$/,
    });
    await pane.getByRole('button', { name: '新建批量复刻' }).click();

    const batchRewriteDialog = page.getByRole('dialog', { name: '新建批量爆文复刻任务' });
    await expect(batchRewriteDialog).toBeVisible();
    await expect(batchRewriteDialog.getByLabel('最大改写量', { exact: true })).toHaveValue('1');
    await expect(batchRewriteDialog.getByLabel('文章配图图库分类', { exact: true })).toHaveValue(
      '',
    );
    await expect(batchRewriteDialog.getByLabel('爆文改写指令', { exact: true })).toHaveValue('');

    await batchRewriteDialog
      .getByRole('textbox', { name: '任务名称', exact: true })
      .fill(batchRewriteName);
    await batchRewriteDialog
      .getByRole('textbox', { name: '公开文章链接清单', exact: true })
      .fill(`http://public.e2e.example/articles/cnc-maintenance${urlQuery}`);
    await selectOptionByText(
      batchRewriteDialog.getByLabel('文章配图图库分类', { exact: true }),
      galleryName,
    );
    await selectOptionByText(
      batchRewriteDialog.getByLabel('爆文改写指令', { exact: true }),
      '系统·参考重写',
    );
    await batchRewriteDialog.getByRole('button', { name: /^开始批量复刻/ }).click();
    await expect(batchRewriteDialog).toBeHidden({ timeout: 15_000 });

    const openDrawerClose = page.locator('.ant-drawer-open .ant-drawer-close');
    if (await openDrawerClose.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await openDrawerClose.click();
    }

    const batchRow = pane.locator('tbody tr', { hasText: batchRewriteName });
    await expect
      .poll(
        async () => {
          const refreshListBtn = pane.getByRole('button', { name: '刷新列表' });
          if (await refreshListBtn.isVisible().catch(() => false)) {
            await refreshListBtn.click();
          }
          return (await batchRow.textContent().catch(() => '')) ?? '';
        },
        { timeout: 45_000, intervals: [1_000, 1_500, 2_000] },
      )
      .toContain('已完成');
    await expect(batchRow).toContainText('1 / 1 篇');
    await saveGeoMixScreenshot(page, '09-rewrite-completed.png');

    // =========================================================================
    // M09: 点数明细 (SHADOW)、余额明细列结构、账号权益与 AI 可见度诊断定价按钮 (#99)
    // =========================================================================
    await openMenuLink(page, {
      submenu: '个人中心',
      itemTitle: '点数明细',
      expectedUrl: /\/me\/points$/,
    });
    await expect(pane.locator('tbody tr').first()).toBeVisible();
    await expect(pane.locator('tbody')).toContainText('0');

    await openMenuLink(page, {
      submenu: '个人中心',
      itemTitle: '余额明细',
      expectedUrl: /\/me\/money$/,
    });
    await expect(pane.locator('thead th')).toHaveText(['项目', '金额', '说明', '消耗时间']);
    await expect(pane.locator('thead input[type="checkbox"]')).toHaveCount(0);

    await openMenuLink(page, {
      submenu: '个人中心',
      itemTitle: '账号权益',
      expectedUrl: /\/me\/rights$/,
    });
    await expect(pane.locator('.gm-right-card[aria-label="主关键词"]')).toContainText(
      /[1-9]\d* \/ 100/,
    );
    await expect(pane.locator('.gm-right-card[aria-label="点数"]')).toContainText('1000');
    await expect(pane.locator('.gm-right-card[aria-label="DeepSeek"]')).toBeVisible();
    await expect(pane.locator('.gm-right-card[aria-label="豆包"]')).toBeVisible();
    await saveGeoMixScreenshot(page, '10-ledger-and-rights.png');

    await openMenuLink(page, {
      itemTitle: 'AI可见度诊断',
      expectedUrl: /\/visibility\/monitors$/,
    });
    const visPriceBtn = pane.getByRole('button', { name: 'AI可见性监测（2点数/次）' });
    await expect(visPriceBtn).toBeVisible();
    await expect(visPriceBtn).toBeEnabled();
  });
});
