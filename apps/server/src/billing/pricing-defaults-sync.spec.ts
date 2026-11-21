import { PRICING_DEFAULTS } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import { AdminOfficeService } from '../admin/admin-office.service';
import type { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';

describe('Pricing defaults backfill (#99)', () => {
  it('BillingService.listPrices merges and backfills missing visibility_check when DB only has Phase-1 rows', async () => {
    const phase1Rows = PRICING_DEFAULTS.filter((item) => item.action !== 'visibility_check').map(
      (item) => ({
        action: item.action,
        unitPoints: item.unitPoints,
        enabled: true,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      base: {
        pricingItem: {
          findMany: vi.fn().mockResolvedValue(phase1Rows),
          createMany,
        },
      },
    } as unknown as PrismaService;

    const service = new BillingService(prisma, {
      globalMode: () => 'SHADOW',
      orphanAfterMs: 60_000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const prices = await service.listPrices();
    const visibilityItem = prices.find((item) => item.action === 'visibility_check');
    expect(visibilityItem).toEqual({
      action: 'visibility_check',
      unitPoints: 2,
      enabled: true,
      label: 'AI可见性监测',
    });
    expect(prices.map((item) => item.action)).toEqual(
      [...PRICING_DEFAULTS.map((item) => item.action)].sort((a, b) => a.localeCompare(b)),
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [{ action: 'visibility_check', unitPoints: 2, enabled: true }],
      skipDuplicates: true,
    });
  });

  it('BillingService.listPrices preserves explicit disabled state when visibility_check already exists in DB', async () => {
    const allRows = PRICING_DEFAULTS.map((item) => ({
      action: item.action,
      unitPoints: item.action === 'visibility_check' ? 5 : item.unitPoints,
      enabled: item.action !== 'visibility_check',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    const createMany = vi.fn();
    const prisma = {
      base: {
        pricingItem: {
          findMany: vi.fn().mockResolvedValue(allRows),
          createMany,
        },
      },
    } as unknown as PrismaService;

    const service = new BillingService(prisma, {
      globalMode: () => 'SHADOW',
      orphanAfterMs: 60_000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const prices = await service.listPrices();
    expect(prices.find((item) => item.action === 'visibility_check')).toEqual({
      action: 'visibility_check',
      unitPoints: 5,
      enabled: false,
      label: 'AI可见性监测',
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('AdminOfficeService.listPrices also backfills missing visibility_check', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      base: {
        pricingItem: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany,
        },
      },
    } as unknown as PrismaService;

    const admin = new AdminOfficeService(prisma, {} as BillingService);
    const result = await admin.listPrices();
    expect(result.items.find((item) => item.action === 'visibility_check')).toMatchObject({
      action: 'visibility_check',
      unitPoints: 2,
      enabled: true,
    });
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('BillingService.quoteGeoWrite falls back to PRICING_DEFAULTS when geo_write row is absent and rejects explicit enabled=false', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = {
      base: {
        pricingItem: {
          findUnique,
        },
      },
    } as unknown as PrismaService;

    const service = new BillingService(prisma, {
      globalMode: () => 'SHADOW',
      orphanAfterMs: 60_000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const fallbackQuote = await service.quoteGeoWrite({ count: 3, taskName: '缺省回退测试' });
    expect(fallbackQuote).toEqual({
      count: 3,
      unitPrice: 10,
      total: 30,
      lines: [{ action: 'geo_write', listPrice: 10, title: 'GEO写作-缺省回退测试' }],
    });

    findUnique.mockResolvedValueOnce({
      action: 'geo_write',
      unitPoints: 15,
      enabled: true,
    });
    const customQuote = await service.quoteGeoWrite({ count: 2 });
    expect(customQuote.unitPrice).toBe(15);
    expect(customQuote.total).toBe(30);

    findUnique.mockResolvedValueOnce({
      action: 'geo_write',
      unitPoints: 10,
      enabled: false,
    });
    await expect(service.quoteGeoWrite({ count: 1 })).rejects.toMatchObject({
      status: 400,
      message: 'GEO写作价格未启用',
    });
  });

  it('BillingService.settleGeoWriteUnit clamps long CN/GLOBAL/CITATION_COUNTER titles to <= 80 chars and passes normalizeLines', async () => {
    const settledTitles: string[] = [];
    const prisma = {
      base: {
        $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
      },
    } as unknown as PrismaService;

    const service = new BillingService(prisma, {
      globalMode: () => 'SHADOW',
      orphanAfterMs: 60_000,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
    });

    vi.spyOn(
      service as unknown as {
        settleIn: (
          tx: unknown,
          request: {
            tenantId: string;
            reservationId: string;
            unitKey: string;
            lines: Array<{ title: string; action: string; listPrice: number }>;
          },
        ) => Promise<{
          reservation: {
            id: string;
            tenantId: string;
            refType: string;
            refId: string;
            shadow: boolean;
            frozen: number;
            settled: number;
            released: number;
            status: 'OPEN' | 'CLOSED';
          };
          lines: Array<{
            id: string;
            action: string;
            reason: string;
            title: string;
            unitKey: string;
            delta: number;
            listPrice: number;
            balanceAfter: number | null;
            status: 'SETTLED';
            detail: null;
            createdAt: string;
          }>;
          replayed: boolean;
        }>;
      },
      'settleIn',
    ).mockImplementation(async (_tx, request) => {
      for (const line of request.lines) {
        settledTitles.push(line.title);
      }
      return {
        reservation: {
          id: request.reservationId,
          tenantId: request.tenantId,
          refType: 'geo_article',
          refId: 'art_ref',
          shadow: true,
          frozen: 10,
          settled: 10,
          released: 0,
          status: 'CLOSED',
        },
        lines: request.lines.map((line, i) => ({
          id: `log_${i}`,
          action: line.action,
          reason: line.action,
          title: line.title,
          unitKey: request.unitKey,
          delta: 0,
          listPrice: line.listPrice,
          balanceAfter: null,
          status: 'SETTLED',
          detail: null,
          createdAt: '2026-11-21T00:00:00.000Z',
        })),
        replayed: false,
      };
    });

    const longSubjects = [
      // GLOBAL > 74 chars
      'Best 私有云 NAS 2026 Buying Guide: AstraVault f12t4-1763738000 Top-Rated Review & Comparison',
      // CN > 74 chars
      '2026年家用静音四盘位私有云NAS深度横向实测对比指南：星辰存储DXP4800与主流竞品在满载噪音、待机功耗、扩展能力及数据安全维度全面解析',
      // CITATION_COUNTER > 74 chars
      '反制高引用信源评测：针对竞品权威媒体榜单页面的 2026 实测参数超越与全场景对比指南（含客观优缺点与真实用户案例数据核验）',
    ];

    for (const [idx, subject] of longSubjects.entries()) {
      const result = await service.settleGeoWriteUnit({
        tenantId: 'tenant_1',
        reservationId: `res_${idx}`,
        unitKey: `article:art_${idx}`,
        subject,
        geoWritePoints: 10,
      });
      expect(result.reservation.settled).toBe(10);
      expect(result.lines[0]?.title.length).toBeLessThanOrEqual(80);
    }

    expect(settledTitles).toHaveLength(longSubjects.length);
    for (const title of settledTitles) {
      expect(title.startsWith('GEO写作-')).toBe(true);
      expect(title.length).toBeGreaterThanOrEqual(7);
      expect(title.length).toBeLessThanOrEqual(80);
    }
  });
});
