import { describe, expect, it } from 'vitest';
import {
  KB_CHUNK_SIZE,
  KB_DETAIL_FIELDS_META,
  chunkKnowledgeText,
  formatKnowledgeFactCard,
  isAgreementScrolledToBottom,
  knowledgeWriteSchema,
  requiresKbVectorIndex,
} from './knowledge';

describe('knowledge shared helpers', () => {
  it('exposes 查看说明 help docs on the exact 5 detail fields and omits brandStory & other', () => {
    const withHelp = KB_DETAIL_FIELDS_META.filter((f) => Boolean(f.help)).map((f) => f.key);
    expect(withHelp).toEqual(['productService', 'productFeature', 'painPoint', 'trust', 'cases']);
  });

  it('validates DETAIL and SUMMARY schemas independently', () => {
    const validDetail = knowledgeWriteSchema.safeParse({
      name: '激光设备知识库',
      mode: 'DETAIL',
      companyName: '智造星装备有限公司',
      brandShort: '智造星',
      directions: ['产品说明', '选购建议'],
      copyTypes: ['说明文', '指南'],
      fields: {
        productService: '光纤激光切割机',
        productFeature: '',
        brandStory: '',
        painPoint: '',
        trust: '',
        cases: '',
        other: '',
      },
    });
    expect(validDetail.success).toBe(true);

    const invalidSummary = knowledgeWriteSchema.safeParse({
      name: '超长汇总',
      mode: 'SUMMARY',
      summaryText: '甲'.repeat(20_001),
    });
    expect(invalidSummary.success).toBe(false);
  });

  it('chunks 20,000-character summary text into <=600-char overlapping segments and detects >6000 index threshold', () => {
    const shortText = '段'.repeat(6000);
    expect(requiresKbVectorIndex('SUMMARY', shortText)).toBe(false);

    const paragraph = `${'智能制造装备工艺参数与交付服务流程说明'.repeat(12)}。\n`;
    const full20k = paragraph.repeat(90).slice(0, 20_000);
    expect(Array.from(full20k)).toHaveLength(20_000);
    expect(requiresKbVectorIndex('SUMMARY', full20k)).toBe(true);

    const chunks = chunkKnowledgeText(full20k, 600, 80);
    expect(chunks.length).toBeGreaterThanOrEqual(35);
    for (const chunk of chunks) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(KB_CHUNK_SIZE);
    }
  });

  it('checks scroll-to-bottom lock and formats non-empty fact card fields', () => {
    expect(
      isAgreementScrolledToBottom({ scrollTop: 100, clientHeight: 300, scrollHeight: 800 }),
    ).toBe(false);
    expect(
      isAgreementScrolledToBottom({ scrollTop: 495, clientHeight: 300, scrollHeight: 800 }),
    ).toBe(true);

    const card = formatKnowledgeFactCard({
      companyName: '智造星装备有限公司',
      brandShort: '智造星',
      fields: { productService: '激光切割机', brandStory: '' },
    });
    expect(card).toContain('智造星装备有限公司（智造星）');
    expect(card).toContain('产品服务：激光切割机');
    expect(card).not.toContain('品牌故事：');
  });
});
