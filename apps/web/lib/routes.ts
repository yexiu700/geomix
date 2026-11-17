/** 后台英文语义路由和分组菜单。旧地址不放在这里。 */

export type RouteMatch = {
  href: string;
  path: string;
  title: string;
  parent: string | null;
  pinned: boolean;
};

type StaticRoute = {
  title: string;
  parent: string | null;
};

export const STATIC_ROUTES: Record<string, StaticRoute> = {
  '/dashboard': { title: '首页', parent: null },
  '/workbench/samples': { title: '列表示例', parent: null },
  '/material/keywords': { title: '关键词', parent: null },
  '/material/questions': { title: '写作标题', parent: '/material/keywords' },
  '/material/gallery': { title: '企业画像图库', parent: null },
  '/material/knowledge': { title: '企业知识库', parent: null },
  '/writing/prompts': { title: '写作指令', parent: null },
  '/writing/categories': { title: '文章分类', parent: null },
  '/writing/tasks': { title: 'AI写作任务', parent: null },
  '/writing/articles': { title: '文章列表', parent: '/writing/categories' },
  '/rewrite/single': { title: '全网爆文复刻', parent: null },
  '/rewrite/batch': { title: '批量爆文复刻', parent: null },
  '/image': { title: 'AI生图', parent: null },
  '/visibility/overview': { title: 'AI数据看板', parent: null },
  '/visibility/monitors': { title: 'AI可见度诊断', parent: null },
  '/me/points': { title: '点数明细', parent: null },
  '/me/money': { title: '余额明细', parent: null },
  '/me/rights': { title: '账号权益', parent: null },
  '/me/verify': { title: '实名认证', parent: null },
};

const QUERY_KEYS: Record<string, readonly string[]> = {
  '/material/questions': ['keywordId'],
  '/writing/tasks': ['keywordId'],
  '/writing/articles': ['categoryId', 'taskId'],
  '/visibility/overview': ['profileId'],
  '/visibility/monitors': ['profileId', 'runId'],
};

const GALLERY_DETAIL = /^\/material\/gallery\/([A-Za-z0-9_-]{1,64})$/;

export type MenuBadge = 'new';

export type MenuItem =
  | { type: 'section'; key: string; title: string; children: MenuItem[] }
  | { type: 'submenu'; key: string; title: string; badge?: MenuBadge; children: MenuItem[] }
  | { type: 'link'; href: string; title: string }
  | { type: 'soon'; key: string; title: string };

function link(href: keyof typeof STATIC_ROUTES): MenuItem {
  const route = STATIC_ROUTES[href];
  if (!route) throw new Error(`missing route ${href}`);
  return { type: 'link', href, title: route.title };
}

export const MENU: MenuItem[] = [
  link('/dashboard'),
  {
    type: 'section',
    key: 'creation',
    title: 'AI创作-文章&素材',
    children: [
      {
        type: 'submenu',
        key: 'material',
        title: '素材源力',
        children: [
          link('/material/keywords'),
          link('/material/questions'),
          link('/material/gallery'),
          link('/material/knowledge'),
        ],
      },
      {
        type: 'submenu',
        key: 'writing',
        title: '文章写作',
        children: [
          link('/writing/prompts'),
          link('/writing/categories'),
          link('/writing/tasks'),
          link('/writing/articles'),
        ],
      },
      {
        type: 'submenu',
        key: 'rewrite',
        title: '流量复刻',
        children: [link('/rewrite/single'), link('/rewrite/batch')],
      },
    ],
  },
  {
    type: 'submenu',
    key: 'image',
    title: 'AI生图/视频',
    badge: 'new',
    children: [link('/image')],
  },
  {
    type: 'section',
    key: 'publish',
    title: '文章发布',
    children: [{ type: 'soon', key: 'publish-soon', title: '即将上线' }],
  },
  {
    type: 'section',
    key: 'aidata',
    title: 'AI数据',
    children: [link('/visibility/overview')],
  },
  {
    type: 'section',
    key: 'visibility',
    title: 'AI可见度诊断',
    children: [link('/visibility/monitors')],
  },
  {
    type: 'submenu',
    key: 'tools',
    title: 'AI工具',
    children: [
      { type: 'soon', key: 'tool-index', title: '关键词指数' },
      { type: 'soon', key: 'tool-expand', title: 'AI拓词' },
      { type: 'soon', key: 'tool-manual', title: '手动拓词工具' },
    ],
  },
  {
    type: 'submenu',
    key: 'me',
    title: '个人中心',
    children: [link('/me/points'), link('/me/money'), link('/me/rights'), link('/me/verify')],
  },
];

