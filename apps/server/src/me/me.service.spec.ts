import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseMoneyListQuery, parsePointListQuery } from '@geomix/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';

describe('MeService.rights quota reconciliation (#195)', () => {
  it('reconciles drifted AI_WRITE and STORAGE_BYTES quota values from actual AI_TASK articles and MediaAssets', async () => {
    const prisma = {
      base: {
        tenant: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'tenant_1',
            expiresAt: new Date('2027-11-16T00:00:00.000Z'),
            billingMode: null,
          }),
        },
        wallet: {
          findUnique: vi.fn().mockResolvedValue({
            points: 1000,
            money: { toString: () => '0.00' },
          }),
        },
        quota: {
          findMany: vi.fn().mockResolvedValue([
            { key: 'MAIN_KEYWORD', used: 2n, limit: 100n },
            { key: 'QUESTION', used: 3n, limit: 10_000n },
            { key: 'AI_WRITE', used: 0n, limit: 10_000n },
            { key: 'STORAGE_BYTES', used: 0n, limit: 100n * 1024n * 1024n },
            { key: 'PUBLISH', used: 0n, limit: 10_000n },
            { key: 'SOCIAL_AUTH', used: 0n, limit: 100n },
          ]),
        },
        brand: {
          count: vi.fn().mockResolvedValue(2),
        },
        geoBrief: {
          count: vi.fn().mockResolvedValue(3),
        },
        geoArticle: {
          count: vi.fn().mockResolvedValue(1),
        },
        brandMediaAsset: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { bytes: 5120 } }),
        },
        visibilityObservation: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as unknown as PrismaService;

    const service = new MeService(prisma);
    const rights = await service.rights('tenant_1');

    expect(rights.cards.find((c) => c.key === 'MAIN_KEYWORD')?.text).toBe('2 / 100');
    expect(rights.cards.find((c) => c.key === 'QUESTION')?.text).toBe('3 / 10000');
    expect(rights.cards.find((c) => c.key === 'AI_WRITE')?.text).toBe('1 / 10000');
    expect(rights.cards.find((c) => c.key === 'STORAGE_BYTES')?.text).toBe('5 KB / 100 MB');
  });

  it('preserves higher stored quota values (e.g. cumulative AI_WRITE after article deletion or seeded STORAGE_BYTES)', async () => {
    const prisma = {
      base: {
        tenant: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'tenant_2',
            expiresAt: new Date('2027-11-16T00:00:00.000Z'),
            billingMode: null,
          }),
        },
        wallet: {
          findUnique: vi.fn().mockResolvedValue({
            points: 1500,
            money: { toString: () => '0.00' },
          }),
        },
        quota: {
          findMany: vi.fn().mockResolvedValue([
            { key: 'MAIN_KEYWORD', used: 0n, limit: 100n },
            { key: 'QUESTION', used: 0n, limit: 10_000n },
            { key: 'AI_WRITE', used: 4n, limit: 10_000n },
            { key: 'STORAGE_BYTES', used: 2048n, limit: 100n * 1024n * 1024n },
            { key: 'PUBLISH', used: 0n, limit: 10_000n },
            { key: 'SOCIAL_AUTH', used: 0n, limit: 100n },
          ]),
        },
        brand: {
          count: vi.fn().mockResolvedValue(0),
        },
        geoBrief: {
          count: vi.fn().mockResolvedValue(0),
        },
        geoArticle: {
          count: vi.fn().mockResolvedValue(1),
        },
        brandMediaAsset: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { bytes: null } }),
        },
        visibilityObservation: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as unknown as PrismaService;

    const service = new MeService(prisma);
    const rights = await service.rights('tenant_2');

    expect(rights.cards.find((c) => c.key === 'AI_WRITE')?.text).toBe('4 / 10000');
    expect(rights.cards.find((c) => c.key === 'STORAGE_BYTES')?.text).toBe('2 KB / 100 MB');
  });

  it('sanitizes CoT reasoning leakage from historical PointLog and MoneyLog records (#201)', async () => {
    const prisma = {
      base: {
        pointLog: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'pt_1',
              title: 'AI生图-用户需要把简短描述扩写成配图提示词，80-220（免费期）',
              delta: 0,
              listPrice: 10,
              createdAt: new Date('2026-11-18T02:00:00.000Z'),
              status: 'SETTLED',
            },
          ]),
        },
        moneyLog: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'ml_1',
              title: 'AI生图-<think>内部推理</think>（免费期）',
              amount: { toString: () => '12.50' },
              remark: '影子计费测试备注',
              createdAt: new Date('2026-11-18T02:00:00.000Z'),
            },
          ]),
        },
      },
    } as unknown as PrismaService;

    const service = new MeService(prisma);
    const pointsPage = await service.points('tenant_1', parsePointListQuery({}));
    expect(pointsPage.items[0]?.title).toBe('AI生图（免费期）');
    expect(pointsPage.items[0]?.phrase).toBe('0 AI生图（免费期）');
    expect(pointsPage.items[0]?.pointsText).toBe('0（原价 10）');

    const moneyPage = await service.money('tenant_1', parseMoneyListQuery({}));
    expect(moneyPage.items[0]?.title).toBe('AI生图（免费期）');
    expect(moneyPage.items[0]?.remark).toBe('免费体验期测试备注');
  });

  it('reconciles MAIN_KEYWORD brand quota strictly to live brand count after deletions (#430)', async () => {
    const prisma = {
      base: {
        tenant: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'tenant_3',
            expiresAt: new Date('2027-11-16T00:00:00.000Z'),
            billingMode: 'STRICT',
          }),
        },
        wallet: {
          findUnique: vi.fn().mockResolvedValue({
            points: 1000,
            pointsReserved: 0,
            money: { toString: () => '0.00' },
          }),
        },
        quota: {
          findMany: vi.fn().mockResolvedValue([
            { key: 'MAIN_KEYWORD', used: 5n, limit: 100n },
            { key: 'AI_WRITE', used: 4n, limit: 10_000n },
          ]),
        },
        brand: { count: vi.fn().mockResolvedValue(3) },
        geoBrief: { count: vi.fn().mockResolvedValue(0) },
        geoArticle: { count: vi.fn().mockResolvedValue(1) },
        brandMediaAsset: { aggregate: vi.fn().mockResolvedValue({ _sum: { bytes: 0 } }) },
        visibilityObservation: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as unknown as PrismaService;

    const service = new MeService(prisma);
    const rights = await service.rights('tenant_3');
    expect(rights.cards.find((c) => c.key === 'MAIN_KEYWORD')?.text).toBe('3 / 100');
    expect(rights.cards.find((c) => c.key === 'AI_WRITE')?.text).toBe('4 / 10000');
  });

  it('exports points CSV with aligned columns matching headers 项目,点数,消耗时间,对账 (#430)', async () => {
    const me = {
      collectPoints: vi.fn().mockResolvedValue([
        {
          id: 'p1',
          title: 'GEO写作-测试',
          delta: -10,
          listPrice: 10,
          phrase: '-10 GEO写作-测试',
          pointsText: '-10',
          createdAt: '2026-11-26T09:52:54.000Z',
          status: 'SETTLED',
        },
      ]),
    } as unknown as MeService;
    const controller = new MeController(me);
    let sentBody: string | Buffer = '';
    const response = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      json: vi.fn(),
      send: vi.fn((body: string | Buffer) => {
        sentBody = body;
      }),
    };
    await controller.points(
      { auth: { userId: 'u1', tenantId: 't1' } },
      { export: 'csv' },
      response,
    );
    const lines = String(sentBody)
      .replace(/^\uFEFF/, '')
      .split('\r\n');
    expect(lines[0]).toBe('项目,点数,消耗时间,对账');
    expect(lines[1]).toBe("GEO写作-测试,-10,2026-11-26 17:52:54,'-10 GEO写作-测试");
  });
});
