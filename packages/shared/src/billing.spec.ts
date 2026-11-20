import { describe, expect, it } from 'vitest';
import {
  BillingRuleError,
  CHARGE_ACTIONS,
  RESERVATION_REF_TYPES,
  articleQuotaEffect,
  countsTowardAiWrite,
  evaluateLedger,
  isChargeAction,
  isReservationRefType,
  ledgerTitle,
  quoteGeoWrite,
  quotaReleasePolicy,
  readReconcileConfig,
  resolveTenantBillingMode,
} from './billing';

describe('GeoMix 2.0 billing rules', () => {
  it('registers v2 reservation refTypes and 3 paid charge actions', () => {
    expect(RESERVATION_REF_TYPES).toEqual([
      'geo_article',
      'geo_batch',
      'inline_image_gen',
      'visibility_run',
    ]);
    expect(CHARGE_ACTIONS).toEqual(['geo_write', 'visibility_check', 'inline_image_gen']);

    expect(isReservationRefType('geo_article')).toBe(true);
    expect(isReservationRefType('geo_batch')).toBe(true);
    expect(isReservationRefType('inline_image_gen')).toBe(true);
    expect(isReservationRefType('visibility_run')).toBe(true);
    expect(isReservationRefType('ai_task')).toBe(false);

    expect(isChargeAction('geo_write')).toBe(true);
    expect(isChargeAction('visibility_check')).toBe(true);
    expect(isChargeAction('inline_image_gen')).toBe(true);
    expect(isChargeAction('kb_addon')).toBe(false);
    expect(isChargeAction('ai_write')).toBe(false);

    expect(ledgerTitle('AI可见性监测-核心词巡检', true)).toBe('AI可见性监测-核心词巡检（免费期）');
  });

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

  it('quotes unified geo_write at 10 points per article with a single line (no kb_addon)', () => {
    const one = quoteGeoWrite({
      count: 1,
      geoWritePoints: 10,
      subject: '春季说明',
    });
    expect(one.unitPrice).toBe(10);
    expect(one.total).toBe(10);
    expect(one.lines).toEqual([{ action: 'geo_write', listPrice: 10, title: 'GEO写作-春季说明' }]);

    const five = quoteGeoWrite({
      count: 5,
      geoWritePoints: 10,
    });
    expect(five.total).toBe(50);
    expect(five.lines).toEqual([{ action: 'geo_write', listPrice: 10, title: 'GEO写作' }]);
  });

  it('rejects a non-positive price or invalid count instead of quoting a free charge', () => {
    expect(() => quoteGeoWrite({ count: 1, geoWritePoints: 0 })).toThrow(BillingRuleError);
    expect(() => quoteGeoWrite({ count: 1, geoWritePoints: -5 })).toThrow(BillingRuleError);
    expect(() => quoteGeoWrite({ count: 0, geoWritePoints: 10 })).toThrow(BillingRuleError);
  });

  it('marks shadow ledger titles and leaves strict titles unchanged', () => {
    expect(ledgerTitle('GEO写作-甲', true)).toBe('GEO写作-甲（免费期）');
    expect(ledgerTitle('GEO写作-甲（免费期）', true)).toBe('GEO写作-甲（免费期）');
    expect(ledgerTitle('GEO写作-甲', false)).toBe('GEO写作-甲');
  });

  it('counts GEO_STREAM and GEO_BATCH toward AI writing quota, and never MANUAL or delete', () => {
    expect(countsTowardAiWrite('GEO_STREAM')).toBe(true);
    expect(countsTowardAiWrite('GEO_BATCH')).toBe(true);
    expect(countsTowardAiWrite('MANUAL')).toBe(false);
    expect(articleQuotaEffect('GEO_STREAM', 'create')).toEqual({ aiWrite: 1, publish: 0 });
    expect(articleQuotaEffect('GEO_BATCH', 'create')).toEqual({ aiWrite: 1, publish: 0 });
    expect(articleQuotaEffect('MANUAL', 'create')).toEqual({ aiWrite: 0, publish: 0 });
    expect(articleQuotaEffect('GEO_STREAM', 'status_change')).toEqual({ aiWrite: 0, publish: 0 });
    expect(articleQuotaEffect('GEO_BATCH', 'delete')).toEqual({ aiWrite: 0, publish: 0 });
  });

  it('releases stock quotas only, and leaves unconfirmed quotas alone', () => {
    expect(quotaReleasePolicy('MAIN_KEYWORD')).toBe('stock');
    expect(quotaReleasePolicy('QUESTION')).toBe('stock');
    expect(quotaReleasePolicy('STORAGE_BYTES')).toBe('stock');
    expect(quotaReleasePolicy('AI_WRITE')).toBe('cumulative');
    expect(quotaReleasePolicy('PUBLISH')).toBe('unconfirmed');
    expect(quotaReleasePolicy('SOCIAL_AUTH')).toBe('unconfirmed');
  });

  it('holds the ledger identity for strict partial settle, refund release, and shadow no-op', () => {
    const strict = evaluateLedger({
      openingPoints: 100,
      points: 90,
      pointsReserved: 10,
      reservations: [
        { id: 'open', shadow: false, status: 'OPEN', frozen: 20, settled: 10, released: 0 },
      ],
      entries: [
        {
          reservationId: 'open',
          action: 'geo_write',
          delta: -10,
          listPrice: 10,
          status: 'SETTLED',
          shadow: false,
        },
      ],
    });
    expect(strict).toEqual({ ok: true, issues: [] });

    const refunded = evaluateLedger({
      openingPoints: 100,
      points: 100,
      pointsReserved: 0,
      reservations: [
        { id: 'failed', shadow: false, status: 'CLOSED', frozen: 10, settled: 0, released: 10 },
      ],
      entries: [
        {
          reservationId: 'failed',
          action: 'geo_write',
          delta: 0,
          listPrice: 10,
          status: 'RELEASED',
          shadow: false,
        },
      ],
    });
    expect(refunded).toEqual({ ok: true, issues: [] });

    const shadow = evaluateLedger({
      openingPoints: 1000,
      points: 1000,
      pointsReserved: 0,
      reservations: [
        { id: 'shadow', shadow: true, status: 'CLOSED', frozen: 10, settled: 10, released: 0 },
      ],
      entries: [
        {
          reservationId: 'shadow',
          action: 'geo_write',
          delta: 0,
          listPrice: 10,
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
          action: 'geo_write',
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
          action: 'inline_image_gen',
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
