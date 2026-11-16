import type { BillingMode } from '@geomix/shared';
import type { ActiveJobRef } from '@geomix/shared';

export const BILLING_OPTIONS = Symbol('BILLING_OPTIONS');
export const RECONCILE_INTERVAL_MS = Symbol('RECONCILE_INTERVAL_MS');

export type ActiveJobProbe = (ref: ActiveJobRef) => boolean | Promise<boolean>;

export type BillingOptions = {
  /** 每次预扣时读取。已有冻结单仍按自己的 shadow 标记结算。 */
  globalMode: () => BillingMode;
  orphanAfterMs: number;
  now: () => Date;
  /**
   * 返回 true 表示队列里还有这个冻结单的活跃任务，对账不会释放它。
   * 队列消费者尚未实现时，默认没有活跃任务。调用方仍要等 orphanAfterMs。
   */
  hasActiveJob?: ActiveJobProbe;
};
