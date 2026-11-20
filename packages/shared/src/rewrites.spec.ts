import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REWRITE_MIN_SOURCE_CHARS,
  REWRITE_SIM_MAX_DEFAULT,
  assembleRewriteMessages,
  buildDefaultRewriteCategoryName,
  buildFakeRewriteMarkdown,
  canonicalizeRewriteUrl,
  computeChar5GramJaccard,
  computeRewriteUrlHash,
  extractArticleFromHtml,
  extractRewriteTopic,
  normalizePastedSource,
  parseRewrittenMarkdown,
  rewriteSingleCreateSchema,
  sha256Hex,
  truncateSourceText,
} from './rewrites';

const WECHAT_FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta property="og:title" content="工业传感器选型实务：从工况评估到维护核对" />
  <title>工业传感器选型实务</title>
</head>
<body>
  <div id="img-content">
    <h1 class="rich_media_title" id="activity-name">
      工业传感器选型实务：从工况评估到维护核对
    </h1>
    <div id="meta_content" class="rich_media_meta_list">
      <span>原创 技术专栏 2026-11-10</span>
    </div>
    <div class="rich_media_content" id="js_content">
      <section>
        <p>在自动化产线升级改造过程中，传感器选型直接决定采集信号的稳定性与后续巡检的工作量。许多现场工程师只看量程上限，却忽略了环境温湿度波动、电磁干扰以及安装空间限制，导致投产三个月后频繁出现零点漂移。</p>
        <p><img data-src="https://mmbiz.qpic.cn/sz_mmbiz_jpg/orig-wechat-banner/640" src="https://mmbiz.qpic.cn/sz_mmbiz_jpg/orig-wechat-banner/640" alt="原站配图1" /></p>
        <div>
          <p>第一步需要核对被测介质的物理特性与工作温度区间。高温蒸汽或强腐蚀性液体场景下，探头密封材质和引线护套耐温等级必须留出充足安全裕量，切忌贴着极限参数长期满负荷运行。</p>
          <p>第二步是确认输出信号制式与现场控制柜接口是否兼容。模拟量电流信号抗干扰能力较强，适合长距离敷设；数字总线接口则便于多节点集中诊断与参数远程下发。</p>
        </div>
        <p>第三步还要把日常标定周期、备件通用性和故障替换耗时纳入综合测算，通过两周小批量试运行记录真实波动曲线，再决定全线铺开计划。</p>
        <p>扫码关注公众号获取更多内部手册</p>
      </section>
    </div>
    <div id="js_pc_qr_code" class="qr_code_pc_outer">
      <p>长按识别二维码关注我们</p>
      <img src="https://mmbiz.qpic.cn/qrcode.png" />
    </div>
  </div>
</body>
</html>`;

const ZHIHU_FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <title>中小企业知识库搭建避坑记录 - 知乎</title>
</head>
<body>
  <header class="Sticky AppHeader">导航栏噪音内容</header>
  <main class="App-main">
    <article class="Post-Main">
      <h1 class="Post-Title">中小企业知识库搭建避坑记录</h1>
      <div class="AuthorInfo">某数字化顾问 · 关注他</div>
      <div class="Post-RichTextContainer">
        <div class="RichText ztext Post-RichText">
          <p>不少团队在启动内部知识库整理时，上来就要求所有部门把过去五年的历史文档一次性全部上传，结果目录层级混乱、版本互相冲突，检索出来的答案半数已经过期失效。</p>
          <figure>
            <img src="https://picx.zhimg.com/v2-original-zhihu-photo_r.jpg" />
            <figcaption>图 1：历史归档混乱示意图（原图说明）</figcaption>
          </figure>
          <h2>先高频问题后历史归档</h2>
          <p>更稳妥的做法是从一线客服与销售每周被反复追问的三十个高频问题切入，先由业务负责人核对标准口径、适用范围和例外边界，整理成结构化问答卡片并标注更新时间。</p>
          <p>同时建立月度巡检机制：凡是涉及产品参数变更、流程调整或价格体系更新的条目，必须在变更生效当天同步修订旧文档，避免新老员工看到截然不同的执行说明。</p>
        </div>
      </div>
      <div class="ContentItem-actions">赞同 328 · 评论 42 · 分享</div>
    </article>
  </main>
</body>
</html>`;

