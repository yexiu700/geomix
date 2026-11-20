/**
 * GeoMix 2.0 统一定价与租户默认配额（Issue #326 / D3）。
 * 品牌事实卡、GEO 体检与 Schema 导出均免费标配，不再拆账 kb_addon。
 */

export const PRICING_DEFAULTS = [
  { action: 'geo_write', unitPoints: 10, label: 'GEO写作' },
  { action: 'visibility_check', unitPoints: 2, label: 'AI可见性监测' },
  { action: 'inline_image_gen', unitPoints: 5, label: '行内AI配图' },
] as const;

export type PricingAction = (typeof PRICING_DEFAULTS)[number]['action'];

/** 免费标配动作（0 点，服务端按租户做防刷限流，不进入 PricingItem）。 */
export const FREE_RATE_LIMITED_ACTIONS = [
  'geo_brief',
  'brand_fact_extract',
  'geo_evaluate',
  'rewrite_section',
] as const;

export type FreeRateLimitedAction = (typeof FREE_RATE_LIMITED_ACTIONS)[number];

/** 顺序与 Prisma QuotaKey 枚举一致：100 / 10000 / 10000 / 100MB / 10000 / 100。 */
export const QUOTA_DEFAULTS = [
  { key: 'MAIN_KEYWORD', limit: 100, label: '品牌数量' },
  { key: 'QUESTION', limit: 10_000, label: '写作意见' },
  { key: 'AI_WRITE', limit: 10_000, label: 'GEO写作' },
  { key: 'STORAGE_BYTES', limit: 100 * 1024 * 1024, label: '图片存储' },
  { key: 'PUBLISH', limit: 10_000, label: '文章发布' },
  { key: 'SOCIAL_AUTH', limit: 100, label: '自媒体授权' },
] as const;

export type QuotaKeyName = (typeof QUOTA_DEFAULTS)[number]['key'];

/**
 * 路线图已经写明口径的配额。
 * 文章发布和自媒体授权的存量/累计口径尚未确认，不在这里猜测。
 */
export const QUOTA_MEASURE = {
  MAIN_KEYWORD: 'stock',
  QUESTION: 'stock',
  STORAGE_BYTES: 'stock',
  AI_WRITE: 'cumulative',
} as const;

export const STORAGE_QUOTA_BYTES = 100 * 1024 * 1024;

export const DEMO_TENANT_POINTS = 1000;
export const DEMO_TENANT_VALID_DAYS = 365;
