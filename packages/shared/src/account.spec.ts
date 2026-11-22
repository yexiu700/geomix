import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  AccountQueryError,
  MONEY_LEDGER_COLUMNS,
  MONEY_LEDGER_EXCLUDED_COLUMNS,
  MODEL_INCLUSION_CARDS,
  POINT_LEDGER_COLUMNS,
  PRICING_ACTION_META,
  PRICING_ACTION_NAMES,
  buildRightsCards,
  emptyModelInclusions,
  formatAdminDateTime,
  formatBytes,
  formatPointsCell,
  getPricingActionMeta,
  isPricingAction,
  parseMoneyListQuery,
  parsePointListQuery,
  pointLedgerPhrase,
  pricingBatchUpdateSchema,
  pricingUpdateSchema,
  summarizeMonthMoney,
  summarizeMonthPoints,
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
    expect(pointLedgerPhrase(0, 'GEO写作-示例（免费期）')).toBe('0 GEO写作-示例（免费期）');
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

describe('account rights cards (D11)', () => {
  it('reads quota rows, shows storage used with limit, and omits MONEY card', () => {
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
    });
    expect(cards).toHaveLength(9);
    expect(cards.map((card) => card.label)).toEqual([
      '品牌数量',
      '写作意见',
      '已收录',
      'GEO写作数量',
      '文章发布',
      '自媒体授权',
      '有效期',
      '图片存储空间',
      '点数',
    ]);
    expect(cards.find((card) => card.key === 'MONEY')).toBeUndefined();
    expect(cards.find((card) => card.key === 'MAIN_KEYWORD')?.text).toBe('1 / 100');
    expect(cards.find((card) => card.key === 'INCLUDED')?.text).toBe('4');
    expect(cards.find((card) => card.key === 'STORAGE_BYTES')?.text).toBe(
      `${formatBytes(2048n)} / ${formatBytes(100n * 1024n * 1024n)}`,
    );
    expect(cards.find((card) => card.key === 'POINTS')?.text).toBe('1500');
    expect(emptyModelInclusions()).toHaveLength(MODEL_INCLUSION_CARDS.length);
    expect(emptyModelInclusions().every((item) => item.count === 0)).toBe(true);
  });

  it('summarizes monthly points and money accurately', () => {
    expect(
      summarizeMonthPoints([
        { delta: 500, listPrice: 500, status: 'SETTLED', action: 'admin_topup' },
        { delta: -10, listPrice: 10, status: 'SETTLED', action: 'geo_write' },
        { delta: 0, listPrice: 5, status: 'SETTLED', action: 'inline_image_gen' },
        { delta: 0, listPrice: 10, status: 'RELEASED', action: 'geo_write' },
      ]),
    ).toEqual({ actualConsumed: 10, listPriceConsumed: 15, recharged: 500 });
    expect(summarizeMonthMoney([{ amount: '100.50' }, { amount: '-12.25' }])).toEqual({
      consumed: '12.25',
      recharged: '100.50',
    });
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

describe('v2 pricing metadata, admin routes, batch schema, and UTC+8 formatting', () => {
  it('exposes admin routes without templates and maps all 3 v2 PRICING_DEFAULTS actions', () => {
    expect(ADMIN_ROUTES).toEqual({
      tenants: '/admin/tenants',
      pricing: '/admin/pricing',
      announcements: '/admin/announcements',
      llmCosts: '/admin/llm-costs',
    });
    expect(Object.keys(PRICING_ACTION_META).sort()).toEqual([
      'geo_write',
      'inline_image_gen',
      'visibility_check',
    ]);
    for (const item of PRICING_DEFAULTS) {
      const meta = getPricingActionMeta(item.action);
      expect(meta.action).toBe(item.action);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label).not.toBe(item.action);
      expect(meta.unit).toMatch(/^点\/(篇|次|张)$/);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(PRICING_ACTION_META[item.action]).toBeDefined();
    }
    expect(getPricingActionMeta('geo_write')).toMatchObject({
      label: 'GEO 靶向写作',
      unit: '点/篇',
    });
    expect(getPricingActionMeta('inline_image_gen')).toMatchObject({
      label: '行内 AI 配图',
      unit: '点/张',
    });
  });

  it('validates batch pricing updates and rejects empty or duplicate action lists', () => {
    expect(
      pricingBatchUpdateSchema.parse({
        items: [
          { action: 'geo_write', unitPoints: 12, enabled: true },
          { action: 'inline_image_gen', unitPoints: 8, enabled: false },
        ],
      }),
    ).toEqual({
      items: [
        { action: 'geo_write', unitPoints: 12, enabled: true },
        { action: 'inline_image_gen', unitPoints: 8, enabled: false },
      ],
    });
    expect(() => pricingBatchUpdateSchema.parse({ items: [] })).toThrow();
    expect(() =>
      pricingBatchUpdateSchema.parse({
        items: [
          { action: 'geo_write', unitPoints: 10, enabled: true },
          { action: 'geo_write', unitPoints: 12, enabled: true },
        ],
      }),
    ).toThrow();
  });

  it('enforces canonical v2 pricing actions in isPricingAction and pricing schemas', () => {
    expect(PRICING_ACTION_NAMES).toEqual(['geo_write', 'visibility_check', 'inline_image_gen']);

    for (const action of ['geo_write', 'visibility_check', 'inline_image_gen'] as const) {
      expect(isPricingAction(action)).toBe(true);
      const single = pricingUpdateSchema.safeParse({ action, unitPoints: 10, enabled: true });
      expect(single.success).toBe(true);
    }

    const retiredOrUnknown = [
      'kb_addon',
      'ai_write',
      'distill',
      'rewrite_single',
      'rewrite_batch',
      'image_gen',
      'unknown_action',
      '',
    ];
    for (const action of retiredOrUnknown) {
      expect(isPricingAction(action)).toBe(false);
      const single = pricingUpdateSchema.safeParse({ action, unitPoints: 5, enabled: true });
      expect(single.success).toBe(false);
      if (!single.success) {
        expect(single.error.issues[0]?.message).toBe('价格项不正确');
      }

      const batch = pricingBatchUpdateSchema.safeParse({
        items: [{ action, unitPoints: 5, enabled: true }],
      });
      expect(batch.success).toBe(false);
      if (!batch.success) {
        expect(batch.error.issues[0]?.message).toBe('价格项不正确');
      }
    }
  });

  it('formats UTC timestamps to Asia/Shanghai (UTC+8) and handles empty values gracefully', () => {
    expect(formatAdminDateTime('2026-11-18T00:05:09.000Z')).toBe('2026-11-18 08:05:09');
    expect(formatAdminDateTime('2026-11-17T16:30:00.000Z')).toBe('2026-11-18 00:30:00');
    expect(formatAdminDateTime(null)).toBe('—');
    expect(formatAdminDateTime(undefined)).toBe('—');
    expect(formatAdminDateTime('not-a-date')).toBe('—');
  });
});