const GENERIC_PORTAL_FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <title>冷链仓储温控巡检规范解读 _ 物流技术参考网</title>
</head>
<body>
  <nav class="top-nav"><a href="/news">首页</a><a href="/about">关于</a></nav>
  <div class="layout-wrap">
    <aside class="sidebar">
      <a href="/hot1">热门排行一</a>
      <a href="/hot2">热门排行二</a>
    </aside>
    <div class="article-content" id="artibody">
      <h1>冷链仓储温控巡检规范解读</h1>
      <p>来源：技术编辑部</p>
      <p>生鲜与医药冷链仓储的核心难点不在于制冷机组本身，而在于库门开启装卸货期间的局部温度回升控制，以及死角测温探头的布点合理性。</p>
      <picture>
        <source srcset="https://cdn.example.org/warehouse.webp" type="image/webp" />
        <img src="https://cdn.example.org/warehouse.jpg" alt="冷库原图" />
      </picture>
      <p>按照分区分级管理经验，收发货月台缓冲间、货架顶层回风口以及靠近库门两侧通道都应当设置独立测点，采样间隔控制在五分钟以内，并配置多级越限告警阈值。</p>
      <p>一旦出现探头读数持续偏离设定区间，值班人员需要按照先核查库门密封条与风幕机运行状态、再排查化霜周期与冷媒压力的顺序逐项定位并留存处置工单。</p>
    </div>
    <footer class="site-footer">版权所有 转载请联系</footer>
  </div>
