import { describe, expect, it } from 'vitest';
import { renderPrompt } from './render';

describe('renderPrompt', () => {
  it('replaces named placeholders and keeps unknown ones', () => {
    expect(renderPrompt('写给 {{ brand }} 的草稿', { brand: 'GeoMix' })).toBe('写给 GeoMix 的草稿');
    expect(renderPrompt('第 {{count}} 节', { count: 2 })).toBe('第 2 节');
    expect(renderPrompt('缺少 {{topic}}', {})).toBe('缺少 {{topic}}');
  });

  it('does not treat nearby braces as tokens', () => {
    expect(renderPrompt('保留 {brand} 和 {{ brand-name }}', { brand: 'GeoMix' })).toBe(
      '保留 {brand} 和 {{ brand-name }}',
    );
  });
});
