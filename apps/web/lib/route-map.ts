import { matchRoute } from './routes';

/**
 * 旧入口路由对照表（GeoMix 2.0 极简重构 #327）：
 * 将 v1 控制台旧路由与历史 `/user/*` 业务路径 307 重定向至全新 5 工作区，
 * 兼容尾斜杠及子路径，彻底移除 `/me/money`（¥0.00 余额页）入口。
 */
export const LEGACY_REDIRECTS = {
  // v1 console routes → v2 workspaces
  '/dashboard': '/home',
  '/visibility/overview': '/visibility',
  '/visibility/monitors': '/visibility',
  '/me/points': '/account',
  '/me/rights': '/account',
  '/me/verify': '/account',
  '/me/money': '/account',
  // historical /user/* routes → v2 workspaces
  '/user/dashboard': '/home',
  '/user/company_keyword': '/brands',
  '/user/company_question': '/brands',
  '/user/images_type/index/type/1': '/brands',
  '/user/user_huaxiang': '/brands',
  '/user/article_type': '/studio',
  '/user/zhiling': '/studio',
  '/user/ai_task': '/studio',
  '/user/article': '/studio',
  '/user/weixin_baowen': '/studio',
  '/user/piliang_baowen': '/studio',
  '/user/ai_image': '/studio',
  '/user/user_score_log': '/account',
  '/user/user_money_log': '/account',
  '/user/quanyi': '/account',
  '/user/account_rights': '/account',
} as const;

const LEGACY_ACCOUNT_TABS: Record<string, 'points' | 'rights' | 'verify'> = {
  '/me/points': 'points',
  '/me/money': 'points',
  '/me/rights': 'rights',
  '/me/verify': 'verify',
  '/user/user_score_log': 'points',
  '/user/user_money_log': 'points',
  '/user/quanyi': 'rights',
  '/user/account_rights': 'rights',
};

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

export function legacyAccountTab(pathname: string): 'points' | 'rights' | 'verify' | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [prefix, tab] of Object.entries(LEGACY_ACCOUNT_TABS)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return tab;
    }
  }
  return null;
}

const ADMIN_ROUTES = new Set([
  '/admin/tenants',
  '/admin/pricing',
  '/admin/announcements',
  '/admin/llm-costs',
]);

/** 登录后的 next 只允许回到本工作台合法站内路由，避免跳到站外或已下线旧路由。 */
export function safeConsoleHref(value: string | null): string | null {
  if (!value) return null;
  return matchRoute(value)?.href ?? null;
}

/** 校验管理后台路由（/admin/*），拦截外链、已移除路由与路径穿越。 */
export function safeAdminHref(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return null;
  if (trimmed.split(/[?#]/, 1)[0]?.split('/').includes('..')) return null;
  try {
    const url = new URL(trimmed, 'http://localhost');
    if (url.origin !== 'http://localhost' || url.username || url.password) return null;
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (path === '/admin') return '/admin/tenants';
    return ADMIN_ROUTES.has(path) ? path : null;
  } catch {
    return null;
  }
}

/** 登录成功后的 next 允许回到工作台或管理后台的合法站内路由。 */
export function safePostLoginHref(value: string | null): string | null {
  return safeConsoleHref(value) ?? safeAdminHref(value);
}
