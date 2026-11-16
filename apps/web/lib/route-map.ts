import { matchRoute } from './routes';

/**
 * 旧入口对照。
 * 只保留 issue #7 已经点名的路径，目标是路线里的英文语义路由。
 * 不要从仓库外再补参考系统的地址。
 */
export const LEGACY_REDIRECTS = {
  '/user/zhiling': '/writing/prompts',
} as const;

export function legacyPathname(pathname: string): string | null {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (!Object.prototype.hasOwnProperty.call(LEGACY_REDIRECTS, path)) return null;
  return LEGACY_REDIRECTS[path as keyof typeof LEGACY_REDIRECTS];
}

/** 登录后的 next 只允许回到本后台的英文路由，避免跳到站外。 */
export function safeConsoleHref(value: string | null): string | null {
  if (!value) return null;
  return matchRoute(value)?.href ?? null;
}
