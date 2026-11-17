import { describe, expect, it } from 'vitest';
import {
  MENU,
  STATIC_ROUTES,
  buildMenu,
  collectHrefs,
  isConsoleRouteAccessible,
  matchRoute,
  menuSelection,
} from './routes';

describe('console routes', () => {
  it('hides /workbench/samples from merchant menu and nests AI生图/视频 inside AI创作-文章&素材', () => {
    const menuHrefs = new Set(collectHrefs());
    expect(menuHrefs.has('/workbench/samples')).toBe(false);
    const expectedMerchantRoutes = Object.keys(STATIC_ROUTES).filter(
      (route) => route !== '/workbench/samples',
    );
    expect(menuHrefs).toEqual(new Set(expectedMerchantRoutes));

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
    expect(image?.type === 'submenu' ? image.title : undefined).toBe('AI生图/视频');
    expect(image?.type === 'submenu' ? image.badge : undefined).toBe('new');

    expect(collectHrefs(buildMenu({ aiImageEnabled: false })).includes('/image')).toBe(false);
    expect(isConsoleRouteAccessible('/workbench/samples', 'MERCHANT')).toBe(false);
    expect(isConsoleRouteAccessible('/workbench/samples', 'ADMIN')).toBe(true);
  });

  it('canonicalizes query tabs and gallery detail', () => {
    expect(matchRoute('/material/questions?keywordId=demo')).toMatchObject({
      href: '/material/questions?keywordId=demo',
      title: '写作标题 · demo',
      parent: '/material/keywords',
    });
    expect(matchRoute('/writing/articles?taskId=t2&categoryId=c1')).toMatchObject({
      href: '/writing/articles?categoryId=c1&taskId=t2',
      title: '文章列表 · 分类 c1 · 任务 t2',
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
  });
});
