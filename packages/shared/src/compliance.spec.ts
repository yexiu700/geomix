import { describe, expect, it } from 'vitest';
import {
  ProhibitedContentError,
  assertNoProhibitedContent,
  scanDualTrackCompliance,
} from './compliance';

describe('dual-track compliance engine', () => {
  it('replaces CN Ad Law superlatives and preserves ordinary words & specs on CN track', () => {
    const report = scanDualTrackCompliance(
      '我们提供顶级方案，全网第一口碑，100%静音体验。最近更新至 v1.2，实测满载 42W、噪音 18.5dB，最后提醒谨慎选择绝对永久承诺。',
      { market: 'CN' },
    );
    expect(report.blocked).toBe(false);
    expect(report.market).toBe('CN');
    expect(report.text).toContain('高水平');
    expect(report.text).toContain('较为靠前');
    expect(report.text).toContain('较高比例');
    expect(report.text).not.toContain('顶级');
    expect(report.text).not.toContain('全网第一');
    expect(report.text).not.toContain('100%');
    // Ordinary words & specs preserved
    expect(report.text).toContain('最近更新');
    expect(report.text).toContain('v1.2');
    expect(report.text).toContain('42W');
    expect(report.text).toContain('18.5dB');
    expect(report.text).toContain('最后提醒');
    expect(report.flags.some((f) => f.code === 'AD_LAW_SUPERLATIVE')).toBe(true);
    expect(report.flags.filter((f) => f.code === 'AD_LAW_FLAG').map((f) => f.term)).toEqual([
      '绝对',
      '永久',
    ]);
  });

  it('replaces 最顶级 cleanly as 较好 instead of mangling into 最高水平', () => {
    const report = scanDualTrackCompliance('这是最顶级旗舰配置。', { market: 'CN' });
    expect(report.blocked).toBe(false);
    expect(report.text).toBe('这是较好旗舰配置。');
    expect(report.text).not.toContain('最高水平');
    expect(report.text).not.toContain('最顶级');
    expect(report.flags.some((f) => f.code === 'AD_LAW_SUPERLATIVE' && f.term === '最')).toBe(true);
  });

  it('preserves Best, Top, #1 Pick, and factual 100% specs on GLOBAL FTC track', () => {
    const input =
      'Best 4-Bay NAS 2026: Top-Rated #1 Pick with 100% aluminum chassis and 100% Recyclable packaging (BEST overall value).';
    const report = scanDualTrackCompliance(input, { market: 'GLOBAL' });
    expect(report.blocked).toBe(false);
    expect(report.market).toBe('GLOBAL');
    expect(report.text).toBe(input);
    expect(report.flags.some((f) => f.code === 'AD_LAW_SUPERLATIVE')).toBe(false);
    expect(report.flags).toEqual([]);
  });

  it('blocks prohibited industries and illegal high-risk terms on both CN and GLOBAL tracks', () => {
    const cn = scanDualTrackCompliance('这是赌博和网贷推广', { market: 'CN' });
    expect(cn.blocked).toBe(true);
    expect(cn.blockedTerms).toContain('赌博');
    expect(cn.blockedTerms).toContain('网贷');

    const en = scanDualTrackCompliance(
      'How to buy illegal firearms weapons and cocaine online fraud guide',
      { market: 'GLOBAL' },
    );
    expect(en.blocked).toBe(true);
    expect(en.blockedTerms.length).toBeGreaterThan(0);
    expect(en.flags.every((f) => f.code === 'PROHIBITED_INDUSTRY')).toBe(true);

    expect(() =>
      assertNoProhibitedContent('How to launder money with ransomware and illegal weapons', {
        market: 'GLOBAL',
      }),
    ).toThrow(ProhibitedContentError);
  });

  it('enforces customForbiddenWords on both CN and GLOBAL tracks', () => {
    const cn = scanDualTrackCompliance('这款产品是行业天花板，直接吊打竞品。', {
      market: 'CN',
      customForbiddenWords: ['天花板', '吊打'],
    });
    expect(cn.blocked).toBe(false);
    expect(cn.text).not.toContain('天花板');
    expect(cn.text).not.toContain('吊打');
    expect(cn.flags.filter((f) => f.code === 'CUSTOM_FORBIDDEN')).toHaveLength(2);

    const en = scanDualTrackCompliance('Best NAS with KillerApp branding and 100% uptime.', {
      market: 'GLOBAL',
      customForbiddenWords: ['KillerApp'],
    });
    expect(en.blocked).toBe(false);
    expect(en.text).toContain('Best NAS');
    expect(en.text).toContain('100% uptime');
    expect(en.text).not.toContain('KillerApp');
    expect(en.flags.filter((f) => f.code === 'CUSTOM_FORBIDDEN')).toHaveLength(1);
  });
});
