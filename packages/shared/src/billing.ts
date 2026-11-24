import type { BillingMode } from './infra';
import {
  PRICING_DEFAULTS,
  QUOTA_MEASURE,
  isZeroAllowedPricingAction,
  type QuotaKeyName,
} from './catalog';

export { PRICING_DEFAULTS, type QuotaKeyName };

/**
 * GeoMix 2.0 统一计费规则（Issue #326 / D3）。
 * 租户 billingMode 为空时继承全局配置，全局默认 SHADOW。
 * 品牌事实卡默认免费标配，GEO 写作统一定价（默认 10 点/篇），取消 kb_addon 拆账。
 * 无产出或失败释放剩余冻结，绝不静默扣费。
 */

export const MAX_POINT_AMOUNT = 1_000_000_000;
export const SHADOW_TITLE_SUFFIX = '（免费期）';

export const BILLING_ERROR = {
  CONFLICT: 40902,
} as const;

export const RESERVATION_REF_TYPES = [
  'geo_article',
  'geo_batch',
  'inline_image_gen',
  'visibility_run',
  'geo_variant',
  'geo_distribution',
] as const;
export type ReservationRefType = (typeof RESERVATION_REF_TYPES)[number];

export const CHARGE_ACTIONS = [
  'geo_write',
  'visibility_check',
  'inline_image_gen',
  'geo_variant',
] as const;
export type ChargeAction = (typeof CHARGE_ACTIONS)[number];

const REF_TYPE_SET = new Set<string>(RESERVATION_REF_TYPES);
const CHARGE_SET = new Set<string>(CHARGE_ACTIONS);

export function isReservationRefType(value: string): value is ReservationRefType {
  return REF_TYPE_SET.has(value);
}

export function isChargeAction(value: string): value is ChargeAction {
  return CHARGE_SET.has(value);
}

export type ResolvedBillingMode = {
  mode: BillingMode;
  source: 'tenant' | 'global';
  shadow: boolean;
};

/** null / undefined 表示没有租户覆盖，继承全局，而不是再默认一次 SHADOW。 */
export function resolveTenantBillingMode(
  tenantMode: BillingMode | null | undefined,
  globalMode: BillingMode,
): ResolvedBillingMode {
  if (tenantMode === null || tenantMode === undefined) {
    return { mode: globalMode, source: 'global', shadow: globalMode === 'SHADOW' };
  }
  return { mode: tenantMode, source: 'tenant', shadow: tenantMode === 'SHADOW' };
}

export function isPositivePoints(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_POINT_AMOUNT;
}

/** 按计费动作校验单价合法性：geo_variant 允许设为 0（免费限流），其余动作必须为正整数。 */
export function isValidUnitPoints(action: string, points: number): boolean {
  if (!Number.isSafeInteger(points) || points > MAX_POINT_AMOUNT) return false;
  if (isZeroAllowedPricingAction(action)) return points >= 0;
  return points > 0;
}

const MAX_LEDGER_TITLE_LENGTH = 80;
const GEO_WRITE_TITLE_PREFIX = 'GEO写作-';

function sliceSafe(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  let end = maxLen;
  const lastCode = value.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function cleanSubject(value: string): string {
  return sliceSafe(value.replace(/[\u0000-\u001f]/g, '').trim(), MAX_LEDGER_TITLE_LENGTH).trim();
}

export function ledgerTitle(base: string, shadow: boolean): string {
  const trimmed = cleanSubject(base);
  if (!shadow) return trimmed;
  if (trimmed.endsWith(SHADOW_TITLE_SUFFIX)) return trimmed;
  return `${trimmed}${SHADOW_TITLE_SUFFIX}`;
}

export type GeoWriteLine = {
  action: 'geo_write';
  listPrice: number;
  title: string;
};

export type GeoWriteQuote = {
  count: number;
  unitPrice: number;
  total: number;
  lines: GeoWriteLine[];
};

export class BillingRuleError extends Error {
  constructor(readonly reason: 'count' | 'price' | 'total' | 'subject') {
    super(reason);
    this.name = 'BillingRuleError';
  }
}

/**
 * GeoMix 2.0 统一单篇写作报价：单条 geo_write 明细（免费标配品牌事实卡 + 体检 + Schema）。
 */
export function quoteGeoWrite(input: {
  count: number;
  geoWritePoints: number;
  subject?: string;
}): GeoWriteQuote {
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 10_000) {
    throw new BillingRuleError('count');
  }
  if (!isPositivePoints(input.geoWritePoints)) throw new BillingRuleError('price');
  const total = input.count * input.geoWritePoints;
  if (!Number.isSafeInteger(total) || total > MAX_POINT_AMOUNT) {
    throw new BillingRuleError('total');
  }
  const subject = sliceSafe(
    cleanSubject(input.subject ?? ''),
    MAX_LEDGER_TITLE_LENGTH - GEO_WRITE_TITLE_PREFIX.length,
  ).trim();
  return {
    count: input.count,
    unitPrice: input.geoWritePoints,
    total,
    lines: [
      {
        action: 'geo_write',
        listPrice: input.geoWritePoints,
        title: subject.length > 0 ? `${GEO_WRITE_TITLE_PREFIX}${subject}` : 'GEO写作',
      },
    ],
  };
}

