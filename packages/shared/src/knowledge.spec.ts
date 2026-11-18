import { describe, expect, it } from 'vitest';
import {
  KB_AGREEMENT_CONFIRM_BUTTON_LABEL,
  KB_AGREEMENT_PARAGRAPHS,
  KB_CHUNK_SIZE,
  KB_DETAIL_FIELDS_META,
  chunkKnowledgeText,
  formatKnowledgeFactCard,
  isAgreementScrolledToBottom,
  knowledgeExportTable,
  knowledgeWriteSchema,
  requiresKbVectorIndex,
  type KnowledgeBaseRecord,
} from './knowledge';

describe('knowledge shared helpers', () => {
  it('exposes 查看说明 help docs on the exact 5 detail fields and omits brandStory & other', () => {
    const withHelp = KB_DETAIL_FIELDS_META.filter((f) => Boolean(f.help)).map((f) => f.key);
    expect(withHelp).toEqual(['productService', 'productFeature', 'painPoint', 'trust', 'cases']);
  });

  it('uses clean Chinese punctuation in placeholders and clean copy in agreement (#146)', () => {
    expect(KB_AGREEMENT_CONFIRM_BUTTON_LABEL).toBe('确认已阅读并承诺信息是真实数据');
    for (const meta of KB_DETAIL_FIELDS_META) {
      expect(meta.placeholder).not.toContain(',');
      expect(meta.placeholder).toContain('，1000 字以内');
    }
    const agreementText = KB_AGREEMENT_PARAGRAPHS.join('\n');
    expect(agreementText).not.toMatch(/向量检索|整段注入|切分向量索引/);
  });

  it('validates DETAIL and SUMMARY schemas independently and accepts optional companyName in SUMMARY (#205)', () => {
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

    const summaryWithCompany = knowledgeWriteSchema.safeParse({
      name: '安克创新（Anker）品牌与产品矩阵知识库',
      mode: 'SUMMARY',
      companyName: '  安克创新（Anker）  ',
      summaryText: '专注消费电子充电与储能硬件研发。',
    });
    expect(summaryWithCompany.success).toBe(true);
    if (summaryWithCompany.success && summaryWithCompany.data.mode === 'SUMMARY') {
      expect(summaryWithCompany.data.companyName).toBe('安克创新（Anker）');
    }

    const exported = knowledgeExportTable([
      {
        id: 'kb_sum_company',
        name: '安克创新（Anker）品牌与产品矩阵知识库',
        mode: 'SUMMARY',
        companyName: '安克创新（Anker）',
        brandShort: null,
        directions: [],
        copyTypes: [],
        fields: null,
        summaryText: '汇总资料',
        indexStatus: 'READY',
        chunkCount: 10,
        signatureId: 'sig_1',
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      } satisfies KnowledgeBaseRecord,
    ]);
    expect(exported.rows[0]?.[2]).toBe('安克创新（Anker）');
    expect(exported.rows[0]?.[3]).toBe('2026-11-18 08:00:00');

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

    const dedupCard = formatKnowledgeFactCard({
      companyName: '阿卓帕科技（ARZOPA）',
      brandShort: 'ARZOPA',
      fields: { productService: '便携显示器' },
    });
    expect(dedupCard).toContain('企业主体：阿卓帕科技（ARZOPA）');
    expect(dedupCard).not.toContain('（ARZOPA）（ARZOPA）');

    const sameBrandCard = formatKnowledgeFactCard({
      companyName: 'ARZOPA',
      brandShort: 'ARZOPA',
      fields: { productService: '便携显示器' },
    });
    expect(sameBrandCard).toContain('企业主体：ARZOPA');
    expect(sameBrandCard).not.toContain('ARZOPA（ARZOPA）');
  });
});
