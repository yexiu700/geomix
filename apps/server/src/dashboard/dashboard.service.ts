import { Inject, Injectable } from '@nestjs/common';
import {
  AUTH_ERROR,
  DASHBOARD_DEFAULT_ANNOUNCEMENTS,
  DASHBOARD_RECHARGE_NOTICE,
  aggregateCreationTrend5Days,
  formatMoney,
  parseEnv,
  resolveTenantBillingMode,
  shanghaiCurrentMonthWindowUtc,
  shanghaiFiveDayWindowUtc,
  summarizeMonthMoney,
  summarizeMonthPoints,
  type DashboardSummary,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { readVisibilityConfig } from '../visibility/visibility.config';

@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async summary(tenantId: string, now: Date = new Date()): Promise<DashboardSummary> {
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
      keywordsCount,
      questionsCount,
      mediaAssetsCount,
      knowledgeBasesCount,
      promptsCount,
      articleCategoriesCount,
      aiTasksCount,
      articlesCount,
      rewriteSingleCount,
      rewriteBatchesCount,
      aiImagesCount,
    ] = await Promise.all([
      this.prisma.base.pointLog.findMany({
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
      this.prisma.base.moneyLog.findMany({
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
      this.prisma.base.article.findMany({
        where: {
          tenantId,
          source: { in: ['AI_TASK', 'REWRITE_SINGLE', 'REWRITE_BATCH'] },
          createdAt: {
            gte: trendWin.startUtc,
            lte: trendWin.endUtc,
          },
        },
        select: {
          source: true,
          createdAt: true,
        },
      }),
      this.prisma.base.announcement.findMany({
        where: { enabled: true },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        select: { id: true, content: true, sort: true },
      }),
      this.prisma.base.keyword.count({ where: { tenantId } }),
      this.prisma.base.question.count({ where: { tenantId } }),
      this.prisma.base.mediaAsset.count({
        where: { tenantId, categoryId: { not: null } },
      }),
      this.prisma.base.knowledgeBase.count({ where: { tenantId } }),
      this.prisma.base.promptTemplate.count({ where: { tenantId } }),
      this.prisma.base.articleCategory.count({ where: { tenantId } }),
      this.prisma.base.aiTask.count({ where: { tenantId } }),
      this.prisma.base.article.count({ where: { tenantId } }),
      this.prisma.base.rewriteRecord.count({ where: { tenantId, batchId: null } }),
      this.prisma.base.rewriteBatch.count({ where: { tenantId } }),
      this.prisma.base.aiImageJob.count({ where: { tenantId } }),
    ]);

    const pointSummary = summarizeMonthPoints(monthPointLogs);
    const moneySummary = summarizeMonthMoney(
      monthMoneyLogs.map((row) => ({ amount: row.amount.toString() })),
    );
    const trend5d = aggregateCreationTrend5Days(recentArticles, now);
    const announcements =
      announcementRows.length > 0
        ? announcementRows
        : DASHBOARD_DEFAULT_ANNOUNCEMENTS.map((item) => ({ ...item }));

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
        rechargeNotice: DASHBOARD_RECHARGE_NOTICE.money,
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
        rechargeNotice: DASHBOARD_RECHARGE_NOTICE.points,
      },
      announcements,
      trend5d,
      stats: {
        keywords: keywordsCount,
        questions: questionsCount,
        mediaAssets: mediaAssetsCount,
        knowledgeBases: knowledgeBasesCount,
        prompts: promptsCount,
        articleCategories: articleCategoriesCount,
        aiTasks: aiTasksCount,
        articles: articlesCount,
        rewriteSingle: rewriteSingleCount,
        rewriteBatches: rewriteBatchesCount,
        aiImages: aiImagesCount,
      },
    };
  }
}
