import {
  PUBLIC_PRICING_FALLBACK,
  SITE_NAME,
  type ChannelProvider,
  type GeoMarket,
  type PreflightItemCode,
  type PricingAction,
} from '@geomix/shared';
import {
  buildMarketingCanonical,
  getMarketingSiteUrl,
  type MarketingLocale,
} from '../../lib/marketing-i18n';
import type { FaqAccordionItem } from './faq-accordion';
import type { JsonLdData } from './json-ld-script';

export type EngineMarketKey = 'GLOBAL' | 'CN';

export interface EngineBadgeItem {
  id: string;
  label: string;
  detail: string;
}

export interface DiagnosisPromptRow {
  id: string;
  engine: string;
  prompt: string;
  status: 'CITED' | 'MENTIONED' | 'COMPETITOR' | 'ABSENT';
  domain: string;
}

export interface DiagnosisFixture {
  market: EngineMarketKey;
  brandName: string;
  ownedDomain: string;
  totalChecks: number;
  ownedCitationSharePct: number;
  breakdown: {
    CITED: number;
    MENTIONED: number;
    COMPETITOR: number;
    ABSENT: number;
  };
  prompts: readonly DiagnosisPromptRow[];
}

export interface PreflightFixtureBase {
  market: GeoMarket;
  localBrandName: string;
  brandNames: readonly string[];
  title: string;
  targetPrompt: string;
  targetFanOuts: readonly string[];
  matchedFactIds: readonly string[];
  brandFactTexts: readonly string[];
  provider: ChannelProvider;
  variantSlug: string;
  variantMetaDesc: string;
  contentMarkdown: string;
  tbdTarget: string;
  tbdReplacement: string;
  hypeAppend: string;
  cjkLeakAppend: string;
}

export type DistributionChannelKey = 'L1_STOREFRONT' | 'L3_REDDIT' | 'L3_PR_KIT';

export interface DistributionChannelPreview {
  key: DistributionChannelKey;
  label: string;
  badge: string;
  summary: string;
  snippetLabel: string;
  snippet: string;
  checklist: readonly string[];
}

export interface AttributionPoint {
  day: string;
  citationRate: number;
  ownedShare: number;
  note: string;
}

export interface WorkflowStepItem {
  step: string;
  title: string;
  description: string;
  highlights: readonly string[];
}

export interface ConnectorGroupItem {
  tier: string;
  title: string;
  description: string;
  items: readonly string[];
}

export interface TrustCommitmentItem {
  code: string;
  title: string;
  description: string;
}

export const HERO_ENGINES: Record<EngineMarketKey, readonly EngineBadgeItem[]> = {
  GLOBAL: [
    { id: 'chatgpt', label: 'ChatGPT', detail: 'Web Search Citations' },
    { id: 'perplexity', label: 'Perplexity', detail: 'Inline Footnotes' },
    { id: 'claude', label: 'Claude', detail: 'Answer Grounding' },
    { id: 'gemini', label: 'Gemini', detail: 'Entity Synthesis' },
    { id: 'google_aio', label: 'Google AI Overviews', detail: 'SERP Top Summary' },
  ],
  CN: [
    { id: 'doubao', label: '豆包', detail: '联网信源引用' },
    { id: 'deepseek', label: 'DeepSeek', detail: '深度推理参考' },
    { id: 'kimi', label: 'Kimi', detail: '长文检索溯源' },
    { id: 'yuanbao', label: '元宝', detail: '生态内容聚合' },
    { id: 'tongyi', label: '通义', detail: '多轮问答引用' },
  ],
};

export const DIAGNOSIS_FIXTURES: Record<EngineMarketKey, DiagnosisFixture> = {
  GLOBAL: {
    market: 'GLOBAL',
    brandName: 'NordicAudio',
    ownedDomain: 'nordicaudio.example',
    totalChecks: 120,
    ownedCitationSharePct: 44,
    breakdown: {
      CITED: 53,
      MENTIONED: 29,
      COMPETITOR: 24,
      ABSENT: 14,
    },
    prompts: [
      {
        id: 'g1',
        engine: 'Perplexity',
        prompt: 'Best low-latency wireless studio headphones under 300 USD',
        status: 'CITED',
        domain: 'nordicaudio.example/benchmarks/studio-pro-4',
      },
      {
        id: 'g2',
        engine: 'ChatGPT',
        prompt: 'Headphones with 40h+ ANC battery for field mixing',
        status: 'CITED',
        domain: 'nordicaudio.example/guides/anc-battery-lab',
      },
      {
        id: 'g3',
        engine: 'Google AI Overviews',
        prompt: 'USB-C lossless monitoring headset comparison 2026',
        status: 'MENTIONED',
        domain: 'audio-roundup.example/usb-c-monitors',
      },
      {
        id: 'g4',
        engine: 'Gemini',
        prompt: 'Studio wireless latency benchmark 18ms vs 45ms',
        status: 'COMPETITOR',
        domain: 'rival-acoustics.example/wireless-lab',
      },
      {
        id: 'g5',
        engine: 'Claude',
        prompt: 'Repairable modular earpad studio headphones warranty',
        status: 'ABSENT',
        domain: '—',
      },
    ],
  },
  CN: {
    market: 'CN',
    brandName: '北境声学',
    ownedDomain: 'nordicaudio.example',
    totalChecks: 120,
    ownedCitationSharePct: 41,
    breakdown: {
      CITED: 49,
      MENTIONED: 32,
      COMPETITOR: 25,
      ABSENT: 14,
    },
    prompts: [
      {
        id: 'c1',
        engine: 'DeepSeek',
        prompt: '2000元以内低延迟监听无线耳机实测推荐',
        status: 'CITED',
        domain: 'nordicaudio.example/zh/studio-pro-4-lab',
      },
      {
        id: 'c2',
        engine: '豆包',
        prompt: '开启主动降噪续航40小时以上的头戴耳机对比',
        status: 'CITED',
        domain: 'nordicaudio.example/zh/anc-endurance',
      },
      {
        id: 'c3',
        engine: 'Kimi',
        prompt: '支持 USB-C 无损直连的编曲监听耳机怎么选',
        status: 'MENTIONED',
        domain: 'acoustics-review.example/zh/usb-c-list',
      },
      {
        id: 'c4',
        engine: '元宝',
        prompt: '18ms 低延迟无线耳机录音室实测排行',
        status: 'COMPETITOR',
        domain: 'rival-audio-cn.example/latency-test',
      },
      {
        id: 'c5',
        engine: '通义',
        prompt: '可替换耳罩且提供两年质保的便携监听耳机',
        status: 'ABSENT',
        domain: '—',
      },
    ],
  },
};

