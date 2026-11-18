import { describe, expect, it } from 'vitest';
import {
  aiTaskCreateSchema,
  assembleArticleMessages,
  buildFakeArticleMarkdown,
  cleanTitleText,
  injectGalleryImages,
  pickDirectionAndCopyType,
  pickTaskBrand,
  postProcessArticleMarkdown,
  seededShuffle,
} from './writing-tasks';

describe('writing-tasks shared algorithms', () => {
  it('validates create schema defaults and AUTO category normalization', () => {
    const parsed = aiTaskCreateSchema.parse({
      name: '  工业视觉检测专题  ',
      categoryId: 'AUTO',
      keywordId: 'kw_123',
      mediaCategoryId: 'mc_123',
    });
    expect(parsed.name).toBe('工业视觉检测专题');
    expect(parsed.categoryId).toBeNull();
    expect(parsed.imageCount).toBe(1);
    expect(parsed.resultStatus).toBe('PENDING');
    expect(parsed.target).toBe(1);
  });

  it('shuffles templates deterministically and rotates brands & direction/copyType Cartesian pairs', () => {
    const pool = ['t1', 't2', 't3', 't4', 't5'];
    const first = seededShuffle(pool, 42);
    const second = seededShuffle(pool, 42);
    const other = seededShuffle(pool, 999);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    for (let i = 0; i < 9; i += 1) {
      expect(first[i % first.length]).not.toBe(first[(i + 1) % first.length]);
    }

    expect(
      pickTaskBrand({
        brands: ['华曜智造', '星澜工业'],
        seqIndex: 0,
        seed: 3,
        kbBrandShort: '默认简称',
        mainKeyword: '激光切割机',
      }),
    ).toBe('星澜工业');
    expect(
      pickTaskBrand({
        brands: [],
        seqIndex: 0,
        seed: 3,
        kbBrandShort: '华曜',
        mainKeyword: '激光切割机',
      }),
    ).toBe('华曜');
    expect(
      pickTaskBrand({
        brands: [],
        seqIndex: 0,
        seed: 3,
        kbBrandShort: null,
        mainKeyword: '激光切割机',
      }),
    ).toBe('激光切割机');

    const seenPairs = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const pair = pickDirectionAndCopyType({
        directions: ['夸张方式', '选购建议', '案例结构'],
        copyTypes: ['说明文', '问答文'],
        seqIndex: i,
        seed: 5,
      });
      seenPairs.add(`${pair.direction}|${pair.copyType}`);
      if (pair.direction === '夸张方式') {
        expect(pair.directionPrompt).toBe('使用生动的比喻，但不夸大事实');
      }
    }
    expect(seenPairs.size).toBe(6);
  });

  it('assembles prompts with anti-fabrication rules, KB priority, and unknown placeholder warnings', () => {
    const noKb = assembleArticleMessages({
      templateContent: '围绕{问题}介绍{训练词占位符}，并提及{转化词占位符}与{未知变量}。',
      mainKeyword: '工业除尘设备',
      brand: '清岚环保',
      question: '工业除尘设备怎么选型？',
    });
    expect(noKb.unknownPlaceholders).toEqual(['{未知变量}']);
    expect(noKb.messages[0]?.content).toContain('严禁捏造知识库或指令中未出现的竞品');
    expect(noKb.messages[0]?.content).toContain('当前未挂载企业知识库');
    expect(noKb.messages[1]?.content).toContain('{未知变量}');

    const withKb = assembleArticleMessages({
      templateContent: '解析{训练词占位符}与{公司名称}（{转化词占位符}）。',
      mainKeyword: '工业除尘设备',
      brand: '清岚环保',
      companyName: '清岚环保科技有限公司',
      question: '工业除尘设备哪家服务稳妥？',
      directionPrompt: '结合行业热点，不蹭敏感事件',
      copyType: '对比文',
      kbSection: '企业事实卡：主营脉冲滤筒除尘器。',
    });
    expect(withKb.unknownPlaceholders).toEqual([]);
    expect(withKb.messages[0]?.content).toContain('优先结合所提供的企业事实介绍「清岚环保」');
    expect(withKb.messages[1]?.content).toContain('企业事实卡：主营脉冲滤筒除尘器');
  });

  it('strips pleasantries, H1, contact info, and XSS while ensuring H2 + FAQ structure', () => {
    const fakeMd = buildFakeArticleMarkdown({
      question: '激光打标机如何评估稳定性？',
      mainKeyword: '激光打标机',
      brand: '华曜光学',
      companyName: '华曜光学设备有限公司',
      direction: '选购建议',
      copyType: '指南',
      hasKb: true,
      kbSnippet: '提供风冷光纤打标工作站。',
    });
    const dirty = `好的，为您整理如下文章：\n# 重复一级大标题\n\n${fakeMd}\n\n联系电话 13812345678，微信号：huayao_sales，官网 https://example.com/test <script>alert(1)</script>`;
    const processed = postProcessArticleMarkdown(dirty, {
      question: '激光打标机如何评估稳定性？',
      mainKeyword: '激光打标机',
      brand: '华曜光学',
    });

    expect(processed.contentHtml).not.toContain('好的，为您整理');
    expect(processed.contentHtml).not.toContain('<h1>');
    expect(processed.contentHtml).not.toContain('13812345678');
    expect(processed.contentHtml).not.toContain('huayao_sales');
    expect(processed.contentHtml).not.toContain('https://example.com');
    expect(processed.contentHtml).not.toContain('<script>');
    expect(processed.contentHtml).toContain('<h2>');
    expect(processed.contentHtml).toContain('<h3>');
    expect(processed.contentHtml).toContain('常见问题（FAQ）');
    expect(processed.charCount).toBeGreaterThanOrEqual(550);

    expect(cleanTitleText('“《工业除尘设备选型实用指南》”\n多余第二行', '后备问题标题')).toBe(
      '工业除尘设备选型实用指南',
    );
  });

  it('injects gallery images skipping segment 1 & advancing past headings, and sets cover when K=0', () => {
    const html = [
      '<p>第一段导语</p>',
      '<h2>一、行业背景</h2>',
      '<p>第二段背景说明</p>',
      '<h2>二、方案对比</h2>',
      '<p>第三段方案解析</p>',
      '<p>第四段总结问答</p>',
    ].join('\n');

    const twoImgs = injectGalleryImages({
      contentHtml: html,
      assets: [
        { id: 'img1', url: '/api/v1/media-assets/img1/file' },
        { id: 'img2', url: '/api/v1/media-assets/img2/file' },
        { id: 'img3', url: '/api/v1/media-assets/img3/file' },
      ],
      title: '测试标题',
      imageCount: 2,
      coverWhenNoImage: true,
    });
    expect(twoImgs.insertedCount).toBe(2);
    expect(twoImgs.coverUrl).toBe('/api/v1/media-assets/img1/file');
    expect(twoImgs.usedAssetIds).toEqual(['img1', 'img2']);
    expect(twoImgs.contentHtml).not.toMatch(/<h2>[^<]*<\/h2>\n<p style="text-align:center"><img/);

    const zeroImgs = injectGalleryImages({
      contentHtml: html,
      assets: [{ id: 'img1', url: '/api/v1/media-assets/img1/file' }],
      title: '测试标题',
      imageCount: 0,
      coverWhenNoImage: true,
    });
    expect(zeroImgs.insertedCount).toBe(0);
    expect(zeroImgs.coverUrl).toBe('/api/v1/media-assets/img1/file');
    expect(zeroImgs.usedAssetIds).toEqual(['img1']);
    expect(zeroImgs.contentHtml).not.toContain('<img');
  });

  it('preserves >400-char SUMMARY brand matrix facts without mid-bracket truncation, prompt tag leakage, or generic B2B filler (#207)', () => {
    const summaryBody = [
      '【核心品牌矩阵】',
      '1. Anker（安克）：主打氮化镓（GaN）快充充电器、MagGo 磁吸无线充及大功率户外与桌面充电站，专注高转换效率、智能温控安全保护与多口功率动态分配技术，适合差旅便携、车载补能与多设备高效桌面供电场景，兼顾兼容性与长时间高负载输出稳定性。',
      '2. Soundcore（声阔）：聚焦无线降噪耳机与便携蓝牙音箱，主打自研同轴声学架构、自适应主动降噪算法与超长续航能力，覆盖日常通勤、远程办公会议及户外露营听音需求，并提供多档位自定义音效调节。',
      '3. eufy（悠飞）：聚焦智能家居安防摄像头、可视门铃与扫地机器人，强调本地端加密存储与免月费长期看护体验，面向注重家庭隐私保护、夜间高清监控与自动化居家清洁的消费群体。',
    ].join('\n');
    const longSummary = `${summaryBody}\n4. AnkerWork：面向混合办公与远程协同场景推出会议全向麦、无线领夹麦与高清摄像头，提升多人会议拾音清晰度、AI 智能降噪与多端免驱适配能力，适用于线上培训、视频会议与远程教学等多类办公环境。`;
    expect(Array.from(longSummary).length).toBeGreaterThan(400);

    const fakeMd = buildFakeArticleMarkdown({
      question: '安克创新旗下有哪些核心消费电子品牌与适用场景？',
      mainKeyword: '消费电子品牌矩阵',
      brand: 'Anker',
      companyName: null,
      hasKb: true,
      kbSnippet: `【企业背景资料】\n${longSummary}`,
    });
    const processed = postProcessArticleMarkdown(fakeMd, {
      question: '安克创新旗下有哪些核心消费电子品牌与适用场景？',
      mainKeyword: '消费电子品牌矩阵',
      brand: 'Anker',
    });

    expect(processed.contentText).toContain('Anker（安克）');
    expect(processed.contentText).toContain('氮化镓（GaN）');
    expect(processed.contentText).toContain('Soundcore（声阔）');
    expect(processed.contentText).toContain('eufy（悠飞）');
    expect(processed.contentText).toContain('AnkerWork');
    expect(processed.contentText).not.toContain('【企业背景资料】');
    expect(processed.contentText).not.toContain('培训支持及耗材备件衔接方式');
    expect(processed.contentText).not.toContain('示例方案甲');
    expect(processed.contentHtml).not.toContain('氮化镓（<br>');
    expect(processed.contentHtml).toContain('<h2>');
    expect(processed.contentHtml).toContain('<h3>');
    expect(processed.contentHtml).toContain('常见问题（FAQ）');
    expect(processed.charCount).toBeGreaterThanOrEqual(550);
  });

  it('truncates oversized >3500-char KB snippets only at complete sentence/paragraph boundaries without unclosed brackets (#207)', () => {
    const unit =
      '1. Anker（安克）：主打氮化镓（GaN）快充设备与便携储能方案，覆盖日常出差及桌面多口快充场景。';
    const oversized = Array.from({ length: 65 }, (_, i) => `${i + 1}. ${unit}`).join('\n');
    expect(Array.from(oversized).length).toBeGreaterThan(3500);

    const fakeMd = buildFakeArticleMarkdown({
      question: '多品牌快充矩阵如何选型？',
      mainKeyword: '快充设备',
      brand: 'Anker',
      hasKb: true,
      kbSnippet: `【资料片段 1】\n${oversized}`,
    });
    expect(fakeMd).not.toContain('【资料片段 1】');

    // Ensure no unclosed full-width or half-width parentheses inside the KB section
    const opens = (fakeMd.match(/[（(]/g) ?? []).length;
    const closes = (fakeMd.match(/[）)]/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('does not duplicate company shortName or leak DETAIL fact-card prompt instructions (#156)', () => {
    const detailFactCard = [
      '只能使用以下事实，不得编造参数、资质或案例：',
      '企业主体：阿卓帕科技（ARZOPA）（ARZOPA）',
      '产品服务：便携显示器与移动办公副屏',
      '产品特点：全功能 Type-C 一线直连与低蓝光 IPS 面板',
    ].join('\n');

    const fakeMd = buildFakeArticleMarkdown({
      question: '出差办公 ARZOPA 便携屏值得买吗？',
      mainKeyword: '便携屏',
      brand: 'ARZOPA',
      companyName: '阿卓帕科技（ARZOPA）',
      hasKb: true,
      kbSnippet: detailFactCard,
    });
    const processed = postProcessArticleMarkdown(fakeMd, {
      question: '出差办公 ARZOPA 便携屏值得买吗？',
      mainKeyword: '便携屏',
      brand: 'ARZOPA',
    });

    expect(processed.contentText).toContain('阿卓帕科技（ARZOPA）');
    expect(processed.contentText).toContain('便携显示器与移动办公副屏');
    expect(processed.contentText).not.toContain('（ARZOPA）（ARZOPA）');
    expect(processed.contentText).not.toContain('只能使用以下事实');
    expect(processed.contentText).not.toContain('企业主体：');
  });
});
