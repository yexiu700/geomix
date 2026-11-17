import {
  DASHBOARD_DEFAULT_ANNOUNCEMENTS,
  DASHBOARD_RECHARGE_NOTICE,
  aggregateCreationTrend5Days,
  shanghaiCurrentMonthWindowUtc,
  type DashboardSummary,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import { readAccessToken, type SessionStorageLike } from './session';

export class DashboardApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'DashboardApiError';
  }
}

export type DashboardGateway = {
  getSummary(): Promise<DashboardSummary>;
};

export function createEmptyDashboardSummary(
  aiImageEnabled = true,
  now: Date = new Date(),
  visibilityEnabled = true,
): DashboardSummary {
  const monthWin = shanghaiCurrentMonthWindowUtc(now);
  return {
    generatedAt: now.toISOString(),
    monthKey: monthWin.monthKey,
    tenant: {
      id: '',
      name: '',
      expiresAt: '2029-12-31T00:00:00.000Z',
      isActive: true,
      readOnly: false,
    },
    features: {
      aiImage: aiImageEnabled,
      visibility: visibilityEnabled,
    },
    balanceCard: {
      balance: '0.00',
      monthConsumed: '0.00',
      monthRecharged: '0.00',
      rechargeNotice: DASHBOARD_RECHARGE_NOTICE.money,
    },
    pointsCard: {
      billingMode: 'SHADOW',
      billingModeSource: 'global',
      points: 0,
      pointsReserved: 0,
      available: 0,
      monthConsumedPoints: 0,
      monthListPricePoints: 0,
      monthRechargedPoints: 0,
      rechargeNotice: DASHBOARD_RECHARGE_NOTICE.points,
    },
    announcements: DASHBOARD_DEFAULT_ANNOUNCEMENTS.map((item) => ({ ...item })),
    trend5d: aggregateCreationTrend5Days([], now),
    stats: {
      keywords: 0,
      questions: 0,
      mediaAssets: 0,
      knowledgeBases: 0,
      prompts: 0,
      articleCategories: 0,
      aiTasks: 0,
      articles: 0,
      rewriteSingle: 0,
      rewriteBatches: 0,
      aiImages: 0,
    },
  };
}

export function httpDashboardGateway(storage: SessionStorageLike): DashboardGateway {
  return {
    async getSummary(): Promise<DashboardSummary> {
      if (!readAccessToken(storage)) {
        return createEmptyDashboardSummary(true);
      }
      const res = await authorizedRequest(storage, 'GET', '/dashboard');
      const payload = (await res.json()) as Envelope<DashboardSummary>;
      if (!res.ok || payload.code !== 0 || !payload.data) {
        throw new DashboardApiError(
          res.status,
          payload.code ?? res.status,
          payload.msg || '加载首页概览数据失败',
        );
      }
      return payload.data;
    },
  };
}