export const PREFLIGHT_SANDBOX_BASE: Record<EngineMarketKey, PreflightFixtureBase> = {
  GLOBAL: {
    market: 'GLOBAL',
    localBrandName: 'NordicAudio',
    brandNames: ['NordicAudio'],
    title: 'NordicAudio Studio Pro 4: Verified Acoustic & Battery Benchmark',
    targetPrompt: 'Best low-latency studio wireless headphones under 300 USD',
    targetFanOuts: ['battery endurance', 'codec latency', 'acoustic isolation'],
    matchedFactIds: ['fact_battery', 'fact_latency', 'fact_isolation'],
    brandFactTexts: [
      '42 hours battery endurance, 18 ms aptX Low Latency, 34 dB ANC, 248 g weight, 2 years warranty',
    ],
    provider: 'SHOPIFY',
    variantSlug: 'nordicaudio-studio-pro-4-benchmark',
    variantMetaDesc:
      'Lab-verified NordicAudio Studio Pro 4 battery endurance (42 hours), 18 ms latency, and 34 dB isolation benchmarks.',
    contentMarkdown: [
      'NordicAudio Studio Pro 4 delivers 42 hours of continuous ANC playback, 18 ms low-latency wireless transmission, and 34 dB active noise reduction at 280 USD.',
      '',
      '## Battery Endurance Benchmark',
      '- Continuous ANC playback: 42 hours (ISO lab loop at 75 dB SPL).',
      '- Quick charge: 10 minutes via USB-C yields 5 hours of playback.',
      '',
      '## Codec Latency & Acoustic Isolation',
      '| Metric | NordicAudio Studio Pro 4 | Category Median |',
      '| --- | --- | --- |',
      '| Battery endurance | 42 hours | 30 hours |',
      '| Codec latency | 18 ms | 45 ms |',
      '| Acoustic isolation | 34 dB | 26 dB |',
      '| Warranty | 2 years | 1 year |',
      '',
      '## Frequently Asked Questions',
      '**Q: Does NordicAudio Studio Pro 4 support wired studio monitoring?**',
      'A: Yes, USB-C lossless 24-bit/96 kHz audio and 3.5 mm analog bypass are included.',
    ].join('\n'),
    tbdTarget: '42 hours',
    tbdReplacement: '[TBD: runtime]',
    hypeAppend:
      '\n\nIn conclusion, it is worth noting this miracle 100% safe headset is the guaranteed #1 risk-free pick.',
    cjkLeakAppend: '\n\n注意：发布前请核对英文实测数据。',
  },
  CN: {
    market: 'CN',
    localBrandName: '北境声学',
    brandNames: ['北境声学', 'NordicAudio'],
    title: '北境声学 Studio Pro 4 实测：续航、延迟与降噪参数对比',
    targetPrompt: '2000元以内低延迟监听无线耳机推荐',
    targetFanOuts: ['续航实测', '低延迟模式', '主动降噪'],
    matchedFactIds: ['fact_battery', 'fact_latency', 'fact_isolation'],
    brandFactTexts: ['42小时续航，18 ms 低延迟，34 dB 主动降噪，2年官方质保'],
    provider: 'WORDPRESS',
    variantSlug: 'nordicaudio-studio-pro-4-cn-review',
    variantMetaDesc:
      '北境声学 Studio Pro 4 实验室实测：42 小时续航、18 ms 低延迟模式与 34 dB 主动降噪深度对比。',
    contentMarkdown: [
      '北境声学 Studio Pro 4 实测降噪续航达 42 小时，低延迟模式端到端延迟 18 ms，主动降噪深度 34 dB，售价 1999 元并享 2 年质保。',
      '',
      '## 续航实测表现',
      '- 开启主动降噪连续播放：42 小时（75 dB 声压实验室循环）。',
      '- USB-C 快充 10 分钟可补充 5 小时续航。',
      '',
      '## 低延迟模式与主动降噪对比',
      '| 核心指标 | 北境声学 Studio Pro 4 | 同档位均值 |',
      '| --- | --- | --- |',
      '| 续航实测 | 42 小时 | 30 小时 |',
      '| 低延迟模式 | 18 ms | 45 ms |',
      '| 主动降噪 | 34 dB | 26 dB |',
      '| 官方质保 | 2 年 | 1 年 |',
      '',
      '## 常见问题 FAQ',
      '**问：北境声学 Studio Pro 4 是否支持有线无损监听？**',
      '答：支持 USB-C 24-bit/96 kHz 无损输入与 3.5 mm 模拟直连。',
    ].join('\n'),
    tbdTarget: '42 小时',
    tbdReplacement: '[待补充：实验室续航]',
    hypeAppend: '\n\n全网第一音质，绝对顶级降噪体验，包治百病的声波理疗功能。',
    cjkLeakAppend: '',
  },
};

