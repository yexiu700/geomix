import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MENU,
  STATIC_ROUTES,
  buildMenu,
  collectHrefs,
  isCommandPaletteRoute,
  isConsoleRouteAccessible,
  matchRoute,
  menuSelection,
} from './routes';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('console routes', () => {
  it('hides /workbench/samples from merchant menu and nests AI生图 inside AI创作-文章&素材', () => {
    const menuHrefs = new Set(collectHrefs());
    expect(menuHrefs.has('/workbench/samples')).toBe(false);
    const expectedMerchantRoutes = Object.keys(STATIC_ROUTES).filter(
      (route) => route !== '/workbench/samples',
    );
    expect(menuHrefs).toEqual(new Set(expectedMerchantRoutes));
    expect(collectHrefs()).toContain('/visibility/overview');
    expect(collectHrefs()).toContain('/visibility/monitors');

    const creation = MENU.find((item) => item.type === 'section' && item.key === 'creation');
    expect(creation?.type === 'section' ? creation.title : undefined).toBe('AI创作-文章&素材');
    const creationKeys =
      creation?.type === 'section'
        ? creation.children.map((child) => (child.type === 'submenu' ? child.key : ''))
        : [];
    expect(creationKeys).toEqual(['material', 'writing', 'rewrite', 'image']);

    const image =
      creation?.type === 'section'
        ? creation.children.find((child) => child.type === 'submenu' && child.key === 'image')
        : undefined;
    expect(image?.type === 'submenu' ? image.title : undefined).toBe('AI生图');
    expect(image?.type === 'submenu' ? image.badge : undefined).toBe('new');

    expect(collectHrefs(buildMenu({ aiImageEnabled: false })).includes('/image')).toBe(false);
    expect(isConsoleRouteAccessible('/workbench/samples', 'MERCHANT')).toBe(false);
    expect(isConsoleRouteAccessible('/workbench/samples', 'ADMIN')).toBe(true);

    vi.stubEnv('NODE_ENV', 'production');
    expect(isConsoleRouteAccessible('/workbench/samples', 'ADMIN')).toBe(false);
    expect(isCommandPaletteRoute('/workbench/samples', 'ADMIN')).toBe(false);
    expect(isCommandPaletteRoute('/workbench/samples', 'MERCHANT')).toBe(false);
  });

  it('flattens single-child visibility sections and converges disabled soon items (#134)', () => {
    // No disabled 'soon' items in main MENU
    const hasSoon = (items: typeof MENU): boolean =>
      items.some(
        (item) =>
          item.type === 'soon' ||
          ((item.type === 'section' || item.type === 'submenu') && hasSoon(item.children)),
      );
    expect(hasSoon(MENU)).toBe(false);

    // Visibility items are flattened to single-level links without duplicate group titles
    expect(MENU.some((item) => item.type === 'link' && item.href === '/visibility/overview')).toBe(
      true,
    );
    expect(MENU.some((item) => item.type === 'link' && item.href === '/visibility/monitors')).toBe(
      true,
    );
    expect(MENU.some((item) => item.type === 'section' && item.key === 'visibility')).toBe(false);
    expect(MENU.some((item) => item.type === 'section' && item.key === 'aidata')).toBe(false);
  });

  it('hides visibility links and command palette entries when visibilityEnabled is false', () => {
    const filtered = buildMenu({ visibilityEnabled: false });
    const hrefs = collectHrefs(filtered);
    expect(hrefs).not.toContain('/visibility/overview');
    expect(hrefs).not.toContain('/visibility/monitors');
    expect(
      isCommandPaletteRoute('/visibility/monitors', 'MERCHANT', { visibilityEnabled: false }),
    ).toBe(false);
    expect(isCommandPaletteRoute('/image', 'MERCHANT', { aiImageEnabled: false })).toBe(false);
  });

  it('canonicalizes query tabs and gallery detail', () => {
    expect(matchRoute('/material/questions?keywordId=demo')).toMatchObject({
      href: '/material/questions?keywordId=demo',
      title: '写作标题 · demo',
      parent: '/material/keywords',
    });
    expect(matchRoute('/writing/tasks?keywordId=kw_1')).toMatchObject({
      href: '/writing/tasks?keywordId=kw_1',
      path: '/writing/tasks',
      title: 'AI写作任务 · kw_1',
      parent: null,
    });
    expect(matchRoute('/writing/articles?taskId=t2&categoryId=c1')).toMatchObject({
      href: '/writing/articles?categoryId=c1&taskId=t2',
      title: '文章列表 · 分类 c1 · 任务 t2',
    });
    expect(matchRoute('/visibility/overview?profileId=vprof_1&ignored=1')).toMatchObject({
      href: '/visibility/overview?profileId=vprof_1',
      path: '/visibility/overview',
      title: 'AI数据看板 · 档案 vprof_1',
      parent: null,
    });
    expect(matchRoute('/visibility/monitors?runId=vrun_9&profileId=vprof_1')).toMatchObject({
      href: '/visibility/monitors?profileId=vprof_1&runId=vrun_9',
      path: '/visibility/monitors',
      title: 'AI可见度诊断 · 档案 vprof_1 · 任务 vrun_9',
      parent: null,
    });
    expect(matchRoute('/material/gallery/pic_1')).toMatchObject({
      href: '/material/gallery/pic_1',
      title: '企业画像图库 · pic_1',
      parent: '/material/gallery',
    });
    expect(matchRoute('/material/gallery/../keywords')).toBeNull();
    expect(matchRoute('/workbench/samples')).toMatchObject({
      href: '/workbench/samples',
      title: '列表示例',
      parent: null,
      pinned: false,
    });
    expect(matchRoute('/not-a-page')).toBeNull();
  });

  it('highlights the list when a detail tab is open', () => {
    expect(menuSelection('/material/gallery/pic_1')).toEqual({
      selected: '/material/gallery',
      parents: ['material'],
    });
    expect(menuSelection('/writing/prompts').parents).toEqual(['writing']);
    expect(menuSelection('/visibility/monitors?runId=vrun_1')).toEqual({
      selected: '/visibility/monitors',
      parents: [],
    });
  });

  it('strips opaque CUIDs from detail and query tab titles', () => {
    const cuidA = 'cm8x9abcde12345fghij67890';
    const cuidB = 'cm9z1zyxwv98765utsrq43210';

    const gallery = matchRoute(`/material/gallery/${cuidA}`);
    expect(gallery?.title).toBe('企业画像图库 · 图库详情');
    expect(gallery?.title).not.toContain(cuidA);

    const articles = matchRoute(`/writing/articles?categoryId=${cuidA}&taskId=${cuidB}`);
    expect(articles?.title).toBe('文章列表 · 按分类筛选 · 按任务筛选');
    expect(articles?.title).not.toContain(cuidA);
    expect(articles?.title).not.toContain(cuidB);

    const monitors = matchRoute(`/visibility/monitors?profileId=${cuidA}&runId=${cuidB}`);
    expect(monitors?.title).toBe('AI可见度诊断 · 当前监测档案 · 当前诊断任务');
  });
});
