import { describe, expect, it } from 'vitest';
import * as rootBarrel from './index';
import {
  UX_GLOSSARY_TOOLTIPS,
  UX_TERMS,
  VISIBILITY_TASK_STATUS_LABELS,
  containsRawCuid,
  dedupeRechargeNotice,
  formatCollectorDisplayLabel,
  formatJudgeModelDisplayLabel,
  formatShanghaiDate,
  formatShanghaiDateTime,
  formatShortDisplayId,
  isOpaqueEntityId,
  replaceUxJargon,
  sanitizeEntityTitleSegment,
  type UxGlossaryKey,
} from './ux-foundation';

describe('ux-foundation', () => {
  it('formats UTC timestamps deterministically in Asia/Shanghai (UTC+8)', () => {
    // 2026-11-18T05:00:00.000Z -> 2026-11-18 13:00 in UTC+8
    expect(formatShanghaiDateTime('2026-11-18T05:00:00.000Z')).toBe('2026-11-18 13:00');
    expect(formatShanghaiDateTime('2026-11-18T05:00:09.000Z', { seconds: true })).toBe(
      '2026-11-18 13:00:09',
    );
    // Cross-midnight boundary: 2026-11-17T18:30:00.000Z -> 2026-11-18 02:30 in UTC+8
    expect(formatShanghaiDateTime('2026-11-17T18:30:00.000Z')).toBe('2026-11-18 02:30');
    expect(formatShanghaiDate('2026-11-17T18:30:00.000Z')).toBe('2026-11-18');
    expect(formatShanghaiDate('2026-11-17')).toBe('2026-11-17');
  });

  it('returns fallback on null, empty, or invalid timestamps', () => {
    expect(formatShanghaiDateTime(null)).toBe('—');
    expect(formatShanghaiDateTime('')).toBe('—');
    expect(formatShanghaiDateTime('not-a-date', { fallback: '-' })).toBe('-');
    expect(formatShanghaiDate(undefined)).toBe('—');
  });

  it('detects CUIDs and UUIDs while preserving short human or test slugs', () => {
    expect(isOpaqueEntityId('cm1234567890abcdefghijklm')).toBe(true);
    expect(isOpaqueEntityId('c'.repeat(25))).toBe(true);
    expect(isOpaqueEntityId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);

    expect(isOpaqueEntityId('demo')).toBe(false);
    expect(isOpaqueEntityId('kw_1')).toBe(false);
    expect(isOpaqueEntityId('c1')).toBe(false);
    expect(isOpaqueEntityId('vprof_1')).toBe(false);
    expect(isOpaqueEntityId('pic_1')).toBe(false);
    expect(isOpaqueEntityId('ARZOPA便携屏')).toBe(false);

    expect(sanitizeEntityTitleSegment('cm1234567890abcdefghijklm', '按分类筛选')).toBe(
      '按分类筛选',
    );
    expect(sanitizeEntityTitleSegment('demo', '按主词筛选')).toBe('demo');
    expect(containsRawCuid('文章列表 · cm1234567890abcdefghijklm')).toBe(true);
    expect(containsRawCuid('文章列表 · 按分类筛选')).toBe(false);
    expect(formatShortDisplayId('cm1234567890abcdefghijklm', '图片')).toBe('图片 #HIJKLM');
    expect(formatShortDisplayId('tenant-a', '')).toBe('tenant-a');
  });

  it('provides domain-accurate visibility status labels and masks debug provider identifiers', () => {
    expect(VISIBILITY_TASK_STATUS_LABELS.RUNNING).toBe('监测中');
    expect(VISIBILITY_TASK_STATUS_LABELS.COMPLETED).toBe('监测完成');
    expect(VISIBILITY_TASK_STATUS_LABELS.FAILED).toBe('监测失败');

    expect(formatCollectorDisplayLabel('fake')).toBe('模拟演示采集');
    expect(formatCollectorDisplayLabel('mock-collector')).toBe('模拟演示采集');
    expect(formatCollectorDisplayLabel('llm_api')).toBe('大模型直连采集');
    expect(formatCollectorDisplayLabel('remote_scraper')).toBe('联网搜索采集');
    expect(formatCollectorDisplayLabel('live')).toBe('实时引擎采集');

    expect(formatJudgeModelDisplayLabel('deterministic-fallback')).toBe('规则语义判别');
    expect(formatJudgeModelDisplayLabel('deepseek-flash:deterministic-fallback')).toBe(
      '规则语义判别',
    );
    expect(formatJudgeModelDisplayLabel('deterministic-skip')).toBe('规则语义判别');
    expect(formatJudgeModelDisplayLabel('deterministic-domain')).toBe('规则语义判别');
    expect(formatJudgeModelDisplayLabel('fake-cheap')).toBe('规则语义判别');
    expect(formatJudgeModelDisplayLabel('judge-mock')).toBe('规则语义判别');
    expect(formatJudgeModelDisplayLabel('deepseek-chat')).toBe('deepseek-chat');
  });

  it('deduplicates recharge notices and sanitizes internal R&D jargon', () => {
    expect(dedupeRechargeNotice('如需充值余额，请联系客服人工办理（充值请联系客服）')).toBe(
      '如需充值余额，请联系客服人工办理',
    );
    expect(replaceUxJargon('影子计费期间消耗仅记录原价核算流水')).toContain(UX_TERMS.billingShadow);
    expect(replaceUxJargon('支持零拷贝转存至图库')).toBe('支持一键转存至图库');
  });

  it('exposes plain-language terminology glossary & tooltips re-exported from root barrel without jargon', () => {
    const expectedTerms: Record<UxGlossaryKey, string> = {
      fanOutCoverage: 'AI 追问覆盖度',
      channelModeL1: '一键直发自有站',
      channelModeL3Community: '社区合规辅发',
      channelModeL3Pr: '外部媒体 / KOL 供稿',
      crawlSchemaProbe: 'AI 抓取与结构化体检',
      highConfidenceSampling: '3 次采样（结果更稳）',
    };

    const bannedTerms = [
      '影子计费',
      '零拷贝',
      '检索适配器',
      '复刻落库状态',
      '已落库查看',
      '切分向量索引',
      '整段注入',
      '切片向量化',
      '含手工槽位·不入随机池',
      '模型收录计数留到后续模块',
    ];

    expect(Object.keys(UX_GLOSSARY_TOOLTIPS).sort()).toEqual(Object.keys(expectedTerms).sort());
    expect(rootBarrel.UX_TERMS).toBe(UX_TERMS);
    expect(rootBarrel.UX_GLOSSARY_TOOLTIPS).toBe(UX_GLOSSARY_TOOLTIPS);

    for (const [key, label] of Object.entries(expectedTerms) as Array<[UxGlossaryKey, string]>) {
      expect(UX_TERMS[key]).toBe(label);
      expect(replaceUxJargon(label)).toBe(label);

      const tooltip = UX_GLOSSARY_TOOLTIPS[key];
      expect(tooltip.trim().length).toBeGreaterThanOrEqual(16);
      expect(/[\u4e00-\u9fff]/.test(tooltip)).toBe(true);
      expect(replaceUxJargon(tooltip)).toBe(tooltip);

      for (const banned of bannedTerms) {
        expect(label).not.toContain(banned);
        expect(tooltip).not.toContain(banned);
      }
    }
  });
});
