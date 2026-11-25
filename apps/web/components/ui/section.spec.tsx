// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Section } from './index';

describe('Section', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults to plain variant and links section aria-labelledby to its h2 heading', () => {
    render(
      <Section
        id="brand-section-identity"
        title="基础身份"
        description="维护品牌中英文名称、品类与主域名"
        actions={<button type="button">编辑</button>}
        data-testid="section-identity"
      >
        <p>身份表单内容</p>
      </Section>,
    );

    const section = screen.getByTestId('section-identity');
    expect(section.tagName).toBe('SECTION');
    expect(section.id).toBe('brand-section-identity');
    expect(section.className).toContain('gm-ui-section--plain');

    const heading = screen.getByRole('heading', { level: 2, name: '基础身份' });
    expect(heading.id).toBeTruthy();
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(section.getAttribute('aria-label')).toBeNull();

    expect(screen.getByText('维护品牌中英文名称、品类与主域名')).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByText('身份表单内容')).toBeTruthy();
  });

  it('supports card variant and respects explicit aria-label without overriding', () => {
    const { container } = render(
      <Section
        variant="card"
        title="品牌事实卡"
        aria-label="品牌事实卡区块"
        className="extra-card"
        data-testid="section-card"
      >
        <div>内容体</div>
      </Section>,
    );

    const section = screen.getByTestId('section-card');
    expect(section.className).toContain('gm-ui-section--card');
    expect(section.className).toContain('extra-card');
    expect(section.getAttribute('aria-label')).toBe('品牌事实卡区块');
    expect(section.getAttribute('aria-labelledby')).toBeNull();
    expect(container.querySelector('.gm-ui-section-body')?.textContent).toBe('内容体');
  });

  it('omits section header when title, description, and actions are absent', () => {
    const { container } = render(
      <Section aria-label="纯内容分节" data-testid="section-headless">
        <span>仅子内容</span>
      </Section>,
    );

    expect(container.querySelector('.gm-ui-section-header')).toBeNull();
    expect(screen.getByText('仅子内容')).toBeTruthy();
  });
});