export const PREFLIGHT_CODE_LABELS: Record<
  MarketingLocale,
  Record<PreflightItemCode, { title: string; summary: string }>
> = {
  en: {
    MISSING_FACT_SLOTS: {
      title: 'Unresolved Fact Placeholder Slot',
      summary:
        'Publishing is blocked until every [TBD] / unverified slot is backed by a fact card.',
    },
    GLOBAL_CJK_LEAK: {
      title: 'CJK Character Leak on GLOBAL Track',
      summary: 'Non-brand CJK characters detected in an English storefront variant.',
    },
    COMPLIANCE_BLOCKED: {
      title: 'Prohibited / High-Risk Claim Blocker',
      summary:
        'High-risk medical, financial, or prohibited claim triggered a hard compliance block.',
    },
    GLOBAL_CLAIM_WARNING: {
      title: 'FTC / Global Superlative Warning',
      summary: 'Unsubstantiated superlatives or guarantee terms flagged with line-level excerpts.',
    },
    LOW_GEO_SCORE: {
      title: 'Low GEO Extractability Score',
      summary:
        'Article scored below 70/100; strengthen direct answer, structured tables, or facts.',
    },
    MISSING_FACT_CARDS: {
      title: 'No Verified Fact Cards Linked',
      summary: 'Attach verified brand fact cards before publishing.',
    },
    MISSING_META_DESCRIPTION: {
      title: 'Missing Meta Description',
      summary: 'L1 storefront connectors require a concise meta description.',
    },
    MISSING_SLUG: {
      title: 'Missing URL Slug',
      summary: 'L1 storefront connectors require a stable URL slug.',
    },
  },
  'zh-CN': {
    MISSING_FACT_SLOTS: {
      title: '未补全事实占位槽位',
      summary: '检测到未核验的 [TBD] / [待补充] 占位符，必须补齐品牌事实卡后才允许发布。',
    },
    GLOBAL_CJK_LEAK: {
      title: '海外轨检测到中文残留',
      summary: '英文站点内容混入非品牌专有名词中文字符，已拦截防外泄。',
    },
    COMPLIANCE_BLOCKED: {
      title: '高风险 / 禁做行业违规词拦截',
      summary: '命中广告法禁做词或海外高风险医疗/收益承诺，触发硬门禁拦截。',
    },
    GLOBAL_CLAIM_WARNING: {
      title: '海外极限词与合规风险提示',
      summary: '检测到未经实证的极限词或担保表述，并定位至具体行号与上下文片段。',
    },
    LOW_GEO_SCORE: {
      title: 'GEO 结构体检分偏低',
      summary: '当前得分低于 70/100，建议补充首段直答、对比表或实测数据。',
    },
    MISSING_FACT_CARDS: {
      title: '未绑定品牌事实卡',
      summary: '建议至少关联 1 条已核验的品牌事实卡以防 AI 幻觉。',
    },
    MISSING_META_DESCRIPTION: {
      title: '缺少 Meta Description',
      summary: 'L1 官网连接器直发前需补全页面摘要。',
    },
    MISSING_SLUG: {
      title: '缺少固定 Slug',
      summary: 'L1 官网连接器直发前需配置规范 URL Slug。',
    },
  },
};