</body>
</html>`;

describe('rewrites shared helpers', () => {
  it('computes pure SHA-256 identical to node:crypto and canonicalizes tracking params', () => {
    for (const sample of [
      '',
      'abc',
      'https://mp.weixin.qq.com/s/test-article',
      '中文爆文复刻测试',
    ]) {
      const expected = createHash('sha256').update(sample, 'utf8').digest('hex');
      expect(sha256Hex(sample)).toBe(expected);
    }

    const hashA = computeRewriteUrlHash(
      'https://MP.WEIXIN.QQ.COM/s?__biz=MzA1&mid=100&utm_source=timeline#wechat_redirect',
    );
    const hashB = computeRewriteUrlHash(
      'https://mp.weixin.qq.com/s?mid=100&__biz=MzA1&spm=123.456',
    );
    expect(hashA).toBe(hashB);
    expect(canonicalizeRewriteUrl('https://example.com/post?a=1&utm_medium=cpc#top')).toBe(
      'https://example.com/post?a=1',
    );
  });

  it('extracts WeChat, Zhihu, and Generic HTML fixtures cleanly with zero original images or QR noise', () => {
    const wx = extractArticleFromHtml(
      WECHAT_FIXTURE_HTML,
      'https://mp.weixin.qq.com/s/demo-sensor',
    );
    expect(wx.site).toBe('wechat');
    expect(wx.title).toBe('工业传感器选型实务：从工况评估到维护核对');
    expect(wx.charCount).toBeGreaterThanOrEqual(REWRITE_MIN_SOURCE_CHARS);
    expect(wx.contentText).toContain('传感器选型直接决定采集信号的稳定性');
    expect(wx.contentText).toContain('第三步还要把日常标定周期');
    expect(wx.contentText).not.toContain('mmbiz.qpic.cn');
    expect(wx.contentText).not.toContain('<img');
    expect(wx.contentText).not.toContain('扫码关注');
    expect(wx.contentText).not.toContain('长按识别二维码');

    const zh = extractArticleFromHtml(ZHIHU_FIXTURE_HTML, 'https://zhuanlan.zhihu.com/p/998877');
    expect(zh.site).toBe('zhihu');
    expect(zh.title).toBe('中小企业知识库搭建避坑记录');
    expect(zh.charCount).toBeGreaterThanOrEqual(REWRITE_MIN_SOURCE_CHARS);
    expect(zh.contentText).toContain('先高频问题后历史归档');
    expect(zh.contentText).not.toContain('picx.zhimg.com');
    expect(zh.contentText).not.toContain('原图说明');
    expect(zh.contentText).not.toContain('赞同 328');

    const gen = extractArticleFromHtml(
      GENERIC_PORTAL_FIXTURE_HTML,
      'https://news.example.org/cold-chain.html',
    );
    expect(gen.site).toBe('generic');
    expect(gen.title).toBe('冷链仓储温控巡检规范解读');
    expect(gen.charCount).toBeGreaterThanOrEqual(REWRITE_MIN_SOURCE_CHARS);
    expect(gen.contentText).toContain('收发货月台缓冲间');
    expect(gen.contentText).not.toContain('cdn.example.org');
    expect(gen.contentText).not.toContain('热门排行一');
  });

  it('flags short pages (< 200 chars) and truncates > 8000 chars cleanly', () => {
    const shortHtml =
      '<html><head><title>快讯</title></head><body><article><h1>简短动态</h1><p>今日某展会在上海开幕，现场展示了若干设备新品，参展观众近百人。</p></article></body></html>';
    const extracted = extractArticleFromHtml(shortHtml, 'https://news.example.org/short.html');
    expect(extracted.charCount).toBeLessThan(REWRITE_MIN_SOURCE_CHARS);

    const longParagraph =
      '这是一段用于验证超长源文截断逻辑的测试段落内容，包含完整的标点与语义。'.repeat(12);
    const hugeText = Array.from({ length: 30 }, () => longParagraph).join('\n\n');
    const truncated = truncateSourceText(hugeText, 8000);
    expect(truncated.truncated).toBe(true);
    expect(truncated.charCount).toBeLessThanOrEqual(8000);
    expect(truncated.charCount).toBeGreaterThan(7800);
  });

  it('calculates 5-gram character Jaccard accurately and keeps fake rewrite well below 0.35', () => {
    const src = extractArticleFromHtml(WECHAT_FIXTURE_HTML).contentText;
    expect(computeChar5GramJaccard(src, src)).toBe(1);

    const nearCopy = src.replace('自动化产线升级改造', '智能化车间技术改造');
    expect(computeChar5GramJaccard(src, nearCopy)).toBeGreaterThan(REWRITE_SIM_MAX_DEFAULT);

    const fakeMd = buildFakeRewriteMarkdown({
      sourceTitle: '工业传感器选型实务：从工况评估到维护核对',
      sourceText: src,
      brand: '精测传感',
    });
    const parsed = parseRewrittenMarkdown(fakeMd, {
      sourceTitle: '工业传感器选型实务：从工况评估到维护核对',
      brand: '精测传感',
    });
    expect(parsed.newTitle.length).toBeGreaterThanOrEqual(12);
    expect(parsed.contentHtml).toContain('<h2>');
    expect(parsed.contentHtml).not.toContain('<img');
    expect(computeChar5GramJaccard(src, parsed.contentText)).toBeLessThan(REWRITE_SIM_MAX_DEFAULT);
  });

  it('validates URL mode, pastedText fallback mode, and builds editable timestamped category name', () => {
    const badUrl = rewriteSingleCreateSchema.safeParse({
      pastedText: false,
      url: 'ftp://internal.host/file',
      mediaCategoryId: 'mcat_1',
      imageCount: 2,
      templateId: 'sys_rewrite_01',
    });
    expect(badUrl.success).toBe(false);

    const shortPaste = rewriteSingleCreateSchema.safeParse({
      pastedText: true,
      pastedContent: '只有寥寥十几个字的粘贴内容',
      mediaCategoryId: 'mcat_1',
      imageCount: 2,
      templateId: 'sys_rewrite_01',
    });
    expect(shortPaste.success).toBe(false);

    const validPaste = rewriteSingleCreateSchema.safeParse({
      pastedText: true,
      pastedTitle: '手工补充长文标题',
      pastedContent:
        '这是一段充足的粘贴正文内容，专门用于测试源站反爬无法直接抓取时的手工兜底通道。'.repeat(8),
      mediaCategoryId: 'mcat_1',
      imageCount: 3,
      templateId: 'sys_rewrite_01',
      resultStatus: 'PENDING',
    });
    expect(validPaste.success).toBe(true);

    const normalized = normalizePastedSource({
      pastedTitle: 'QA测试单篇复刻源标题_1119',
      pastedContent: '<p>正文内容<img src="https://evil.example/orig.png" /></p>'.repeat(25),
    });
    expect(normalized.title).toBe('QA测试单篇复刻源标题_1119');
    expect(normalized.contentText).not.toContain('evil.example');

    const msgs = assembleRewriteMessages({
      templateContent: '品牌用{转化词占位符}，公司用{公司名称}。',
      sourceTitle: '测试标题',
      sourceText: normalized.contentText,
      brand: '云析工具',
      retryHighSimilarity: true,
    });
    expect(msgs[0]?.content).toContain('云析工具');
    expect(msgs[0]?.content).toContain('重要二次重写要求');

    const autoName = buildDefaultRewriteCategoryName(new Date('2026-11-17T08:30:00Z'));
    expect(autoName).toMatch(/^爆文复刻-\d{8}-\d{4}$/);
  });

  it('keeps multi-character Chinese/English phrases intact in fake titles and FAQ without "围绕围绕" duplication (#208)', () => {
    const sourceTitle = '2026 氮化镓多口快充充电器实测与选购避坑指南';
    const sourceText =
      '氮化镓充电器在高功率密度桌面快充场景下显著减小了体积，选购时需关注多口同时输出时的功率分配策略、温升控制表现与线缆协议兼容性。'.repeat(
        6,
      );

    expect(extractRewriteTopic(sourceTitle)).toBe('2026 氮化镓多口快充充电器');
    expect(extractRewriteTopic('手工粘贴：车间压缩空气管路节能巡检方法')).toBe(
      '车间压缩空气管路节能巡检方法',
    );
    expect(extractRewriteTopic('围绕企业知识库搭建的要点解析')).toBe('企业知识库搭建的要点');
    const longMixed = extractRewriteTopic(
      '2026款Anker 100W氮化镓多口快充充电器横向对比评测与选购避坑指南',
    );
    expect(longMixed).toContain('Anker');
    expect(longMixed).toContain('100W');

    const fakeMd = buildFakeRewriteMarkdown({
      sourceTitle,
      sourceText,
      brand: 'Anker',
    });
    const parsed = parseRewrittenMarkdown(fakeMd, { sourceTitle, brand: 'Anker' });

    expect(parsed.newTitle).toContain('2026 氮化镓多口快充充电器');
    expect(parsed.newTitle).not.toMatch(/^围绕/);
    expect(parsed.newTitle).not.toContain('多口快的');
    expect(parsed.contentText).toContain('常见问题（FAQ）');
    expect(parsed.contentText).not.toContain('数据留存');
    expect(parsed.contentText).not.toContain('权限隔离');
    expect(parsed.contentText).not.toContain('围绕围绕');
    expect(parsed.contentText).not.toContain('多口快的');
    expect(parsed.contentText).not.toContain('氮化镓多的');
    expect(computeChar5GramJaccard(sourceText, parsed.contentText)).toBeLessThan(
      REWRITE_SIM_MAX_DEFAULT,
    );

    // Even if an upstream LLM emits a title starting with "围绕", FAQ never duplicates "围绕围绕"
    const llmWithWeiraoTitle = [
      '围绕氮化镓快充充电器的实测选购与使用指南',
      '',
      '## 核心选购要点',
      '氮化镓快充在体积与散热之间取得平衡，实际使用中建议核对多口分配功率与协议兼容性。'.repeat(4),
    ].join('\n');
    const parsedLlm = parseRewrittenMarkdown(llmWithWeiraoTitle, {
      sourceTitle: '未命名源文章',
      brand: 'Anker',
    });
    expect(parsedLlm.contentText).toContain('常见问题（FAQ）');
    expect(parsedLlm.contentText).not.toContain('围绕围绕');
  });
});
