import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, extractPlainTextFromHtml } from './html-extract';

describe('extractPlainTextFromHtml', () => {
  it('extracts title, structured article text, and table rows while stripping scripts, styles, nav, and boilerplate', () => {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <title>DXP4800 四盘位私有云参数 - 青松官网</title>
  <style>.hidden { display: none; }</style>
</head>
<body>
  <nav>首页 | 产品 | 联系我们</nav>
  <script>window.__tracking = "should-not-appear";</script>
  <article>
    <h1>DXP4800 核心产品参数</h1>
    <p>搭载 Intel N100 四核处理器与 16GB DDR5 内存，满载噪音低至 28dB，待机功耗仅 14W。</p>
    <table>
      <tr><th>型号</th><th>网口</th><th>建议零售价</th></tr>
      <tr><td>DXP4800</td><td>双 2.5GbE</td><td>&yen;2,499 &amp; 3,199</td></tr>
    </table>
    <h2>权威资质与客户案例</h2>
    <p>通过 ISO9001 质量认证与国家 3C 认证，服务超过 12,000 家家庭与影视剪辑工作室。</p>
  </article>
  <footer>Copyright 2026 QingSong</footer>
</body>
</html>`;

    const result = extractPlainTextFromHtml(html);
    expect(result.title).toBe('DXP4800 四盘位私有云参数');
    expect(result.text).toContain('DXP4800 核心产品参数');
    expect(result.text).toContain('Intel N100 四核处理器');
    expect(result.text).toContain('型号 | 网口 | 建议零售价');
    expect(result.text).toContain('DXP4800 | 双 2.5GbE');
    expect(result.text).toContain('ISO9001');
    expect(result.text).not.toContain('should-not-appear');
    expect(result.text).not.toContain('.hidden');
    expect(result.text).not.toContain('Copyright 2026');
  });

  it('decodes named, decimal, and hexadecimal HTML entities cleanly', () => {
    expect(decodeHtmlEntities('A &amp; B &lt; 100&#37; &#x2014; &quot;ok&quot;')).toBe(
      'A & B < 100% — "ok"',
    );
  });

  it('strips </script > with trailing whitespace, unclosed <script>, and nested <nav>/<aside> without leaking text', () => {
    const html = `<!doctype html>
<html>
<body>
  <main>
    <p>这是一款经过真实实验室测试的家用静音四盘位存储服务器，搭载 Intel N100 四核处理器与 16GB DDR5 内存，满载噪音低至 28dB，待机功耗 14W。</p>
    <nav><nav>InnerNav</nav>OUTER_NAV_IN_MAIN_LEAK</nav>
    <aside><aside>InnerAside</aside>OUTER_ASIDE_LEAK</aside>
    <script>const LEAK_SPACE = "BAD_SCRIPT_1";</script >
    <script>const LEAK_UNCLOSED = "BAD_SCRIPT_2";
  </main>
</body>
</html>`;

    const result = extractPlainTextFromHtml(html);
    expect(result.text).toContain('这是一款经过真实实验室测试的家用静音四盘位存储服务器');
    expect(result.text).not.toContain('BAD_SCRIPT_1');
    expect(result.text).not.toContain('LEAK_SPACE');
    expect(result.text).not.toContain('BAD_SCRIPT_2');
    expect(result.text).not.toContain('LEAK_UNCLOSED');
    expect(result.text).not.toContain('InnerNav');
    expect(result.text).not.toContain('OUTER_NAV_IN_MAIN_LEAK');
    expect(result.text).not.toContain('InnerAside');
    expect(result.text).not.toContain('OUTER_ASIDE_LEAK');
  });

  it('extracts og:title cleanly regardless of attribute order', () => {
    const html = `<html><head><meta content="Aurora NAS X1 - Brand" property="og:title" /></head><body><p>正文内容</p></body></html>`;
    expect(extractPlainTextFromHtml(html).title).toBe('Aurora NAS X1');
  });

  it('completes in linear O(N) time (<500ms) on pathological repeated tags (B-07 / B-07-R)', () => {
    const payloads = [
      '<meta '.repeat(50_000),
      '<meta '.repeat(50_000) + '>',
      '<meta '.repeat(50_000) + 'property="og:title">',
      '<meta '.repeat(50_000) + '>og:title',
      '<article>'.repeat(50_000),
      '<article>'.repeat(50_000) + '</article>',
      '</article>'.repeat(50_000) + '<article>',
      '<nav>'.repeat(50_000),
      '<nav>'.repeat(50_000) + '</nav>',
      '</nav>'.repeat(50_000) + '<nav>',
    ];
    for (const payload of payloads) {
      const start = performance.now();
      const res = extractPlainTextFromHtml(payload);
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(500);
      expect(typeof res.text).toBe('string');
    }
  });
});
