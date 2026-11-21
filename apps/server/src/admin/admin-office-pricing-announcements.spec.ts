import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminOfficeService } from './admin-office.service';

describe('AdminOfficeService pricing batch & announcement CRUD (#196, #199)', () => {
  it('lists prices with Chinese labels, units, and descriptions, and updates multiple items atomically (#196)', async () => {
    const rows = [
      {
        action: 'geo_write',
        unitPoints: 10,
        enabled: true,
        updatedAt: new Date('2026-11-18T00:00:00.000Z'),
      },
      {
        action: 'inline_image_gen',
        unitPoints: 5,
        enabled: true,
        updatedAt: new Date('2026-11-18T00:00:00.000Z'),
      },
    ];
    const update = vi.fn().mockImplementation(async ({ where, data }) => {
      const target = rows.find((r) => r.action === where.action);
      if (target) {
        target.unitPoints = data.unitPoints;
        target.enabled = data.enabled;
      }
      return target;
    });
    const upsert = vi.fn().mockImplementation(async ({ where, create }) => {
      rows.push({
        action: where.action,
        unitPoints: create.unitPoints,
        enabled: create.enabled,
        updatedAt: new Date('2026-11-18T00:05:00.000Z'),
      });
      return rows[rows.length - 1];
    });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'aud-1' });

    const prisma = {
      base: {
        pricingItem: {
          findMany: vi.fn().mockImplementation(async () => [...rows]),
          createMany: vi.fn().mockResolvedValue({ count: 5 }),
        },
        auditLog: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        $transaction: vi.fn().mockImplementation(async (fn) =>
          fn({
            pricingItem: { update, upsert },
            auditLog: { create: auditCreate },
          }),
        ),
      },
    } as unknown as PrismaService;

    const service = new AdminOfficeService(prisma, {} as BillingService);

    const listed = await service.listPrices();
    expect(listed.items.find((item) => item.action === 'geo_write')).toMatchObject({
      action: 'geo_write',
      label: 'GEO 靶向写作',
      unit: '点/篇',
    });
    expect(listed.items.find((item) => item.action === 'inline_image_gen')).toMatchObject({
      action: 'inline_image_gen',
      label: '行内 AI 配图',
      unit: '点/张',
    });

    const updated = await (
      service as unknown as {
        updatePrices: (
          actor: { userId: string; role: 'ADMIN' | 'MERCHANT' },
          input: { items: Array<{ action: string; unitPoints: number; enabled: boolean }> },
          idempotencyKey?: string,
        ) => Promise<{ items: Array<{ action: string; unitPoints: number; enabled: boolean }> }>;
      }
    ).updatePrices(
      { userId: 'admin-1', role: 'ADMIN' },
      {
        items: [
          { action: 'geo_write', unitPoints: 12, enabled: true },
          { action: 'inline_image_gen', unitPoints: 8, enabled: false },
        ],
      },
      'batch_key_0001',
    );

    expect(updated.items.find((item) => item.action === 'geo_write')?.unitPoints).toBe(12);
    expect(updated.items.find((item) => item.action === 'inline_image_gen')).toMatchObject({
      unitPoints: 8,
      enabled: false,
    });
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown/legacy pricing actions with 400/40001 and non-admin callers with 404 in updatePrices (#196)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        action: 'kb_addon',
        unitPoints: 5,
        enabled: true,
        updatedAt: new Date('2026-11-18T00:00:00.000Z'),
      },
    ]);
    const transaction = vi.fn();
    const prisma = {
      base: {
        pricingItem: {
          findMany,
        },
        auditLog: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        $transaction: transaction,
      },
    } as unknown as PrismaService;

    const service = new AdminOfficeService(prisma, {} as BillingService);
    const updatePrices = (
      service as unknown as {
        updatePrices: (
          actor: { userId: string; role: 'ADMIN' | 'MERCHANT' },
          input: { items: Array<{ action: string; unitPoints: number; enabled: boolean }> },
        ) => Promise<unknown>;
      }
    ).updatePrices.bind(service);

    await expect(
      updatePrices(
        { userId: 'merchant-1', role: 'MERCHANT' },
        { items: [{ action: 'geo_write', unitPoints: 10, enabled: true }] },
      ),
    ).rejects.toMatchObject({ status: 404 });

    for (const action of ['unknown_action', 'kb_addon', 'ai_write', 'distill']) {
      const error = await updatePrices(
        { userId: 'admin-1', role: 'ADMIN' },
        { items: [{ action, unitPoints: 10, enabled: true }] },
      ).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 400, code: 40001 });
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects legacy/unknown pricing actions in updatePrice with 400/40001 even if a stale DB row exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      action: 'kb_addon',
      unitPoints: 5,
      enabled: true,
      updatedAt: new Date('2026-11-18T00:00:00.000Z'),
    });
    const transaction = vi.fn();
    const prisma = {
      base: {
        pricingItem: {
          findUnique,
        },
        auditLog: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        $transaction: transaction,
      },
    } as unknown as PrismaService;

    const service = new AdminOfficeService(prisma, {} as BillingService);
    const updatePrice = (
      service as unknown as {
        updatePrice: (
          actor: { userId: string; role: 'ADMIN' | 'MERCHANT' },
          input: { action: string; unitPoints: number; enabled: boolean },
        ) => Promise<unknown>;
      }
    ).updatePrice.bind(service);

    await expect(
      updatePrice(
        { userId: 'merchant-1', role: 'MERCHANT' },
        { action: 'geo_write', unitPoints: 10, enabled: true },
      ),
    ).rejects.toMatchObject({ status: 404 });

    for (const action of ['kb_addon', 'ai_write', 'distill', 'unknown_action']) {
      const error = await updatePrice(
        { userId: 'admin-1', role: 'ADMIN' },
        { action, unitPoints: 5, enabled: true },
      ).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 400, code: 40001 });
    }
    expect(findUnique).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('records operatorName and createdAt on announcement create/update and deletes with audit (#199)', async () => {
    const createdAt = new Date('2026-11-18T00:05:09.000Z');
    const updatedAt = new Date('2026-11-18T00:10:00.000Z');
    const stored = {
      id: 'ann-1',
      content: 'GeoMix 公告',
      enabled: true,
      sort: 0,
      operatorId: 'admin-1',
      operatorName: '管理员 (admin)',
      createdAt,
      updatedAt: createdAt,
    };

    const deleteMock = vi.fn().mockResolvedValue(stored);
    const auditCreate = vi.fn().mockResolvedValue({ id: 'aud-1' });

    const prisma = {
      base: {
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: 'admin', nickname: '管理员' }),
        },
        announcement: {
          create: vi.fn().mockResolvedValue(stored),
          findUnique: vi.fn().mockResolvedValue(stored),
          update: vi.fn().mockResolvedValue({
            ...stored,
            content: 'GeoMix 公告已修改',
            updatedAt,
          }),
          delete: deleteMock,
        },
        auditLog: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: auditCreate,
        },
        $transaction: vi.fn().mockImplementation(async (fn) =>
          fn({
            announcement: { delete: deleteMock },
            auditLog: { create: auditCreate },
          }),
        ),
      },
    } as unknown as PrismaService;

    const service = new AdminOfficeService(prisma, {} as BillingService);

    const created = await service.createAnnouncement(
      { userId: 'admin-1', role: 'ADMIN' },
      { content: 'GeoMix 公告', enabled: true, sort: 0 },
    );
    expect(created).toMatchObject({
      id: 'ann-1',
      content: 'GeoMix 公告',
      operatorId: 'admin-1',
      operatorName: '管理员 (admin)',
      createdAt: '2026-11-18T00:05:09.000Z',
    });

    const updated = await service.updateAnnouncement(
      { userId: 'admin-1', role: 'ADMIN' },
      'ann-1',
      { content: 'GeoMix 公告已修改', enabled: true, sort: 0 },
    );
    expect(updated).toMatchObject({
      id: 'ann-1',
      content: 'GeoMix 公告已修改',
      operatorName: '管理员 (admin)',
      createdAt: '2026-11-18T00:05:09.000Z',
      updatedAt: '2026-11-18T00:10:00.000Z',
    });

    const deleted = await (
      service as unknown as {
        deleteAnnouncement: (
          actor: { userId: string; role: 'ADMIN' | 'MERCHANT' },
          id: string,
        ) => Promise<{ deleted: boolean; id: string }>;
      }
    ).deleteAnnouncement({ userId: 'admin-1', role: 'ADMIN' }, 'ann-1');
    expect(deleted).toEqual({ deleted: true, id: 'ann-1' });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'ann-1' } });
  });
});