export type QuotaReleasePolicy = 'stock' | 'cumulative' | 'unconfirmed';

export function quotaReleasePolicy(key: QuotaKeyName): QuotaReleasePolicy {
  if (!Object.prototype.hasOwnProperty.call(QUOTA_MEASURE, key)) return 'unconfirmed';
  return QUOTA_MEASURE[key as keyof typeof QUOTA_MEASURE] === 'stock' ? 'stock' : 'cumulative';
}

export type ArticleQuotaSource = 'GEO_STREAM' | 'GEO_BATCH' | 'MANUAL';
export type ArticleQuotaEvent = 'create' | 'status_change' | 'delete';

/** 流式写作与轻量批量写作计入 GEO 写作累计配额；手动草稿、状态变更与删除不计。 */
export function countsTowardAiWrite(source: ArticleQuotaSource): boolean {
  return source === 'GEO_STREAM' || source === 'GEO_BATCH';
}

export function articleQuotaEffect(
  source: ArticleQuotaSource,
  event: ArticleQuotaEvent,
): { aiWrite: number; publish: number } {
  if (event === 'create' && countsTowardAiWrite(source)) return { aiWrite: 1, publish: 0 };
  return { aiWrite: 0, publish: 0 };
}

export type LedgerReservation = {
  id: string;
  shadow: boolean;
  status: 'OPEN' | 'CLOSED';
  frozen: number;
  settled: number;
  released: number;
};

export type LedgerEntry = {
  reservationId: string | null;
  action: string;
  delta: number;
  listPrice: number;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED';
  shadow: boolean;
};

export type LedgerSnapshot = {
  openingPoints: number;
  points: number;
  pointsReserved: number;
  reservations: readonly LedgerReservation[];
  entries: readonly LedgerEntry[];
};

export type LedgerInvariant = {
  ok: boolean;
  issues: string[];
};

function reservationBounds(reservation: LedgerReservation): boolean {
  return (
    reservation.settled >= 0 &&
    reservation.released >= 0 &&
    reservation.settled + reservation.released <= reservation.frozen
  );
}

/** 结算 + 可用 + 冻结 = 初始 + 管理员充值。影子账和释放预扣不改变账面点数。 */
export function evaluateLedger(snapshot: LedgerSnapshot): LedgerInvariant {
  const issues: string[] = [];
  const openHold = snapshot.reservations
    .filter((reservation) => reservation.status === 'OPEN' && !reservation.shadow)
    .reduce(
      (sum, reservation) => sum + (reservation.frozen - reservation.settled - reservation.released),
      0,
    );
  if (snapshot.pointsReserved !== openHold) issues.push('reserved-drift');
  if (
    snapshot.points < 0 ||
    snapshot.pointsReserved < 0 ||
    snapshot.points < snapshot.pointsReserved
  ) {
    issues.push('negative-wallet');
  }
  if (snapshot.reservations.some((reservation) => !reservationBounds(reservation))) {
    issues.push('reservation-bounds');
  }

  const strictCharges = snapshot.entries.filter(
    (entry) => entry.status === 'SETTLED' && !entry.shadow && entry.action !== 'admin_topup',
  );
  const strictList = strictCharges.reduce((sum, entry) => sum + entry.listPrice, 0);
  const strictDelta = strictCharges.reduce((sum, entry) => sum + entry.delta, 0);
  if (strictDelta !== -strictList) issues.push('strict-delta');
  if (snapshot.entries.some((entry) => entry.shadow && entry.delta !== 0))
    issues.push('shadow-delta');
  if (snapshot.entries.some((entry) => entry.status === 'RELEASED' && entry.delta !== 0)) {
    issues.push('release-delta');
  }

  const adminNet = snapshot.entries
    .filter((entry) => entry.action === 'admin_topup')
    .reduce((sum, entry) => sum + entry.delta, 0);
  if (snapshot.points !== snapshot.openingPoints + adminNet - strictList)
    issues.push('points-identity');

  const available = snapshot.points - snapshot.pointsReserved;
  const left = strictList + available + snapshot.pointsReserved;
  const right = snapshot.openingPoints + adminNet;
  if (left !== right) issues.push('ledger-identity');

  return { ok: issues.length === 0, issues };
}

export type ReconcileConfig = {
  intervalMs: number;
  orphanAfterMs: number;
};

function positiveMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer number of milliseconds`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1000 || value > 86_400_000) {
    throw new Error(`${name} must be between 1000 and 86400000`);
  }
  return value;
}

export function readReconcileConfig(
  env: Record<string, string | undefined> = process.env,
): ReconcileConfig {
  return {
    intervalMs: positiveMs(
      env.BILLING_RECONCILE_INTERVAL_MS,
      15 * 60 * 1000,
      'BILLING_RECONCILE_INTERVAL_MS',
    ),
    orphanAfterMs: positiveMs(
      env.BILLING_RECONCILE_AFTER_MS,
      2 * 60 * 60 * 1000,
      'BILLING_RECONCILE_AFTER_MS',
    ),
  };
}

export type ActiveJobRef = {
  tenantId: string;
  refType: string;
  refId: string;
};
