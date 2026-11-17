import { describe, expect, it } from 'vitest';
import { MENU, STATIC_ROUTES, buildMenu, collectHrefs, matchRoute, menuSelection } from './routes';

describe('console routes', () => {
  it('puts every active console page on the grouped menu', () => {
    expect(new Set(collectHrefs())).toEqual(
      new Set(Object.keys(STATIC_ROUTES).filter((href) => href !== '/workbench/samples')),
    );
    expect(collectHrefs()).toContain('/visibility/overview');
    expect(collectHrefs()).toContain('/visibility/monitors');
    const image = MENU.find((item) => item.type === 'submenu' && item.key === 'image');
    expect(image?.type === 'submenu' ? image.badge : undefined).toBe('new');
    expect(MENU.some((item) => item.type === 'section' && item.title === 'AI创作-文章&素材')).toBe(
      true,
    );
  });

  it('hides aidata and visibility sections when visibilityEnabled is false', () => {
    const filtered = buildMenu({ visibilityEnabled: false });
    const hrefs = collectHrefs(filtered);
    expect(hrefs).not.toContain('/visibility/overview');
    expect(hrefs).not.toContain('/visibility/monitors');
    expect(filtered.some((item) => item.type === 'section' && item.key === 'aidata')).toBe(false);
    expect(filtered.some((item) => item.type === 'section' && item.key === 'visibility')).toBe(
      false,
    );
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
});
