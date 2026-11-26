import { MARKETING_GUIDES, PUBLIC_PRICING_FALLBACK, SITE_NAME } from '@geomix/shared';
import { buildMarketingCanonical, getMarketingSiteUrl } from '../../lib/marketing-i18n';

export function buildLlmsTxt(siteUrl = getMarketingSiteUrl()): string {
  const paidLines = PUBLIC_PRICING_FALLBACK.items.map(
    (item) =>
      `- ${item.labelEn} (${item.action}): ${item.unitPoints} ${item.unitEn} — ${item.descriptionEn}`,
  );
  const freeLines = PUBLIC_PRICING_FALLBACK.freeActions.map(
    (item) => `- ${item.labelEn} (${item.action}): 0 pts (rate-limited) — ${item.descriptionEn}`,
  );
  const guideLinesEn = MARKETING_GUIDES.map(
    (guide) =>
      `- [${guide.en.title}](${buildMarketingCanonical(`/guides/${guide.slug}`, siteUrl)}): ${guide.en.description}`,
  );
  const guideLinesZh = MARKETING_GUIDES.map(
    (guide) =>
      `- [${guide.zh.title}](${buildMarketingCanonical(`/zh/guides/${guide.slug}`, siteUrl)}): ${guide.zh.description}`,
  );

  return [
    `# ${SITE_NAME}`,
    '',
    '> Dual-Market Generative Engine Optimization (GEO) & AI Visibility Platform (Global + CN).',
    '> Built around verified Brand Fact Cards, multi-engine citation topology diagnosis, dual-track compliance preflight gating, 1-to-N compliant distribution, and T+1/T+7/T+14/T+30 attribution retesting.',
    '',
    '## Core Pages (English Default)',
    `- Homepage & Live Interactive Sandbox: ${buildMarketingCanonical('/', siteUrl)}`,
    `- Pricing & Monthly Points Calculator: ${buildMarketingCanonical('/pricing', siteUrl)}`,
    `- GEO Guides & Playbooks: ${buildMarketingCanonical('/guides', siteUrl)}`,
    `- Request Demo / 1,000-Pt Trial: ${buildMarketingCanonical('/demo', siteUrl)}`,
    `- XML Sitemap: ${buildMarketingCanonical('/sitemap.xml', siteUrl)}`,
    '',
    '## Chinese Mirror Pages (简体中文)',
    `- 品牌首页与交互沙盒: ${buildMarketingCanonical('/zh', siteUrl)}`,
    `- 定价与月度点数计算器: ${buildMarketingCanonical('/zh/pricing', siteUrl)}`,
    `- GEO 实操指南: ${buildMarketingCanonical('/zh/guides', siteUrl)}`,
    `- 申请 1,000 点 Demo 试用: ${buildMarketingCanonical('/zh/demo', siteUrl)}`,
    '',
    '## Dual-Market AI Engine Coverage',
    '- GLOBAL Market: ChatGPT, Perplexity, Claude, Gemini, Google AI Overviews',
    '- CN Market: DeepSeek, 豆包 (Doubao), 腾讯元宝 (Yuanbao), 通义千问 (Qwen)',
    '',
    '## Distribution & Connectors (GA v2.1 vs Upcoming v2.2)',
    '- L1 Official Owned-Site Connectors (GA v2.1): Shopify Blog, WordPress, Webflow CMS, Signed HMAC Webhook + IndexNow',
    '- L3 Compliant Community & External Assist (GA v2.1): Reddit, Quora, Zhihu anti-ban human checklists (zero automated astroturfing) + 30-day login-free read-only PR / KOL Media Kits',
    '- Upcoming v2.2 Roadmap (Not Yet GA): Near-Miss citation mining, Wilson 95% confidence intervals, Ghost / Dev.to / Hashnode / GitHub MDX / WeChat Draft Box / Chrome Extension L2 bridge',
    '',
    '## Transparent Points Pricing',
    ...paidLines,
    '',
    '## Included 0-Point Actions (7 Rate-Limited Standards + Bundled Exports)',
    ...freeLines,
    '- Bundled Self-GEO Exports: JSON-LD structured schema & llms.txt export (0 pts)',
    '',
    '## Demo Trial Quota',
    `- Request via ${buildMarketingCanonical('/demo', siteUrl)}: ${PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US')} points valid for ${PUBLIC_PRICING_FALLBACK.demoTrial.validDays} days.`,
    '',
    '## Security & Engineering Commitments',
    '- Credentials encrypted at rest with AES-256-GCM; plaintext secrets are never returned to clients.',
    '- 100% SSRF protection across outbound connectors and T+1 CrawlProbe requests.',
    '- Strict multi-tenant isolation (PostgreSQL + pgvector) and auditable point ledger with auto-refund on task failure.',
    '- Zero automated community astroturfing or bot posting.',
    '',
    '## GEO Guides (EN)',
    ...guideLinesEn,
    '',
    '## GEO 实操指南 (ZH)',
    ...guideLinesZh,
    '',
  ].join('\n');
}
