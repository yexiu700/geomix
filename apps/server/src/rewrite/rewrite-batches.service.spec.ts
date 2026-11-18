import 'reflect-metadata';
import { REWRITE_BATCH_SHORT_SOURCE_MSG } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import { runInTenant } from '../tenant/tenant-context';
import { RewriteBatchRunner } from './rewrite-batch.runner';
import { RewriteBatchesService } from './rewrite-batches.service';

describe('RewriteBatchesService & RewriteBatchRunner unit tests (#209)', () => {
  it('stores keyword (theme tag) and brand independently without overwriting each other', async () => {
    let createdData: Record<string, unknown> | null = null;
    const now = new Date('2026-11-18T12:00:00.000Z');

    const prismaMock = {
      base: {
        promptTemplate: {
          count: vi.fn(async () => 100),
          findFirst: vi.fn(async () => ({ id: 'sys_rewrite_01', kind: 'REWRITE' })),
          upsert: vi.fn(async () => undefined),
        },
        pricingItem: {
          findUnique: vi.fn(async () => ({
            action: 'rewrite_batch',
            unitPoints: 5,
            enabled: true,
          })),
        },
        articleCategory: {
          findFirst: vi.fn(async () => ({ id: 'cat_001' })),
        },
        rewriteBatch: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            createdData = data;
            return { id: 'rwb_unit_01' };
          }),
          findFirst: vi.fn(async () => ({
            id: 'rwb_unit_01',
            tenantId: 'ten_01',
            name: createdData?.name,
            keyword: createdData?.keyword,
            brand: createdData?.brand,
            resultStatus: createdData?.resultStatus ?? 'PENDING',
            maxCount: createdData?.maxCount,
            doneCount: 0,
            sourceType: 'link_list',
            linkList: createdData?.linkList ?? [],
            categoryId: 'cat_001',
            mediaCategoryId: null,
            templateId: 'sys_rewrite_01',
            status: 'QUEUED',
            note: null,
            createdAt: now,
            category: { id: 'cat_001', name: '批量复刻归档' },
            mediaCategory: null,
            template: { id: 'sys_rewrite_01', name: '系统·参考重写' },
            _count: { records: 0 },
          })),
        },
        rewriteRecord: {
          findMany: vi.fn(async () => []),
          groupBy: vi.fn(async () => []),
        },
        pointReservation: {
          findMany: vi.fn(async () => [
            { refId: 'rwb_unit_01', frozen: 5, settled: 0, released: 0 },
          ]),
        },
      },
    };

    const billingMock = {
      wallet: vi.fn(async () => ({
        billingMode: 'SHADOW',
        points: 100,
        pointsReserved: 0,
        available: 100,
      })),
      reserve: vi.fn(async () => ({ id: 'resv_01' })),
      close: vi.fn(async () => undefined),
    };

    const complianceMock = {
      assertAllowed: vi.fn(async ({ text }: { text: string }) => ({ text, flags: [] })),
    };

    const searchMock = {
      isRemoteReady: vi.fn(() => false),
    };

    const enqueuerMock = {
      enqueueRewriteBatch: vi.fn(async () => undefined),
    };

    const service = new RewriteBatchesService(
      prismaMock as never,
      billingMock as never,
      complianceMock as never,
      searchMock as never,
      enqueuerMock,
    );

    const detail = await runInTenant('ten_01', () =>
      service.create({
        name: '氮化镓快充批处理',
        maxCount: 1,
        sourceType: 'link_list',
        keyword: 'Anker氮化镓充电器',
        brand: 'Anker',
        linksText: 'https://news.example.org/p1',
        mediaCategoryId: null,
        templateId: 'sys_rewrite_01',
        resultStatus: 'NORMAL',
      }),
    );

    expect(createdData).toMatchObject({
      keyword: 'Anker氮化镓充电器',
      brand: 'Anker',
      resultStatus: 'NORMAL',
    });
    expect(detail.batch.keyword).toBe('Anker氮化镓充电器');
    expect(detail.batch.brand).toBe('Anker');
    expect(detail.batch.resultStatus).toBe('NORMAL');
    expect(detail.batch.note).toBeNull();
  });

  it('skips short source pages in batch runner with batch-specific message (no paste-switch hint)', async () => {
    const updatedRecords: Array<Record<string, unknown>> = [];

    const prismaMock = {
      base: {
        rewriteRecord: {
          updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            updatedRecords.push(data);
            return { count: 1 };
          }),
        },
      },
    };

    const runner = new RewriteBatchRunner(
      prismaMock as never,
      {} as never,
      {} as never,
      {
        fetch: vi.fn(async () => ({
          url: 'https://news.example.org/short',
          status: 200,
          headers: {},
          body: '<html><head><title>短讯</title></head><body><article><h1>短讯</h1><p>正文太短不足两百字。</p></article></body></html>',
        })),
      } as never,
      {} as never,
      {} as never,
    );

    // Invoke private executeCandidate directly to test short-source error formatting cleanly
    await (
      runner as unknown as {
        executeCandidate(input: Record<string, unknown>): Promise<void>;
      }
    ).executeCandidate({
      tenantId: 'ten_01',
      batchId: 'rwb_01',
      batchName: '短文测试',
      categoryId: 'cat_01',
      mediaCategoryId: null,
      templateContent: '改写指令',
      brandHint: 'Anker',
      resultStatus: 'PENDING',
      recordId: 'rec_short_01',
      url: 'https://news.example.org/short',
      sourceTitleHint: null,
      reservationId: 'resv_01',
      unitPoints: 5,
      simMax: 0.35,
      timeoutMs: 5000,
    });

    expect(updatedRecords).toHaveLength(1);
    expect(updatedRecords[0]?.status).toBe('SKIPPED');
    expect(String(updatedRecords[0]?.error)).toContain(REWRITE_BATCH_SHORT_SOURCE_MSG);
    expect(String(updatedRecords[0]?.error)).not.toContain('开启「粘贴原文」');
  });
});
