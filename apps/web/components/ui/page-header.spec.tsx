// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './index';

describe('PageHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders h1 title, clamped description, tags, meta, extra, and right-hand action', () => {
    const { container } = render(
      <PageHeader
        title="行动首页"
        description="追踪品牌在主流 AI 引擎中的可见度变化与高优内容机会"
        tags={<span>CN 市场</span>}
        meta={<span>最近更新：2 分钟前</span>}
        extra={<button type="button">导出报告</button>}
        action={<button type="button">发起新一轮监测</button>}
        className="custom-header"
        data-testid="home-page-header"
      />,
    );

    const header = screen.getByTestId('home-page-header');
    expect(header.tagName).toBe('HEADER');
    expect(header.className).toContain('gm-ui-page-header');
    expect(header.className).toContain('custom-header');

    const heading = screen.getByRole('heading', { level: 1, name: '行动首页' });
    expect(heading.className).toContain('gm-ui-page-header-title');

    const desc = screen.getByText('追踪品牌在主流 AI 引擎中的可见度变化与高优内容机会');
    expect(desc.className).toContain('gm-ui-page-header-desc');
    expect(desc.className).toContain('gm-clamp-1');

    expect(screen.getByText('CN 市场')).toBeTruthy();
    expect(screen.getByText('最近更新：2 分钟前')).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出报告' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发起新一轮监测' })).toBeTruthy();
    expect(container.querySelector('.gm-ui-page-header-actions')).toBeTruthy();
  });

  it('omits optional wrapper nodes when optional props are omitted', () => {
    const { container } = render(<PageHeader title="品牌资产" />);

    expect(screen.getByRole('heading', { level: 1, name: '品牌资产' })).toBeTruthy();
    expect(container.querySelector('.gm-ui-page-header-tags')).toBeNull();
    expect(container.querySelector('.gm-ui-page-header-desc')).toBeNull();
    expect(container.querySelector('.gm-ui-page-header-meta')).toBeNull();
    expect(container.querySelector('.gm-ui-page-header-actions')).toBeNull();
    expect(container.querySelector('.gm-ui-page-header-extra')).toBeNull();
    expect(container.querySelector('.gm-ui-page-header-action')).toBeNull();
  });
});
