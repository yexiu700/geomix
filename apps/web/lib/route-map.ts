import { matchRoute } from './routes';

/**
 * 旧入口路由对照表（#7 / #72）。
 * 将已登记的 15 个历史 `/user/*` 业务路径重定向到控制台英文语义路由，
 * 兼容尾斜杠及子路径（如 `/index`），不引入任何外部域名或未登记路径。
 */
export const LEGACY_REDIRECTS = {
  '/user/dashboard': '/dashboard',
  '/user/company_keyword': '/material/keywords',
  '/user/company_question': '/material/questions',
  '/user/images_type/index/type/1': '/material/gallery',
  '/user/user_huaxiang': '/material/knowledge',
  '/user/article_type': '/writing/categories',
  '/user/zhiling': '/writing/prompts',
  '/user/ai_task': '/writing/tasks',
  '/user/article': '/writing/articles',
  '/user/weixin_baowen': '/rewrite/single',
  '/user/piliang_baowen': '/rewrite/batch',
  '/user/ai_image': '/image',
  '/user/user_score_log': '/me/points',
  '/user/user_money_log': '/me/money',
  '/user/quanyi': '/me/rights',
} as const;

const SORTED_LEGACY_ENTRIES = (
  Object.entries(LEGACY_REDIRECTS) as Array<[keyof typeof LEGACY_REDIRECTS, string]>
).sort((a, b) => b[0].length - a[0].length);

export function legacyPathname(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [prefix, target] of SORTED_LEGACY_ENTRIES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return target;
    }
  }
  return null;
}

/** 登录后的 next 只允许回到本后台的英文路由，避免跳到站外。 */
export function safeConsoleHref(value: string | null): string | null {
  if (!value) return null;
  return matchRoute(value)?.href ?? null;
}