export const DISTRIBUTION_CHANNELS: Record<MarketingLocale, readonly DistributionChannelPreview[]> =
  {
    en: [
      {
        key: 'L1_STOREFRONT',
        label: 'Shopify / WordPress L1',
        badge: 'JSON-LD + IndexNow',
        summary:
          'Publishes structured HTML, embedded Article + FAQPage JSON-LD, and triggers an immediate IndexNow ping to accelerate crawler discovery.',
        snippetLabel: 'L1 Publish Payload · nordicaudio.example',
        snippet: `{
  "connector": "SHOPIFY_BLOG",
  "slug": "nordicaudio-studio-pro-4-benchmark",
  "jsonLdTypes": ["Article", "FAQPage"],
  "indexNow": { "status": "202 Accepted", "host": "nordicaudio.example" },
  "ssrfGuard": "VERIFIED_PUBLIC_DNS"
}`,
        checklist: [
          'Embedded JSON-LD matches visible FAQ & specs verbatim',
          'Canonical URL & hreflang validated before push',
          'Automatic T+1 CrawlProbe scheduled after publish',
        ],
      },
      {
        key: 'L3_REDDIT',
        label: 'Reddit Zero-Ban Checklist',
        badge: 'Human-Reviewed L3',
        summary:
          'Generates a neutral, lab-data-first community discussion draft plus an anti-ban self-check list for human review — zero automated posting.',
        snippetLabel: 'Community Draft Guard · r/headphones',
        snippet: `Title: Measured 18ms aptX LL vs 45ms AAC on 4 wireless studio cans (raw CSV)
Tone: Neutral lab log · Disclosure included
Blocked hype terms removed: 3
Outbound link policy: Plain-text methodology first, zero affiliate UTM`,
        checklist: [
          'Brand affiliation disclosed transparently in opening note',
          'Zero promotional superlatives, coupon spam, or bot scheduling',
          'Manual copy-and-post by verified human community owner',
        ],
      },
      {
        key: 'L3_PR_KIT',
        label: 'Login-Free PR/KOL Media Kit',
        badge: '30-Day Share Link',
        summary:
          'Packages verified Brand Fact Cards, citation-ready comparison tables, and clean spec quotes into a read-only external share link.',
        snippetLabel: 'Read-Only Share Packet · Expires in 30d',
        snippet: `Share URL: /share/pr/na_studio_pro4_kit (Read-Only · No Login)
Included Assets:
  - 5 Verified Brand Fact Cards (ISO 75dB battery, 18ms latency, 34dB ANC)
  - Copy-ready Markdown & HTML comparison table
  - Brand pronunciation & official citation URL`,
        checklist: [
          'Zero account required for journalists, agencies, or KOLs',
          'Immutable snapshot of approved specs prevents misquoting',
          'Revocable anytime from GeoMix Studio with audit trail',
        ],
      },
    ],
    'zh-CN': [
      {
        key: 'L1_STOREFRONT',
        label: 'Shopify / WordPress L1 直发',
        badge: 'JSON-LD + IndexNow',
        summary:
          '一键推送结构化正文与 Article + FAQPage JSON-LD，并在发布后自动触发 IndexNow 通知以加快抓取收录。',
        snippetLabel: 'L1 官网推送载荷 · nordicaudio.example',
        snippet: `{
  "connector": "WORDPRESS_REST",
  "slug": "nordicaudio-studio-pro-4-cn-review",
  "jsonLdTypes": ["Article", "FAQPage"],
  "indexNow": { "status": "202 Accepted", "host": "nordicaudio.example" },
  "ssrfGuard": "VERIFIED_PUBLIC_DNS"
}`,
        checklist: [
          '页面内嵌 JSON-LD 与正文参数、FAQ 逐字一致',
          '推送前自动校验 Canonical 与双语 hreflang',
          '发布完成后自动排期 T+1 线上抓取体检',
        ],
      },
      {
        key: 'L3_REDDIT',
        label: 'Reddit / 社区防封自检清单',
        badge: 'L3 人工复核',
        summary:
          '生成以实测数据为核心的去营销社区草稿，并附带逐项防封自检清单，交由运营人工发布——严禁自动化发帖或刷屏。',
        snippetLabel: '社区防封校验 · 音频评测板块',
        snippet: `标题：四款监听无线耳机 18ms vs 45ms 端到端延迟实验室实测记录
语气校验：客观实测日志 · 已附品牌身份披露
已拦截营销极限词：3 处
外链策略：优先完整公开方法论与数据，禁止硬广短链`,
        checklist: [
          '开头透明披露品牌或测试者关联身份',
          '彻底剔除夸张营销词、优惠码堆砌与自动化脚本',
          '由真实运营人员人工审阅后手动发布',
        ],
      },
      {
        key: 'L3_PR_KIT',
        label: '免登录 PR / KOL 供稿包',
        badge: '30 天只读外链',
        summary:
          '将已核验品牌事实卡、可引用参数对比表与规范引用口径打包为免登录只读链接，便于媒体与 KOL 准确引用。',
        snippetLabel: '只读供稿单 · 30 天有效',
        snippet: `分享地址：/share/pr/na_studio_pro4_kit（免登录只读）
包含素材：
  - 5 张已核验品牌事实卡（42h 降噪续航 / 18ms 延迟 / 34dB 降噪）
  - 可直接复用的 Markdown / HTML 参数对比表
  - 官方规范信源 URL 与媒体引用口径`,
        checklist: [
          '媒体记者、公关代理与 KOL 无需注册登录即可打开',
          '锁定已审核参数快照，避免二次传播口径偏差',
          '支持在工作台随时撤销链接并留存审计记录',
        ],
      },
    ],
  };

export const ATTRIBUTION_SERIES: Record<MarketingLocale, readonly AttributionPoint[]> = {
  en: [
    { day: 'T0', citationRate: 18, ownedShare: 11, note: 'Baseline before publish' },
    { day: 'T+7', citationRate: 31, ownedShare: 24, note: 'IndexNow + T+1 probe green' },
    { day: 'T+14', citationRate: 44, ownedShare: 36, note: 'Perplexity & ChatGPT citing docs' },
    {
      day: 'T+30',
      citationRate: 56,
      ownedShare: 48,
      note: 'Sustained owned-domain citation share',
    },
  ],
  'zh-CN': [
    { day: 'T0', citationRate: 18, ownedShare: 11, note: '发布前基线监测' },
    { day: 'T+7', citationRate: 31, ownedShare: 24, note: 'IndexNow 推送 + T+1 体检通过' },
    { day: 'T+14', citationRate: 44, ownedShare: 36, note: '多引擎开始稳定引用官网实测页' },
    { day: 'T+30', citationRate: 56, ownedShare: 48, note: '自有域信源占比持续稳步抬升' },
  ],
};

function pricingUnitPoints(action: PricingAction): number {
  return PUBLIC_PRICING_FALLBACK.items.find((item) => item.action === action)?.unitPoints ?? 0;
}

const GEO_WRITE_PTS = pricingUnitPoints('geo_write');
const VISIBILITY_CHECK_PTS = pricingUnitPoints('visibility_check');
const INLINE_IMAGE_PTS = pricingUnitPoints('inline_image_gen');
const GEO_VARIANT_PTS = pricingUnitPoints('geo_variant');

