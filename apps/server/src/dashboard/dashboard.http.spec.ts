import 'reflect-metadata';
import {
  DASHBOARD_TREND_DAYS,
  shanghaiCurrentMonthWindowUtc,
  shanghaiFiveDayWindowUtc,
  type DashboardSummary,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'dashboard HTTP aggregation & detail reconciliation against isolated Postgres',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('dashboard');
    });

    afterAll(async () => {
      await ctx.close();
    });

    it('reconciles monthly balance & points consumption with /me/points and /me/money, counts strict 5-day trend by day, and isolates tenants', async () => {
      const actorA = await ctx.createTenantUser({
        prefix: 'dash_a',
        points: 880,
        billingMode: 'STRICT',
      });
      const actorB = await ctx.createTenantUser({
        prefix: 'dash_b',
        points: 500,
        billingMode: 'SHADOW',
      });

      const now = new Date();
      const monthWin = shanghaiCurrentMonthWindowUtc(now);
      const trendWin = shanghaiFiveDayWindowUtc(now);
      const [day0, day1, day2, day3, day4] = trendWin.keys;

      // Seed custom enabled & disabled announcements
      await ctx.prisma.base.announcement.createMany({
        data: [
          { content: 'GeoMix 测试播报一：欢迎使用智能内容工作台', enabled: true, sort: 1 },
          { content: 'GeoMix 已停用播报：不应展示', enabled: false, sort: 2 },
        ],
      });

      // Seed wallet balance + current-month & prior-month MoneyLog + PointLog for Tenant A
      await ctx.prisma.base.wallet.update({
        where: { tenantId: actorA.tenantId },
        data: {
          money: '360.50',
          points: 880,
          pointsReserved: 30,
        },
      });

      const priorMonthDate = new Date(monthWin.startUtc.getTime() - 48 * 3600 * 1000);
      const inMonthDate = new Date(monthWin.startUtc.getTime() + 1000);

      await ctx.prisma.base.moneyLog.createMany({
        data: [
          {
            tenantId: actorA.tenantId,
            title: '账户开通充值',
            amount: '500.00',
            remark: '管理员入账',
            createdAt: inMonthDate,
          },
          {
            tenantId: actorA.tenantId,
            title: '定制服务扣费',
            amount: '-139.50',
            remark: '月度结算',
            createdAt: inMonthDate,
          },
          // Prior month log (should NOT count in current monthConsumed)
          {
            tenantId: actorA.tenantId,
            title: '上月扣费',
            amount: '-99.00',
            createdAt: priorMonthDate,
          },
          // Other tenant log (should NOT leak into Tenant A)
          {
            tenantId: actorB.tenantId,
            title: '其他租户扣费',
            amount: '-88.00',
            createdAt: inMonthDate,
          },
        ],
      });

      await ctx.prisma.base.pointLog.createMany({
        data: [
          {
            tenantId: actorA.tenantId,
            action: 'admin_topup',
            title: '管理员充值',
            unitKey: 'dash_topup_a1',
            delta: 200,
            listPrice: 0,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
          {
            tenantId: actorA.tenantId,
            action: 'ai_write',
            title: 'AI写作-测试任务',
            unitKey: 'dash_write_a1',
            delta: -15,
            listPrice: 15,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
          {
            tenantId: actorA.tenantId,
            action: 'rewrite_single',
            title: '全网爆文复刻',
            unitKey: 'dash_rw_a1',
            delta: -5,
            listPrice: 5,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
          // Prior month point log (excluded)
          {
            tenantId: actorA.tenantId,
            action: 'distill',
            title: '上月蒸馏',
            unitKey: 'dash_old_a1',
            delta: -10,
            listPrice: 10,
            status: 'SETTLED',
            createdAt: priorMonthDate,
          },
          // Tenant B shadow-mode consumption (delta=0, listPrice=15)
          {
            tenantId: actorB.tenantId,
            action: 'ai_write',
            title: 'AI写作-影子（免费期）',
            unitKey: 'dash_shadow_b1',
            delta: 0,
            listPrice: 15,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
        ],
      });

      // Seed Articles across the 5-day window + 1 manual + 1 older than 5 days
      const cat = await ctx.prisma.base.articleCategory.create({
        data: { tenantId: actorA.tenantId, name: '首页对账分类' },
      });
      const shanghaiNoon = (ymd: string) => new Date(`${ymd}T12:00:00.000+08:00`);
      const sixDaysAgo = new Date(trendWin.startUtc.getTime() - 24 * 3600 * 1000);

      await ctx.prisma.base.article.createMany({
        data: [
          // Older than 5 days -> excluded from trend5d, included in total articles stat
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: '六天前文章',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'AI_TASK',
            status: 'NORMAL',
            createdAt: sixDaysAgo,
          },
          // day0: 1 AI_TASK
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: 'D0写作一',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'AI_TASK',
            status: 'NORMAL',
            createdAt: shanghaiNoon(day0!),
          },
          // day2: 2 AI_TASK + 1 REWRITE_SINGLE
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: 'D2写作一',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'AI_TASK',
            status: 'NORMAL',
            createdAt: shanghaiNoon(day2!),
          },
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: 'D2写作二',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'AI_TASK',
            status: 'NORMAL',
            createdAt: shanghaiNoon(day2!),
          },
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: 'D2单篇复刻',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'REWRITE_SINGLE',
            status: 'PENDING',
            createdAt: shanghaiNoon(day2!),
          },
          // day4 (today): 1 REWRITE_BATCH + 1 MANUAL (manual excluded from AI trend)
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: 'D4批量复刻',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'REWRITE_BATCH',
            status: 'PENDING',
            createdAt: shanghaiNoon(day4!),
          },
          {
            tenantId: actorA.tenantId,
            categoryId: cat.id,
            title: 'D4手工撰稿',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'MANUAL',
            status: 'NORMAL',
            createdAt: shanghaiNoon(day4!),
          },
          // Tenant B article on day4 -> isolated from Tenant A
          {
            tenantId: actorB.tenantId,
            title: '租户B文章',
            contentHtml: '<p>正文</p>',
            contentText: '正文',
            source: 'AI_TASK',
            status: 'NORMAL',
            createdAt: shanghaiNoon(day4!),
          },
        ],
      });

      const dashResA = await httpCall<DashboardSummary>(ctx.base, 'GET', '/api/v1/dashboard', {
        token: actorA.token,
      });
      expect(dashResA.status).toBe(200);
      const summaryA = dashResA.data;

      // 1. Balance card matches /me/money
      expect(summaryA.balanceCard.balance).toBe('360.50');
      expect(summaryA.balanceCard.monthConsumed).toBe('139.50');
      expect(summaryA.balanceCard.monthRecharged).toBe('500.00');

      const moneyLedgerRes = await httpCall<{
        total: number;
        items: Array<{ amount: string }>;
      }>(
        ctx.base,
        'GET',
        `/api/v1/me/money?page=1&pageSize=50&filter=${encodeURIComponent(
          JSON.stringify({
            from: monthWin.startUtc.toISOString(),
            to: new Date(monthWin.endUtc.getTime() - 1).toISOString(),
          }),
        )}`,
        { token: actorA.token },
      );
      expect(moneyLedgerRes.status).toBe(200);
      const ledgerNegativeSum = moneyLedgerRes.data.items
        .map((r) => Number(r.amount))
        .filter((n) => n < 0)
        .reduce((acc, n) => acc + Math.abs(n), 0)
        .toFixed(2);
      expect(summaryA.balanceCard.monthConsumed).toBe(ledgerNegativeSum);

      // 2. Points card matches /me/points
      expect(summaryA.pointsCard).toMatchObject({
        billingMode: 'STRICT',
        points: 880,
        pointsReserved: 30,
        available: 850,
        monthConsumedPoints: 20,
        monthListPricePoints: 20,
        monthRechargedPoints: 200,
      });

      const pointsLedgerRes = await httpCall<{
        total: number;
        items: Array<{ delta: number; listPrice: number }>;
      }>(
        ctx.base,
        'GET',
        `/api/v1/me/points?page=1&pageSize=50&filter=${encodeURIComponent(
          JSON.stringify({
            from: monthWin.startUtc.toISOString(),
            to: new Date(monthWin.endUtc.getTime() - 1).toISOString(),
          }),
        )}`,
        { token: actorA.token },
      );
      expect(pointsLedgerRes.status).toBe(200);
      const ledgerPointsConsumed = pointsLedgerRes.data.items
        .filter((r) => r.delta < 0)
        .reduce((acc, r) => acc + Math.abs(r.delta), 0);
      expect(summaryA.pointsCard.monthConsumedPoints).toBe(ledgerPointsConsumed);

      // 3. Strictly 5-day trend by day matching detail articles
      expect(summaryA.trend5d).toHaveLength(DASHBOARD_TREND_DAYS);
      expect(summaryA.trend5d.map((d) => d.date)).toEqual([day0, day1, day2, day3, day4]);
      expect(summaryA.trend5d.map((d) => ({ w: d.writingCount, r: d.rewriteCount }))).toEqual([
        { w: 1, r: 0 },
        { w: 0, r: 0 },
        { w: 2, r: 1 },
        { w: 0, r: 0 },
        { w: 0, r: 1 },
      ]);

      // Total articles stat matches /api/v1/articles total (7 articles for Tenant A)
      const articlesListRes = await httpCall<{ total: number }>(
        ctx.base,
        'GET',
        '/api/v1/articles?page=1&pageSize=25',
        { token: actorA.token },
      );
      expect(summaryA.stats.articles).toBe(7);
      expect(summaryA.stats.articles).toBe(articlesListRes.data.total);
      expect(summaryA.stats.articleCategories).toBe(1);

      // 4. Announcements only include enabled items
      expect(summaryA.announcements.some((a) => a.content.includes('欢迎使用智能内容工作台'))).toBe(
        true,
      );
      expect(summaryA.announcements.some((a) => a.content.includes('不应展示'))).toBe(false);

      // 5. Tenant B (SHADOW mode) sees its own 0 actual / 15 listPrice consumption & 1 AI_TASK article
      const dashResB = await httpCall<DashboardSummary>(ctx.base, 'GET', '/api/v1/dashboard', {
        token: actorB.token,
      });
      expect(dashResB.status).toBe(200);
      expect(dashResB.data.pointsCard.billingMode).toBe('SHADOW');
      expect(dashResB.data.pointsCard.monthConsumedPoints).toBe(0);
      expect(dashResB.data.pointsCard.monthListPricePoints).toBe(15);
      expect(dashResB.data.stats.articles).toBe(1);

      // 6. Expired tenant can still read GET /api/v1/dashboard (readOnly = true)
      const expiredActor = await ctx.createTenantUser({
        prefix: 'dash_exp',
        expired: true,
      });
      const expRes = await httpCall<DashboardSummary>(ctx.base, 'GET', '/api/v1/dashboard', {
        token: expiredActor.token,
      });
      expect(expRes.status).toBe(200);
      expect(expRes.data.tenant.readOnly).toBe(true);
    });
  },
);
