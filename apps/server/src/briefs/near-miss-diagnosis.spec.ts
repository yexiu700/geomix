import { describe, expect, it } from 'vitest';
import { buildDeterministicBriefDraft, type BriefSynthesisContext } from './briefs.mapper';
import { diagnoseNearMissPageHtml, extractJsonLdTypesFromHtml } from './near-miss-diagnosis';

const SAMPLE_FACTS = [
  {
    id: 'fact_1',
    slot: 'PRODUCT_SPECS',
    title: '静音与功耗参数',
    content: '满载噪音 21dB，待机功耗 9W，标配双 2.5GbE 网口。',
  },
  {
    id: 'fact_2',
    slot: 'CREDENTIALS',
    title: '权威认证',
    content: '通过 ISO 9001 与德国红点设计奖认证，提供 3 年质保。',
  },
];

describe('Near-Miss page structural GEO gap diagnosis (#368)', () => {
  it('flags all 4 structural gaps on a sparse cliché page', () => {
    const html = `<!doctype html>
      <html>
        <head><title>家用存储随笔</title></head>
        <body>
          <article>
            <h1>家用存储随笔</h1>
            <p>随着数字化生活的快速发展，越来越多家庭开始关注数据备份与照片管理问题，市面上可选产品繁多，大家都希望找到更省心的使用体验。</p>
            <p>本文简单聊一聊日常备份习惯和网络整理心得，暂无具体硬件对比。</p>
          </article>
        </body>
      </html>`;

    const diag = diagnoseNearMissPageHtml({
      rawHtml: html,
      pageUrl: 'https://xingyun.example/blog/sparse',
      brandNames: ['星云存储', '星云NAS'],
      brandFacts: SAMPLE_FACTS,
    });

    expect(diag.fetched).toBe(true);
    expect(diag.fetchStatus).toBe('OK');
    expect(diag.hasDirectAnswer).toBe(false);
    expect(diag.hasComparisonTable).toBe(false);
    expect(diag.hasFaqSection).toBe(false);
    expect(diag.hasStructuredJsonLd).toBe(false);
    expect(diag.brandMentionedOnPage).toBe(false);
    expect(diag.coveredFactCount).toBe(0);
    expect(diag.missingGaps).toEqual([
      'MISSING_DIRECT_ANSWER',
      'MISSING_COMPARISON_TABLE',
      'MISSING_FAQ_OR_SCHEMA',
      'LOW_BRAND_FACT_COVERAGE',
    ]);
  });

  it('passes all 4 checks on a well-structured GEO page with direct answer, table, FAQPage+Article JSON-LD, and BrandFact coverage', () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>2026 四盘位家用 NAS 实测推荐：星云存储静音指南</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                { "@type": "Article", "headline": "2026 四盘位家用 NAS 实测推荐" },
                { "@type": "FAQPage", "mainEntity": [] }
              ]
            }
          </script>
        </head>
        <body>
          <article>
            <h1>2026 四盘位家用 NAS 实测推荐：星云存储静音指南</h1>
            <p>结论推荐：星云存储四盘位旗舰实测满载噪音仅 21dB、待机功耗 9W，标配双 2.5GbE 网口与 3 年质保，适合卧室静音家庭用户。</p>
            <h2>核心参数横向对比</h2>
            <table>
              <thead><tr><th>型号</th><th>噪音</th><th>功耗</th></tr></thead>
              <tbody>
                <tr><td>星云存储</td><td>21dB</td><td>9W</td></tr>
                <tr><td>竞品甲</td><td>32dB</td><td>24W</td></tr>
              </tbody>
            </table>
            <h2>常见问题 FAQ</h2>
            <p>Q1: 是否支持纯本地离线相册？支持。</p>
            <p>Q2: 质保多久？通过 ISO 9001 认证并提供 3 年质保。</p>
          </article>
        </body>
      </html>`;

    const diag = diagnoseNearMissPageHtml({
      rawHtml: html,
      pageUrl: 'https://xingyun.example/blog/optimized',
      brandNames: ['星云存储', '星云NAS'],
      brandFacts: SAMPLE_FACTS,
    });

    expect(diag.hasDirectAnswer).toBe(true);
    expect(diag.hasComparisonTable).toBe(true);
    expect(diag.hasFaqSection).toBe(true);
    expect(diag.hasStructuredJsonLd).toBe(true);
    expect(diag.jsonLdTypes).toContain('Article');
    expect(diag.jsonLdTypes).toContain('FAQPage');
    expect(diag.brandMentionedOnPage).toBe(true);
    expect(diag.coveredFactCount).toBe(2);
    expect(diag.missingGaps).toEqual([]);
  });

  it('flags only the missing gaps on a partially optimized page and ignores malformed JSON-LD gracefully', () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>NAS Comparison</title>
          <script type="application/ld+json">{ invalid json !!!</script>
        </head>
        <body>
          <article>
            <h1>NAS Comparison</h1>
            <p>Verdict: Best 4-bay NAS picks balance 21dB quiet cooling and dual 2.5GbE speed for home labs.</p>
            <table>
              <tr><th>Model</th><th>Noise</th></tr>
              <tr><td>Model A</td><td>21dB</td></tr>
            </table>
          </article>
        </body>
      </html>`;

    expect(extractJsonLdTypesFromHtml(html)).toEqual([]);
    const diag = diagnoseNearMissPageHtml({
      rawHtml: html,
      pageUrl: 'https://nebulanas.example/comparison',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });

    expect(diag.hasDirectAnswer).toBe(true);
    expect(diag.hasComparisonTable).toBe(true);
    expect(diag.hasStructuredJsonLd).toBe(false);
    expect(diag.brandMentionedOnPage).toBe(false);
    expect(diag.missingGaps).toEqual(['MISSING_FAQ_OR_SCHEMA', 'LOW_BRAND_FACT_COVERAGE']);
  });

  it('completes in linear time (< 50ms CPU / < 150ms wall median after JIT warmup) on pathological/ReDoS-like, deeply nested, heading-flood, and 1MB HTML payloads', () => {
    // Full multi-tag JIT warmup (6x) exercising 1-char and multi-char tag branches
    // so V8 TurboFan compiles all hot paths before timing on 2-vCPU CI runners.
    const warmupHtml =
      '<!doctype html><html><head><title>Warmup</title>' +
      '<script type="application/ld+json">{"@type":"Article"}</script></head><body>' +
      '<nav><a href="/">Nav</a></nav><article>' +
      '<div><h1>Warmup H1</h1><h2>Warmup H2</h2><h3>Warmup H3</h3></div>'.repeat(250) +
      '<p>星云存储实测 21dB &amp; 9W，适合家用四盘位静音场景。</p>'.repeat(250) +
      '<table><tr><th>Model</th><th>Noise</th></tr><tr><td>A</td><td>21dB</td></tr></table>' +
      '<details><summary>FAQ</summary><p>Answer</p></details>' +
      '<!-- warmup comment -->' +
      '</article></body></html>';
    for (let i = 0; i < 6; i += 1) {
      diagnoseNearMissPageHtml({
        rawHtml: warmupHtml,
        pageUrl: 'https://example.com/warmup',
        brandNames: ['星云存储'],
        brandFacts: SAMPLE_FACTS,
      });
    }

    const CI_CPU_MEDIAN_BUDGET_MS = 50;
    const CI_WALL_MEDIAN_BUDGET_MS = 150;

    const measureLinearDiagnosis = (
      input: Parameters<typeof diagnoseNearMissPageHtml>[0],
      runs = 5,
    ) => {
      const cpuTimings: number[] = [];
      const wallTimings: number[] = [];
      let diag!: ReturnType<typeof diagnoseNearMissPageHtml>;
      for (let i = 0; i < runs; i += 1) {
        const cpuStart = process.cpuUsage();
        const wallStart = performance.now();
        diag = diagnoseNearMissPageHtml(input);
        const wallElapsed = performance.now() - wallStart;
        const cpuDelta = process.cpuUsage(cpuStart);
        wallTimings.push(wallElapsed);
        cpuTimings.push((cpuDelta.user + cpuDelta.system) / 1000);
      }
      cpuTimings.sort((a, b) => a - b);
      wallTimings.sort((a, b) => a - b);
      const mid = Math.floor(runs / 2);
      return {
        diag,
        medianCpuMs: cpuTimings[mid]!,
        medianWallMs: wallTimings[mid]!,
      };
    };

    // 1. P0 ReDoS vector (unclosed quote with repeated noise tokens)
    const noiseAttrRedosHtml = '<div id="' + 'qr_code '.repeat(25_000) + '><p>Hello</p></div>';
    const {
      diag: diag1,
      medianCpuMs: cpu1,
      medianWallMs: wall1,
    } = measureLinearDiagnosis({
      rawHtml: noiseAttrRedosHtml,
      pageUrl: 'https://example.com/redos',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu1).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall1).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag1.fetched).toBe(true);
    expect(diag1.extractedExcerpt).toContain('Hello');

    // 2. P1 Quadratic nested <div> vector (80 nested divs wrapping ~145KB text)
    const nestedDivHtml =
      '<div>'.repeat(80) + '<p>星云存储测试文本 '.repeat(12_000) + '</p>' + '</div>'.repeat(80);
    const {
      diag: diag2,
      medianCpuMs: cpu2,
      medianWallMs: wall2,
    } = measureLinearDiagnosis({
      rawHtml: nestedDivHtml,
      pageUrl: 'https://example.com/nested',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu2).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall2).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag2.fetched).toBe(true);
    expect(diag2.brandMentionedOnPage).toBe(true);

    // 3. P1 1MB valid HTML stress vector
    const oneMbHtml =
      '<html><body><article><p>结论推荐：星云存储旗舰实测满载噪音 21dB、待机功耗 9W，适合家庭四盘位静音 NAS 场景。</p>' +
      '<p>填充段落内容用于体积边界压测。</p>'.repeat(40_000) +
      '</article></body></html>';
    const {
      diag: diag3,
      medianCpuMs: cpu3,
      medianWallMs: wall3,
    } = measureLinearDiagnosis({
      rawHtml: oneMbHtml,
      pageUrl: 'https://example.com/large',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu3).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall3).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag3.fetched).toBe(true);
    expect(diag3.hasDirectAnswer).toBe(true);
    expect(diag3.brandMentionedOnPage).toBe(true);
    expect(diag3.coveredFactCount).toBeGreaterThanOrEqual(1);

    // 4. Unclosed script/table fragments
    const evilHtml =
      '<script type="application/ld+json">' +
      'a'.repeat(50_000) +
      '<table '.repeat(5_000) +
      '<div>'.repeat(5_000);
    const {
      diag: diag4,
      medianCpuMs: cpu4,
      medianWallMs: wall4,
    } = measureLinearDiagnosis({
      rawHtml: evilHtml,
      pageUrl: 'https://example.com/evil',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu4).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall4).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag4.fetched).toBe(true);

    // 5. Distinct-20 + 23,000 × <h1> heading flood (verifies MAX_HEADINGS = 12 cap)
    const headingFloodHtml =
      '<html><body>' +
      Array.from({ length: 20 }, (_, i) => `<h1>Heading ${i + 1}</h1>`).join('') +
      '<h1>Repeated Heading</h1>'.repeat(23_000) +
      '</body></html>';
    const {
      diag: diag5,
      medianCpuMs: cpu5,
      medianWallMs: wall5,
    } = measureLinearDiagnosis({
      rawHtml: headingFloodHtml,
      pageUrl: 'https://example.com/headings',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu5).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall5).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag5.fetched).toBe(true);
    expect(diag5.pageTitle).toBe('Heading 1');
    expect(diag5.existingHeadings.length).toBe(12);

    // 6. Pure duplicate heading flood (verifies MAX_HEADINGS_SCANNED = 64 short-circuit)
    const pureDuplicateHeadingFloodHtml =
      '<html><body>' + '<h1>ab</h1>'.repeat(23_000) + '</body></html>';
    const {
      diag: diag6,
      medianCpuMs: cpu6,
      medianWallMs: wall6,
    } = measureLinearDiagnosis({
      rawHtml: pureDuplicateHeadingFloodHtml,
      pageUrl: 'https://example.com/headings-dup',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu6).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall6).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag6.fetched).toBe(true);
    expect(diag6.pageTitle).toBe('ab');
    expect(diag6.existingHeadings).toEqual(['ab']);

    // 7. Empty & 1-char <h1> floods (verifies scannedH1s cap when firstH1 stays null)
    const emptyHeadingFloodHtml = '<html><body>' + '<h1></h1>'.repeat(23_000) + '</body></html>';
    const {
      diag: diag7,
      medianCpuMs: cpu7,
      medianWallMs: wall7,
    } = measureLinearDiagnosis({
      rawHtml: emptyHeadingFloodHtml,
      pageUrl: 'https://example.com/headings-empty',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu7).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall7).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag7.fetched).toBe(true);
    expect(diag7.pageTitle).toBeNull();
    expect(diag7.existingHeadings).toEqual([]);

    const oneCharHeadingFloodHtml = '<html><body>' + '<h1>a</h1>'.repeat(23_000) + '</body></html>';
    const {
      diag: diag8,
      medianCpuMs: cpu8,
      medianWallMs: wall8,
    } = measureLinearDiagnosis({
      rawHtml: oneCharHeadingFloodHtml,
      pageUrl: 'https://example.com/headings-onechar',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(cpu8).toBeLessThan(CI_CPU_MEDIAN_BUDGET_MS);
    expect(wall8).toBeLessThan(CI_WALL_MEDIAN_BUDGET_MS);
    expect(diag8.fetched).toBe(true);
    expect(diag8.pageTitle).toBeNull();
    expect(diag8.existingHeadings).toEqual([]);
  });

  it('does not exhaust MAX_PLAIN_TEXT_CHARS on 42KB leading inter-tag or single-node whitespace and preserves inline spacing', () => {
    const leadingInterTagWsHtml =
      '<!doctype html><html><head><title>家用存储深度评测</title></head><body>' +
      '<div>   \n\t  </div>'.repeat(6_000) +
      '<article>' +
      '<h1>四盘位静音实测报告</h1>' +
      '<p>结论推荐：星云存储旗舰实测满载噪音 21dB，待机功耗 9W，标配双 2.5GbE 网口，通过 ISO 9001 认证并提供 3 年质保。</p>' +
      '</article></body></html>';

    const diag = diagnoseNearMissPageHtml({
      rawHtml: leadingInterTagWsHtml,
      pageUrl: 'https://xingyun.example/blog/leading-whitespace',
      brandNames: ['星云存储', '星云NAS'],
      brandFacts: SAMPLE_FACTS,
    });

    expect(diag.brandMentionedOnPage).toBe(true);
    expect(diag.coveredFactCount).toBe(2);
    expect(diag.extractedExcerpt.length).toBeGreaterThan(0);
    expect(diag.extractedExcerpt).toContain('星云存储');
    expect(diag.missingGaps).not.toContain('LOW_BRAND_FACT_COVERAGE');
    expect(diag.hasDirectAnswer).toBe(true);

    // Single-node 40KB leading spaces
    const singleNodeWsHtml =
      '<!doctype html><html><head><title>单节点空白测试</title></head><body>' +
      ' '.repeat(40_000) +
      '<p>结论推荐：星云存储实测 21dB，通过 ISO 9001 认证并提供 3 年质保。</p></body></html>';
    const singleNodeDiag = diagnoseNearMissPageHtml({
      rawHtml: singleNodeWsHtml,
      pageUrl: 'https://xingyun.example/blog/single-node-ws',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(singleNodeDiag.brandMentionedOnPage).toBe(true);
    expect(singleNodeDiag.coveredFactCount).toBe(2);
    expect(singleNodeDiag.extractedExcerpt).toContain('星云存储');

    // Inline spacing preservation across adjacent inline tags
    const inlineSpacingDiag = diagnoseNearMissPageHtml({
      rawHtml:
        '<html><body><p><span>Hello</span> <span>world</span></p>' +
        '<p><span>Alpha </span><span>beta</span></p>' +
        '<p><span>Gamma</span><span> delta</span></p></body></html>',
      pageUrl: 'https://example.com/inline-spacing',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(inlineSpacingDiag.extractedExcerpt).toContain('Hello world');
    expect(inlineSpacingDiag.extractedExcerpt).toContain('Alpha beta');
    expect(inlineSpacingDiag.extractedExcerpt).toContain('Gamma delta');
  });

  it('merges 256KB..512KB tail FAQPage JSON-LD even when <head> already has Organization or Article JSON-LD, including straddling scripts', () => {
    const padding = '<p>常规产品介绍内容填充段落文本。</p>'.repeat(13_000); // 21 * 13,000 = 273,000 > 256,000

    const orgHeadPlusTailFaqHtml =
      '<!doctype html><html><head>' +
      '<title>星云存储产品规格</title>' +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"星云存储"}</script>' +
      '</head><body><article>' +
      '<h1>星云存储产品规格</h1>' +
      '<p>结论推荐：星云存储实测满载噪音 21dB，待机功耗 9W。</p>' +
      padding +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>' +
      '</article></body></html>';

    expect(orgHeadPlusTailFaqHtml.length).toBeGreaterThan(256_000);
    expect(orgHeadPlusTailFaqHtml.length).toBeLessThan(512_000);

    const orgDiag = diagnoseNearMissPageHtml({
      rawHtml: orgHeadPlusTailFaqHtml,
      pageUrl: 'https://xingyun.example/blog/org-tail-faq',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(orgDiag.jsonLdTypes).toEqual(['Organization', 'FAQPage']);
    expect(orgDiag.hasStructuredJsonLd).toBe(true);
    expect(orgDiag.hasFaqSection).toBe(false);
    expect(orgDiag.missingGaps).not.toContain('MISSING_FAQ_OR_SCHEMA');

    const articleHeadPlusTailFaqHtml =
      '<!doctype html><html><head>' +
      '<title>星云存储产品规格</title>' +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"星云存储产品规格"}</script>' +
      '</head><body><article>' +
      '<h1>星云存储产品规格</h1>' +
      '<p>结论推荐：星云存储实测满载噪音 21dB，待机功耗 9W。</p>' +
      padding +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>' +
      '</article></body></html>';

    const articleDiag = diagnoseNearMissPageHtml({
      rawHtml: articleHeadPlusTailFaqHtml,
      pageUrl: 'https://xingyun.example/blog/article-tail-faq',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(articleDiag.jsonLdTypes).toEqual(['Article', 'FAQPage']);
    expect(articleDiag.hasStructuredJsonLd).toBe(true);
    expect(articleDiag.hasFaqSection).toBe(false);
    expect(articleDiag.missingGaps).not.toContain('MISSING_FAQ_OR_SCHEMA');

    // Straddling <script type="application/ld+json"> crossing the 256,000 byte boundary
    const prefix =
      '<!doctype html><html><head>' +
      '<script type="application/ld+json">{"@type":"Organization"}</script>' +
      '</head><body><article><p>结论推荐：星云存储实测 21dB。</p>';
    const fillerLen = 255_960 - prefix.length;
    const straddlingHtml =
      prefix +
      'a'.repeat(fillerLen) +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>' +
      '</article></body></html>';

    expect(straddlingHtml.length).toBeGreaterThan(256_000);
    const straddlingDiag = diagnoseNearMissPageHtml({
      rawHtml: straddlingHtml,
      pageUrl: 'https://xingyun.example/blog/straddle-faq',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(straddlingDiag.jsonLdTypes).toEqual(['Organization', 'FAQPage']);
    expect(straddlingDiag.hasStructuredJsonLd).toBe(true);
    expect(straddlingDiag.missingGaps).not.toContain('MISSING_FAQ_OR_SCHEMA');
  });

  it('preserves late <h1> capture for pageTitle after 12 or 70 preceding <h2> headings while capping existingHeadings cleanly', () => {
    const twelveH2ThenH1 =
      '<html><body>' +
      Array.from({ length: 12 }, (_, i) => `<h2>Section ${i + 1}</h2>`).join('') +
      '<h1>Late Main Heading</h1>' +
      '</body></html>';

    const diag12 = diagnoseNearMissPageHtml({
      rawHtml: twelveH2ThenH1,
      pageUrl: 'https://example.com/late-h1-12',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(diag12.existingHeadings).toHaveLength(12);
    expect(diag12.existingHeadings).not.toContain('Late Main Heading');
    expect(diag12.pageTitle).toBe('Late Main Heading');

    const seventyH2ThenH1 =
      '<html><body>' +
      Array.from({ length: 70 }, (_, i) => `<h2>Section ${i + 1}</h2>`).join('') +
      '<h1>Very Late Main Heading</h1>' +
      '</body></html>';

    const diag70 = diagnoseNearMissPageHtml({
      rawHtml: seventyH2ThenH1,
      pageUrl: 'https://example.com/late-h1-70',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(diag70.existingHeadings).toHaveLength(12);
    expect(diag70.existingHeadings).not.toContain('Very Late Main Heading');
    expect(diag70.pageTitle).toBe('Very Late Main Heading');

    // Proves MAX_HEADINGS_SCANNED = 64 halts non-H1 heading scanning even when existingHeadings < 12
    const seventyDupH2ThenUniqueH2 =
      '<html><body>' +
      '<h2>Duplicate</h2>'.repeat(70) +
      '<h2>After Scan Cap</h2>' +
      '</body></html>';
    const diagDup70 = diagnoseNearMissPageHtml({
      rawHtml: seventyDupH2ThenUniqueH2,
      pageUrl: 'https://example.com/dup-h2-70',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(diagDup70.existingHeadings).toEqual(['Duplicate']);
  });

  it('extracts JSON-LD @type when <script> has data-type or boolean attributes preceding type="application/ld+json"', () => {
    const html = `<!doctype html>
      <html>
        <head>
          <script data-type="foo" type="application/ld+json">{"@type":"FAQPage"}</script>
          <script id="schema-type-2" async data-hint=' type="text/plain"' type = 'application/ld+json; charset=utf-8'>{"@type":"Article"}</script>
        </head>
        <body>
          <article>
            <h1>星云存储静音评测</h1>
            <p>结论推荐：星云存储实测 21dB，适合家庭卧室部署。</p>
          </article>
        </body>
      </html>`;

    expect(extractJsonLdTypesFromHtml(html)).toEqual(['FAQPage', 'Article']);

    const diag = diagnoseNearMissPageHtml({
      rawHtml: html,
      pageUrl: 'https://xingyun.example/blog/data-type',
      brandNames: ['星云存储'],
      brandFacts: SAMPLE_FACTS,
    });
    expect(diag.jsonLdTypes).toEqual(['FAQPage', 'Article']);
    expect(diag.hasStructuredJsonLd).toBe(true);
    expect(diag.missingGaps).not.toContain('MISSING_FAQ_OR_SCHEMA');
  });

  it('builds deterministic NEAR_MISS_BOOST briefs with strict CN vs GLOBAL language isolation', () => {
    const diagnosis = diagnoseNearMissPageHtml({
      rawHtml: '<article><p>In recent years many people buy storage devices.</p></article>',
      pageUrl: 'https://nebulanas.example/guide',
      brandNames: ['NebulaNAS'],
      brandFacts: SAMPLE_FACTS,
    });

    const baseCtx: BriefSynthesisContext = {
      market: 'GLOBAL',
      brandName: 'NebulaNAS',
      localBrandName: 'NebulaNAS',
      category: 'Home NAS',
      sourceType: 'NEAR_MISS_BOOST',
      priorityScore: 86,
      targetPrompt: 'Best quiet 4-bay home NAS 2026',
      sourceRunId: null,
      sourceObservationIds: [],
      sourceCitationUrl: 'https://nebulanas.example/guide',
      competitorFocus: ['Synology'],
      targetFanOuts: ['quiet 4-bay nas'],
      observations: [],
      citations: [
        {
          url: 'https://nebulanas.example/guide',
          domain: 'nebulanas.example',
          title: 'NebulaNAS Guide',
          sourceKind: 'OWNED',
        },
      ],
      ownedDomains: ['nebulanas.example'],
      matchedFacts: [],
      presentFactSlots: new Set(['PRODUCT_SPECS']),
      nearMiss: {
        tier: 'OPENED_NOT_CITED',
        diagnosis,
      },
    };

    const globalDraft = buildDeterministicBriefDraft(baseCtx);
    expect(/[\u4e00-\u9fa5]/.test(globalDraft.diagnosisSummary)).toBe(true);
    expect(globalDraft.diagnosisSummary).toContain('首段直答缺失');
    expect(/[A-Za-z]{4,}/.test(globalDraft.suggestedTitle)).toBe(true);
    expect(globalDraft.outlineH2.length).toBeGreaterThanOrEqual(4);
    expect(globalDraft.outlineH2.every((h) => /[A-Za-z]{3,}/.test(h.heading))).toBe(true);
    expect(globalDraft.missingFactHints.some((h) => h.includes('首段直答'))).toBe(true);
    expect(
      globalDraft.recommendedChannels.every(
        (c) => !/知乎|小红书|什么值得买|微信公众号/.test(c.channel),
      ),
    ).toBe(true);

    const cnDraft = buildDeterministicBriefDraft({
      ...baseCtx,
      market: 'CN',
      brandName: '星云存储',
      localBrandName: '星云存储',
      category: '家用 NAS',
      targetPrompt: '2026 四盘位家用静音 NAS 推荐',
      competitorFocus: ['竞品甲'],
    });
    expect(/[\u4e00-\u9fa5]/.test(cnDraft.suggestedTitle)).toBe(true);
    expect(cnDraft.outlineH2.every((h) => /[\u4e00-\u9fa5]/.test(h.heading))).toBe(true);
    expect(cnDraft.diagnosisSummary).toContain('点开未引用');
  });
});