export const HOME_FAQ_ITEMS: Record<MarketingLocale, readonly FaqAccordionItem[]> = {
  en: [
    {
      id: 'geo-vs-seo',
      question: 'How is GEO different from traditional SEO?',
      answer:
        'Traditional SEO optimizes web pages to rank in blue-link search results. GEO (Generative Engine Optimization) optimizes verified brand facts, structured comparisons, and crawlable schemas so AI engines like ChatGPT, Perplexity, Google AI Overviews, DeepSeek, and Doubao cite your owned domain as a trusted source inside synthesized answers — not just mention your name in passing.',
    },
    {
      id: 'points-billing',
      question: 'How does transparent points billing work, and what actions cost 0 points?',
      answer: `GeoMix uses a transparent action-based points ledger with automatic refund on task failure: GEO Targeted Writing costs ${GEO_WRITE_PTS} pts/article, AI Visibility Check costs ${VISIBILITY_CHECK_PTS} pts/engine run, Inline AI Image costs ${INLINE_IMAGE_PTS} pts/image, and Channel Variant Adaptation costs ${GEO_VARIANT_PTS} pts/channel. All 7 core workflow utilities (GEO Topic Brief, Brand Fact Card Extraction, Real-Time 0–100 GEO Audit, Targeted Section Rewrite, Pre-Publish Preflight Gate, T+1 Crawl & Schema Probe, and Login-Free PR/KOL Media Kit) plus JSON-LD & llms.txt export cost 0 points. Qualified teams start with a ${PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US')}-point Demo trial valid for ${PUBLIC_PRICING_FALLBACK.demoTrial.validDays} days, and production plans are tailored via Contact Sales.`,
    },
    {
      id: 'anti-hallucination',
      question: 'How does GeoMix prevent AI hallucinations and compliance violations?',
      answer:
        'Every draft is grounded in your verified Brand Fact Cards. If an unverified specification is missing, GeoMix inserts an explicit [TBD] slot instead of fabricating numbers. Before publishing, the Dual-Track Preflight Gate blocks unresolved [TBD] slots, detects CJK leakage on GLOBAL English tracks, and flags FTC / China Advertising Law high-risk claims with line-level excerpts.',
    },
    {
      id: 'connectors-roadmap',
      question: 'Which storefronts, community channels, and v2.2 integrations are supported?',
      answer:
        'In GA v2.1, GeoMix supports L1 direct publishing to Shopify, WordPress, Webflow, and signed HMAC Webhook + IndexNow, plus L3 human-reviewed checklists for Reddit, Quora, and Zhihu alongside 30-day login-free PR/KOL media kits. Upcoming v2.2 roadmap features — clearly separated from GA — include Near-Miss citation mining, Wilson 95% confidence intervals, and Ghost, Dev.to, Hashnode, GitHub MDX, WeChat Draft Box, and Chrome Extension L2 bridges.',
    },
    {
      id: 'demo-trial',
      question: 'How do I request the 1,000-point Demo trial?',
      answer:
        'Submit your brand name, target market (Global, CN, or Both), and work email on the Request Demo page (/demo). Our team reviews every request and provisions a dedicated 1,000-point Demo workspace valid for 365 days — no credit card required to evaluate the full diagnosis, studio, and preflight workflow.',
    },
  ],
  'zh-CN': [
    {
      id: 'geo-vs-seo',
      question: 'GEO（生成式引擎优化）与传统 SEO 有什么本质区别？',
      answer:
        '传统 SEO 聚焦网页在搜索结果页中的蓝色链接排名；GEO 则围绕已核验的品牌事实库、高信息密度对比结构与可抓取 Schema，让 ChatGPT、Perplexity、Google AI Overviews、豆包、DeepSeek、Kimi 等 AI 引擎在生成答案时，直接将你的官网或权威内容作为「首选信源」引用，而不只是顺带提及品牌名。',
    },
    {
      id: 'points-billing',
      question: '点数计费如何透明核算？哪些核心动作 0 点数免费？',
      answer: `GeoMix 采用透明按动作扣点、任务失败自动退点的可审计账本：GEO 靶向写作 ${GEO_WRITE_PTS} 点/篇，AI 可见性监测 ${VISIBILITY_CHECK_PTS} 点/引擎/次，行内 AI 配图 ${INLINE_IMAGE_PTS} 点/张，渠道变体改写 ${GEO_VARIANT_PTS} 点/渠道。全部 7 项核心辅助动作（GEO 选题简报、品牌事实卡提取、GEO 0–100 实时体检、局部分段重写、发布前合规门禁校验、T+1 线上抓取与 Schema 体检、免登录 PR/KOL 供稿单）以及 JSON-LD / llms.txt 导出均为 0 点数。团队可通过预约演示申请含 ${PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US')} 点 / ${PUBLIC_PRICING_FALLBACK.demoTrial.validDays} 天有效期的 Demo 试用，正式套餐按需由商务顾问定制。`,
    },
    {
      id: 'anti-hallucination',
      question: 'GeoMix 如何防止 AI 编造参数幻觉与双市场合规违规？',
      answer:
        '写作阶段严格绑定已核验的品牌事实卡，遇到缺失参数时强制插入 [待补充] / [TBD] 占位符而不是杜撰数据。发布前必须通过双轨合规门禁：硬拦截未补全占位符、海外英文轨中文残留以及广告法/海外高风险违规词，并对极限词给出逐行摘录提示。',
    },
    {
      id: 'connectors-roadmap',
      question: '当前支持哪些官网直发连接器、社区协作渠道与 v2.2 规划能力？',
      answer:
        '已上线的 v2.1 正式版包含 L1 官方连接器（Shopify、WordPress、Webflow、签名 HMAC Webhook + IndexNow）以及 L3 合规社区防封自检清单（Reddit、Quora、知乎，人工复核严禁刷屏）与 30 天免登录 PR/KOL 供稿包。即将上线的 v2.2 路线图（与已上线能力明确区分）将扩展 Near-Miss 差一步引用挖掘、Wilson 95% 置信区间以及 Ghost / Dev.to / Hashnode / GitHub MDX / 微信公众号草稿箱 / Chrome 扩展 L2 桥接。',
    },
    {
      id: 'demo-trial',
      question: '如何申请 1,000 点 Demo 试用账号？',
      answer:
        '前往申请试用页（/zh/demo）填写工作邮箱、品牌名称与目标市场（出海 / 国内 / 双市场），提交后由团队审核并开通含 1,000 点数、365 天有效期的专属 Demo 租户，即可完整体验引用诊断、合规门禁与多渠道分发闭环。',
    },
  ],
};

