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
});
