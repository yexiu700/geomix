import type {
  BrandFactSlot,
  GeoBriefSource,
  GeoMarket,
  GeoRecipe,
  GeoRewriteAction,
  GeoTargetFormat,
  NearMissTier,
} from '@geomix/shared';

/**
 * 控制台 2–4 字短标签映射（仅用于 Web 控制台展示，不修改 @geomix/shared 中的服务端/报告完整枚举文案）。
 */

export const BRAND_FACT_SLOT_SHORT: Record<BrandFactSlot, string> = {
  PRODUCT_SPECS: '产品参数',
  DIFFERENTIATORS: '差异卖点',
  CREDENTIALS: '资质背书',
  CASE_STUDIES: '客户案例',
  EXTRA_DOC: '长文档',
};

export const GEO_RECIPE_SHORT: Record<GeoRecipe, string> = {
  AUTHORITY_GUIDE: '选购指南',
  COMPARISON_MATRIX: '对比评测',
  OBJECTION_FAQ: '痛点答疑',
  CITATION_COUNTER: '信源反制',
};

export const GEO_TARGET_FORMAT_SHORT: Record<GeoTargetFormat, string> = {
  CN_DEEP_REVIEW: '深度长文',
  CN_COMMUNITY_QA: '社区问答',
  GLOBAL_AUTHORITY_GUIDE: '独立长文',
  GLOBAL_COMMUNITY_DISCUSSION: '社区讨论',
};

export const GEO_REWRITE_ACTION_SHORT: Record<GeoRewriteAction, string> = {
  DE_AD: '去广告',
  TO_TABLE: '转表格',
  ADD_EVIDENCE: '补数据',
  CONCISE_ANSWER: '精简直答',
};

export const GEO_BRIEF_SOURCE_SHORT: Record<GeoBriefSource, string> = {
  AUTO_GAP: '霸榜缺口',
  LOW_RANK: '顺位落后',
  SENTIMENT_RISK: '情感风险',
  FANOUT_CLUSTER: '拆解缺口',
  CITATION_COUNTER: '引用反制',
  NEAR_MISS_BOOST: '待补强',
  MANUAL: '自由选题',
};

export const NEAR_MISS_TIER_SHORT: Record<NearMissTier, string> = {
  OPENED_NOT_CITED: '点开未引',
  RETRIEVED_NOT_CITED: '召回未引',
  CRAWLED_NOT_CITED: '可抓未引',
  MENTIONED_NOT_OWNED: '提及未引',
};

export const GEO_MARKET_SHORT: Record<GeoMarket, string> = {
  CN: '国内',
  GLOBAL: '海外',
};

export const WORKSPACE_NAV_SHORT: Record<
  '/home' | '/brands' | '/visibility' | '/studio' | '/publish',
  string
> = {
  '/home': '首页',
  '/brands': '品牌',
  '/visibility': '诊断',
  '/studio': '写作',
  '/publish': '发布',
};
