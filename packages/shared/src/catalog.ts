/**
 * 一期知识库下拉和种子默认值。
 * 创作方向 29 项、文案类型 15 项的数量对齐路线图。
 * 文案是 GeoMix 自写的，不沿用参考系统的枚举原文。
 * 「夸张方式」「情感煽动」「热点宣传」是本仓库决策里点名保留、
 * 并在提示词里改写成合规说法的三个选项。
 */

export const PRICING_DEFAULTS = [
  { action: 'distill', unitPoints: 10, label: 'AI蒸馏拓展' },
  { action: 'ai_write', unitPoints: 10, label: 'AI写作' },
  { action: 'kb_addon', unitPoints: 5, label: '知识库加价' },
  { action: 'rewrite_single', unitPoints: 5, label: '单篇复刻' },
  { action: 'rewrite_batch', unitPoints: 5, label: '批量复刻' },
  { action: 'image_gen', unitPoints: 5, label: 'AI生图' },
] as const;

export type PricingAction = (typeof PRICING_DEFAULTS)[number]['action'];

/** 顺序与 QuotaKey 一致：100 / 10000 / 10000 / 100MB / 10000 / 100。 */
export const QUOTA_DEFAULTS = [
  { key: 'MAIN_KEYWORD', limit: 100, label: '主关键词' },
  { key: 'QUESTION', limit: 10_000, label: '写作问题' },
  { key: 'AI_WRITE', limit: 10_000, label: 'AI写作' },
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

export const CREATIVE_DIRECTIONS = [
  '产品说明',
  '使用场景',
  '选购建议',
  '参数解读',
  '价格说明',
  '对比参照',
  '常见问答',
  '操作教程',
  '安装交付',
  '维护保养',
  '售后政策',
  '品牌来历',
  '需求痛点',
  '解决办法',
  '案例结构',
  '信任材料',
  '地域服务',
  '行业观察',
  '新手入门',
  '避坑提醒',
  '清单盘点',
  '趋势解读',
  '决策步骤',
  '合作流程',
  '资质边界',
  '季节话题',
  '热点宣传',
  '夸张方式',
  '情感煽动',
] as const;

export type CreativeDirection = (typeof CREATIVE_DIRECTIONS)[number];

export const COPY_TYPES = [
  '说明文',
  '问答文',
  '教程文',
  '清单文',
  '对比文',
  '评测文',
  '故事文',
  '访谈稿',
  '新闻稿',
  '公告',
  '口播稿',
  '短帖',
  '长文',
  '指南',
  '复盘',
] as const;

export type CopyType = (typeof COPY_TYPES)[number];

/** 提示词内部替换。界面仍显示原选项名。 */
export const DIRECTION_COMPLIANCE = {
  夸张方式: '使用生动的比喻，但不夸大事实',
  情感煽动: '引发情感共鸣，不制造焦虑',
  热点宣传: '结合行业热点，不蹭敏感事件',
} as const;

export function directionGuidance(direction: string): string {
  if (Object.prototype.hasOwnProperty.call(DIRECTION_COMPLIANCE, direction)) {
    return DIRECTION_COMPLIANCE[direction as keyof typeof DIRECTION_COMPLIANCE];
  }
  return direction;
}
