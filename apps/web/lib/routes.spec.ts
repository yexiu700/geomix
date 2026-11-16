import { describe, expect, it } from 'vitest';
import { MENU, STATIC_ROUTES, collectHrefs, matchRoute, menuSelection } from './routes';

describe('console routes', () => {
  it('puts every phase-1 page on the grouped menu', () => {
    expect(new Set(collectHrefs())).toEqual(new Set(Object.keys(STATIC_ROUTES)));
    const image = MENU.find((item) => item.type === 'submenu' && item.key === 'image');
    expect(image?.type === 'submenu' ? image.badge : undefined).toBe('new');
    expect(MENU.some((item) => item.type === 'section' && item.title === 'AI创作-文章&素材')).toBe(
      true,
    );
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
