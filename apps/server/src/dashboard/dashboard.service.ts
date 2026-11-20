import { Inject, Injectable } from '@nestjs/common';
import {
  AUTH_ERROR,
  formatMoney,
  parseEnv,
  resolveTenantBillingMode,
  shanghaiCurrentMonthWindowUtc,
  shanghaiFiveDayWindowUtc,
  summarizeMonthMoney,
  summarizeMonthPoints,
  toShanghaiDateKey,
  type BillingMode,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { readVisibilityConfig } from '../visibility/visibility.config';

export type DashboardSummaryV1Stub = {
  generatedAt: string;
  monthKey: string;
  tenant: {
    id: string;
    name: string;
    expiresAt: string;
    isActive: boolean;
    readOnly: boolean;
  };
  features: {
    aiImage: boolean;
    visibility: boolean;
  };
  balanceCard: {
    balance: string;
    monthConsumed: string;
    monthRecharged: string;
    rechargeNotice: string;
  };
  pointsCard: {
    billingMode: BillingMode;
    billingModeSource: 'tenant' | 'global';
    points: number;
    pointsReserved: number;
    available: number;
    monthConsumedPoints: number;
    monthListPricePoints: number;
    monthRechargedPoints: number;
    rechargeNotice: string;
  };
  announcements: Array<{ id: string; content: string; sort: number }>;
  trend5d: Array<{
    date: string;
    label: string;
    writingCount: number;
    rewriteCount: number;
    totalCount: number;
  }>;
  stats: {
    brands: number;
    geoBriefs: number;
    geoArticles: number;
    brandMediaAssets: number;
    geoBatchJobs: number;
  };
};

const DEFAULT_ANNOUNCEMENTS = [
  { id: 'default-1', content: '欢迎使用 GeoMix 2.0 极简 GEO 增长工作台。', sort: 0 },
] as const;

@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async summary(tenantId: string, now: Date = new Date()): Promise<DashboardSummaryV1Stub> {
    const tenant = await this.prisma.base.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        expiresAt: true,
        isActive: true,
        billingMode: true,
        wallet: true,
      },
    });
    if (!tenant) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '账号不存在');
    }
    const wallet = tenant.wallet;
    if (!wallet) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '钱包不存在');
    }

    const env = parseEnv(process.env);
    const resolvedBilling = resolveTenantBillingMode(tenant.billingMode, env.BILLING_MODE);
    const readOnly = !tenant.isActive || tenant.expiresAt.getTime() <= now.getTime();

    const monthWin = shanghaiCurrentMonthWindowUtc(now);
    const trendWin = shanghaiFiveDayWindowUtc(now);

    const [
      monthPointLogs,
      monthMoneyLogs,
      recentArticles,
      announcementRows,
      brandsCount,
      geoBriefsCount,
      geoArticlesCount,
      brandMediaAssetsCount,
      geoBatchJobsCount,
    ] = await Promise.all([
      this.prisma.scoped.pointLog.findMany({
        where: {
          tenantId,
          createdAt: {
            gte: monthWin.startUtc,
            lt: monthWin.endUtc,
          },
        },
        select: {
          delta: true,
          listPrice: true,
          status: true,
          action: true,
        },
      }),
      this.prisma.scoped.moneyLog.findMany({
        where: {
          tenantId,
          createdAt: {
            gte: monthWin.startUtc,
            lt: monthWin.endUtc,
          },
        },
        select: {
          amount: true,
        },
      }),
      this.prisma.scoped.geoArticle.findMany({
        where: {
          tenantId,
          createdAt: {
            gte: trendWin.startUtc,
            lte: trendWin.endUtc,
          },
        },
        select: {
          createdAt: true,
        },
      }),
      this.prisma.base.announcement.findMany({
        where: { enabled: true },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        select: { id: true, content: true, sort: true },
      }),
      this.prisma.scoped.brand.count({ where: { tenantId } }),
      this.prisma.scoped.geoBrief.count({ where: { tenantId } }),
      this.prisma.scoped.geoArticle.count({ where: { tenantId } }),
      this.prisma.scoped.brandMediaAsset.count({ where: { tenantId } }),
      this.prisma.scoped.geoBatchJob.count({ where: { tenantId } }),
    ]);

    const pointSummary = summarizeMonthPoints(monthPointLogs);
    const moneySummary = summarizeMonthMoney(
      monthMoneyLogs.map((row) => ({ amount: row.amount.toString() })),
    );

    const buckets = new Map<string, number>();
    for (const key of trendWin.keys) buckets.set(key, 0);
    for (const row of recentArticles) {
      const key = toShanghaiDateKey(row.createdAt);
      if (buckets.has(key)) {
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    }
    const trend5d = trendWin.keys.map((date) => {
      const writingCount = buckets.get(date) ?? 0;
      return {
        date,
        label: date.slice(5),
        writingCount,
        rewriteCount: 0,
        totalCount: writingCount,
      };
    });

    const announcements =
      announcementRows.length > 0
        ? announcementRows
        : DEFAULT_ANNOUNCEMENTS.map((item) => ({ ...item }));

    const visibilityEnabled =
      process.env.FEATURE_VISIBILITY?.trim().toLowerCase() === 'false'
        ? false
        : (() => {
            try {
              return readVisibilityConfig(process.env).featureEnabled;
            } catch {
              return true;
            }
          })();

    return {
      generatedAt: now.toISOString(),
      monthKey: monthWin.monthKey,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        expiresAt: tenant.expiresAt.toISOString(),
        isActive: tenant.isActive,
        readOnly,
      },
      features: {
        aiImage: env.FEATURE_AI_IMAGE,
        visibility: visibilityEnabled,
      },
      balanceCard: {
        balance: formatMoney(wallet.money.toString()),
        monthConsumed: moneySummary.consumed,
        monthRecharged: moneySummary.recharged,
        rechargeNotice: '如需调整额度请联系管理员。',
      },
      pointsCard: {
        billingMode: resolvedBilling.mode,
        billingModeSource: resolvedBilling.source,
        points: wallet.points,
        pointsReserved: wallet.pointsReserved,
        available: wallet.points - wallet.pointsReserved,
        monthConsumedPoints: pointSummary.actualConsumed,
        monthListPricePoints: pointSummary.listPriceConsumed,
        monthRechargedPoints: pointSummary.recharged,
        rechargeNotice: '如需充值点数请联系管理员。',
      },
      announcements,
      trend5d,
      stats: {
        brands: brandsCount,
        geoBriefs: geoBriefsCount,
        geoArticles: geoArticlesCount,
        brandMediaAssets: brandMediaAssetsCount,
        geoBatchJobs: geoBatchJobsCount,
      },
    };
  }
}
