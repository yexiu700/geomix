/** GeoMix 2.0 极简 5 工作区路由与平面 4 项左侧业务导航。 */

import type { GeoMarket } from '@geomix/shared';

export const HOME_ROUTE = '/home' as const;

export type WorkspacePath = '/home' | '/brands' | '/visibility' | '/studio' | '/account';

export type RouteMatch = {
  href: string;
  path: WorkspacePath;
  title: string;
};

type StaticRoute = {
  title: string;
  businessWorkspace: boolean;
};

export const STATIC_ROUTES: Record<WorkspacePath, StaticRoute> = {
  '/home': { title: '行动首页', businessWorkspace: true },
  '/brands': { title: '品牌资产', businessWorkspace: true },
  '/visibility': { title: '可见度诊断', businessWorkspace: true },
  '/studio': { title: 'GEO 写作台', businessWorkspace: true },
  '/account': { title: '点数与权益', businessWorkspace: false },
};

const QUERY_KEYS: Record<WorkspacePath, readonly string[]> = {
  '/home': ['brandId', 'market'],
  '/brands': ['brandId', 'market'],
  '/visibility': ['brandId', 'market', 'tab', 'runId'],
  '/studio': ['brandId', 'market', 'briefId', 'articleId'],
  '/account': ['brandId', 'market', 'tab'],
};

export type MenuItem = {
  type: 'link';
  href: Exclude<WorkspacePath, '/account'>;
  title: string;
};

function link(href: Exclude<WorkspacePath, '/account'>): MenuItem {
  return { type: 'link', href, title: STATIC_ROUTES[href].title };
}

export const MENU: MenuItem[] = [
  link('/home'),
  link('/brands'),
  link('/visibility'),
  link('/studio'),
];

export const PRIMARY_NAV_ITEMS: readonly MenuItem[] = MENU;

export function buildMenu(options?: { visibilityEnabled?: boolean }): MenuItem[] {
  if (options?.visibilityEnabled !== false) {
    return MENU;
  }
  return MENU.filter((item) => item.href !== '/visibility');
}

export function isConsoleRouteAccessible(href: string): boolean {
  return matchRoute(href) !== null;
}

export function isCommandPaletteRoute(
  href: string,
  _role?: string,
  options?: { visibilityEnabled?: boolean },
): boolean {
  const matched = matchRoute(href);
  if (!matched) return false;
  if (options?.visibilityEnabled === false && matched.path === '/visibility') {
    return false;
  }
  return true;
}

export function matchRoute(input: string): RouteMatch | null {
  const url = parseLocal(input);
  if (!url) return null;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  if (!(path in STATIC_ROUTES)) return null;
  const workspacePath = path as WorkspacePath;
  const staticRoute = STATIC_ROUTES[workspacePath];

  const params = new URLSearchParams();
  for (const key of QUERY_KEYS[workspacePath]) {
    const value = cleanParam(url.searchParams.get(key));
    if (!value) continue;
    params.set(key, value);
  }
  const query = params.toString();
  return {
    href: query ? `${workspacePath}?${query}` : workspacePath,
    path: workspacePath,
    title: staticRoute.title,
  };
}

export function buildWorkspaceHref(
  targetPath: WorkspacePath | string,
  brandId: string | null,
  market: GeoMarket | null,
  extra?: Record<string, string | null | undefined>,
): string {
  const url = parseLocal(targetPath);
  if (!url) return HOME_ROUTE;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!(path in STATIC_ROUTES)) return HOME_ROUTE;

  const workspacePath = path as WorkspacePath;
  const params = new URLSearchParams(url.searchParams.toString());
  if (STATIC_ROUTES[workspacePath].businessWorkspace) {
    if (brandId) params.set('brandId', brandId);
    else params.delete('brandId');
    if (market) params.set('market', market);
    else params.delete('market');
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
  }
  const matched = matchRoute(
    params.toString() ? `${workspacePath}?${params.toString()}` : workspacePath,
  );
  return matched?.href ?? workspacePath;
}

export function collectHrefs(items: readonly MenuItem[] = MENU): string[] {
  return items.map((item) => item.href);
}

export function menuSelection(href: string): { selected: string; parents: string[] } {
  const path = (href.split('?')[0] ?? href).replace(/\/+$/, '') || HOME_ROUTE;
  return { selected: path, parents: [] };
}

function parseLocal(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return null;
  if (trimmed.split(/[?#]/, 1)[0]?.split('/').includes('..')) return null;
  try {
    const url = new URL(trimmed, 'http://localhost');
    if (url.origin !== 'http://localhost' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function cleanParam(value: string | null): string {
  if (!value) return '';
  let next = '';
  for (const char of value.trim()) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    next += char;
    if (next.length >= 64) break;
  }
  return next;
}
