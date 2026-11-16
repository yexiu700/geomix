import type { BillingMode } from './infra';
import { PRICING_DEFAULTS, QUOTA_MEASURE, type QuotaKeyName } from './catalog';

export { PRICING_DEFAULTS, type QuotaKeyName };

/**
 * 计费规则（issue #4）。
 * 租户 billingMode 为空时继承全局配置，全局默认 SHADOW。
 * 知识库写作的预扣总额是篇数 ×（写作单价 + 知识库加价），账本按项目分两条。
 * 无产出或失败释放剩余冻结，不把「创建即扣、没结果不退」写进实现。
 * 发布配额和自媒体授权的回退口径未确认，这里不猜测。
 */

export const MAX_POINT_AMOUNT = 1_000_000_000;
export const SHADOW_TITLE_SUFFIX = '（免费期）';

export const BILLING_ERROR = {
  CONFLICT: 40902,
} as const;

export const RESERVATION_REF_TYPES = [
  'ai_task',
  'rewrite_batch',
  'image_job',
  'distill',
  'rewrite_single',
] as const;
export type ReservationRefType = (typeof RESERVATION_REF_TYPES)[number];

export const CHARGE_ACTIONS = [
  'distill',
  'ai_write',
  'kb_addon',
  'rewrite_single',
  'rewrite_batch',
  'image_gen',
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

export function cleanSubject(value: string): string {
  return value
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
}

export function ledgerTitle(base: string, shadow: boolean): string {
  const trimmed = cleanSubject(base);
  if (!shadow) return trimmed;
  if (trimmed.endsWith(SHADOW_TITLE_SUFFIX)) return trimmed;
  return `${trimmed}${SHADOW_TITLE_SUFFIX}`;
}

export type AiWriteLine = {
  action: 'ai_write' | 'kb_addon';
  listPrice: number;
  title: string;
};

export type AiWriteQuote = {
  count: number;
  withKnowledgeBase: boolean;
  unitAiWrite: number;
  unitKbAddon: number;
  unitTotal: number;
  total: number;
  lines: AiWriteLine[];
};

export class BillingRuleError extends Error {
  constructor(readonly reason: 'count' | 'price' | 'total' | 'subject') {
    super(reason);
    this.name = 'BillingRuleError';
  }
}

/**
 * 一条写作的账是两条：正文价和知识库加价。
 * 不挂知识库时只有正文一条。总额给预扣和界面共用。
 */
export function quoteAiWrite(input: {
  count: number;
  withKnowledgeBase: boolean;
  aiWritePoints: number;
  kbAddonPoints: number;
  taskName?: string;
}): AiWriteQuote {
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 10_000) {
    throw new BillingRuleError('count');
  }
  if (!isPositivePoints(input.aiWritePoints)) throw new BillingRuleError('price');
  if (input.withKnowledgeBase && !isPositivePoints(input.kbAddonPoints)) {
    throw new BillingRuleError('price');
  }
  const unitKbAddon = input.withKnowledgeBase ? input.kbAddonPoints : 0;
  const unitTotal = input.aiWritePoints + unitKbAddon;
  const total = input.count * unitTotal;
  if (!Number.isSafeInteger(total) || total > MAX_POINT_AMOUNT) throw new BillingRuleError('total');
  const subject = cleanSubject(input.taskName ?? '');
  const lines: AiWriteLine[] = [
    {
      action: 'ai_write',
      listPrice: input.aiWritePoints,
      title: subject.length > 0 ? `AI写作-${subject}` : 'AI写作',
    },
  ];
  if (input.withKnowledgeBase) {
    lines.push({
      action: 'kb_addon',
      listPrice: input.kbAddonPoints,
      title: subject.length > 0 ? `知识库加价-${subject}` : '知识库加价',
    });
  }
  return {
    count: input.count,
    withKnowledgeBase: input.withKnowledgeBase,
    unitAiWrite: input.aiWritePoints,
    unitKbAddon,
    unitTotal,
    total,
    lines,
  };
}

export type QuotaReleasePolicy = 'stock' | 'cumulative' | 'unconfirmed';

export function quotaReleasePolicy(key: QuotaKeyName): QuotaReleasePolicy {
  if (!Object.prototype.hasOwnProperty.call(QUOTA_MEASURE, key)) return 'unconfirmed';
  return QUOTA_MEASURE[key as keyof typeof QUOTA_MEASURE] === 'stock' ? 'stock' : 'cumulative';
}

export type ArticleQuotaSource = 'AI_TASK' | 'MANUAL' | 'REWRITE_SINGLE' | 'REWRITE_BATCH';
export type ArticleQuotaEvent = 'create' | 'status_change' | 'delete';

/** 只有写作任务计入 AI 写作数量。复刻、手动文章、状态变更和删除都不计，也不动发布配额。 */
export function countsTowardAiWrite(source: ArticleQuotaSource): boolean {
  return source === 'AI_TASK';
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
