import {
  MARKETING_LEAD_MARKETS,
  PUBLIC_PRICING_FALLBACK,
  SITE_NAME,
  type MarketingLeadMarket,
  type MarketingLocale,
} from '@geomix/shared';
import { buildMarketingCanonical, getMarketingSiteUrl } from '../../lib/marketing-i18n';
import type { JsonLdData } from './json-ld-script';

export type DemoSearchParamsInput = Record<string, string | string[] | undefined>;

export interface DemoPrefill {
  estimatedPts?: number;
  targetMarket: MarketingLeadMarket;
  monthlyGoal?: string;
}

const MARKETING_LEAD_MARKET_SET = new Set<string>(MARKETING_LEAD_MARKETS);
const STRICT_ESTIMATED_PTS_RE = /^\d+$/;
const MAX_ESTIMATED_PTS = 10_000_000;
const MAX_MONTHLY_GOAL_LENGTH = 160;

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return undefined;
}

function stripSingleLineControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    out += value[i];
  }
  return out;
}

/**
 * Pure sanitizer for `/demo` and `/zh/demo` URL query parameters (`estimatedPts`, `targetMarket`, `monthlyGoal`).
 * Enforces exact `createMarketingLeadSchema` bounds and strips control characters safely.
 */
export function sanitizeDemoSearchParams(raw?: DemoSearchParamsInput | null): DemoPrefill {
  const input = raw ?? {};

  // 1. estimatedPts: strict non-negative integer within 0..10_000_000
  let estimatedPts: number | undefined;
  const rawPts = firstQueryValue(input.estimatedPts)?.trim();
  if (rawPts && STRICT_ESTIMATED_PTS_RE.test(rawPts)) {
    const parsed = Number(rawPts);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_ESTIMATED_PTS) {
      estimatedPts = parsed === 0 ? 0 : parsed;
    }
  }

  // 2. targetMarket: allowlisted enum (default GLOBAL)
  let targetMarket: MarketingLeadMarket = 'GLOBAL';
  const rawMarket = firstQueryValue(input.targetMarket)?.trim().toUpperCase();
  if (rawMarket && MARKETING_LEAD_MARKET_SET.has(rawMarket)) {
    targetMarket = rawMarket as MarketingLeadMarket;
  }

  // 3. monthlyGoal: strip control chars, trim, clamp to 160 chars
  let monthlyGoal: string | undefined;
  const rawGoal = firstQueryValue(input.monthlyGoal);
  if (rawGoal) {
    const cleaned = stripSingleLineControlChars(rawGoal).trim().slice(0, MAX_MONTHLY_GOAL_LENGTH);
    if (cleaned.length > 0) {
      monthlyGoal = cleaned;
    }
  }

  return {
    estimatedPts,
    targetMarket,
    monthlyGoal,
  };
}

export function buildDemoContactPageJsonLd(
  locale: MarketingLocale,
  siteUrl: string = getMarketingSiteUrl(),
): JsonLdData {
  const isZh = locale === 'zh-CN';
  const demoPath = isZh ? '/zh/demo' : '/demo';
  const canonicalUrl = buildMarketingCanonical(demoPath, siteUrl);
  const pointsFormatted = PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US');
  const days = PUBLIC_PRICING_FALLBACK.demoTrial.validDays;

  return {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: isZh
      ? `预约演示与 ${pointsFormatted} 点试用申请 · ${SITE_NAME}`
      : `Request Demo & ${pointsFormatted}-Point Trial · ${SITE_NAME}`,
    description: isZh
      ? `提交品牌信息与目标市场，审核后开通含 ${pointsFormatted} 点额度与 ${days} 天有效期的 GeoMix 试用 Demo 账号。`
      : `Submit your brand details and target market to request a manually provisioned GeoMix Trial Demo loaded with ${pointsFormatted} points valid for ${days} days.`,
    url: canonicalUrl,
    inLanguage: locale,
    mainEntity: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: siteUrl,
    },
  };
}

export function getDemoPageCopy(locale: MarketingLocale) {
  const isZh = locale === 'zh-CN';
  const pointsFormatted = PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US');
  const days = PUBLIC_PRICING_FALLBACK.demoTrial.validDays;

  if (isZh) {
    return {
      eyebrow: '预约演示与试用申请',
      title: `申请 ${pointsFormatted} 点 / ${days} 天试用 Demo`,
      lead: '填写您的品牌、目标市场与月度目标，我们的顾问将在人工核验后为您开通隔离的 Demo 租户并安排一对一工作流演示。',
      provisioningTitle: `试用 Demo 开通说明（${pointsFormatted} 点 / ${days} 天）`,
      provisioningSubtitle:
        '为保障共享 AI 推理通道稳定性与租户隔离，GeoMix 采用人工核验开通试用机制，替代无人值守机器人自助注册。',
      provisioningSteps: [
        '提交品牌名称、工作邮箱与目标市场（海外 / 国内 / 双市场）',
        `人工审核通过后，管理员在控制台为您创建独立试用租户并注入 ${pointsFormatted} 点额度（${days} 天有效）`,
        '直接用真实品牌问句跑通 AI 引用拓扑诊断、品牌事实卡、合规门禁写作与 L1/L3 分发',
      ],
      privacyTitle: '数据安全与隐私承诺',
      privacyItems: [
        '线索防刷仅记录来源 IP 的单向 SHA-256 哈希，不落库明文 IP',
        '提交的官网 URL 仅用于业务评估与人工查阅，服务端不触发自动外呼抓取（零 SSRF）',
        '正式租户渠道凭证采用 AES-256-GCM 静态加密存储，业务数据在 PostgreSQL + pgvector 严格租户隔离',
      ],
      pricingLinkLabel: '← 返回点数定价与预算计算器',
      pricingHref: '/zh/pricing',
    };
  }

  return {
    eyebrow: 'Book a Demo & Trial Access',
    title: `Request Your ${pointsFormatted}-Point / ${days}-Day Trial Demo`,
    lead: 'Share your brand, target market, and monthly GEO goals. Our team manually reviews each request to provision an isolated Trial Demo workspace and walk you through your citation baseline.',
    provisioningTitle: `How Trial Demo Provisioning Works (${pointsFormatted} pts / ${days} days)`,
    provisioningSubtitle:
      'Manual provisioning replaces open bot signup so every brand evaluates GeoMix on clean, reliable AI inference capacity.',
    provisioningSteps: [
      'Submit your brand name, work email, and target market (Global, China, or Both)',
      `After review, we provision an isolated Trial Demo tenant preloaded with ${pointsFormatted} points valid for ${days} days`,
      'Run live AI citation diagnostics, Brand Fact Cards, Preflight gating, and L1/L3 distribution on your real brand prompts',
    ],
    privacyTitle: 'Privacy & Engineering Commitments',
    privacyItems: [
      'Rate-limiting stores only a one-way SHA-256 IP hash — never plaintext IP addresses',
      'Submitted website URLs are never auto-fetched by the backend (100% SSRF-safe intake)',
      'Production workspace credentials use AES-256-GCM encryption at rest with strict PostgreSQL + pgvector tenant isolation',
    ],
    pricingLinkLabel: '← Back to Points Pricing & Calculator',
    pricingHref: '/pricing',
  };
}
