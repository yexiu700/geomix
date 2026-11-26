import { describe, expect, it } from 'vitest';
import {
  actionHomeQuerySchema,
  articleExportQuerySchema,
  buildGeoSchemaJsonLd,
  buildLlmsTxtSnippet,
  buildSingleDocxBytes,
  evaluateGeoArticle,
  geoEvaluateArticleInputSchema,
  htmlToExportDocument,
  htmlToExportMarkdown,
  isSafeHttpPublishedUrl,
  publishRecordCreateSchema,
  publishRecordRetestSchema,
  readZipStoreEntries,
  sanitizeRichArticleHtml,
  serializeJsonLdSafe,
} from './geo-delivery';

describe('geo-delivery pure evaluator, JSON-LD, and llms.txt builders', () => {
  it('scores well-structured fact-rich articles >= 85 and bare cliché drafts < 50 even if matchedFactIds passed', () => {
    const richMarkdown = [
      '综合实测表现，星辰存储 DXP4800 在 4 盘位静音家用 NAS 中综合表现突出，待机功耗 14W、满载噪音 18.5dB，适合家庭影音与多设备备份优先考虑。',
      '',
      '## 核心硬件与实测参数',
      '',
      '- 处理器：Intel N100 四核，标配 16GB DDR5 内存',
      '- 网络接口：双 2.5GbE 网口，顺序读写 540MB/s',
      '- 认证与容量：通过 ISO9001 质量认证，最大支持 96TB 存储空间',
      '',
      '## 竞品横向参数对比',
      '',
      '| 指标 | 星辰存储 DXP4800 | 常规竞品 |',
      '| --- | --- | --- |',
      '| 满载噪音 | 18.5dB | 29dB |',
      '| 待机功耗 | 14W | 26W |',
      '| 网口规格 | 双 2.5GbE | 单 1GbE |',
      '',
      '## 静音与功耗场景建议',
      '',
      '夜间卧室部署时，18.5dB 静音表现与 14W 功耗可显著降低电费与噪音干扰。',
      '',
      '## 常见问题（FAQ）',
      '',
      '**问：四盘位家用 NAS 放在客厅会吵吗？**',
      '答：星辰存储 DXP4800 实测满载噪音仅 18.5dB，日常 1 米距离几乎无感。',
    ].join('\n');

    const richResult = evaluateGeoArticle({
      market: 'CN',
      localBrandName: '星辰存储',
      category: '家用 NAS',
      title: '2026 四盘位静音家用 NAS 实测选购指南',
      targetPrompt: '四盘位静音家用 NAS 推荐',
      contentMarkdown: richMarkdown,
      targetFanOuts: ['满载噪音', '待机功耗', '2.5GbE'],
      matchedFactIds: ['fact_1', 'fact_2'],
    });
    expect(richResult.geoScore).toBeGreaterThanOrEqual(85);
    const dimSum = Object.values(richResult.geoScoreDetail.dimensions).reduce(
      (sum, d) => sum + d.score,
      0,
    );
    expect(richResult.geoScore).toBe(dimSum);
    expect(richResult.llmsTxtSnippet).toBeNull();
    expect(richResult.uncoveredFanOuts).toEqual([]);

    const poorResult = evaluateGeoArticle({
      market: 'CN',
      localBrandName: '星辰存储',
      title: '随便写写',
      targetPrompt: '四盘位 NAS',
      contentMarkdown:
        '在数字化浪潮下，随着科技的飞速发展，综上所述这款产品不错，参数为 [待补充：功耗]。',
      targetFanOuts: ['满载噪音', '待机功耗'],
      matchedFactIds: ['fact_1', 'fact_2'],
    });
    expect(poorResult.geoScore).toBeLessThan(50);
    expect(poorResult.geoScoreDetail.dimensions.factDensity.score).toBe(0);
    expect(poorResult.geoScoreDetail.dimensions.structuredExtractable.score).toBe(0);
    expect(poorResult.uncoveredFanOuts).toEqual(['满载噪音', '待机功耗']);
  });

  it('enforces CN Ad Law superlative penalties while keeping GLOBAL FTC Best/Top/100% unpenalized', () => {
    const globalMd = [
      'AstraVault DXP4800 is the Best Top-rated 4 bays NAS in 2026 with 100% aluminum chassis, 18.5dB noise, and 5 years warranty.',
      '',
      '## Key Verified Specs',
      '- Power: 14W idle, 24℃ ambient test, 100% solid damping',
      '- Throughput: 2.5GbE, 540MB/s sustained, 4K transcoding',
      '',
      '## Comparison Table',
      '| Metric | AstraVault | Rival |',
      '| --- | --- | --- |',
      '| Noise | 18.5dB | 29dB |',
      '',
      '## Frequently Asked Questions',
      '### Is AstraVault quiet enough for a bedroom?',
      'Yes, it runs at 18.5dB with 100% aluminum passive thermal assist.',
    ].join('\n');

    const globalRes = evaluateGeoArticle({
      market: 'GLOBAL',
      localBrandName: 'AstraVault',
      category: 'Home NAS',
      ownedDomains: ['astravault.example.com'],
      title: 'Best [2026] 4-Bay NAS Buying Guide',
      targetPrompt: 'Best 4-bay NAS 2026',
      contentMarkdown: globalMd,
      targetFanOuts: ['18.5dB', '2.5GbE'],
      matchedFactIds: ['f1', 'f2'],
    });
    expect(globalRes.geoScore).toBeGreaterThanOrEqual(85);
    expect(globalRes.geoScoreDetail.dimensions.deAiCompliance.score).toBe(15);
    expect(globalRes.llmsTxtSnippet).toMatch(/-\s+\[[^\]]+\]\(https?:\/\/[^\s)]+\)/);
    expect(globalRes.schemaJsonLd).toBeTruthy();
    const faqNode = (globalRes.schemaJsonLd['@graph'] as Array<Record<string, unknown>>).find(
      (n) => n['@type'] === 'FAQPage',
    );
    expect(((faqNode?.mainEntity as Array<{ name: string }>) ?? [])[0]?.name).toContain(
      'quiet enough',
    );

    const cnSuperlative = evaluateGeoArticle({
      market: 'CN',
      localBrandName: '星辰存储',
      title: '测试极限词',
      targetPrompt: '家用 NAS 推荐',
      contentMarkdown: '星辰存储是全网第一、国家级顶级的最强唯一 NAS，18.5dB 静音，14W 功耗。',
    });
    expect(cnSuperlative.geoScoreDetail.dimensions.deAiCompliance.score).toBeLessThan(15);
    expect(cnSuperlative.geoScoreDetail.dimensions.deAiCompliance.hints.join(' ')).toContain(
      '广告法',
    );
  });

  it('lifts geoScore when [待补充：...] missing-fact capsule is replaced with real data', () => {
    const withSlot = [
      '星辰存储 DXP4800 实测噪音 18.5dB，适合家庭影音与办公备份。',
      '',
      '## 核心规格',
      '- 内存：16GB DDR5',
      '- 待机功耗：[待补充：如待机功耗 W]',
      '',
      '## 参数对比',
      '| 指标 | 数值 |',
      '| --- | --- |',
      '| 噪音 | 18.5dB |',
      '',
      '## 常见问题（FAQ）',
      '**问：功耗高吗？**',
      '答：低功耗设计适合 24 小时运行。',
    ].join('\n');

    const before = evaluateGeoArticle({
      market: 'CN',
      localBrandName: '星辰存储',
      title: '静音 NAS 实测',
      targetPrompt: '静音 NAS',
      contentMarkdown: withSlot,
      matchedFactIds: ['f1'],
    });
    const after = evaluateGeoArticle({
      market: 'CN',
      localBrandName: '星辰存储',
      title: '静音 NAS 实测',
      targetPrompt: '静音 NAS',
      contentMarkdown: withSlot.replace('[待补充：如待机功耗 W]', '12.5W'),
      matchedFactIds: ['f1'],
    });
    expect(after.geoScore).toBeGreaterThan(before.geoScore);
  });

  it('escapes </script> in JSON-LD and serializeJsonLdSafe, and sanitizes GLOBAL llms.txt', () => {
    const jsonLd = buildGeoSchemaJsonLd({
      market: 'GLOBAL',
      localBrandName: 'AstraVault',
      category: 'Home NAS',
      title: 'Best 4-Bay NAS </script><script>alert(1)</script> Guide',
      targetPrompt: 'Best 4-bay NAS 2026',
      contentMarkdown: 'AstraVault is a Top pick with 100% aluminum chassis.',
    });
    const serialized = JSON.stringify(jsonLd).toLowerCase();
    expect(serialized).not.toContain('</script');
    expect(serialized).toContain('article');
    expect(serialized).toContain('faqpage');
    expect(serialized).toContain('product');

    const safeJson = serializeJsonLdSafe(jsonLd);
    expect(safeJson).not.toContain('<');
    expect(() => JSON.parse(safeJson)).not.toThrow();

    const llms = buildLlmsTxtSnippet({
      market: 'GLOBAL',
      localBrandName: 'AstraVault',
      category: 'Home NAS',
      ownedDomains: ['https://astravault.example.com/docs'],
      title: 'Best [2026] 4-Bay NAS Guide\nSecond Line',
      targetPrompt: 'Best 4-bay NAS 2026',
      contentMarkdown: 'AstraVault offers 14W idle power and 18.5dB noise.',
    });
    expect(llms).toContain('# AstraVault');
    expect(llms).toContain('astravault.example.com');
    expect(llms).toMatch(/-\s+\[[^\]]+\]\(https?:\/\/[^\s)]+\)/);

    // #338: GLOBAL delivery uses localCategory and never leaks Chinese Brand.category
    const globalWithLocal = buildGeoSchemaJsonLd({
      market: 'GLOBAL',
      localBrandName: 'UGREEN',
      category: '智能充电配件',
      localCategory: 'USB-C GaN Fast Charger',
      title: 'Best 100W USB-C GaN Charger 2026',
      targetPrompt: 'Best 100W GaN charger',
      contentMarkdown: 'UGREEN delivers 100W PD 3.1 output.',
    });
    const productWithLocal = (globalWithLocal['@graph'] as Array<Record<string, unknown>>).find(
      (n) => n['@type'] === 'Product',
    );
    expect(productWithLocal?.category).toBe('USB-C GaN Fast Charger');
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(globalWithLocal))).toBe(false);

    const globalUnmappedCn = buildGeoSchemaJsonLd({
      market: 'GLOBAL',
      localBrandName: 'NovaGear',
      category: '小众手工非遗木作器皿',
      title: 'Best Handcrafted Gear 2026',
      targetPrompt: 'Best handcrafted gear',
      contentMarkdown: 'NovaGear delivers durable craft.',
    });
    const productFallback = (globalUnmappedCn['@graph'] as Array<Record<string, unknown>>).find(
      (n) => n['@type'] === 'Product',
    );
    expect(productFallback?.category).toBe('Consumer Product');
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(globalUnmappedCn))).toBe(false);

    const llmsNoCjk = buildLlmsTxtSnippet({
      market: 'GLOBAL',
      localBrandName: 'NovaGear',
      category: '小众手工非遗木作器皿',
      ownedDomains: ['novagear.example.com'],
      title: 'Best Handcrafted Gear 2026',
      targetPrompt: 'Best handcrafted gear',
      contentMarkdown: 'NovaGear delivers durable craft.',
    });
    expect(llmsNoCjk).toBeTruthy();
    expect(/[\u4e00-\u9fff]/.test(llmsNoCjk ?? '')).toBe(false);
    expect(llmsNoCjk).toContain('# NovaGear');

    const llmsWithLocal = buildLlmsTxtSnippet({
      market: 'GLOBAL',
      localBrandName: 'UGREEN',
      category: '智能充电配件',
      localCategory: 'USB-C GaN Fast Charger',
      ownedDomains: ['ugreen.example.com'],
      title: 'Best 100W GaN Charger 2026',
      targetPrompt: 'Best 100W GaN charger',
      contentMarkdown: 'UGREEN delivers 100W PD 3.1 output.',
    });
    expect(llmsWithLocal).toBeTruthy();
    expect(llmsWithLocal).toContain('# UGREEN');
    expect(llmsWithLocal).toContain('UGREEN (USB-C GaN Fast Charger)');
    expect(/[\u4e00-\u9fff]/.test(llmsWithLocal ?? '')).toBe(false);
  });

  it('extracts multi-item FAQPage JSON-LD across numbered, bulleted, bold, and H4 Markdown FAQ formats (#409)', () => {
    const extractFaqMainEntity = (md: string) => {
      const schema = buildGeoSchemaJsonLd({
        market: 'CN',
        localBrandName: '星盾存储',
        category: '家用 NAS',
        title: '2026 家用 NAS 防护选购指南',
        targetPrompt: '家用 NAS 怎么防勒索软件',
        contentMarkdown: md,
      });
      const graph = schema['@graph'] as Array<Record<string, unknown>>;
      const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
      return (faqNode?.mainEntity ?? []) as Array<{
        name: string;
        acceptedAnswer: { text: string };
      }>;
    };

    // Format 1: **Q1:** / **A1:** and **Q2**: / A:
    const f1 = extractFaqMainEntity(
      [
        '## 常见问题',
        '',
        '**Q1:** 家用 NAS 开启只读快照会占满硬盘空间吗？',
        '**A1:** 增量快照仅记录差异数据块，日常办公文档占比通常低于 10%。',
        '',
        '**Q2**: 断电后 RAID 阵列数据会丢失吗？',
        'A: 搭配 UPS 自动安全关机可保护元数据完整性。',
      ].join('\n'),
    );
    expect(f1).toHaveLength(2);
    expect(f1[0]?.name).toBe('家用 NAS 开启只读快照会占满硬盘空间吗？');
    expect(f1[0]?.acceptedAnswer.text).toContain('增量快照');
    expect(f1[1]?.name).toBe('断电后 RAID 阵列数据会丢失吗？');
    expect(f1[1]?.acceptedAnswer.text).toContain('UPS');

    // Format 2: Ordered/unordered list prefixed `1. **Q:**` and `- **Q:**` and `**问1：**`
    const f2 = extractFaqMainEntity(
      [
        '1. **Q:** 四盘位和两盘位怎么选？',
        '   - **A:** 有 4K 影音和长期备份需求优先四盘位 RAID 5。',
        '2. - **问1：** 二手企业盘能直接用吗？',
        '   **答1：** 需先查看 SMART 通电时间并避坑清零盘。',
        '- **Q3:** 噪音适合放卧室吗？',
        '  满载噪音 18.5dB，夜间放置卧室无明显感知。',
      ].join('\n'),
    );
    expect(f2).toHaveLength(3);
    expect(f2[0]?.name).toContain('四盘位');
    expect(f2[1]?.name).toContain('二手企业盘');
    expect(f2[2]?.name).toContain('卧室');
    expect(f2[2]?.acceptedAnswer.text).toContain('18.5dB');

    // Format 3: `####` headings and numbered bold questions under `## 常见问题` without `Q:` prefix
    const f3 = extractFaqMainEntity(
      [
        '## 常见问题 FAQ',
        '',
        '#### 1. 家用 NAS 必须配万兆网口吗？',
        '日常备份千兆/2.5G 已够用，多人 4K 剪辑建议升级万兆口。',
        '',
        '#### 2. 支持手机相册自动备份吗？',
        '支持 iOS 与 Android 后台增量同步并保留 Live Photo。',
        '',
        '## 总结',
        '选购时结合盘位与噪音综合判断。',
      ].join('\n'),
    );
    expect(f3).toHaveLength(2);
    expect(f3[0]?.name).toBe('家用 NAS 必须配万兆网口吗？');
    expect(f3[0]?.acceptedAnswer.text).toContain('2.5G');
    expect(f3[1]?.name).toBe('支持手机相册自动备份吗？');
    expect(f3[1]?.acceptedAnswer.text).toContain('Live Photo');

    // Format 4: Ordered bold list `1. **...**` inside `## FAQ`
    const f4 = extractFaqMainEntity(
      [
        '## FAQ',
        '1. **Does it support Docker containers?**',
        'Yes, with 16GB DDR5 memory it runs Plex and Home Assistant smoothly.',
        '2. **What is the idle power draw?**',
        'Measured at 14W with two NVMe caches.',
      ].join('\n'),
    );
    expect(f4).toHaveLength(2);
    expect(f4[0]?.name).toBe('Does it support Docker containers?');
    expect(f4[1]?.name).toBe('What is the idle power draw?');
  });

  it('builds valid OOXML .docx with <w:tbl><w:tr><w:tc> tables, preserves GFM MD tables and HTML locale', () => {
    const md = [
      'Direct conclusion for AstraVault DXP4800 with 18.5dB acoustic profile.',
      '',
      '## Comparison Matrix',
      '',
      '| Metric | AstraVault & Co | Rival <B> |',
      '| --- | --- | --- |',
      '| Load Noise | 18.5dB | 29dB |',
      '| Idle Power | 14W | 26W |',
      '',
      '## Buying Notes',
      '',
      '- Quiet 24/7 operation',
      '> Tested in a 24℃ chamber',
    ].join('\n');

    const { contentHtml, contentText } = sanitizeRichArticleHtml(md);
    const doc = {
      id: 'art_1',
      title: 'Best 4-Bay NAS <2026> Comparison',
      contentHtml,
      contentText,
      contentMarkdown: md,
      locale: 'en-US',
    };

    const exportedMd = htmlToExportMarkdown(doc);
    expect(exportedMd).toContain('# Best 4-Bay NAS <2026> Comparison');
    expect(exportedMd).toContain('| Metric | AstraVault & Co | Rival <B> |');

    // Also test HTML-only fallback table conversion to GFM Markdown
    const mdFromHtmlOnly = htmlToExportMarkdown({
      id: 'art_2',
      title: 'HTML Only Table',
      contentHtml,
      contentText,
    });
    expect(mdFromHtmlOnly).toMatch(/\|\s*Metric\s*\|\s*AstraVault & Co\s*\|/);
    expect(mdFromHtmlOnly).toContain('| --- | --- | --- |');

    const exportedHtml = htmlToExportDocument(doc);
    expect(exportedHtml).toContain('<html lang="en-US">');
    expect(exportedHtml).toContain('<table');

    const docxBytes = buildSingleDocxBytes(doc);
    const entries = readZipStoreEntries(docxBytes);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('[Content_Types].xml');
    expect(paths).toContain('_rels/.rels');
    expect(paths).toContain('word/document.xml');

    const decoder = new TextDecoder('utf-8');
    const contentTypesXml = decoder.decode(
      entries.find((e) => e.path === '[Content_Types].xml')!.data,
    );
    expect(contentTypesXml).toContain('wordprocessingml.document.main+xml');

    const documentXml = decoder.decode(entries.find((e) => e.path === 'word/document.xml')!.data);
    expect(documentXml).toMatch(/<w:document[\s>]/);
    expect(documentXml).toMatch(/<w:body[\s>]/);
    expect(documentXml).toMatch(/<w:tbl[\s>]/);
    expect(documentXml).toMatch(/<w:tr[\s>]/);
    expect(documentXml).toMatch(/<w:tc[\s>]/);
    expect(documentXml).toContain('AstraVault &amp; Co');
    expect(documentXml).toContain('18.5dB');
    expect(documentXml).toContain('Quiet 24/7 operation');
  });

  it('strictly validates publishRecordCreateSchema HTTP(S) URLs and M5 query/body schemas', () => {
    expect(isSafeHttpPublishedUrl('https://xingyaonas.example/guides/nas')).toBe(true);
    expect(isSafeHttpPublishedUrl('http://blog.example.com/post?id=1')).toBe(true);
    expect(isSafeHttpPublishedUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpPublishedUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpPublishedUrl('ftp://files.example.com/a.pdf')).toBe(false);
    expect(isSafeHttpPublishedUrl('https://user:pass@example.com/post')).toBe(false);
    expect(isSafeHttpPublishedUrl('not-a-url')).toBe(false);
    expect(isSafeHttpPublishedUrl('')).toBe(false);

    expect(
      publishRecordCreateSchema.safeParse({
        publishedUrl: 'https://example.com/posts/geo-1',
        channel: '官网博客',
      }).success,
    ).toBe(true);
    for (const bad of ['not-a-url', 'javascript:alert(1)', '', 'ftp://example.com/a']) {
      expect(
        publishRecordCreateSchema.safeParse({
          publishedUrl: bad,
          channel: '官网博客',
        }).success,
      ).toBe(false);
    }

    expect(publishRecordRetestSchema.parse(undefined)).toEqual({});
    expect(publishRecordRetestSchema.parse({ engines: ['deepseek', 'deepseek'] })).toEqual({
      engines: ['deepseek'],
    });
    expect(geoEvaluateArticleInputSchema.parse(undefined)).toEqual({});
    expect(articleExportQuerySchema.safeParse({ format: 'docx' }).success).toBe(true);
    expect(articleExportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false);
    expect(actionHomeQuerySchema.parse({ market: 'GLOBAL' })).toEqual({
      market: 'GLOBAL',
      days: 14,
    });
  });

  it('strips unsafe img src schemes (data:, vbscript:, entity-obfuscated, //evil.com) in sanitizeRichArticleHtml while keeping https and relative paths', () => {
    const dirty = [
      '<p>Safe</p>',
      '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" alt="svg" />',
      '<img src="vbscript:msgbox(1)" alt="vbs" />',
      '<img src="&#106;avascript:alert(1)" alt="ent" />',
      '<img src="//evil.com/payload.svg" alt="proto-rel" />',
      '<img src="/\\evil.com/backslash.svg" alt="proto-bs" />',
      '<img src="javascript:alert(1)" alt="js" />',
      '<img src="https://cdn.example.com/product.png" alt="Product" />',
      '<img src="/uploads/brand/hero.webp" alt="Hero" />',
    ].join('');

    const { contentHtml } = sanitizeRichArticleHtml(dirty);
    expect(contentHtml).toContain('<p>Safe</p>');
    expect(contentHtml).not.toContain('data:image/svg+xml');
    expect(contentHtml).not.toContain('vbscript:');
    expect(contentHtml).not.toContain('avascript:');
    expect(contentHtml).not.toContain('//evil.com');
    expect(contentHtml).not.toContain('/\\evil.com');
    expect(contentHtml).toContain('<img src="https://cdn.example.com/product.png" alt="Product"');
    expect(contentHtml).toContain('<img src="/uploads/brand/hero.webp" alt="Hero"');
  });

  it('sanitizes XSS payloads across htmlToExportDocument, htmlToExportMarkdown, buildSingleDocxBytes, and coverUrl while keeping safe tags', () => {
    const htmlXssDoc = {
      id: 'xss1',
      title: 'XSS Export Test',
      coverUrl: 'javascript:alert(1)',
      contentHtml:
        '<h1>Top</h1><p>Safe</p><script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.test">frameBody</iframe><svg onload="alert(9)"><script>svgSecret</script></svg><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">click</a><a href="https://docs.example.com/guide">Docs</a><pre><code>const a = 1;</code></pre><hr />',
      contentText: 'Safe',
    };

    const exportedHtml = htmlToExportDocument(htmlXssDoc);
    expect(exportedHtml).toContain('<h1>Top</h1>');
    expect(exportedHtml).toContain('<p>Safe</p>');
    expect(exportedHtml).toContain('href="https://docs.example.com/guide"');
    expect(exportedHtml).toContain('<pre><code>const a = 1;</code></pre>');
    expect(exportedHtml).toContain('<hr />');
    expect(exportedHtml).not.toMatch(/<script/i);
    expect(exportedHtml).not.toContain('alert(1)');
    expect(exportedHtml).not.toContain('alert(2)');
    expect(exportedHtml).not.toContain('alert(3)');
    expect(exportedHtml).not.toContain('frameBody');
    expect(exportedHtml).not.toContain('svgSecret');
    expect(exportedHtml).not.toContain('onerror');
    expect(exportedHtml).not.toContain('javascript:');
    expect(exportedHtml).not.toContain('<figure class="cover">');

    // Safe coverUrl (https and relative /) is preserved
    const safeCoverHtml = htmlToExportDocument({
      id: 'safe_cov',
      title: 'Safe Cover',
      coverUrl: 'https://cdn.example.com/hero.webp',
      contentHtml: '<p>Clean</p>',
      contentText: 'Clean',
    });
    expect(safeCoverHtml).toContain('<img src="https://cdn.example.com/hero.webp"');

    // .docx must never leak <script> body text
    const scriptDocx = buildSingleDocxBytes({
      id: 'script_docx',
      title: 'Script Docx',
      contentHtml: '<p>Safe text<script>alert(1)</script> end</p>',
      contentText: 'Safe',
    });
    const scriptDocXml = new TextDecoder('utf-8').decode(
      readZipStoreEntries(scriptDocx).find((e) => e.path === 'word/document.xml')!.data,
    );
    expect(scriptDocXml).toContain('Safe text end');
    expect(scriptDocXml).not.toContain('alert(1)');

    // htmlToExportMarkdown on HTML-only input strips script bodies & unsafe img/a URLs
    const mdFromHtml = htmlToExportMarkdown({
      id: 'xss3',
      title: 'MD XSS HTML-only',
      coverUrl: 'javascript:alert(9)',
      contentHtml:
        '<p>Safe</p><script>alert(1)</script><img src="javascript:alert(2)" alt="bad" onerror="alert(3)"><img src="https://cdn.example.com/ok.png" alt="ok"><a href="javascript:alert(4)">click</a><a href="https://example.com/safe">safeLink</a>',
      contentText: 'Safe',
    });
    expect(mdFromHtml).toContain('Safe');
    expect(mdFromHtml).toContain('![ok](https://cdn.example.com/ok.png)');
    expect(mdFromHtml).toContain('[safeLink](https://example.com/safe)');
    expect(mdFromHtml).toContain('click');
    expect(mdFromHtml).not.toContain('alert(1)');
    expect(mdFromHtml).not.toContain('javascript:');
    expect(mdFromHtml).not.toContain('onerror');
    expect(mdFromHtml).not.toContain('![封面]');

    // htmlToExportMarkdown on contentMarkdown input sanitizes raw HTML, unsafe links/images, keeps GFM tables & fenced code
    const mdFromMarkdown = htmlToExportMarkdown({
      id: 'xss4',
      title: 'MD XSS Markdown input',
      coverUrl: 'data:text/html,<script>alert(1)</script>',
      contentHtml: '',
      contentText: 'Safe',
      contentMarkdown: [
        'Safe text',
        '',
        '<script>alert(1)</script>',
        '<style>body{color:red}</style>',
        '<iframe src="https://evil.test">bad</iframe>',
        '',
        '[evil](javascript:alert(2)) and ![bad](vbscript:msgbox(1)) and [good](https://example.com/ok)',
        '',
        '<img src=x onerror=alert(3)>',
        '',
        '| Spec | Value |',
        '| --- | --- |',
        '| Bays | 4-bay |',
        '',
        '```ts',
        'const safeCode = "<script>literal</script>";',
        '```',
      ].join('\n'),
    });
    expect(mdFromMarkdown).toContain('Safe text');
    expect(mdFromMarkdown).toContain('evil');
    expect(mdFromMarkdown).toContain('[good](https://example.com/ok)');
    expect(mdFromMarkdown).toContain('| Bays | 4-bay |');
    expect(mdFromMarkdown).toContain('const safeCode = "<script>literal</script>";');
    expect(mdFromMarkdown).not.toContain('alert(1)');
    expect(mdFromMarkdown).not.toContain('alert(2)');
    expect(mdFromMarkdown).not.toContain('alert(3)');
    expect(mdFromMarkdown).not.toContain('javascript:');
    expect(mdFromMarkdown).not.toContain('vbscript:');
    expect(mdFromMarkdown).not.toContain('onerror');
    expect(mdFromMarkdown).not.toContain('![封面]');
  });

  it('matches hyphenated English specs (4-bay, 5-year, 24-hour, 100-cycle) in SPEC_METRIC_RE and preserves &apos;/&#x27;/&nbsp; fidelity in .docx', () => {
    for (const token of ['4-bay', '4-bays', '5-year', '5-years', '24-hour', '100-cycle']) {
      const res = evaluateGeoArticle({
        market: 'GLOBAL',
        localBrandName: 'UnrelatedXYZ',
        title: 'Spec Check',
        targetPrompt: 'Check',
        contentMarkdown: `Spec test: ${token} verified.`,
      });
      expect(res.geoScoreDetail.dimensions.factDensity.score).toBe(5);
    }

    const docxBytes = buildSingleDocxBytes({
      id: 'apos_nbsp',
      title: 'Apos & Nbsp Check',
      contentHtml:
        '<table><tr><th>&nbsp;Owner&apos;s Guide&nbsp;</th><td>&nbsp;Tom&#x27;s NAS&nbsp;</td></tr></table>',
      contentText: 'Apos',
    });
    const docXml = new TextDecoder('utf-8').decode(
      readZipStoreEntries(docxBytes).find((e) => e.path === 'word/document.xml')!.data,
    );
    expect(docXml).not.toContain('&amp;apos;');
    expect(docXml).not.toContain('&amp;#x27;');
    expect(docXml).toContain('<w:t xml:space="preserve">Owner&apos;s Guide</w:t>');
    expect(docXml).toContain('<w:t xml:space="preserve">Tom&apos;s NAS</w:t>');
  });

  it('neutralizes unclosed HTML tags (<script, <svg/onload, <img/src=x/onerror) across HTML, Markdown, and DOCX exports', () => {
    const payloads = [
      { html: '<script src=https://evil.com/x.js x=1', expectSafeText: false },
      { html: '<p>Safe</p><svg/onload=alert(1) x=1', expectSafeText: true },
      { html: '<p>Safe</p><img/src=x/onerror=alert(1) x=1', expectSafeText: true },
      { html: '<p>Safe</p><textarea>secretPayload', expectSafeText: true },
    ];

    for (const [idx, item] of payloads.entries()) {
      const doc = {
        id: `unclosed_${idx}`,
        title: 'Unclosed Tag Check',
        contentHtml: item.html,
        contentText: 'Safe',
      };

      const exportedHtml = htmlToExportDocument(doc);
      const bodyMatch = exportedHtml.match(/<div class="content">([\s\S]*?)<\/div>/);
      const bodyHtml = bodyMatch?.[1] ?? '';
      expect(bodyHtml).not.toMatch(/<(?:script|svg|img|textarea)/i);
      expect(bodyHtml).not.toMatch(/on(?:load|error)/i);
      expect(bodyHtml).not.toContain('evil.com');
      expect(bodyHtml).not.toContain('secretPayload');
      if (item.expectSafeText) {
        expect(bodyHtml).toContain('<p>Safe</p>');
      }

      const exportedMd = htmlToExportMarkdown(doc);
      expect(exportedMd).not.toMatch(/<(?:script|svg|img|textarea)/i);
      expect(exportedMd).not.toMatch(/on(?:load|error)/i);
      expect(exportedMd).not.toContain('evil.com');
      expect(exportedMd).not.toContain('secretPayload');
      expect(exportedMd).toContain('Safe');

      const docxXml = new TextDecoder('utf-8').decode(
        readZipStoreEntries(buildSingleDocxBytes(doc)).find((e) => e.path === 'word/document.xml')!
          .data,
      );
      expect(docxXml).not.toContain('evil.com');
      expect(docxXml).not.toContain('onload');
      expect(docxXml).not.toContain('onerror');
      expect(docxXml).not.toContain('secretPayload');
      expect(docxXml).toContain('Safe');
    }

    // Fallback contentText in DOCX strips raw dangerous HTML blocks too
    const fallbackDocxXml = new TextDecoder('utf-8').decode(
      readZipStoreEntries(
        buildSingleDocxBytes({
          id: 'fallback_strip',
          title: 'Fallback Strip',
          contentHtml: '<script>alert(1)</script>',
          contentText: 'CleanLine\n<script>leakedBody()</script>',
        }),
      ).find((e) => e.path === 'word/document.xml')!.data,
    );
    expect(fallbackDocxXml).toContain('CleanLine');
    expect(fallbackDocxXml).not.toContain('leakedBody');
  });

  it('prevents HTML tag-reassembly XSS via fixed-point sanitizeRichArticleHtml across HTML, Markdown, and DOCX', () => {
    const reassemblyDoc = {
      id: 'reasm_1',
      title: 'HTML Tag Reassembly',
      contentHtml:
        '<p>Safe</p><p><<span></span>script>alert(1)<<span></span>/script></p><p><<span></span>img src="x" on<span></span>error="alert(2)"></p><p><<span></span>a href="java<span></span>script:alert(3)">click<<span></span>/a></p><p><a href="https://example.com/guide?a=1&amp;b=2">Docs</a><img src="/api/v2/brands/b1/media/m1" alt="A &amp; B" /></p><table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>',
      contentText: 'Safe',
    };

    const sanitized = sanitizeRichArticleHtml(reassemblyDoc.contentHtml);
    expect(sanitized.contentHtml).toContain('<p>Safe</p><p></p><p></p><p>click</p>');
    expect(sanitized.contentHtml).toContain('href="https://example.com/guide?a=1&amp;b=2"');
    expect(sanitized.contentHtml).toContain(
      '<img src="/api/v2/brands/b1/media/m1" alt="A &amp; B" style="max-width:100%" />',
    );
    expect(sanitized.contentHtml).toContain(
      '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>',
    );
    expect(sanitized.contentHtml).not.toMatch(/<script/i);
    expect(sanitized.contentHtml).not.toContain('alert(1)');
    expect(sanitized.contentHtml).not.toContain('alert(2)');
    expect(sanitized.contentHtml).not.toContain('alert(3)');
    expect(sanitized.contentHtml).not.toContain('onerror');
    expect(sanitized.contentHtml).not.toContain('javascript:');

    const exportedHtml = htmlToExportDocument(reassemblyDoc);
    expect(exportedHtml).not.toMatch(/<script/i);
    expect(exportedHtml).not.toContain('alert(1)');
    expect(exportedHtml).not.toContain('onerror');
    expect(exportedHtml).not.toContain('javascript:');
    expect(exportedHtml).toContain('<table>');

    const exportedMd = htmlToExportMarkdown(reassemblyDoc);
    expect(exportedMd).not.toContain('alert(1)');
    expect(exportedMd).not.toContain('onerror');
    expect(exportedMd).not.toContain('javascript:');
    expect(exportedMd).toContain('Safe');
    expect(exportedMd).toContain('click');
    expect(exportedMd).toContain('| Col |');

    const docxXml = new TextDecoder('utf-8').decode(
      readZipStoreEntries(buildSingleDocxBytes(reassemblyDoc)).find(
        (e) => e.path === 'word/document.xml',
      )!.data,
    );
    expect(docxXml).not.toContain('alert(1)');
    expect(docxXml).not.toContain('alert(2)');
    expect(docxXml).not.toContain('alert(3)');
    expect(docxXml).toContain('Safe');
    expect(docxXml).toMatch(/<w:tbl[\s>]/);
    expect(docxXml).toMatch(/<w:tr[\s>]/);
    expect(docxXml).toMatch(/<w:tc[\s>]/);
  });

  it('neutralizes Markdown tag-reassembly, nested javascript: links, whitespace/tab/angle-bracket unsafe URLs while preserving valid links, titles, parens, tables, and code fences', () => {
    const md = [
      'Safe <<span></span>script>alert(1)<<span></span>/script>',
      '',
      'Safe <<span></span>img src="x" on<span></span>error="alert(1)">',
      '',
      'Nested: [[x](javascript:alert(1))](javascript:alert(2))',
      'NestedSafeImg: [![hero](https://cdn.example.com/a.png)](javascript:alert(9))',
      'TabLink: [tab](java\tscript:alert(3))',
      'TabImg: ![bad](java\tscript:alert(1))',
      'SpaceJs: [evil](javascript:alert("hi there"))',
      'SimpleJs: [cleanLabel](javascript:alert(2))',
      'SpaceDataImg: ![bad](data:text/html,hello world)',
      'SpaceDataLink: [evilData](data:text/html, <b>x</b>)',
      'AngleJs: [angleX](<javascript: alert(1)>)',
      '',
      '[badref]: <javascript: alert(1)>',
      '[goodref]: https://example.com/ref "Ref Title"',
      '',
      'ValidTitled: [good](https://example.com/ok "Guide")',
      'ValidParens: [wiki](https://en.wikipedia.org/wiki/NAS_(storage))',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| Noise | 18.5dB |',
      '',
      '```html',
      '<script>const literalInCodeFence = true;</script>',
      '```',
      '',
      '<svg/onload=alert(7) x=1',
    ].join('\n');

    const exportedMd = htmlToExportMarkdown({
      id: 'md_bypass',
      title: 'Markdown Hardening',
      coverUrl: 'https://cdn.example.com/hero_(v2).png',
      contentHtml: '',
      contentText: 'Safe',
      contentMarkdown: md,
    });

    // All bypass vectors eliminated with zero stray ')'
    expect(exportedMd).not.toContain('javascript:');
    expect(exportedMd).not.toContain('java\tscript:');
    expect(exportedMd).not.toContain('data:text/html');
    expect(exportedMd).not.toContain('onerror');
    expect(exportedMd).not.toContain('onload');
    expect(exportedMd).not.toContain('alert(1)');
    expect(exportedMd).not.toContain('alert(2)');
    expect(exportedMd).not.toContain('alert(3)');
    expect(exportedMd).not.toContain('alert(7)');
    expect(exportedMd).not.toContain('alert(9)');
    expect(exportedMd).not.toContain('[badref]:');
    expect(exportedMd).toContain('Nested: x\n');
    expect(exportedMd).toContain('NestedSafeImg: ![hero](https://cdn.example.com/a.png)');
    expect(exportedMd).toContain('TabLink: tab\n');
    expect(exportedMd).toContain('SpaceJs: evil\n');
    expect(exportedMd).toContain('SimpleJs: cleanLabel\n');
    expect(exportedMd).toContain('SpaceDataLink: evilData\n');
    expect(exportedMd).toContain('AngleJs: angleX\n');

    // Legitimate links, titles, balanced parens, coverUrl encoding, GFM tables, and closed code fences preserved
    expect(exportedMd).toContain('![封面](https://cdn.example.com/hero_(v2%29.png)');
    expect(exportedMd).toContain('[goodref]: https://example.com/ref "Ref Title"');
    expect(exportedMd).toContain('ValidTitled: [good](https://example.com/ok "Guide")');
    expect(exportedMd).toContain(
      'ValidParens: [wiki](https://en.wikipedia.org/wiki/NAS_(storage))',
    );
    expect(exportedMd).toContain('| Metric | Value |');
    expect(exportedMd).toContain('| Noise | 18.5dB |');
    expect(exportedMd).toContain('<script>const literalInCodeFence = true;</script>');
  });

  it('executes in linear O(N) time on ReDoS torture payloads across HTML, Markdown, and DOCX exports', () => {
    const t0 = performance.now();
    const htmlRes = sanitizeRichArticleHtml(`<p>x</p>${'<span'.repeat(50_000)}>`);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(htmlRes.contentHtml).toContain('<p>x</p>');

    const mdTorturePayloads = [
      `${'<span'.repeat(19_000)}<b></b>`,
      '[[a]](('.repeat(14_000),
      '['.repeat(50_000),
      '[a]('.repeat(20_000),
      '<!--'.repeat(20_000),
      '<script>'.repeat(20_000),
      '<a>'.repeat(20_000),
      '```a\n'.repeat(10_000),
    ];
    for (const payload of mdTorturePayloads) {
      const start = performance.now();
      const out = htmlToExportMarkdown({
        id: 'redos_md',
        title: 'Perf',
        contentHtml: '',
        contentText: '',
        contentMarkdown: payload,
      });
      expect(performance.now() - start).toBeLessThan(300);
      expect(out).not.toMatch(/<script/i);
    }

    const incompleteLink = `[Read Guide](https://example.com/guide/${'a'.repeat(10_000)}`;
    const tDoc = performance.now();
    const docHtml = htmlToExportDocument({
      id: 'redos_doc',
      title: 'Perf Doc',
      contentHtml: '',
      contentText: '',
      contentMarkdown: incompleteLink,
    });
    const docBytes = buildSingleDocxBytes({
      id: 'redos_docx',
      title: 'Perf Docx',
      contentHtml: '',
      contentText: '',
      contentMarkdown: incompleteLink,
    });
    expect(performance.now() - tDoc).toBeLessThan(250);
    expect(docHtml).toContain('Read Guide');
    expect(docBytes.byteLength).toBeGreaterThan(100);
  });

  it('fails closed on deep 10-layer, 20-layer, and 100-layer tag-reassembly attacks across HTML, MD, and DOCX', () => {
    const nestSpan = (depth: number): string => {
      let s = '<span></span>';
      for (let i = 1; i < depth; i += 1) {
        s = `<sp${s}an></sp${s}an>`;
      }
      return s;
    };
    const nestOpenSpan = (depth: number): string =>
      `${'<'.repeat(depth)}<span>${'span>'.repeat(depth - 1)}`;

    for (const depth of [10, 20, 100]) {
      const htmlPayload = `<p>Safe</p><${nestOpenSpan(depth)}script>alert(1)<${nestOpenSpan(depth)}/script>`;
      const mdPayload = `Safe <${nestOpenSpan(depth)}script>alert(1)<${nestOpenSpan(depth)}/script>`;

      const t0 = performance.now();
      const sanitizedHtml = sanitizeRichArticleHtml(htmlPayload);
      const docHtml = htmlToExportDocument({
        id: `nest_h_${depth}`,
        title: `Nest ${depth}`,
        contentHtml: htmlPayload,
        contentText: 'Safe',
      });
      const exportedMdFromMd = htmlToExportMarkdown({
        id: `nest_m_${depth}`,
        title: `Nest ${depth}`,
        contentHtml: '',
        contentText: 'Safe',
        contentMarkdown: mdPayload,
      });
      const exportedMdFromHtml = htmlToExportMarkdown({
        id: `nest_hm_${depth}`,
        title: `Nest ${depth}`,
        contentHtml: htmlPayload,
        contentText: 'Safe',
      });
      const docxXml = new TextDecoder('utf-8').decode(
        readZipStoreEntries(
          buildSingleDocxBytes({
            id: `nest_d_${depth}`,
            title: `Nest ${depth}`,
            contentHtml: htmlPayload,
            contentText: 'Safe',
          }),
        ).find((e) => e.path === 'word/document.xml')!.data,
      );
      expect(performance.now() - t0).toBeLessThan(200);

      expect(sanitizedHtml.contentHtml).not.toMatch(/<script/i);
      expect(docHtml).not.toMatch(/<script/i);
      expect(exportedMdFromMd).not.toMatch(/<script/i);
      expect(exportedMdFromHtml).not.toMatch(/<script/i);
      expect(docxXml).not.toMatch(/<script/i);

      // Idempotency: f(f(x)) === f(x)
      expect(sanitizeRichArticleHtml(sanitizedHtml.contentHtml).contentHtml).toBe(
        sanitizedHtml.contentHtml,
      );
    }

    // Also verify interleaved 10-layer nested <span></span> variant
    const nestedInterleaved = `<p>Safe</p><${nestSpan(10)}script>alert(1)<${nestSpan(10)}/script>`;
    expect(sanitizeRichArticleHtml(nestedInterleaved).contentHtml).not.toMatch(/<script/i);
  });

  it('closes all 5 CommonMark Markdown link/ref/autolink XSS bypasses while preserving legitimate Markdown and idempotency', () => {
    const md = [
      'DeepBracket: [[[[x]]]](javascript:alert(1))',
      'EscapedBracket: [foo\\]](javascript:alert(2))',
      'MultilineLabel: [click\nhere](javascript:alert(3))',
      'MultilineDest: [click](\njavascript:alert(4)\n)',
      '',
      '[ref][x]',
      '',
      '[x]:',
      'javascript:alert(5)',
      '',
      '[y\\]]:',
      '  vbscript:msgbox(6)',
      '',
      'AutoJs: <javascript:alert(7)>',
      'AutoVbs: <vbscript:msgbox(8)>',
      'AutoData: <data:text/html,<b>x</b>>',
      'AutoEntity: <&#106;avascript:alert(9)>',
      '',
      'KeepTitled: [good](https://example.com/ok "Guide")',
      'KeepWiki: [wiki](https://en.wikipedia.org/wiki/NAS_(storage))',
      'KeepBadge: [![CI](https://img.shields.io/badge.svg)](https://github.com/org/repo)',
      'KeepBracketLabel: [Best [2026] Guide](https://example.com/guide)',
      '',
      '| ColA | ColB |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```js',
      'const literal = "<javascript:alert(1)>";',
      '```',
    ].join('\n');

    const exported = htmlToExportMarkdown({
      id: 'cm_bypass',
      title: 'CommonMark Security',
      contentHtml: '',
      contentText: '',
      contentMarkdown: md,
    });

    const outsideFence = exported.split('```js')[0] ?? exported;
    expect(outsideFence).not.toContain('javascript:alert');
    expect(outsideFence).not.toContain('vbscript:msgbox');
    expect(outsideFence).not.toContain('data:text/html');
    expect(outsideFence).not.toContain('&#106;avascript:');
    expect(outsideFence).not.toContain('[x]:');
    expect(outsideFence).not.toContain('[y\\]]:');

    // Legitimate Markdown preserved
    expect(exported).toContain('KeepTitled: [good](https://example.com/ok "Guide")');
    expect(exported).toContain('KeepWiki: [wiki](https://en.wikipedia.org/wiki/NAS_(storage))');
    expect(exported).toContain(
      'KeepBadge: [![CI](https://img.shields.io/badge.svg)](https://github.com/org/repo)',
    );
    expect(exported).toContain('KeepBracketLabel: [Best [2026] Guide](https://example.com/guide)');
    expect(exported).toContain('| ColA | ColB |');
    expect(exported).toContain('const literal = "<javascript:alert(1)>";');

    // Idempotency
    const secondPass = htmlToExportMarkdown({
      id: 'cm_bypass',
      title: 'CommonMark Security',
      contentHtml: '',
      contentText: '',
      contentMarkdown: exported,
    });
    expect(secondPass).toBe(exported);
  });

  it('sanitizes HTML-only fallback after entity decoding, sanitizes raw HTML titles, and encodes ) in HTML-only URLs', () => {
    const exported = htmlToExportMarkdown({
      id: 'html_fallback_xss',
      title: '<script>alert(9)</script> Clean\nTitle',
      contentHtml: [
        '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
        '<p>&lt;iframe src="https://evil.com"&gt;&lt;/iframe&gt;</p>',
        '<p>&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;</p>',
        '<p>Click [evil](javascript:alert(1))</p>',
        '<p>![x](javascript:alert(1))</p>',
        '<p>[x]: javascript:alert(1)</p>',
        '<p><a href="https://en.wikipedia.org/wiki/NAS_(storage)">Wiki</a></p>',
        '<p><img src="https://cdn.example.com/hero_(1).png" alt="Hero" /></p>',
        '<pre><code>&lt;script&gt;keepInFence()&lt;/script&gt;</code></pre>',
      ].join(''),
      contentText: '',
      contentMarkdown: '',
    });

    expect(exported.startsWith('# Clean Title\n')).toBe(true);
    expect(exported).not.toContain('alert(9)');
    expect(exported).not.toContain('alert(1)');
    expect(exported).not.toMatch(/<iframe/i);
    expect(exported).not.toContain('javascript:');
    expect(exported).not.toContain('[x]:');
    expect(exported).toContain('[Wiki](https://en.wikipedia.org/wiki/NAS_(storage%29)');
    expect(exported).toContain('![Hero](https://cdn.example.com/hero_(1%29.png)');
    expect(exported).toContain('<script>keepInFence()</script>');

    // Raw title in contentMarkdown branch is also sanitized
    const exportedFromMd = htmlToExportMarkdown({
      id: 'md_title_xss',
      title: '<script>alert(9)</script> Safe Title',
      contentHtml: '',
      contentText: '',
      contentMarkdown: 'Body text',
    });
    expect(exportedFromMd).toBe('# Safe Title\n\nBody text\n');
  });

  it('executes in linear O(N) time on adjacent-whitespace, GFM-table, paired-tag, and FAQ ReDoS payloads', () => {
    const timed = (fn: () => void, limitMs = 500) => {
      const start = performance.now();
      fn();
      expect(performance.now() - start).toBeLessThan(limitMs);
    };

    // Fix 1: adjacent whitespace / lazy-tail / FAQ / SPEC_METRIC_RE backtracking payloads
    timed(() => {
      htmlToExportMarkdown({
        id: 'ws_1',
        title: 'Perf',
        contentHtml: '',
        contentText: '',
        contentMarkdown: `<${' '.repeat(50_000)}1`,
      });
    });
    timed(() => {
      htmlToExportMarkdown({
        id: 'ws_2',
        title: 'Perf',
        contentHtml: '',
        contentText: '',
        contentMarkdown: `<${' '.repeat(30_000)}1>`,
      });
    });
    timed(() => {
      sanitizeRichArticleHtml(`<p>ok</p><${' '.repeat(50_000)}1`);
    });
    timed(() => {
      sanitizeRichArticleHtml(`<p>ok</p><${' '.repeat(16_000)}!>`);
    });
    timed(() => {
      sanitizeRichArticleHtml(`<p href=${' '.repeat(30_000)}x>ok</p>`);
    });
    timed(() => {
      htmlToExportMarkdown({
        id: 'ws_img',
        title: 'Perf',
        contentHtml: '',
        contentText: '',
        contentMarkdown: `<img ${' '.repeat(30_000)}src="x">`,
      });
    });
    timed(() => {
      htmlToExportMarkdown({
        id: 'ws_title',
        title: `<${' '.repeat(16_000)}!>`,
        contentHtml: '',
        contentText: '',
        contentMarkdown: 'Safe',
      });
    });
    timed(() => {
      const res = evaluateGeoArticle({
        market: 'GLOBAL',
        localBrandName: 'Brand',
        title: 'FAQ Perf',
        targetPrompt: 'FAQ',
        contentMarkdown: `Q:${' '.repeat(20_000)}\nA:${' '.repeat(20_000)}ok`,
      });
      expect(res.geoScore).toBeGreaterThanOrEqual(0);
    });
    timed(() => {
      evaluateGeoArticle({
        market: 'CN',
        localBrandName: 'Brand',
        title: 'Digits Perf',
        targetPrompt: 'Digits',
        contentMarkdown: '1'.repeat(50_000),
      });
    });

    // Fix 2: GFM_TABLE_PRESENT_RE & paired-tag unclosed HTML torture payloads
    const brokenGfm = `|a|b|\n${'|---'.repeat(35_000)}x`;
    timed(() => {
      const res = evaluateGeoArticle({
        market: 'GLOBAL',
        localBrandName: 'Brand',
        title: 'GFM Perf',
        targetPrompt: 'GFM',
        contentMarkdown: brokenGfm,
      });
      expect(res.geoScoreDetail.dimensions.structuredExtractable.score).toBe(0);
    });
    timed(() => {
      htmlToExportDocument({
        id: 'gfm_doc',
        title: 'GFM Doc',
        contentHtml: '',
        contentText: '',
        contentMarkdown: brokenGfm,
      });
    });
    timed(() => {
      const bytes = buildSingleDocxBytes({
        id: 'docx_p',
        title: 'Docx P',
        contentHtml: '<p>'.repeat(49_000),
        contentText: '',
      });
      expect(bytes.byteLength).toBeGreaterThan(100);
    });

    const htmlOnlyPairedTorture = [
      '<pre>'.repeat(29_000),
      '<table>'.repeat(20_000),
      '<li>'.repeat(25_000),
      '<code>'.repeat(20_000),
      '<strong>'.repeat(15_000),
      `<table>${'<tr>'.repeat(15_000)}</table>`,
      `<table><tr>${'<td>'.repeat(15_000)}</tr></table>`,
    ];
    for (const htmlPayload of htmlOnlyPairedTorture) {
      timed(() => {
        htmlToExportMarkdown({
          id: 'paired_md',
          title: 'Paired',
          contentHtml: htmlPayload,
          contentText: '',
        });
      });
    }
  });

  it('fails closed and stays strictly idempotent on 60-deep and 100-deep obfuscated nested Markdown links', () => {
    const buildDeepNested = (depth: number, scheme: string): string => {
      let s = 'x';
      for (let i = 0; i < depth; i += 1) {
        s = `[${s}](${scheme}alert(${i}))`;
      }
      return s;
    };

    for (const depth of [60, 100]) {
      for (const scheme of ['java\tscript:', '&#106;avascript:']) {
        const payload = buildDeepNested(depth, scheme);
        const start = performance.now();
        const pass1 = htmlToExportMarkdown({
          id: `deep_${depth}`,
          title: 'Deep Link',
          contentHtml: '',
          contentText: '',
          contentMarkdown: payload,
        });
        expect(performance.now() - start).toBeLessThan(50);

        expect(pass1).not.toContain('](');
        expect(pass1).not.toContain(']:');
        expect(pass1.toLowerCase()).not.toContain('javascript:');
        expect(pass1.toLowerCase()).not.toContain('java\tscript:');
        expect(pass1.toLowerCase()).not.toContain('&#106;avascript:');

        const pass2 = htmlToExportMarkdown({
          id: `deep_${depth}`,
          title: 'Deep Link',
          contentHtml: '',
          contentText: '',
          contentMarkdown: pass1,
        });
        expect(pass2).toBe(pass1);
      }
    }
  });

  it('prevents CommonMark §4.5 fenced code block breakouts and <pre> sentinel collisions while preserving valid code fences', () => {
    const breakoutVectors = [
      '```\na\n``` \n<script>alert(1)</script>\n```',
      '```\na\n  ```\n<script>alert(1)</script>\n```',
      '```\na\n````\n<script>alert(1)</script>\n```',
      '```js `\n<script>alert(1)</script>\n```',
      '```a`\n<script>alert(1)</script>\n```',
      '~~~\n```\n~~~\n<script>alert(1)</script>\n```',
    ];

    for (const md of breakoutVectors) {
      const exported = htmlToExportMarkdown({
        id: 'fence_breakout',
        title: 'Fence',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(exported).not.toMatch(/<script/i);
      expect(exported).not.toContain('alert(1)');
    }

    // HTML-only <pre> containing indented ``` wraps with 4-backtick CommonMark fence and avoids __GM_PRE_BLOCK_0__ collision
    const preExport = htmlToExportMarkdown({
      id: 'pre_breakout',
      title: 'Pre Fence',
      contentHtml:
        '<p>Keep literal __GM_PRE_BLOCK_0__ here</p><pre><code>x\n   ```\n&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>',
      contentText: '',
    });
    expect(preExport).toContain('Keep literal __GM_PRE_BLOCK_0__ here');
    expect(preExport).toContain('````\nx\n   ```\n<script>alert(1)</script>\n````');

    // Valid closed backtick code fence is preserved verbatim
    const validFence = htmlToExportMarkdown({
      id: 'valid_fence',
      title: 'Valid Fence',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '```json\n{"html":"<script>literal</script>"}\n```',
    });
    expect(validFence).toContain('```json\n{"html":"<script>literal</script>"}\n```');
  });

  it('strips CommonMark §4.7 multiline and container-block unsafe reference-link definitions while preserving safe ones', () => {
    const md = [
      '[click][a\nb]',
      '',
      '[a\nb]: javascript:alert(1)',
      '',
      '[c\nd]: vbscript:msgbox(2)',
      '',
      '> [x]: javascript:alert(3)',
      '',
      '- [y]: javascript:alert(4)',
      '',
      '1. [z]: javascript:alert(5)',
      '',
      '> - [m\nn]:\n>   javascript:alert(6)',
      '',
      '> [p\n> q]:\n>   data:text/html,<b>x</b>',
      '',
      '[ref]: https://example.com/guide "Guide"',
      '',
      '[multi\nref]: https://example.com/multi',
      '',
      '> [safe-quote]: https://example.com/quoted',
    ].join('\n');

    const exported = htmlToExportMarkdown({
      id: 'cm_ref_defs',
      title: 'Ref Defs',
      contentHtml: '',
      contentText: '',
      contentMarkdown: md,
    });

    expect(exported.toLowerCase()).not.toContain('javascript:');
    expect(exported.toLowerCase()).not.toContain('vbscript:');
    expect(exported.toLowerCase()).not.toContain('data:text/html');
    expect(exported).toContain('[ref]: https://example.com/guide "Guide"');
    expect(exported).toContain('[multi\nref]: https://example.com/multi');
    expect(exported).toContain('> [safe-quote]: https://example.com/quoted');

    // Idempotency
    const exported2 = htmlToExportMarkdown({
      id: 'cm_ref_defs',
      title: 'Ref Defs',
      contentHtml: '',
      contentText: '',
      contentMarkdown: exported,
    });
    expect(exported2).toBe(exported);
  });

  it('normalizes bare CR (CommonMark §2.2) across fences, ref defs, tables, and FAQ extraction', () => {
    const crVectors = [
      '```\na\n```\r<script>alert(1)</script>\n```',
      '~~~\na\n~~~\r<script>alert(1)</script>\n~~~',
      '```\na\n```\r[click](javascript:alert(1))\n```',
      '# Heading\r[x]: javascript:alert(1)\n\n[click][x]',
      'hello\r\r[x]: javascript:alert(1)\n\n[click][x]',
    ];
    for (const md of crVectors) {
      const exported = htmlToExportMarkdown({
        id: 'cr_vec',
        title: 'CR Test',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(exported).not.toContain('\r');
      expect(exported).not.toMatch(/<script/i);
      expect(exported.toLowerCase()).not.toContain('javascript:');
      expect(exported).not.toContain('[x]:');
    }

    const crEval = evaluateGeoArticle({
      market: 'GLOBAL',
      localBrandName: 'AstraVault',
      title: 'CR Eval',
      targetPrompt: 'Best 4-bay NAS',
      contentMarkdown:
        'AstraVault DXP4800 runs at 18.5dB.\r\r| Metric | Value |\r| --- | --- |\r| Noise | 18.5dB |\r\r**Q: Is it quiet?**\rA: Yes, 18.5dB.',
    });
    expect(crEval.geoScoreDetail.dimensions.structuredExtractable.score).toBeGreaterThanOrEqual(8);
  });

  it('runs in linear O(N) time on 50k "<" payloads across all tag-stripping paths and avoids <pre> sentinel duplication', async () => {
    const { countArticleWords } = await import('./geo-delivery');
    const lt50k = '<'.repeat(50_000);

    const timed = (fn: () => void, limitMs = 500) => {
      const start = performance.now();
      fn();
      expect(performance.now() - start).toBeLessThan(limitMs);
    };

    timed(() => {
      htmlToExportMarkdown({
        id: 'lt_pre',
        title: 'LT Pre',
        contentHtml: `<pre>${lt50k}</pre>`,
        contentText: '',
      });
    });
    timed(() => {
      htmlToExportMarkdown({
        id: 'lt_a',
        title: 'LT A',
        contentHtml: '',
        contentText: '',
        contentMarkdown: `<a href="https://example.com">${lt50k}</a>`,
      });
    });
    timed(() => {
      htmlToExportMarkdown({
        id: 'lt_td',
        title: 'LT TD',
        contentHtml: `<table><tr><td>${lt50k}</td></tr></table>`,
        contentText: '',
      });
    });
    timed(() => {
      const bytes = buildSingleDocxBytes({
        id: 'lt_docx',
        title: 'LT DOCX',
        contentHtml: `<p>${lt50k}</p>`,
        contentText: '',
      });
      expect(bytes.byteLength).toBeGreaterThan(100);
    });
    timed(() => {
      evaluateGeoArticle({
        market: 'GLOBAL',
        localBrandName: 'Brand',
        title: 'LT FAQ',
        targetPrompt: 'FAQ',
        contentMarkdown: `Q: ${lt50k}\nA: ok`,
      });
    });
    timed(() => {
      sanitizeRichArticleHtml(`<p>ok</p>${lt50k}`);
    });
    timed(() => {
      sanitizeRichArticleHtml(`<p>ok</p>${'<0 '.repeat(50_000)}`);
    });
    timed(() => {
      expect(countArticleWords(lt50k)).toBe(50_000);
    });

    // Sentinel collision via stripped inline tag must not duplicate <pre> block
    const sentinelExport = htmlToExportMarkdown({
      id: 'sentinel_u',
      title: 'Sentinel',
      contentHtml: '<p>G<u></u>MPREBLK0END</p><pre><code>hello world</code></pre>',
      contentText: '',
    });
    expect(sentinelExport.match(/hello world/g)?.length).toBe(1);
    expect(sentinelExport).toContain('GMPREBLK0END');
  });

  it('closes CommonMark fence-desync and list-indented fence breakouts with fixed-point convergence while preserving column-0 fences', () => {
    const fenceBreakouts = [
      '<span></span>```\na\n```\n<script>alert(1)</script>\n```',
      '<!--x-->```\na\n```\n<script>alert(1)</script>\n```',
      '![x](javascript:alert(1))```\na\n```\n<script>alert(1)</script>\n```',
      '```<script>`</script>\na\n```\n<script>alert(1)</script>\n```',
      '- item\n  ```\n<script>alert(1)</script>\n  ```',
      '1. item\n   ```\n<script>alert(1)</script>\n   ```',
      '- item\n\n  ```\n  a\n    ```\n  <script>alert(1)</script>\n  ```',
      '- item\n\n  ~~~\n  a\n    ~~~\n  <script>alert(1)</script>\n  ~~~',
      '1. item\n\n   ```\n   a\n      ```\n   <script>alert(1)</script>\n   ```',
      '- item\n\n  ```\n  a\n\t```\n  <script>alert(1)</script>\n  ```',
    ];

    for (const md of fenceBreakouts) {
      const pass1 = htmlToExportMarkdown({
        id: 'fence_i6',
        title: 'Fence I6',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1).not.toMatch(/<script/i);
      expect(pass1).not.toContain('alert(1)');
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'fence_i6',
        title: 'Fence I6',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    // Legitimate column-0 code fences remain 100% preserved
    const valid = htmlToExportMarkdown({
      id: 'col0_valid',
      title: 'Col0',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '```html\n<div class="demo">safe</div>\n```',
    });
    expect(valid).toContain('```html\n<div class="demo">safe</div>\n```');
  });

  it('strips CommonMark §4.7/§5.2 list-indented (4+ spaces & tab) unsafe ref-link defs while preserving safe indented ones', () => {
    const vectors = [
      '[click][x]\n\n- item\n\n    [x]: javascript:alert(1)',
      '[click][x]\n\n- item\n\n     [x]: javascript:alert(1)',
      '[click][x]\n\n- a\n  - b\n\n    [x]: javascript:alert(1)',
      '[click][x]\n\n1. item\n\n    [x]: javascript:alert(1)',
      '[click][x]\n\n100. a\n\n     [x]: javascript:alert(1)',
      '[click][x]\n\n- item\n\n\t[x]: javascript:alert(1)',
    ];
    for (const md of vectors) {
      const exported = htmlToExportMarkdown({
        id: 'list_ref',
        title: 'List Ref',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(exported.toLowerCase()).not.toContain('javascript:');
      expect(exported).not.toContain('[x]:');
    }

    const safeIndented = htmlToExportMarkdown({
      id: 'safe_list_ref',
      title: 'Safe List Ref',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '- item\n\n    [safe]: https://example.com/docs "Docs"\n\n[read][safe]',
    });
    expect(safeIndented).toContain('    [safe]: https://example.com/docs "Docs"');
  });

  it('neutralizes CommonMark §6.1/§6.3 inline code-span "]" inside link/image labels in O(N) while preserving valid code-span links', () => {
    const mdVectors = [
      '[`]`](javascript:alert(1))',
      '![`]`](javascript:alert(1))',
      '[click `]` here](javascript:alert(1))',
      '[`` ] ``](javascript:alert(1))',
      '[click `\\]` here](javascript:alert(1))',
      '[click `\\`](javascript:alert(1))',
      '[click `\\` `]` here](javascript:alert(1))',
      '[click \\``]` here](javascript:alert(1))',
      '[click](javascript:x`)`',
    ];
    for (const md of mdVectors) {
      const exported = htmlToExportMarkdown({
        id: 'codespan_xss',
        title: 'CodeSpan',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(exported.toLowerCase()).not.toContain('javascript:');
    }

    // HTML-only branch producing [`]`](javascript:alert(1))
    const htmlOnly = htmlToExportMarkdown({
      id: 'codespan_html',
      title: 'CodeSpan HTML',
      contentHtml: '<p>[<code>]</code>](javascript:alert(1))</p>',
      contentText: '',
    });
    expect(htmlOnly.toLowerCase()).not.toContain('javascript:');

    // Legitimate links with code spans in labels are preserved
    const legit = htmlToExportMarkdown({
      id: 'codespan_legit',
      title: 'CodeSpan Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown:
        'See [`Array[0]`](https://example.com/docs) and [click `]` here](https://example.com/docs).',
    });
    expect(legit).toContain('[`Array[0]`](https://example.com/docs)');
    expect(legit).toContain('[click `]` here](https://example.com/docs)');

    // Adversarial unclosed backticks of 400 distinct lengths & 20k repeated backtick runs stay O(N)
    const distinctTicks = Array.from({ length: 400 }, (_, idx) => '`'.repeat(idx + 1)).join(' ');
    const t0 = performance.now();
    htmlToExportMarkdown({
      id: 'ticks_distinct',
      title: 'Ticks',
      contentHtml: '',
      contentText: '',
      contentMarkdown: `[x ${distinctTicks}](https://example.com/ok)`,
    });
    expect(performance.now() - t0).toBeLessThan(100);

    const t1 = performance.now();
    htmlToExportMarkdown({
      id: 'ticks_repeat',
      title: 'Ticks Repeat',
      contentHtml: '',
      contentText: '',
      contentMarkdown: `[${'`` '.repeat(20_000)}](https://example.com/ok)`,
    });
    expect(performance.now() - t1).toBeLessThan(150);
  });

  it('executes in linear O(N) time (< 100ms) on unclosed-tag + trailing-gt-removal, PI/CDATA/Declaration, and autolink ReDoS payloads', () => {
    // Warm up JIT paths before tight latency assertions
    htmlToExportMarkdown({
      id: 'warm',
      title: 'Warm',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '<img src="x"><span >[a](<javascript:1>) <?x?> <![CDATA[y]]> <!A> <a:b>',
    });

    const vectors: Array<[string, string]> = [
      ['img_25k_js', `${'<img '.repeat(25_000)}<javascript:1>`],
      ['span_25k_js', `${'<span '.repeat(25_000)}<javascript:1>`],
      ['a_25k_js', `${'<a '.repeat(25_000)}<javascript:1>`],
      ['lt_sp_50k_gt', `${'< '.repeat(50_000)}>`],
      ['span_25k_mdlink', `${'<span '.repeat(25_000)}[a](<javascript:1>)`],
      ['span_25k_refdef', `${'<span '.repeat(25_000)}\n[x]: <javascript:1>`],
      ['pi_25k', '<?'.repeat(25_000)],
      ['cdata_10k', '<![CDATA['.repeat(10_000)],
      ['decl_25k', '<!A'.repeat(25_000)],
      ['autolink_uri_20k', '<a:'.repeat(20_000)],
      ['autolink_uri_long', `<a:${'x'.repeat(50_000)}`],
      ['autolink_email_20k', '<a@b'.repeat(20_000)],
    ];

    for (const [id, payload] of vectors) {
      const start = performance.now();
      const exported = htmlToExportMarkdown({
        id,
        title: 'Linear',
        contentHtml: '',
        contentText: '',
        contentMarkdown: payload,
      });
      expect(performance.now() - start).toBeLessThan(100);
      expect(exported.toLowerCase()).not.toContain('javascript:');
      expect(exported).not.toMatch(/<script/i);
    }
  });

  it('closes CommonMark §4.6/§6.6 HTML Block Types 3/4/5/7 and raw HTML inline XSS breakouts while preserving legitimate code fences', () => {
    const mdBreakouts = [
      '<b>\n```\n<script>alert(1)</script>\n```',
      '</b>\n```\n<script>alert(1)</script>\n```',
      '<strong>\n```\n<script>alert(1)</script>\n```',
      '<br>\n```\n<script>alert(1)</script>\n```',
      '<br />\n```\n<script>alert(1)</script>\n```',
      '<code>\n~~~\n<script>alert(1)</script>\n~~~',
      '<u>\n~~~\n<script>alert(1)</script>\n~~~',
      '<b>\nfoo\n```\n<script>alert(1)</script>\n```',
      '<b>\n```\n\n<script>alert(1)</script>\n```',
      '<?\n\n```\n<script>alert(1)</script>\n```',
      '<?\n```\n?><script>alert(1)</script>\n```',
      '<![CDATA[\n<b>\n```\n]]><script>alert(1)</script>\n```',
      '<!DOCTYPE html>\n```\n<script>alert(1)</script>\n```',
      '[click <? ] ?> here](javascript:alert(1))',
      'hello <? ` ?> [click `](javascript:alert(1))',
      '[click <!A ] > here](javascript:alert(1))',
      'hello <!A ` > [click `](javascript:alert(1))',
      '[click <![CDATA[ ] ]]> here](javascript:alert(1))',
      '![x](javascript:alert(1))<b>\n```\n<script>alert(1)</script>\n```',
    ];

    for (const md of mdBreakouts) {
      const pass1 = htmlToExportMarkdown({
        id: 'cm46_md',
        title: 'CM46',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1).not.toMatch(/<script/i);
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'cm46_md',
        title: 'CM46',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    const htmlOnlyBreakouts = [
      '<p>&lt;b&gt;<br />```<br />&lt;script&gt;alert(1)&lt;/script&gt;<br />```</p>',
      '<p>&lt;?<br>```<br>?&gt;&lt;script&gt;alert(1)&lt;/script&gt;<br>```</p>',
      '<p>&lt;![CDATA[<br>&lt;b&gt;<br>```<br>]]&gt;&lt;script&gt;alert(1)&lt;/script&gt;<br>```</p>',
    ];
    for (const html of htmlOnlyBreakouts) {
      const exported = htmlToExportMarkdown({
        id: 'cm46_html',
        title: 'CM46 HTML',
        contentHtml: html,
        contentText: '',
      });
      expect(exported).not.toMatch(/<script/i);
      expect(exported.toLowerCase()).not.toContain('javascript:');
    }

    // Legitimate fences after blank line or plain paragraph text stay preserved verbatim
    const bBlankFence = htmlToExportMarkdown({
      id: 'legit_b_blank',
      title: 'Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '<b>bold</b>\n\n```\n<script>literal</script>\n```',
    });
    expect(bBlankFence).toContain('<b>bold</b>');
    expect(bBlankFence).toContain('```\n<script>literal</script>\n```');

    const summaryFence = htmlToExportMarkdown({
      id: 'legit_summary',
      title: 'Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: 'Summary\n```\n<script>literal</script>\n```',
    });
    expect(summaryFence).toContain('Summary\n```\n<script>literal</script>\n```');
  });

  it('closes CommonMark §6.5 URI/email autolink, block-boundary, GFM table-cell, and residual unsafe-dest XSS bypasses while preserving legitimate Markdown', () => {
    const mdVectors = [
      '![<https://example.com/]>](javascript:alert(1))',
      '![<ab:x]>](javascript:alert(1))',
      '![<mailto:a@b.com?x=]>](javascript:alert(1))',
      '[<https://example.com/]>](javascript:alert(1))',
      '![alt <https://example.com/a]b> here](javascript:alert(1))',
      '<https://example.com/`> [click `](javascript:alert(1))',
      '<a`b@example.com> [click `](javascript:alert(1))',
      '`\n# heading\n[click `](javascript:alert(1))',
      '`hello\n===\n[click `](javascript:alert(1))',
      '`\n---\n[click `](javascript:alert(1))',
      '`\n***\n[click `](javascript:alert(1))',
      '`\n___\n[click `](javascript:alert(1))',
      '`\n> [click `](javascript:alert(1))',
      '`\n- [click `](javascript:alert(1))',
      '`\n1. [click `](javascript:alert(1))',
      '| a | b |\n| --- | --- |\n| ` | c |\n| [click `](javascript:alert(1)) | d |',
      '| a | b |\n| --- | --- |\n| ` | [click `](javascript:alert(1)) |',
      '| ` | [click `](javascript:alert(1)) |',
      '[click [x](https://example.com/]) here](javascript:alert(1))',
      '> [click\nhere](javascript:alert(1))',
    ];

    for (const md of mdVectors) {
      const pass1 = htmlToExportMarkdown({
        id: 'cm65_md',
        title: 'CM65',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'cm65_md',
        title: 'CM65',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    const htmlOnlyVectors = [
      '<p>![&lt;https://example.com/]&gt;](javascript:alert(1))</p>',
      '<p>`<br /># heading<br />[click `](javascript:alert(1))</p>',
    ];
    for (const html of htmlOnlyVectors) {
      const exported = htmlToExportMarkdown({
        id: 'cm65_html',
        title: 'CM65 HTML',
        contentHtml: html,
        contentText: '',
      });
      expect(exported.toLowerCase()).not.toContain('javascript:');
    }

    // Legitimate preservation + idempotency
    const legitMd = [
      'See [`Array[0]`](https://example.com/docs).',
      '',
      '![alt <https://example.com/a]b>](https://example.com/pic.png)',
      '',
      'Inline code example: `[demo](javascript:void(0))` stays literal.',
      '',
      '`',
      '# Heading',
      '[Safe Docs](https://example.com/safe)',
    ].join('\n');

    const pass1 = htmlToExportMarkdown({
      id: 'cm65_legit',
      title: 'Legit CM65',
      contentHtml: '',
      contentText: '',
      contentMarkdown: legitMd,
    });
    expect(pass1).toContain('[`Array[0]`](https://example.com/docs)');
    expect(pass1).toContain('![alt <https://example.com/a]b>](https://example.com/pic.png)');
    expect(pass1).toContain('`[demo](javascript:void(0))`');
    expect(pass1).toContain('[Safe Docs](https://example.com/safe)');

    const pass2 = htmlToExportMarkdown({
      id: 'cm65_legit',
      title: 'Legit CM65',
      contentHtml: '',
      contentText: '',
      contentMarkdown: pass1,
    });
    expect(pass2).toBe(pass1);
  });

  it('closes Closure 8-1: safe Markdown link/image/ref-def URL backticks & quoted title backtick/angle-bracket blinding with strict idempotency', () => {
    const mdPayloads = [
      '[a](https://example.com/`)[b](javascript:alert(1))`',
      '![a](https://example.com/`)[b](javascript:alert(1))`',
      '[a](https://example.com/ "t`")[b](javascript:alert(1))`',
      '[a](https://example.com/ \x27t`\x27)[b](javascript:alert(1))`',
      '[a](https://example.com/ "<ab:")[b](javascript:alert(1))>',
      '[a](<https://example.com/`>)[b](javascript:alert(1))`',
      '[ref]: https://example.com/`\n[b](javascript:alert(1))`',
      '[ref]: https://example.com/ "t`"\n[b](javascript:alert(1))`',
      '[ref]: https://example.com/\n"t`"\n[b](javascript:alert(1))`',
    ];

    for (const md of mdPayloads) {
      const pass1 = htmlToExportMarkdown({
        id: 'c81_md',
        title: 'Closure 8-1',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'c81_md',
        title: 'Closure 8-1',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    // HTML-only path with backtick in safe href
    const htmlOnly1 = htmlToExportMarkdown({
      id: 'c81_html',
      title: 'Closure 8-1 HTML',
      contentHtml: '<p><a href="https://example.com/`">a</a>[b](javascript:alert(1))`</p>',
      contentText: '',
    });
    expect(htmlOnly1.toLowerCase()).not.toContain('javascript:');
    expect(htmlOnly1).toContain('[a](https://example.com/%60)');
    expect(
      htmlToExportMarkdown({
        id: 'c81_html',
        title: 'Closure 8-1 HTML',
        contentHtml: '',
        contentText: '',
        contentMarkdown: htmlOnly1,
      }),
    ).toBe(htmlOnly1);

    // Legitimate URLs with balanced parens & normal/special titles preserved cleanly and idempotently
    const legit = htmlToExportMarkdown({
      id: 'c81_legit',
      title: 'Closure 8-1 Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: [
        '[wiki](https://en.wikipedia.org/wiki/NAS_(storage) "NAS Guide")',
        '[quoted](https://example.com/docs "Code `fn` <v2>")',
        '[ref]: https://example.com/ref "Ref Title"',
      ].join('\n\n'),
    });
    expect(legit).toContain('[wiki](https://en.wikipedia.org/wiki/NAS_(storage) "NAS Guide")');
    expect(legit).toContain('[quoted](https://example.com/docs "Code &#96;fn&#96; &lt;v2&gt;")');
    expect(legit).toContain('[ref]: https://example.com/ref "Ref Title"');
    expect(
      htmlToExportMarkdown({
        id: 'c81_legit',
        title: 'Closure 8-1 Legit',
        contentHtml: '',
        contentText: '',
        contentMarkdown: legit,
      }),
    ).toBe(legit);
  });

  it('closes Closure 8-2: verified GFM table scoping, exact CommonMark §4/§5 paragraph interruption, and triple-view opaque intersection', () => {
    const mdVectors = [
      // Non-table pipe splitting vectors
      '`foo | bar` [click](javascript:alert(1)) `',
      '`foo | bar` ![x](javascript:alert(1)) `',
      '`a | ` [b](javascript:alert(1))`',
      '`a | ` ![b](javascript:alert(1))`',
      '<https://example.com/a|b`> [click](javascript:alert(1)) `',
      '# `foo | bar` [click](javascript:alert(1)) `',
      '- `foo | bar` [click](javascript:alert(1)) `',
      '`foo \\\\| bar` [click](javascript:alert(1)) `',
      // False block-boundary vectors (lazy blockquote, non-1 ordered list, 4sp/tab list, backtick fence with backtick info)
      '> `a\n` [b](javascript:alert(1))`',
      '> > `\n> ` [click](javascript:alert(1)) `',
      '> `\r` [click](javascript:alert(1)) `',
      'hello `\n2. ` [click](javascript:alert(1)) `',
      '`a\n2. ` [b](javascript:alert(1))`',
      'hello `\n99) ` [click](javascript:alert(1)) `',
      'hello `\n    - ` [click](javascript:alert(1)) `',
      'hello `\n\t- ` [click](javascript:alert(1)) `',
      'hello ```\n``` [click](javascript:alert(1)) ```',
      'hello ````\n```` [click](javascript:alert(1)) ````',
      // CommonMark-vs-GFM polyglot table cell attack
      '| h1 | h2 |\n| --- | --- |\n| `a | ` [b](javascript:alert(1))` |',
      // Verified GFM table cell backtick blocking
      '| a | b |\n| --- | --- |\n| ` | [click `](javascript:alert(1)) |',
    ];

    for (const md of mdVectors) {
      const pass1 = htmlToExportMarkdown({
        id: 'c82_md',
        title: 'Closure 8-2',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'c82_md',
        title: 'Closure 8-2',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    const htmlOnlyVectors = [
      '<p>`foo | bar` [click](javascript:alert(1)) `</p>',
      '<p>`a | ` [b](javascript:alert(1))`</p>',
      '<p>&gt; `<br />` [click](javascript:alert(1)) `</p>',
      '<p>`a<br>2. ` [b](javascript:alert(1))`</p>',
    ];
    for (const html of htmlOnlyVectors) {
      const exported = htmlToExportMarkdown({
        id: 'c82_html',
        title: 'Closure 8-2 HTML',
        contentHtml: html,
        contentText: '',
      });
      expect(exported.toLowerCase()).not.toContain('javascript:');
    }

    // Legitimate preservation + idempotency
    const legit = htmlToExportMarkdown({
      id: 'c82_legit',
      title: 'Closure 8-2 Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: [
        'Inline code example: `[demo](javascript:void(0))` stays literal.',
        '[a | b](https://example.com/path?a=1&copy=2)',
        '| Metric | Example |\n| --- | --- |\n| Safe | `[demo](javascript:void(0))` |',
      ].join('\n\n'),
    });
    expect(legit).toContain('`[demo](javascript:void(0))`');
    expect(legit).toContain('[a | b](https://example.com/path?a=1&copy=2)');
    expect(legit).toContain('| Safe | `[demo](javascript:void(0))` |');
    expect(
      htmlToExportMarkdown({
        id: 'c82_legit',
        title: 'Closure 8-2 Legit',
        contentHtml: '',
        contentText: '',
        contentMarkdown: legit,
      }),
    ).toBe(legit);
  });

  it('closes Closure 8-3: fail-closed allowlist in hasUnsafeMarkdownDestinationScheme against HTML5 entities, long numeric padding, backslash escapes, and ReDoS', () => {
    const mdVectors = [
      '[click | here](javascript&colon;alert(1))',
      '![a | b](javascript&colon;alert(1))',
      '[a | b](<javascript&colon;alert(1)>)',
      '[a | b](\njavascript&colon;alert(1)\n)',
      '[[a] | b](javascript&colon;alert(1))',
      '[a | b](data&colon;text/html,<script>alert(1)</script>)',
      '> [a\nb](javascript&colon;alert(1))',
      '[a\n2. b](javascript&colon;alert(1))',
      `[click | here](<${'&#x000009;'.repeat(15)}javascript:alert(1)>)`,
      `[a | b](${'&#x09;'.repeat(25)}javascript:alert(1))`,
      `[a | b](${'&#9;'.repeat(35)}javascript:alert(1))`,
      '[a | b](javascript&Tab;:alert(1))',
      '[a | b](java\\script\\:alert(1))',
      '[a | b](javascript\\&colon;alert(1))',
      '| a | b |\n| --- | --- |\n| [x | y](javascript&colon;alert(1)) |',
      `| a | b |\n| --- | --- |\n| [x | y](<${'&#x000009;'.repeat(15)}javascript:alert(1)>) |`,
    ];

    for (const md of mdVectors) {
      const pass1 = htmlToExportMarkdown({
        id: 'c83_md',
        title: 'Closure 8-3',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1.toLowerCase()).not.toContain('javascript:');
      expect(pass1.toLowerCase()).not.toContain('javascript&colon;');
      expect(pass1.toLowerCase()).not.toContain('data&colon;');
      expect(pass1.toLowerCase()).not.toContain('java\\script');

      const pass2 = htmlToExportMarkdown({
        id: 'c83_md',
        title: 'Closure 8-3',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    // HTML-only path with double-encoded &amp;colon;
    const htmlOnly = htmlToExportMarkdown({
      id: 'c83_html',
      title: 'Closure 8-3 HTML',
      contentHtml: '<p>[click | here](javascript&amp;colon;alert(1))</p>',
      contentText: '',
    });
    expect(htmlOnly.toLowerCase()).not.toContain('javascript');

    // Linear O(N) ReDoS checks (< 100 ms) across old + new vectors
    const redosVectors: Array<[string, string]> = [
      ['pipe_50k', '|a'.repeat(25_000)],
      ['bracket_nl_50k', '[a\n'.repeat(25_000)],
      ['img_25k_js', `${'<img '.repeat(25_000)}<javascript:1>`],
      ['gfm_delim_50k', `|a|b|\n${'|---'.repeat(25_000)}x`],
      ['ticks_pipe_25k', `${'`a|'.repeat(15_000)}[x](javascript:alert(1))`],
    ];
    for (const [id, payload] of redosVectors) {
      const start = performance.now();
      const out = htmlToExportMarkdown({
        id,
        title: 'Closure 8 ReDoS',
        contentHtml: '',
        contentText: '',
        contentMarkdown: payload,
      });
      expect(performance.now() - start).toBeLessThan(100);
      expect(out.toLowerCase()).not.toContain('javascript:');
    }
  });

  it('closes Closure 9-1: eliminates O(N^2) DoS in hasUnsafeMarkdownDestinationScheme on 50KB whitespace and angle-bracket destinations', () => {
    // Warm up JIT
    htmlToExportMarkdown({
      id: 'c91_warm',
      title: 'Warm',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '](a   b)',
    });

    const mdVectors: Array<[string, string]> = [
      ['resid_spaces_50k', `](a${' '.repeat(50_000)}b)`],
      ['resid_angle_50k', `](<${'a'.repeat(50_000)}>)`],
      ['resid_spaces_title_50k', `](a${' '.repeat(50_000)}"t")`],
    ];
    for (const [id, payload] of mdVectors) {
      const start = performance.now();
      const out = htmlToExportMarkdown({
        id,
        title: 'Closure 9-1',
        contentHtml: '',
        contentText: '',
        contentMarkdown: payload,
      });
      expect(performance.now() - start).toBeLessThan(100);
      expect(out).not.toContain('javascript:');
    }

    const htmlStart = performance.now();
    const htmlOut = htmlToExportMarkdown({
      id: 'resid_html_spaces_50k',
      title: 'Closure 9-1 HTML',
      contentHtml: `<p>](a${' '.repeat(50_000)}b)</p>`,
      contentText: '',
    });
    expect(performance.now() - htmlStart).toBeLessThan(100);
    expect(htmlOut).not.toContain('javascript:');
  });

  it('closes Closure 9-2: runs sanitizeExportMarkdownTitle in a bounded fail-closed fixed-point loop preventing bareSafeTags XSS resurrection', () => {
    const nestB = (depth: number): string => {
      let open = '<b>';
      for (let i = 1; i < depth; i += 1) {
        open = `<${open}b>`;
      }
      return open;
    };

    const titleVectors = [
      '<<b>script>alert(1)<<b>/script>',
      '[click]<br>(javascript:alert(1))',
      '<<b>img src=x onerror=alert(1)>',
      '<<br>script>alert(1)<<br>/script>',
      '![x]<b>(javascript:alert(1))',
      '<<br>javascript:alert(1)>',
      '<<b><b>script>alert(1)<<b><b>/script>',
      `<${nestB(12)}script>alert(1)<${nestB(12)}/script>`,
    ];

    for (const title of titleVectors) {
      const mdPass1 = htmlToExportMarkdown({
        id: 'c92_md',
        title,
        contentHtml: '',
        contentText: '',
        contentMarkdown: 'Clean body text.',
      });
      expect(mdPass1).not.toMatch(/<script/i);
      expect(mdPass1).not.toMatch(/<img/i);
      expect(mdPass1.toLowerCase()).not.toContain('onerror');
      expect(mdPass1.toLowerCase()).not.toContain('javascript:');
      expect(mdPass1).toContain('Clean body text.');

      const mdPass2 = htmlToExportMarkdown({
        id: 'c92_md',
        title,
        contentHtml: '',
        contentText: '',
        contentMarkdown: mdPass1,
      });
      expect(mdPass2).toBe(mdPass1);

      const htmlPass1 = htmlToExportMarkdown({
        id: 'c92_html',
        title,
        contentHtml: '<p>Clean HTML body.</p>',
        contentText: '',
      });
      expect(htmlPass1).not.toMatch(/<script/i);
      expect(htmlPass1).not.toMatch(/<img/i);
      expect(htmlPass1.toLowerCase()).not.toContain('onerror');
      expect(htmlPass1.toLowerCase()).not.toContain('javascript:');
      expect(htmlPass1).toContain('Clean HTML body.');
    }
  });

  it('closes Closure 9-3: rejects backslash-escaped closing quotes in link titles and encodes backslashes in sanitizeMarkdownTitleToken', () => {
    const mdVectors = [
      '[a](https://example.com/ "\\")` ") [b](javascript:alert(1)) `',
      "[a](https://example.com/ '\\')` ') [b](javascript:alert(1)) `",
      '[a](https://example.com/ "\\\\\\")` ") [b](javascript:alert(1)) `',
      '[a](https://example.com/ "\\")<ab:")[b](javascript:alert(1))>',
      '![a](https://example.com/ "\\")` ") [b](javascript:alert(1)) `',
      '[a](<https://example.com/> "\\")` ") [b](javascript:alert(1)) `',
      '[a](https://example.com/ "\\")` ") ![x](javascript:alert(1)) `',
      '[ref]: https://example.com/ "\\"\n[b](javascript:alert(1))',
    ];

    for (const md of mdVectors) {
      const pass1 = htmlToExportMarkdown({
        id: 'c93_md',
        title: 'Closure 9-3',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'c93_md',
        title: 'Closure 9-3',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    const htmlOnly = htmlToExportMarkdown({
      id: 'c93_html',
      title: 'Closure 9-3 HTML',
      contentHtml: '<p>[a](https://example.com/ "\\")` ") [b](javascript:alert(1)) `</p>',
      contentText: '',
    });
    expect(htmlOnly.toLowerCase()).not.toContain('javascript:');

    // Legitimate titles with quotes/backticks/angles/backslashes preserved cleanly and idempotently
    const legit = htmlToExportMarkdown({
      id: 'c93_legit',
      title: 'Closure 9-3 Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: [
        '[docs](https://example.com/docs "Path C:\\docs `fn` <v2>")',
        "[single](https://example.com/docs 'Guide Title')",
      ].join('\n\n'),
    });
    expect(legit).toContain(
      '[docs](https://example.com/docs "Path C:&#92;docs &#96;fn&#96; &lt;v2&gt;")',
    );
    expect(legit).toContain("[single](https://example.com/docs 'Guide Title')");
    expect(
      htmlToExportMarkdown({
        id: 'c93_legit',
        title: 'Closure 9-3 Legit',
        contentHtml: '',
        contentText: '',
        contentMarkdown: legit,
      }),
    ).toBe(legit);
  });

  it('closes Closure 9-4 & 9-6: enforces strict URI autolink scheme allowlist and removes 63-char email label desync', () => {
    const label64 = 'a'.repeat(64);
    const label100 = 'a'.repeat(100);
    const mdVectors = [
      '<ab:[b](javascript:alert(1))>',
      '<ab:![b](javascript:alert(1))>',
      '[a <ab:](https://example.com/)[b](javascript:alert(1))>',
      '![a <ab:](https://example.com/p.png)[b](javascript:alert(1))>',
      '<file:///etc/passwd>',
      '<https:[b](javascript:alert(1))>',
      '<https://example.com/[b](javascript:alert(1))>',
      '<https://example.com/`> [click `](javascript:alert(1))',
      `<a\`b@${label64}.com> [b](javascript:alert(1))\``,
      `<a\`b@${label64}.com> ![b](javascript:alert(1))\``,
      `<a\`b@${label100}> [b](javascript:alert(1))\``,
    ];

    for (const md of mdVectors) {
      const pass1 = htmlToExportMarkdown({
        id: 'c94_md',
        title: 'Closure 9-4',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1.toLowerCase()).not.toContain('javascript:');
      expect(pass1.toLowerCase()).not.toContain('file:///etc/passwd');

      const pass2 = htmlToExportMarkdown({
        id: 'c94_md',
        title: 'Closure 9-4',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    const htmlOnlyEmail = htmlToExportMarkdown({
      id: 'c96_html',
      title: 'Closure 9-6 HTML',
      contentHtml: `<p>&lt;a\`b@${label64}.com&gt; [b](javascript:alert(1))\`</p>`,
      contentText: '',
    });
    expect(htmlOnlyEmail.toLowerCase()).not.toContain('javascript:');

    // Legitimate allowlisted autolinks & emails preserved verbatim
    const legit = htmlToExportMarkdown({
      id: 'c94_legit',
      title: 'Closure 9-4 Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: [
        'Docs: <https://example.com/docs>',
        'Email: <support@geomix.ai>',
        'Mailto: <mailto:support@geomix.ai>',
        'Tel: <tel:+1-555-0100>',
        '![alt <https://example.com/a]b>](https://example.com/pic.png)',
      ].join('\n\n'),
    });
    expect(legit).toContain('<https://example.com/docs>');
    expect(legit).toContain('<support@geomix.ai>');
    expect(legit).toContain('<mailto:support@geomix.ai>');
    expect(legit).toContain('<tel:+1-555-0100>');
    expect(legit).toContain('![alt <https://example.com/a]b>](https://example.com/pic.png)');
    expect(
      htmlToExportMarkdown({
        id: 'c94_legit',
        title: 'Closure 9-4 Legit',
        contentHtml: '',
        contentText: '',
        contentMarkdown: legit,
      }),
    ).toBe(legit);
  });

  it('closes Closure 9-5: prevents 1-3 space indented fence desync, container fence markers, and Pandoc raw-attribute fences while preserving legitimate column-0 fences', () => {
    const mdVectors = [
      'hi\n ```\n```\n<script>alert(1)</script>\n```',
      'hi\n  ```\n```\n<script>alert(1)</script>\n```',
      'hi\n   ```\n```\n<script>alert(1)</script>\n```',
      'hi\n ~~~\n~~~\n<script>alert(1)</script>\n~~~',
      'hi\n ````\n````\n<script>alert(1)</script>\n````',
      'hi\n ```ts\n```\n<script>alert(1)</script>\n```',
      'hi\n\n ```\n```\n<script>alert(1)</script>\n```',
      'hi\n ```\n```\n[click](javascript:alert(1))\n```',
      '```{=html}\n<script>alert(1)</script>\n```',
      '```{=html}\n\n```\n<script>alert(1)</script>\n```',
      '- ```\n```\n<script>alert(1)</script>\n```',
      '> ```\n```\n<script>alert(1)</script>\n```',
    ];

    for (const md of mdVectors) {
      const pass1 = htmlToExportMarkdown({
        id: 'c95_md',
        title: 'Closure 9-5',
        contentHtml: '',
        contentText: '',
        contentMarkdown: md,
      });
      expect(pass1).not.toMatch(/<script/i);
      expect(pass1).not.toContain('alert(1)');
      expect(pass1.toLowerCase()).not.toContain('javascript:');

      const pass2 = htmlToExportMarkdown({
        id: 'c95_md',
        title: 'Closure 9-5',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    const htmlOnly = htmlToExportMarkdown({
      id: 'c95_html',
      title: 'Closure 9-5 HTML',
      contentHtml: '<p>hi</p><p> ```<br>```<br>&lt;script&gt;alert(1)&lt;/script&gt;<br>```</p>',
      contentText: '',
    });
    expect(htmlOnly).not.toMatch(/<script/i);
    expect(htmlOnly).not.toContain('alert(1)');

    // Linear O(N) on 20k repeated indented / raw-attribute fences
    for (const payload of [' ```\n'.repeat(20_000), '```{=html}\n'.repeat(20_000)]) {
      const start = performance.now();
      htmlToExportMarkdown({
        id: 'c95_perf',
        title: 'Closure 9-5 Perf',
        contentHtml: '',
        contentText: '',
        contentMarkdown: payload,
      });
      expect(performance.now() - start).toBeLessThan(100);
    }

    // Legitimate column-0 code fences remain 100% preserved
    const legitBlank = htmlToExportMarkdown({
      id: 'c95_legit1',
      title: 'Closure 9-5 Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '<b>bold</b>\n\n```ts\nconst x = 1;\n```',
    });
    expect(legitBlank).toContain('<b>bold</b>\n\n```ts\nconst x = 1;\n```');

    const legitSummary = htmlToExportMarkdown({
      id: 'c95_legit2',
      title: 'Closure 9-5 Legit',
      contentHtml: '',
      contentText: '',
      contentMarkdown: 'Summary\n```ts\nconst x = 1;\n```',
    });
    expect(legitSummary).toContain('Summary\n```ts\nconst x = 1;\n```');
  });

  it('closes Closure 10-1: fails closed on >= 4-deep nested Markdown link/image labels in O(N) without backtick-smuggling XSS across MD, HTML-only, and Title paths', () => {
    const wrapLinks = (depth: number, inner: string, url = 'https://a.com'): string =>
      `${'['.repeat(depth)}${inner}${`](${url})`.repeat(depth)}`;
    const wrapImages = (depth: number, inner: string, url = 'https://a.com/p.png'): string =>
      `${'!['.repeat(depth)}${inner}${`](${url})`.repeat(depth)}`;

    const innerPayloads = [
      '![a](https://example.com/ "`") ![c](javascript:alert(1))`',
      '![a](https://example.com/`) ![c](javascript:alert(1))`',
      '![a](https://example.com/ "`") ![c](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`',
      '![a](https://example.com/ "`") ![c](vbscript:msgbox(1))`',
      '[a](https://example.com/ "`") [b](javascript:alert(1))`',
      '[a](https://example.com/ "`") [b](javascript&colon;alert(1))`',
      '[a](https://example.com/ "\\")` ") [b](javascript:alert(1)) `',
      '[a](javascript:alert(1))',
    ];

    const assertCleanAndIdempotent = (id: string, out1: string) => {
      expect(out1.toLowerCase()).not.toContain('javascript:');
      expect(out1.toLowerCase()).not.toContain('javascript&colon;');
      expect(out1.toLowerCase()).not.toContain('vbscript:');
      expect(out1.toLowerCase()).not.toContain('data:text/html');
      const out2 = htmlToExportMarkdown({
        id,
        title: '',
        contentHtml: '',
        contentText: '',
        contentMarkdown: out1,
      });
      expect(out2).toBe(out1);
    };

    for (const depth of [5, 10, 20]) {
      for (const [idx, inner] of innerPayloads.entries()) {
        const md = wrapLinks(depth, inner);

        // Markdown body path
        assertCleanAndIdempotent(
          `c101_md_${depth}_${idx}`,
          htmlToExportMarkdown({
            id: `c101_md_${depth}_${idx}`,
            title: 'Closure 10-1',
            contentHtml: '',
            contentText: '',
            contentMarkdown: md,
          }),
        );

        // HTML-only path
        assertCleanAndIdempotent(
          `c101_html_${depth}_${idx}`,
          htmlToExportMarkdown({
            id: `c101_html_${depth}_${idx}`,
            title: 'Closure 10-1 HTML',
            contentHtml: `<p>${md}</p>`,
            contentText: '',
          }),
        );

        // Title path
        assertCleanAndIdempotent(
          `c101_title_${depth}_${idx}`,
          htmlToExportMarkdown({
            id: `c101_title_${depth}_${idx}`,
            title: md,
            contentHtml: '',
            contentText: '',
            contentMarkdown: 'Clean body.',
          }),
        );

        // Outer image wrappers and trailing backtick escape outside deep wrapper
        assertCleanAndIdempotent(
          `c101_img_${depth}_${idx}`,
          htmlToExportMarkdown({
            id: `c101_img_${depth}_${idx}`,
            title: 'Closure 10-1 Img',
            contentHtml: '',
            contentText: '',
            contentMarkdown: wrapImages(depth, inner),
          }),
        );
        assertCleanAndIdempotent(
          `c101_out_${depth}_${idx}`,
          htmlToExportMarkdown({
            id: `c101_out_${depth}_${idx}`,
            title: 'Closure 10-1 Outside',
            contentHtml: '',
            contentText: '',
            contentMarkdown: `${md} [b](javascript:alert(1))\``,
          }),
        );
      }

      // Unsafe 5th link inside safe outer wrappers
      const unsafeDepth = wrapLinks(
        depth - 1,
        '[![a](https://example.com/ "`") ![c](javascript:alert(1))`](javascript:void(0))',
      );
      assertCleanAndIdempotent(
        `c101_unsafe_inner_${depth}`,
        htmlToExportMarkdown({
          id: `c101_unsafe_inner_${depth}`,
          title: 'Closure 10-1 Unsafe Inner',
          contentHtml: '',
          contentText: '',
          contentMarkdown: unsafeDepth,
        }),
      );
    }

    // Legitimate 1-level image-in-link remains preserved verbatim and idempotent
    const legit = htmlToExportMarkdown({
      id: 'c101_legit',
      title: 'Guide',
      contentHtml: '',
      contentText: '',
      contentMarkdown: '[![alt](https://example.com/a.png)](https://example.com/)',
    });
    expect(legit).toContain('[![alt](https://example.com/a.png)](https://example.com/)');
    expect(
      htmlToExportMarkdown({
        id: 'c101_legit',
        title: '',
        contentHtml: '',
        contentText: '',
        contentMarkdown: legit,
      }),
    ).toBe(legit);

    // Strictly linear O(N) (< 100ms) on 500-deep and 1000-deep nested brackets
    for (const depth of [500, 1000]) {
      const safeDeep = wrapLinks(depth, 'x');
      const t0 = performance.now();
      const outSafe = htmlToExportMarkdown({
        id: `c101_perf_${depth}`,
        title: 'Perf',
        contentHtml: '',
        contentText: '',
        contentMarkdown: safeDeep,
      });
      expect(performance.now() - t0).toBeLessThan(100);
      assertCleanAndIdempotent(`c101_perf_${depth}`, outSafe);

      const xssDeep = wrapLinks(depth, '![a](https://example.com/ "`") ![c](javascript:alert(1))`');
      const t1 = performance.now();
      const outXss = htmlToExportMarkdown({
        id: `c101_perf_xss_${depth}`,
        title: 'Perf XSS',
        contentHtml: '',
        contentText: '',
        contentMarkdown: xssDeep,
      });
      expect(performance.now() - t1).toBeLessThan(100);
      assertCleanAndIdempotent(`c101_perf_xss_${depth}`, outXss);
    }
  });

  it('closes Closure 10-2: aligns unclosed-tag and linear HTML tag scanners with HTML5 §13.2.5.6 preserving strict idempotency and prose', () => {
    const nestedTitle12 = `${'<<b>'.repeat(12)}script>alert(1)${'<<b>'.repeat(12)}/script>`;

    const idempotentCases: Array<{
      id: string;
      title: string;
      md: string;
      mustContain: string[];
    }> = [
      {
        id: 'c102_nest12_plain',
        title: nestedTitle12,
        md: 'body',
        mustContain: ['body'],
      },
      {
        id: 'c102_nest12_bold',
        title: nestedTitle12,
        md: 'body with <b>bold</b>',
        mustContain: ['body with <b>bold</b>'],
      },
      {
        id: 'c102_nest12_form',
        title: nestedTitle12,
        md: 'Form follows function.',
        mustContain: ['Form follows function.'],
      },
      {
        id: 'c102_price_lt',
        title: 'Price <',
        md: 'Full article body here.',
        mustContain: ['# Price <', 'Full article body here.'],
      },
      {
        id: 'c102_price_lt_bold',
        title: 'Price <',
        md: 'Full article body with <b>bold</b> here.',
        mustContain: ['# Price <', 'Full article body with <b>bold</b> here.'],
      },
      {
        id: 'c102_price_lt_form',
        title: 'Price <',
        md: 'Form follows function.',
        mustContain: ['# Price <', 'Form follows function.'],
      },
      {
        id: 'c102_price_lt_slash',
        title: 'Price </',
        md: 'Full article body here.',
        mustContain: ['# Price </', 'Full article body here.'],
      },
      {
        id: 'c102_prose_lt',
        title: 'T',
        md: 'When a < b we recommend Model X.\n\n## Summary\nImportant content that must not be deleted.',
        mustContain: [
          'When a < b we recommend Model X.',
          '## Summary',
          'Important content that must not be deleted.',
        ],
      },
      {
        id: 'c102_prose_lt_quote',
        title: 'T',
        md: 'When a < b we recommend Model X.\n\n> Quoted note here.',
        mustContain: ['When a < b we recommend Model X.', '> Quoted note here.'],
      },
      {
        id: 'c102_prose_lt_anchor',
        title: 'T',
        md: 'When x < a and y > z, see <a href="https://example.com">docs</a>.',
        mustContain: ['When x < a and y > z, see [docs](https://example.com).'],
      },
    ];

    for (const item of idempotentCases) {
      const pass1 = htmlToExportMarkdown({
        id: item.id,
        title: item.title,
        contentHtml: '',
        contentText: '',
        contentMarkdown: item.md,
      });
      expect(pass1).not.toMatch(/<script/i);
      for (const expected of item.mustContain) {
        expect(pass1).toContain(expected);
      }

      // Re-export with empty title so H1 comes from pass1 directly (strict f(f(x)) === f(x))
      const pass2 = htmlToExportMarkdown({
        id: item.id,
        title: '',
        contentHtml: '',
        contentText: '',
        contentMarkdown: pass1,
      });
      expect(pass2).toBe(pass1);
    }

    // Real HTML5 §13.2.5.6 unclosed tags/declarations/comments/PIs remain stripped cleanly
    const unclosedPayloads = [
      '<script src=https://evil.com/x.js x=1',
      'Safe text </script',
      'Safe text <!-- unclosed comment',
      'Safe text <? unclosed pi',
      'Safe text <!DOCTYPE html',
      'Safe text <svg/onload=alert(1) x=1',
      'Safe text <img/src=x/onerror=alert(1) x=1',
    ];
    for (const [idx, payload] of unclosedPayloads.entries()) {
      const out = htmlToExportMarkdown({
        id: `c102_unclosed_${idx}`,
        title: 'T',
        contentHtml: '',
        contentText: '',
        contentMarkdown: payload,
      });
      expect(out).not.toMatch(/<(?:script|\/script|svg|img|!--|\?|!doctype)/i);
      expect(out).not.toContain('evil.com');
      expect(out).not.toContain('alert(1)');
      const out2 = htmlToExportMarkdown({
        id: `c102_unclosed_${idx}`,
        title: '',
        contentHtml: '',
        contentText: '',
        contentMarkdown: out,
      });
      expect(out2).toBe(out);
    }
  });
});
