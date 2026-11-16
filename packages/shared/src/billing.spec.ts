import { describe, expect, it } from 'vitest';
import {
  articleQuotaEffect,
  countsTowardAiWrite,
  evaluateLedger,
  ledgerTitle,
  quoteAiWrite,
  quotaReleasePolicy,
  readReconcileConfig,
  resolveTenantBillingMode,
  BillingRuleError,
} from './billing';

describe('billing rules', () => {
  it('inherits the global mode when the tenant override is null', () => {
    expect(resolveTenantBillingMode(null, 'SHADOW')).toEqual({
      mode: 'SHADOW',
      source: 'global',
      shadow: true,
    });
    expect(resolveTenantBillingMode(undefined, 'STRICT')).toEqual({
      mode: 'STRICT',
      source: 'global',
      shadow: false,
    });
    expect(resolveTenantBillingMode('STRICT', 'SHADOW')).toEqual({
      mode: 'STRICT',
      source: 'tenant',
      shadow: false,
    });
    expect(resolveTenantBillingMode('SHADOW', 'STRICT')).toEqual({
      mode: 'SHADOW',
      source: 'tenant',
      shadow: true,
    });
  });

  it('quotes one knowledge-base article as 10 plus 5, and five articles as 75', () => {
    const one = quoteAiWrite({
      count: 1,
      withKnowledgeBase: true,
      aiWritePoints: 10,
      kbAddonPoints: 5,
      taskName: '春季说明',
    });
    expect(one.unitTotal).toBe(15);
    expect(one.total).toBe(15);
    expect(one.lines.map((line) => [line.action, line.listPrice, line.title])).toEqual([
      ['ai_write', 10, 'AI写作-春季说明'],
      ['kb_addon', 5, '知识库加价-春季说明'],
    ]);
    const five = quoteAiWrite({
      count: 5,
      withKnowledgeBase: true,
      aiWritePoints: 10,
      kbAddonPoints: 5,
    });
    expect(five.total).toBe(75);
    expect(five.lines).toHaveLength(2);
  });

  it('omits the knowledge-base line when the task does not use one', () => {
    const quote = quoteAiWrite({
      count: 3,
      withKnowledgeBase: false,
      aiWritePoints: 10,
      kbAddonPoints: 5,
    });
    expect(quote.total).toBe(30);
    expect(quote.lines.map((line) => line.action)).toEqual(['ai_write']);
  });

  it('rejects a non-positive price instead of quoting a free charge', () => {
    expect(() =>
      quoteAiWrite({
        count: 1,
        withKnowledgeBase: true,
        aiWritePoints: 10,
        kbAddonPoints: 0,
      }),
    ).toThrow(BillingRuleError);
  });

  it('marks shadow ledger titles and leaves strict titles unchanged', () => {
    expect(ledgerTitle('AI写作-甲', true)).toBe('AI写作-甲（免费期）');
    expect(ledgerTitle('AI写作-甲（免费期）', true)).toBe('AI写作-甲（免费期）');
    expect(ledgerTitle('AI写作-甲', false)).toBe('AI写作-甲');
  });

  it('counts only writing tasks toward AI writing, and never toward publish', () => {
    expect(countsTowardAiWrite('AI_TASK')).toBe(true);
    expect(countsTowardAiWrite('REWRITE_SINGLE')).toBe(false);
    expect(countsTowardAiWrite('REWRITE_BATCH')).toBe(false);
    expect(countsTowardAiWrite('MANUAL')).toBe(false);
    expect(articleQuotaEffect('AI_TASK', 'create')).toEqual({ aiWrite: 1, publish: 0 });
    expect(articleQuotaEffect('REWRITE_BATCH', 'create')).toEqual({ aiWrite: 0, publish: 0 });
    expect(articleQuotaEffect('MANUAL', 'create')).toEqual({ aiWrite: 0, publish: 0 });
    expect(articleQuotaEffect('AI_TASK', 'status_change')).toEqual({ aiWrite: 0, publish: 0 });
    expect(articleQuotaEffect('AI_TASK', 'delete')).toEqual({ aiWrite: 0, publish: 0 });
    expect(articleQuotaEffect('MANUAL', 'status_change')).toEqual({ aiWrite: 0, publish: 0 });
  });

  it('releases stock quotas only, and leaves unconfirmed quotas alone', () => {
    expect(quotaReleasePolicy('MAIN_KEYWORD')).toBe('stock');
    expect(quotaReleasePolicy('QUESTION')).toBe('stock');
    expect(quotaReleasePolicy('STORAGE_BYTES')).toBe('stock');
    expect(quotaReleasePolicy('AI_WRITE')).toBe('cumulative');
    expect(quotaReleasePolicy('PUBLISH')).toBe('unconfirmed');
    expect(quotaReleasePolicy('SOCIAL_AUTH')).toBe('unconfirmed');
  });

  it('holds the ledger identity for a strict partial settle and a shadow no-op', () => {
    const strict = evaluateLedger({
      openingPoints: 100,
      points: 85,
      pointsReserved: 15,
      reservations: [
        { id: 'open', shadow: false, status: 'OPEN', frozen: 30, settled: 15, released: 0 },
      ],
      entries: [
        {
          reservationId: 'open',
          action: 'ai_write',
          delta: -10,
          listPrice: 10,
          status: 'SETTLED',
          shadow: false,
        },
        {
          reservationId: 'open',
          action: 'kb_addon',
          delta: -5,
          listPrice: 5,
          status: 'SETTLED',
          shadow: false,
        },
      ],
    });
    expect(strict).toEqual({ ok: true, issues: [] });

    const shadow = evaluateLedger({
      openingPoints: 1000,
      points: 1000,
      pointsReserved: 0,
      reservations: [
        { id: 'shadow', shadow: true, status: 'CLOSED', frozen: 15, settled: 15, released: 0 },
      ],
      entries: [
        {
          reservationId: 'shadow',
          action: 'ai_write',
          delta: 0,
          listPrice: 10,
          status: 'SETTLED',
          shadow: true,
        },
        {
          reservationId: 'shadow',
          action: 'kb_addon',
          delta: 0,
          listPrice: 5,
          status: 'SETTLED',
          shadow: true,
        },
      ],
    });
    expect(shadow.ok).toBe(true);
  });

  it('flags an overspend and a shadow row that changed the wallet', () => {
    const overspent = evaluateLedger({
      openingPoints: 10,
      points: 0,
      pointsReserved: 5,
      reservations: [
        { id: 'bad', shadow: false, status: 'OPEN', frozen: 10, settled: 10, released: 0 },
      ],
      entries: [
        {
          reservationId: 'bad',
          action: 'ai_write',
          delta: -10,
          listPrice: 10,
          status: 'SETTLED',
          shadow: false,
        },
      ],
    });
    expect(overspent.ok).toBe(false);
    expect(overspent.issues).toContain('reserved-drift');

    const leaked = evaluateLedger({
      openingPoints: 10,
      points: 5,
      pointsReserved: 0,
      reservations: [],
      entries: [
        {
          reservationId: 's',
          action: 'ai_write',
          delta: -5,
          listPrice: 5,
          status: 'SETTLED',
          shadow: true,
        },
      ],
    });
    expect(leaked.issues).toContain('shadow-delta');
    expect(leaked.issues).toContain('points-identity');
  });

  it('reads reconcile windows and rejects a tight loop', () => {
    expect(readReconcileConfig({})).toEqual({
      intervalMs: 15 * 60 * 1000,
      orphanAfterMs: 2 * 60 * 60 * 1000,
    });
    expect(readReconcileConfig({ BILLING_RECONCILE_AFTER_MS: '5000' }).orphanAfterMs).toBe(5000);
    expect(() => readReconcileConfig({ BILLING_RECONCILE_INTERVAL_MS: '10' })).toThrow(
      /BILLING_RECONCILE_INTERVAL_MS/,
    );
  });
});