export interface HomePageCopy {
  eyebrow: string;
  heroTitle: string;
  heroSubtitle: string;
  primaryCta: { label: string; href: string };
  secondaryCta: { label: string; href: string };
  engineStripLabel: string;
  sandboxEyebrow: string;
  sandboxTitle: string;
  sandboxSubtitle: string;
  workflowEyebrow: string;
  workflowTitle: string;
  workflowSubtitle: string;
  workflowSteps: readonly WorkflowStepItem[];
  connectorsTitle: string;
  connectors: readonly ConnectorGroupItem[];
  roadmapBadge: string;
  roadmapTitle: string;
  roadmapDescription: string;
  roadmapItems: readonly string[];
  trustEyebrow: string;
  trustTitle: string;
  trustSubtitle: string;
  trustCommitments: readonly TrustCommitmentItem[];
  faqEyebrow: string;
  faqTitle: string;
  faqSubtitle: string;
  bottomCtaTitle: string;
  bottomCtaSubtitle: string;
  bottomPrimaryCta: { label: string; href: string };
  bottomSecondaryCta: { label: string; href: string };
}

export const HOME_PAGE_COPY: Record<MarketingLocale, HomePageCopy> = {
  en: {
    eyebrow: 'DUAL-MARKET GEO PLATFORM · GLOBAL + CN',
    heroTitle: 'Make Your Brand the Source AI Cites — Not Just Mentions.',
    heroSubtitle:
      'Turn verified Brand Fact Cards into AI-citable content across Global and China engines. Diagnose citation gaps, enforce dual-track compliance before publishing, distribute 1→N cleanly, and prove lift with T+1/7/14/30 retests.',
    primaryCta: { label: 'Request 1,000-Pt Trial', href: '/demo' },
    secondaryCta: { label: 'Explore Live Sandbox', href: '#sandbox' },
    engineStripLabel: 'Active AI Engine Coverage',
    sandboxEyebrow: 'INTERACTIVE PRODUCT SANDBOX · ZERO LOGIN',
    sandboxTitle: 'Inspect the Real Diagnosis, Preflight Gate & Attribution Loop',
    sandboxSubtitle:
      'Switch markets, inject compliance edge cases into the live @geomix/shared preflight engine, and inspect structured delivery outputs using our sanitized fictional brand NordicAudio.',
    workflowEyebrow: '4-STEP CLOSED LOOP',
    workflowTitle: 'From Verified Facts to Auditable Citation Lift',
    workflowSubtitle:
      'Every stage is deterministic, grounded in your source-of-truth specs, and separated cleanly between GA v2.1 capabilities and the upcoming v2.2 roadmap.',
    workflowSteps: [
      {
        step: '01',
        title: 'Brand Fact Base',
        description:
          'Extract and lock verified specs, pricing boundaries, and lab benchmarks into structured Brand Fact Cards inside tenant-isolated storage.',
        highlights: ['0-pt Brand Fact Card extraction', 'Strict tenant isolation (pgvector)'],
      },
      {
        step: '02',
        title: 'Multi-Engine Citation Diagnosis',
        description:
          'Probe buyer prompts across GLOBAL and CN AI engines to separate real owned-domain citations from passive mentions and competitor wins.',
        highlights: ['CITED / MENTIONED / COMPETITOR / ABSENT', 'Owned-domain citation share'],
      },
      {
        step: '03',
        title: 'Studio & Dual-Track Preflight Gate',
        description:
          'Draft answer-first structured content, audit live 0–100 GEO extractability, and hard-block [TBD] slots, CJK leaks, or high-risk claims.',
        highlights: ['0-pt real-time GEO audit', 'Hard-blocked compliance gate'],
      },
      {
        step: '04',
        title: '1→N Distribution & Attribution',
        description:
          'Push clean HTML + JSON-LD + IndexNow to official storefronts, prepare human-reviewed L3 packs, and verify T+1 crawl health plus T+7/14/30 lift.',
        highlights: ['T+1 CrawlProbe (HTTP 200 / Schema)', 'T+7 → T+14 → T+30 retest curve'],
      },
    ],
    connectorsTitle: 'Connector Ecosystem (GA v2.1)',
    connectors: [
      {
        tier: 'GA v2.1 · L1 Official',
        title: 'Owned-Site Direct Connectors',
        description:
          'Push structured posts, embedded JSON-LD, and IndexNow pings directly to owned domains with full SSRF and credential protection.',
        items: ['Shopify Blog', 'WordPress', 'Webflow CMS', 'Signed HMAC Webhook + IndexNow'],
      },
      {
        tier: 'GA v2.1 · L3 Compliant Assist',
        title: 'Community Self-Check & PR/KOL Media Kits',
        description:
          'Human-in-the-loop community drafts with anti-ban checklists plus 30-day login-free media kits — strictly zero automated astroturfing.',
        items: [
          'Reddit Zero-Ban Checklist',
          'Quora Human Review Guide',
          'Zhihu Compliance Checklist',
          '30-Day Login-Free PR/KOL Kit',
        ],
      },
    ],
    roadmapBadge: 'Upcoming v2.2',
    roadmapTitle: 'Roadmap Preview (Clearly Separated from GA v2.1)',
    roadmapDescription:
      'In active architecture for v2.2 — transparently marked so your team plans around GA capabilities today.',
    roadmapItems: [
      'Near-Miss Citation Mining',
      'Wilson 95% Confidence Intervals',
      'Ghost / Dev.to / Hashnode / GitHub MDX',
      'WeChat Draft Box & Chrome Extension L2',
    ],
    trustEyebrow: 'SECURITY & ENGINEERING COMMITMENTS',
    trustTitle: 'Built for Real Production Governance, Not Black-Box Scripts',
    trustSubtitle:
      'Hard architectural guardrails protect your credentials, outbound infrastructure, tenant data, and community reputation.',
    trustCommitments: [
      {
        code: 'ENC-01',
        title: 'AES-256-GCM Credentials at Rest',
        description:
          'Connector tokens and signing secrets are encrypted at rest with AES-256-GCM; API responses never echo plaintext credentials back to browsers.',
      },
      {
        code: 'NET-02',
        title: '100% SSRF Outbound Protection',
        description:
          'Every outbound connector push, webhook delivery, and T+1 CrawlProbe validates public DNS and blocks private/loopback/metadata IP ranges.',
      },
      {
        code: 'ISO-03',
        title: 'Strict Tenant Isolation & Auditable Ledger',
        description:
          'PostgreSQL + pgvector tenant scoping isolates brand facts and tasks, paired with an auditable points ledger that auto-refunds on task failure.',
      },
      {
        code: 'CMP-04',
        title: 'Zero Automated Community Astroturfing',
        description:
          'GeoMix never automates Reddit, Quora, or Zhihu posting or bot engagement. L3 community workflows are strictly human-reviewed checklists.',
      },
    ],
    faqEyebrow: 'FREQUENTLY ASKED QUESTIONS',
    faqTitle: 'Direct Answers for Growth, Content & Engineering Teams',
    faqSubtitle:
      'Every answer below is emitted verbatim in our FAQPage JSON-LD so both buyers and AI engines read identical facts.',
    bottomCtaTitle: 'Start Measuring & Lifting Your AI Citation Share',
    bottomCtaSubtitle:
      'Estimate your monthly points budget or request a 1,000-point Demo workspace valid for 365 days.',
    bottomPrimaryCta: { label: 'Request 1,000-Pt Trial', href: '/demo' },
    bottomSecondaryCta: { label: 'View Pricing & Calculator', href: '/pricing' },
  },
  'zh-CN': {
    eyebrow: 'DUAL-MARKET GEO PLATFORM · GLOBAL + CN',
    heroTitle: '让品牌成为 AI 回答的「首选信源」，而不只是被顺带提及',
    heroSubtitle:
      '打通出海与国内双市场 AI 引擎。基于已核验品牌事实库开展引用拓扑诊断、双轨合规门禁校验、1→N 合规分发与 T+1/7/14/30 归因复测，让每一次内容投入都能看见可验证的引用增长。',
    primaryCta: { label: '申请 1,000 点试用', href: '/zh/demo' },
    secondaryCta: { label: '体验交互沙盒', href: '#sandbox' },
    engineStripLabel: '双市场 AI 引擎监测覆盖',
    sandboxEyebrow: '零登录交互产品沙盒 · 真实共享校验引擎',
    sandboxTitle: '亲手体验引用诊断、合规门禁拦截与多渠道归因闭环',
    sandboxSubtitle:
      '无需登录，直接切换出海 / 国内视角，实时触发 @geomix/shared 合规门禁与 0–100 GEO 体检引擎（所有示例数据均使用虚构品牌「北境声学 / NordicAudio」）。',
    workflowEyebrow: '四步闭环工作流',
    workflowTitle: '从品牌事实库到可审计的 AI 引用归因',
    workflowSubtitle:
      '每个环节均有明确工程门禁与透明点数核算，并清晰界定已上线 v2.1 能力与即将上线的 v2.2 规划边界。',
    workflowSteps: [
      {
        step: '01',
        title: '沉淀品牌事实库',
        description:
          '将官方参数、实测数据与资质边界提炼为结构化品牌事实卡，在严格租户隔离的向量库中统一管理。',
        highlights: ['品牌事实卡提取 0 点数', 'PostgreSQL + pgvector 租户隔离'],
      },
      {
        step: '02',
        title: '多引擎引用拓扑诊断',
        description:
          '围绕真实买家提问监测海外与国内主流 AI 引擎，精准拆分「官方引用 / 仅提及 / 竞品占位 / 缺席」。',
        highlights: ['四态引用拓扑拆解', '自有域信源占比追踪'],
      },
      {
        step: '03',
        title: '结构化写作与双轨门禁',
        description:
          '生成结论前置的高可抽取文章，实时计算 0–100 GEO 体检分，并硬拦截 [待补充] 槽位、中英串码与违规极限词。',
        highlights: ['GEO 0–100 实时体检 0 点数', '发布前双轨合规硬门禁'],
      },
      {
        step: '04',
        title: '1→N 合规分发与归因复测',
        description:
          '通过 L1 官方连接器推送正文与 JSON-LD / IndexNow，输出 L3 人工复核包，并自动完成 T+1 抓取体检与 T+7/14/30 复测。',
        highlights: ['T+1 CrawlProbe 抓取验收', 'T+7 → T+14 → T+30 归因曲线'],
      },
    ],
    connectorsTitle: '已上线连接器生态（GA v2.1）',
    connectors: [
      {
        tier: 'GA v2.1 · L1 官方连接器',
        title: '自有官网与独立站直发',
        description: '自动携带内嵌 JSON-LD 与 IndexNow 推送，全程覆盖 SSRF 防护与加密凭据隔离。',
        items: [
          'Shopify 博客直发',
          'WordPress 直发',
          'Webflow CMS',
          '签名 HMAC Webhook + IndexNow',
        ],
      },
      {
        tier: 'GA v2.1 · L3 合规社区与外链协作',
        title: '社区防封自检与免登录 PR/KOL 供稿包',
        description:
          '提供去营销防封自检清单与 30 天免登录只读供稿单，由真实运营人工复核发布——严禁自动化刷屏。',
        items: [
          'Reddit 防封自检清单',
          'Quora 人工复核指南',
          '知乎合规自检清单',
          '30 天免登录 PR/KOL 供稿包',
        ],
      },
    ],
    roadmapBadge: '即将上线 v2.2',
    roadmapTitle: 'v2.2 路线图预告（与已上线 v2.1 能力明确区分）',
    roadmapDescription:
      '以下能力处于 v2.2 架构规划阶段，公开标注边界，确保团队基于当前 GA 能力做出清晰选型。',
    roadmapItems: [
      'Near-Miss 差一步引用机会挖掘',
      'Wilson 95% 置信区间统计归因',
      'Ghost / Dev.to / Hashnode / GitHub MDX',
      '微信公众号草稿箱与 Chrome 扩展 L2 桥接',
    ],
    trustEyebrow: '安全与工程治理承诺',
    trustTitle: '面向生产级团队的确定性工程保障',
    trustSubtitle: '用可验证的安全边界守住凭据资产、出站网络、租户数据与品牌社区声誉。',
    trustCommitments: [
      {
        code: 'ENC-01',
        title: 'AES-256-GCM 凭据落盘加密',
        description:
          '所有连接器 Token 与 Webhook 密钥均采用 AES-256-GCM 静态加密存储，接口绝不向前端明文回显敏感凭据。',
      },
      {
        code: 'NET-02',
        title: '100% 出站 SSRF 防护',
        description:
          '所有官网连接器推送、Webhook 投递与 T+1 CrawlProbe 探测均强制校验公网解析结果，阻断内网与元数据地址访问。',
      },
      {
        code: 'ISO-03',
        title: '严格多租户隔离与可审计点数账本',
        description:
          '基于 PostgreSQL + pgvector 强制租户隔离品牌事实与任务资产；点数流水全程可审计，任务失败或超时自动退点。',
      },
      {
        code: 'CMP-04',
        title: '严格零自动化社区刷屏 / 水军发帖',
        description:
          'GeoMix 绝不提供 Reddit、Quora、知乎等社区的自动化脚本发帖或机器人互动，仅提供人工复核的合规草稿与防封清单。',
      },
    ],
    faqEyebrow: '常见问题',
    faqTitle: '关于 GEO 效果、透明计费与合规边界的直答',
    faqSubtitle:
      '以下每一条问答均与页面内嵌的 FAQPage JSON-LD 逐字一致，确保团队成员与 AI 引擎读取完全一致的事实。',
    bottomCtaTitle: '让 AI 回答开始优先引用你的品牌官网',
    bottomCtaSubtitle:
      '立即测算月度点数预算，或预约申请含 1,000 点 / 365 天有效期的专属 Demo 试用。',
    bottomPrimaryCta: { label: '申请 1,000 点试用', href: '/zh/demo' },
    bottomSecondaryCta: { label: '查看定价与计算器', href: '/zh/pricing' },
  },
};

