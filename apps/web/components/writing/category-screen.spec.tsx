// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArticleCategoryRecord } from '@geomix/shared';
import {
  initialSnapshot,
  reduceShell,
  type ShellAction,
  type ShellSnapshot,
} from '../../lib/tab-stack';
import type { ArticleGateway, ArticlePage, CategoryGateway } from '../../lib/categories';
import { ArticleListScreen } from './article-list-screen';
import { CategoryScreen } from './category-screen';

const CATEGORY = 'c'.repeat(25);

afterEach(() => {
  cleanup();
});

function category(name = '测试分类'): ArticleCategoryRecord {
  return {
    id: CATEGORY,
    name,
    total: 2,
    remaining: 1,
    createdAt: '2026-11-16T08:30:00.000Z',
  };
}

function categoryGateway(partial: Partial<CategoryGateway> = {}): CategoryGateway {
  return {
    list: vi.fn(async () => ({ items: [category()], total: 1, page: 1, pageSize: 10 })),
    create: vi.fn(async (input) => ({ ...category(input.name), total: 0, remaining: 0 })),
    update: vi.fn(async (_id, input) => ({ ...category(input.name) })),
    remove: vi.fn(async () => ({ affected: 1 })),
    download: vi.fn(async () => ({
      filename: 'geomix-article-categories.csv',
      mime: 'text/csv',
      body: new Uint8Array(),
    })),
    ...partial,
  };
}

function articlePage(): ArticlePage {
  return {
    category: category(),
    total: 2,
    page: 1,
    pageSize: 10,
    items: [
      {
        id: 'a'.repeat(25),
        title: '手动正常稿',
        status: 'NORMAL',
        sendCount: 0,
        countsAsRemaining: true,
        createdAt: '2026-11-16T09:00:00.000Z',
      },
      {
        id: 'b'.repeat(25),
        title: '已发送稿',
        status: 'NORMAL',
        sendCount: 2,
        countsAsRemaining: false,
        createdAt: '2026-11-16T09:05:00.000Z',
      },
    ],
  };
}

describe('article categories', () => {
  it('adds a category with only the name field', async () => {
    const client = categoryGateway();
    render(
      <CategoryScreen
        title="文章分类"
        tabId="/writing/categories"
        gateway={client}
        onDispatch={() => undefined}
      />,
    );
    expect(await screen.findByText('测试分类')).toBeTruthy();
    expect(screen.getByText('分组名')).toBeTruthy();
    expect(screen.getByText('文章数量')).toBeTruthy();
    expect(screen.getByText('文章剩余量')).toBeTruthy();
    expect(screen.getAllByText('查看文章').length).toBeGreaterThan(0);
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText('操作')).toBeTruthy();
    const row = screen.getByText('测试分类').closest('tr');
    expect(row?.textContent).toContain('2');
    expect(row?.textContent).toContain('1');

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    const dialog = screen.getByRole('dialog', { name: '添加分类' });
    expect(dialog.querySelectorAll('input, textarea').length).toBe(1);
    expect(screen.getByRole('textbox', { name: '文章分类' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '备注' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect((await screen.findAllByText('请填写文章分类')).length).toBeGreaterThan(0);
    expect(client.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '文章分类' }), {
      target: { value: '新分类' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(client.create).toHaveBeenCalledWith({ name: '新分类' });
  }, 20_000);

  it('blocks writes for a read-only account and deletes the selection', async () => {
    const client = categoryGateway();
    const view = render(
      <CategoryScreen
        title="文章分类"
        tabId="/writing/categories"
        gateway={client}
        onDispatch={() => undefined}
      />,
    );
    expect(await screen.findByText('测试分类')).toBeTruthy();
    view.rerender(
      <CategoryScreen
        title="文章分类"
        tabId="/writing/categories"
        readOnly
        gateway={client}
        onDispatch={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '添加' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '编辑 测试分类' })).toHaveProperty('disabled', true);

    view.rerender(
      <CategoryScreen
        title="文章分类"
        tabId="/writing/categories"
        gateway={client}
        onDispatch={() => undefined}
      />,
    );
    const box = document.querySelector('input[type="checkbox"]');
    if (!(box instanceof HTMLInputElement)) throw new Error('missing selection');
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(client.remove).toHaveBeenCalledWith([CATEGORY]);
  }, 20_000);

  it('opens the filtered article list in a new tab and returns to the category list', async () => {
    const articles = articleGateway();
    const categories = categoryGateway();
    function Harness() {
      const [state, setState] = useState<ShellSnapshot>(() =>
        reduceShell(initialSnapshot(), { type: 'open', href: '/writing/categories' }),
      );
      const dispatch = (action: ShellAction) => setState((current) => reduceShell(current, action));
      return (
        <>
          <div data-testid="active">{state.activeId}</div>
          <div data-testid="tabs">{state.tabs.map((tab) => tab.href).join('|')}</div>
          {state.tabs.map((tab) => {
            const path = tab.href.split('?')[0];
            const hidden = tab.id !== state.activeId;
            if (path === '/writing/categories') {
              return (
                <div key={tab.id} hidden={hidden}>
                  <CategoryScreen
                    title={tab.title}
                    tabId={tab.id}
                    gateway={categories}
                    onDispatch={dispatch}
                  />
                </div>
              );
            }
            if (path === '/writing/articles') {
              return (
                <div key={tab.id} hidden={hidden}>
                  <ArticleListScreen
                    title={tab.title}
                    tabId={tab.id}
                    categoryId={
                      new URLSearchParams(tab.href.split('?')[1] ?? '').get('categoryId') ?? ''
                    }
                    gateway={articles}
                    onDispatch={dispatch}
                  />
                </div>
              );
            }
            return null;
          })}
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '查看文章 测试分类' }));
    expect(await screen.findByText('手动正常稿')).toBeTruthy();
    expect(screen.getByText('已发送稿')).toBeTruthy();
    expect(screen.getByText('是')).toBeTruthy();
    expect(screen.getByText('否')).toBeTruthy();
    expect(screen.getByTestId('active').textContent).toBe(
      `/writing/articles?categoryId=${CATEGORY}`,
    );
    expect(screen.getByTestId('tabs').textContent).toContain('/writing/categories');
    expect(articles.list).toHaveBeenCalledWith({
      categoryId: CATEGORY,
      page: 1,
      pageSize: 10,
    });
    expect(screen.queryByRole('button', { name: '添加' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    expect(screen.getByTestId('active').textContent).toBe('/writing/categories');
    expect(screen.getByTestId('tabs').textContent).not.toContain('/writing/articles');
    expect(screen.queryByText('手动正常稿')).toBeNull();
    expect(await screen.findByText('测试分类')).toBeTruthy();
  }, 20_000);

  it('asks for a category before listing articles', async () => {
    const articles = articleGateway();
    const dispatch = vi.fn();
    render(
      <ArticleListScreen
        title="文章列表"
        tabId="/writing/articles"
        categoryId=""
        gateway={articles}
        onDispatch={dispatch}
      />,
    );
    expect(await screen.findByText('请从文章分类的「查看文章」进入。')).toBeTruthy();
    expect(articles.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'back', id: '/writing/articles' });
  });
});

function articleGateway(): ArticleGateway {
  return { list: vi.fn(async () => articlePage()) };
}
