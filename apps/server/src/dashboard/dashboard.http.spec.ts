import 'reflect-metadata';
import { shanghaiCurrentMonthWindowUtc, shanghaiFiveDayWindowUtc } from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import type { DashboardSummaryV1Stub } from './dashboard.service';

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

    it('reconciles monthly balance & points consumption, counts 5-day GeoArticle trend, and isolates tenants', async () => {
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

      await ctx.prisma.base.announcement.createMany({
        data: [
          { content: 'GeoMix 测试播报一：欢迎使用智能内容工作台', enabled: true, sort: 1 },
          { content: 'GeoMix 已停用播报：不应展示', enabled: false, sort: 2 },
        ],
      });

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
          {
            tenantId: actorA.tenantId,
            title: '上月扣费',
            amount: '-99.00',
            createdAt: priorMonthDate,
          },
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
            action: 'geo_write',
            title: 'GEO写作-测试任务',
            unitKey: 'dash_write_a1',
            delta: -10,
            listPrice: 10,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
          {
            tenantId: actorA.tenantId,
            action: 'inline_image_gen',
            title: '行内AI配图',
            unitKey: 'dash_img_a1',
            delta: -5,
            listPrice: 5,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
          {
            tenantId: actorA.tenantId,
            action: 'visibility_check',
            title: '上月监测',
            unitKey: 'dash_old_a1',
            delta: -2,
            listPrice: 2,
            status: 'SETTLED',
            createdAt: priorMonthDate,
          },
          {
            tenantId: actorB.tenantId,
            action: 'geo_write',
            title: 'GEO写作-影子（免费期）',
            unitKey: 'dash_shadow_b1',
            delta: 0,
            listPrice: 10,
            status: 'SETTLED',
            createdAt: inMonthDate,
          },
        ],
      });

      const brandA = await ctx.prisma.base.brand.create({
        data: {
          tenantId: actorA.tenantId,
          name: '对账品牌A',
          category: 'NAS',
          markets: {
            create: {
              tenantId: actorA.tenantId,
              market: 'CN',
              localBrandName: '对账品牌A',
              ownedDomains: ['brand-a.cn'],
            },
          },
        },
        include: { markets: true },
      });
      const brandB = await ctx.prisma.base.brand.create({
        data: {
          tenantId: actorB.tenantId,
          name: '对账品牌B',
          category: 'NAS',
          markets: {
            create: {
              tenantId: actorB.tenantId,
              market: 'CN',
              localBrandName: '对账品牌B',
              ownedDomains: ['brand-b.cn'],
            },
          },
        },
        include: { markets: true },
      });

      const shanghaiNoon = (ymd: string) => new Date(`${ymd}T12:00:00.000+08:00`);
      const sixDaysAgo = new Date(trendWin.startUtc.getTime() - 24 * 3600 * 1000);

      await ctx.prisma.base.geoArticle.createMany({
        data: [
          {
            tenantId: actorA.tenantId,
            brandId: brandA.id,
            brandMarketId: brandA.markets[0]!.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            title: '六天前文章',
            targetPrompt: '测试问题',
            contentMarkdown: '正文',
            contentHtml: '<p>正文</p>',
            createdAt: sixDaysAgo,
          },
          {
            tenantId: actorA.tenantId,
            brandId: brandA.id,
            brandMarketId: brandA.markets[0]!.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            title: 'D0写作一',
            targetPrompt: '测试问题',
            contentMarkdown: '正文',
            contentHtml: '<p>正文</p>',
            createdAt: shanghaiNoon(day0!),
          },
          {
            tenantId: actorA.tenantId,
            brandId: brandA.id,
            brandMarketId: brandA.markets[0]!.id,
            recipe: 'COMPARISON_MATRIX',
            targetFormat: 'CN_DEEP_REVIEW',
            title: 'D2写作一',
            targetPrompt: '测试问题',
            contentMarkdown: '正文',
            contentHtml: '<p>正文</p>',
            createdAt: shanghaiNoon(day2!),
          },
          {
            tenantId: actorB.tenantId,
            brandId: brandB.id,
            brandMarketId: brandB.markets[0]!.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            title: '租户B文章',
            targetPrompt: '测试问题',
            contentMarkdown: '正文',
            contentHtml: '<p>正文</p>',
            createdAt: shanghaiNoon(day4!),
          },
        ],
      });

      const dashResA = await httpCall<DashboardSummaryV1Stub>(
        ctx.base,
        'GET',
        '/api/v1/dashboard',
        {
          token: actorA.token,
        },
      );
      expect(dashResA.status).toBe(200);
      const summaryA = dashResA.data;

      expect(summaryA.balanceCard.balance).toBe('360.50');
      expect(summaryA.balanceCard.monthConsumed).toBe('139.50');
      expect(summaryA.balanceCard.monthRecharged).toBe('500.00');
      expect(summaryA.pointsCard).toMatchObject({
        billingMode: 'STRICT',
        points: 880,
        pointsReserved: 30,
        available: 850,
        monthConsumedPoints: 15,
        monthListPricePoints: 15,
        monthRechargedPoints: 200,
      });

      expect(summaryA.trend5d).toHaveLength(5);
      expect(summaryA.trend5d.map((d) => d.date)).toEqual([day0, day1, day2, day3, day4]);
      expect(summaryA.trend5d.map((d) => d.writingCount)).toEqual([1, 0, 1, 0, 0]);
      expect(summaryA.stats.brands).toBe(1);
      expect(summaryA.stats.geoArticles).toBe(3);

      const dashResB = await httpCall<DashboardSummaryV1Stub>(
        ctx.base,
        'GET',
        '/api/v1/dashboard',
        {
          token: actorB.token,
        },
      );
      expect(dashResB.status).toBe(200);
      expect(dashResB.data.pointsCard.billingMode).toBe('SHADOW');
      expect(dashResB.data.pointsCard.monthConsumedPoints).toBe(0);
      expect(dashResB.data.pointsCard.monthListPricePoints).toBe(10);
      expect(dashResB.data.stats.geoArticles).toBe(1);
    });
  },
);
