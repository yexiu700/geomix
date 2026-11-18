import { describe, expect, it } from 'vitest';
import {
  AccountQueryError,
  MONEY_LEDGER_COLUMNS,
  MONEY_LEDGER_EXCLUDED_COLUMNS,
  MODEL_INCLUSION_CARDS,
  POINT_LEDGER_COLUMNS,
  PRICING_ACTION_META,
  buildRightsCards,
  emptyModelInclusions,
  formatAdminDateTime,
  formatBytes,
  formatMoney,
  formatPointsCell,
  getPricingActionMeta,
  parseMoneyListQuery,
  parsePointListQuery,
  pointLedgerPhrase,
  pricingBatchUpdateSchema,
} from './account';
import { PRICING_DEFAULTS } from './catalog';

describe('account ledger phrases', () => {
  it('shows an admin top-up as +500 管理员充值', () => {
    expect(pointLedgerPhrase(500, '管理员充值')).toBe('+500 管理员充值');
    expect(formatPointsCell(500, 500)).toBe('+500');
    expect(pointLedgerPhrase(-20, '管理员扣点')).toBe('-20 管理员扣点');
  });

  it('keeps a shadow charge at delta 0 and still shows the list price', () => {
    expect(formatPointsCell(0, 10)).toBe('0（原价 10）');
    expect(pointLedgerPhrase(0, 'AI蒸馏拓展-示例（免费期）')).toBe('0 AI蒸馏拓展-示例（免费期）');
  });

  it('lists money columns without a sequence or checkbox column', () => {
    expect(MONEY_LEDGER_COLUMNS).toEqual(['项目', '金额', '说明', '消耗时间']);
    expect(MONEY_LEDGER_EXCLUDED_COLUMNS).toEqual(['序号', '复选框']);
    expect(POINT_LEDGER_COLUMNS).toEqual(['项目', '点数', '消耗时间']);
    for (const column of MONEY_LEDGER_EXCLUDED_COLUMNS) {
      expect(MONEY_LEDGER_COLUMNS).not.toContain(column);
    }
  });
});

describe('account rights cards', () => {
  it('reads quota rows and shows storage used together with the limit', () => {
    const cards = buildRightsCards({
      quotas: [
        { key: 'MAIN_KEYWORD', used: 1n, limit: 100n },
        { key: 'QUESTION', used: 2n, limit: 10000n },
        { key: 'AI_WRITE', used: 3n, limit: 10000n },
        { key: 'STORAGE_BYTES', used: 2048n, limit: 100n * 1024n * 1024n },
        { key: 'PUBLISH', used: 0n, limit: 10000n },
        { key: 'SOCIAL_AUTH', used: 0n, limit: 100n },
      ],
      included: 4,
      expiresOn: '2027-11-16',
      points: 1500,
      money: '0',
    });
    expect(cards).toHaveLength(10);
    expect(cards.map((card) => card.label)).toEqual([
      '主关键词',
      '写作问题',
      '已收录',
      'AI写作数量',
      '文章发布',
      '自媒体授权',
      '有效期',
      '图片存储空间',
      '点数',
      '余额',
    ]);
    expect(cards.find((card) => card.key === 'MAIN_KEYWORD')?.text).toBe('1 / 100');
    expect(cards.find((card) => card.key === 'INCLUDED')?.text).toBe('4');
    expect(cards.find((card) => card.key === 'STORAGE_BYTES')?.text).toBe(
      `${formatBytes(2048n)} / ${formatBytes(100n * 1024n * 1024n)}`,
    );
    expect(cards.find((card) => card.key === 'STORAGE_BYTES')?.text).toContain('2 KB');
    expect(cards.find((card) => card.key === 'STORAGE_BYTES')?.text).toContain('100 MB');
    expect(cards.find((card) => card.key === 'POINTS')?.text).toBe('1500');
    expect(cards.find((card) => card.key === 'MONEY')?.text).toBe(formatMoney('0'));
    expect(emptyModelInclusions()).toHaveLength(MODEL_INCLUSION_CARDS.length);
    expect(emptyModelInclusions().every((item) => item.count === 0)).toBe(true);
  });
});

describe('account list queries', () => {
  it('filters points by project, delta and time', () => {
    const query = parsePointListQuery({
      page: '2',
      pageSize: '25',
      sort: 'delta',
      order: 'asc',
      filter: JSON.stringify({
        title: '管理员充值',
        delta: 500,
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-16T00:00:00.000Z',
      }),
    });
    expect(query).toMatchObject({
      page: 2,
      pageSize: 25,
      sort: 'delta',
      order: 'asc',
      title: '管理员充值',
      delta: 500,
    });
  });

  it('rejects a tenant id hidden in the filter and a sequence column request', () => {
    expect(() => parseMoneyListQuery({ filter: JSON.stringify({ tenantId: 'other' }) })).toThrow(
      AccountQueryError,
    );
    expect(() => parsePointListQuery({ export: 'pdf' })).toThrow(AccountQueryError);
    expect(parseMoneyListQuery({ filter: JSON.stringify({ amount: '12.5' }) }).amount).toBe(
      '12.50',
    );
  });
});

describe('pricing metadata, batch schema, and UTC+8 formatting (#196, #199)', () => {
  it('maps every PRICING_DEFAULTS action to Chinese label, billing unit, and description', () => {
    for (const item of PRICING_DEFAULTS) {
      const meta = getPricingActionMeta(item.action);
      expect(meta.action).toBe(item.action);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label).not.toBe(item.action);
      expect(meta.unit).toMatch(/^点\/(篇|次|张)$/);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(PRICING_ACTION_META[item.action]).toBeDefined();
    }
    expect(getPricingActionMeta('ai_write')).toMatchObject({
      label: 'AI 文章写作',
      unit: '点/篇',
    });
    expect(getPricingActionMeta('kb_addon')).toMatchObject({
      label: '知识库增强附加费',
      unit: '点/篇',
    });
  });

  it('validates batch pricing updates and rejects empty or duplicate action lists', () => {
    expect(
      pricingBatchUpdateSchema.parse({
        items: [
          { action: 'ai_write', unitPoints: 12, enabled: true },
          { action: 'kb_addon', unitPoints: 8, enabled: false },
        ],
      }),
    ).toEqual({
      items: [
        { action: 'ai_write', unitPoints: 12, enabled: true },
        { action: 'kb_addon', unitPoints: 8, enabled: false },
      ],
    });
    expect(() => pricingBatchUpdateSchema.parse({ items: [] })).toThrow();
    expect(() =>
      pricingBatchUpdateSchema.parse({
        items: [
          { action: 'ai_write', unitPoints: 10, enabled: true },
          { action: 'ai_write', unitPoints: 12, enabled: true },
        ],
      }),
    ).toThrow();
  });

  it('formats UTC timestamps to Asia/Shanghai (UTC+8) and handles empty values gracefully', () => {
    expect(formatAdminDateTime('2026-11-18T00:05:09.000Z')).toBe('2026-11-18 08:05:09');
    expect(formatAdminDateTime('2026-11-17T16:30:00.000Z')).toBe('2026-11-18 00:30:00');
    expect(formatAdminDateTime(null)).toBe('—');
    expect(formatAdminDateTime(undefined)).toBe('—');
    expect(formatAdminDateTime('not-a-date')).toBe('—');
  });
});
