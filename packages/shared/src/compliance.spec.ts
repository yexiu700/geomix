import { describe, expect, it } from 'vitest';
import {
  ProhibitedContentError,
  assertNoProhibitedContent,
  formatComplianceBlockMessage,
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

  it('allows legitimate defensive cybersecurity & used-mining-drive科普 context without false blocking (#409)', () => {
    const cnNasArticle = [
      '2026 家用 NAS 数据防护深度评测：开启 WORM 不可变只读快照可有效防勒索软件加密，',
      '内置安全扫描引擎能够拦截并查杀木马程序入侵。',
      '选购二手企业盘避坑指南：如何通过 SMART 通电时间与损耗指标识别虚拟币矿机盘与翻新清零盘。',
      '同时介绍家庭隐私防护与反窃听、防偷拍自查建议。',
    ].join('');
    const cnReport = scanDualTrackCompliance(cnNasArticle, { market: 'CN' });
    expect(cnReport.blocked).toBe(false);
    expect(cnReport.blockedTerms).toEqual([]);

    const globalNasArticle =
      'Best 4-Bay NAS 2026: immutable snapshots protect your backups against ransomware, and built-in anti-malware scanning detects spyware threats automatically.';
    const globalReport = scanDualTrackCompliance(globalNasArticle, { market: 'GLOBAL' });
    expect(globalReport.blocked).toBe(false);
    expect(globalReport.blockedTerms).toEqual([]);
  });

  it('still blocks malicious, promotional, or non-defensive usage of sensitive terms and formats actionable messages (#409)', () => {
    const maliciousCn = scanDualTrackCompliance('免费提供勒索软件源码与免杀木马程序下载教程', {
      market: 'CN',
    });
    expect(maliciousCn.blocked).toBe(true);
    expect(maliciousCn.blockedTerms).toEqual(expect.arrayContaining(['勒索软件', '木马程序']));

    const promoCrypto = scanDualTrackCompliance('虚拟币交易所合约高回报投资开户推广', {
      market: 'CN',
    });
    expect(promoCrypto.blocked).toBe(true);
    expect(promoCrypto.blockedTerms).toContain('虚拟币');

    // Mixed safe + unsafe occurrence in the same article MUST still block
    const mixedCn = scanDualTrackCompliance(
      '第一段讲快照防勒索软件保护数据。第二段教你制作并出售勒索软件源码。',
      { market: 'CN' },
    );
    expect(mixedCn.blocked).toBe(true);
    expect(mixedCn.blockedTerms).toContain('勒索软件');

    const maliciousEn = scanDualTrackCompliance(
      'Where to buy ransomware exploit kit and deploy malware',
      {
        market: 'GLOBAL',
      },
    );
    expect(maliciousEn.blocked).toBe(true);
    expect(maliciousEn.blockedTerms).toEqual(expect.arrayContaining(['ransomware', 'malware']));

    const genMsg = formatComplianceBlockMessage(['赌博', '勒索软件'], {
      market: 'CN',
      context: 'generate',
    });
    expect(genMsg).toContain('禁做行业词：赌博');
    expect(genMsg).toContain('高危敏感词：勒索软件');
    expect(genMsg).toContain('已拦截并退还本次点数');

    const rewriteMsg = formatComplianceBlockMessage(['ransomware'], {
      market: 'GLOBAL',
      context: 'rewrite',
    });
    expect(rewriteMsg).toContain('ransomware');
    expect(rewriteMsg).toContain('改写结果');
  });
});