export function buildHomeJsonLdSchemas(
  locale: MarketingLocale,
  siteUrl = getMarketingSiteUrl(),
): {
  organization: JsonLdData;
  softwareApplication: JsonLdData;
  faqPage: JsonLdData;
} {
  const isZh = locale === 'zh-CN';
  const canonicalUrl = buildMarketingCanonical(isZh ? '/zh' : '/', siteUrl);
  const demoUrl = buildMarketingCanonical(isZh ? '/zh/demo' : '/demo', siteUrl);
  const faqItems = HOME_FAQ_ITEMS[locale];

  const organization: JsonLdData = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: siteUrl,
    description: isZh
      ? '面向出海与国内双市场的 GEO 内容创作与 AI 可见度平台。'
      : 'Dual-market Generative Engine Optimization (GEO) & AI Visibility Platform (Global + CN).',
  };

  const softwareApplication: JsonLdData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: canonicalUrl,
    inLanguage: locale,
    description: HOME_PAGE_COPY[locale].heroSubtitle,
    offers: {
      '@type': 'Offer',
      name: isZh
        ? `${PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US')} 点免费 Demo 试用（${PUBLIC_PRICING_FALLBACK.demoTrial.validDays} 天有效）`
        : `${PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US')}-Point Trial Demo (${PUBLIC_PRICING_FALLBACK.demoTrial.validDays} Days)`,
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: demoUrl,
    },
  };

  const faqPage: JsonLdData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };

  return { organization, softwareApplication, faqPage };
}