export function buildMenu(options?: {
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
}): MenuItem[] {
  return MENU.filter((item) => {
    if (options?.aiImageEnabled === false && item.type === 'submenu' && item.key === 'image') {
      return false;
    }
    if (
      options?.visibilityEnabled === false &&
      item.type === 'section' &&
      (item.key === 'aidata' || item.key === 'visibility')
    ) {
      return false;
    }
    return true;
  });
}

export function matchRoute(input: string): RouteMatch | null {
  const url = parseLocal(input);
  if (!url) return null;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  let title = '';
  let parent: string | null = null;
  let pinned = false;
  const staticRoute = STATIC_ROUTES[path];
  if (staticRoute) {
    title = staticRoute.title;
    parent = staticRoute.parent;
    pinned = path === '/dashboard';
  } else {
    const id = GALLERY_DETAIL.exec(path)?.[1];
    if (!id) return null;
    path = `/material/gallery/${id}`;
    title = `企业画像图库 · ${id}`;
    parent = '/material/gallery';
  }

  const params = new URLSearchParams();
  const suffixes: string[] = [];
  for (const key of QUERY_KEYS[path] ?? []) {
    const value = cleanParam(url.searchParams.get(key));
    if (!value) continue;
    params.set(key, value);
    suffixes.push(paramLabel(key, value));
  }
  const query = params.toString();
  if (suffixes.length > 0) title = `${title} · ${suffixes.join(' · ')}`;
  return {
    href: query ? `${path}?${query}` : path,
    path,
    title,
    parent,
    pinned,
  };
}

export function collectHrefs(items: MenuItem[] = MENU): string[] {
  const hrefs: string[] = [];
  const walk = (nodes: MenuItem[]) => {
    for (const node of nodes) {
      if (node.type === 'link') hrefs.push(node.href);
      if (node.type === 'section' || node.type === 'submenu') walk(node.children);
    }
  };
  walk(items);
  return hrefs;
}

export function allSubmenuKeys(items: MenuItem[] = MENU): string[] {
  const keys: string[] = [];
  const walk = (nodes: MenuItem[]) => {
    for (const node of nodes) {
      if (node.type === 'submenu') {
        keys.push(node.key);
        walk(node.children);
      } else if (node.type === 'section') {
        walk(node.children);
      }
    }
  };
  walk(items);
  return keys;
}

export function menuSelection(href: string): { selected: string; parents: string[] } {
  const path = href.split('?')[0] ?? href;
  const selected = path.startsWith('/material/gallery/') ? '/material/gallery' : path;
  const parents: string[] = [];
  const walk = (nodes: MenuItem[], chain: string[]): boolean => {
    for (const node of nodes) {
      if (node.type === 'link' && node.href === selected) {
        parents.push(...chain);
        return true;
      }
      if (node.type === 'submenu' && walk(node.children, [...chain, node.key])) return true;
      if (node.type === 'section' && walk(node.children, chain)) return true;
    }
    return false;
  };
  walk(MENU, []);
  return { selected, parents };
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

function paramLabel(key: string, value: string): string {
  if (key === 'categoryId') return `分类 ${value}`;
  if (key === 'taskId') return `任务 ${value}`;
  if (key === 'profileId') return `档案 ${value}`;
  if (key === 'runId') return `任务 ${value}`;
  return value;
}
