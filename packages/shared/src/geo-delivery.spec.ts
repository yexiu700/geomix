import { describe, expect, it } from 'vitest';
import {
  buildGeoSchemaJsonLd,
  buildLlmsTxtSnippet,
  evaluateGeoArticle,
  sanitizeRichArticleHtml,
} from './geo-delivery';

describe('geo-delivery pure evaluator, JSON-LD, and llms.txt builders', () => {
  it('scores well-structured fact-rich articles >= 85 and bare cliché drafts < 50', () => {
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

    const poorResult = evaluateGeoArticle({
      market: 'CN',
      localBrandName: '星辰存储',
      title: '随便写写',
      targetPrompt: '四盘位 NAS',
      contentMarkdown:
        '在数字化浪潮下，随着科技的飞速发展，综上所述这款产品不错，参数为 [待补充：功耗]。',
      targetFanOuts: ['满载噪音', '待机功耗'],
    });
    expect(poorResult.geoScore).toBeLessThan(50);
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

  it('escapes </script> in JSON-LD and generates GLOBAL llms.txt snippet', () => {
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

    const llms = buildLlmsTxtSnippet({
      market: 'GLOBAL',
      localBrandName: 'AstraVault',
      category: 'Home NAS',
      ownedDomains: ['astravault.example.com'],
      title: 'Best 4-Bay NAS Guide',
      targetPrompt: 'Best 4-bay NAS 2026',
      contentMarkdown: 'AstraVault offers 14W idle power and 18.5dB noise.',
    });
    expect(llms).toContain('# AstraVault');
    expect(llms).toContain('astravault.example.com');
  });

  it('strips unsafe img src schemes (data:, vbscript:, entity-obfuscated, //evil.com) in sanitizeRichArticleHtml while keeping https and relative paths', () => {
    const dirty = [
      '<p>Safe</p>',
      '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" alt="svg" />',
      '<img src="vbscript:msgbox(1)" alt="vbs" />',
      '<img src="&#106;avascript:alert(1)" alt="ent" />',
      '<img src="//evil.com/payload.svg" alt="proto-rel" />',
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
    expect(contentHtml).toContain('<img src="https://cdn.example.com/product.png" alt="Product"');
    expect(contentHtml).toContain('<img src="/uploads/brand/hero.webp" alt="Hero"');
  });
});
