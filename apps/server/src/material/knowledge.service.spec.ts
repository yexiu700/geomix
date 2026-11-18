import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeService } from './knowledge.service';
import { runInTenant } from '../tenant/tenant-context';

describe('KnowledgeService SUMMARY companyName persistence (#205)', () => {
  it('stores and returns optional companyName for SUMMARY mode while preserving null when omitted', async () => {
    const createdRows: Array<Record<string, unknown>> = [];
    const updatedRows: Array<Record<string, unknown>> = [];

    const prismaMock = {
      base: {
        agreementSignature: {
          findFirst: vi.fn().mockResolvedValue({ id: 'sig_1' }),
        },
        knowledgeBase: {
          create: vi
            .fn()
            .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
              createdRows.push(data);
              return {
                id: 'kb_sum_1',
                name: data.name,
                mode: data.mode,
                companyName: data.companyName ?? null,
                brandShort: null,
                directions: [],
                copyTypes: [],
                fields: null,
                summaryText: data.summaryText,
                indexStatus: 'NONE',
                signatureId: 'sig_1',
                createdAt: new Date('2026-11-18T00:00:00.000Z'),
                updatedAt: new Date('2026-11-18T00:00:00.000Z'),
                _count: { chunks: 0 },
              };
            }),
          findFirst: vi.fn().mockResolvedValue({ id: 'kb_sum_1' }),
        },
        knowledgeChunk: {
          deleteMany: vi.fn(),
        },
        $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          return fn({
            knowledgeChunk: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
            knowledgeBase: {
              update: vi
                .fn()
                .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
                  updatedRows.push(data);
                  return {
                    id: 'kb_sum_1',
                    name: data.name,
                    mode: data.mode,
                    companyName: data.companyName ?? null,
                    brandShort: null,
                    directions: [],
                    copyTypes: [],
                    fields: null,
                    summaryText: data.summaryText,
                    indexStatus: 'NONE',
                    signatureId: 'sig_1',
                    createdAt: new Date('2026-11-18T00:00:00.000Z'),
                    updatedAt: new Date('2026-11-18T00:01:00.000Z'),
                    _count: { chunks: 0 },
                  };
                }),
            },
          });
        }),
      },
    };

    const complianceMock = {
      assertAllowed: vi.fn().mockResolvedValue(undefined),
    };
    const producerMock = {
      enqueueKbIndex: vi.fn().mockResolvedValue(undefined),
    };

    const service = new KnowledgeService(
      prismaMock as never,
      complianceMock as never,
      producerMock as never,
    );

    await runInTenant('tenant_1', async () => {
      const created = await service.create(
        {
          name: '安克创新（Anker）品牌与产品矩阵知识库',
          mode: 'SUMMARY',
          companyName: '安克创新（Anker）',
          summaryText: '专注智能充电与储能设备。',
        },
        'user_1',
      );
      expect(created.companyName).toBe('安克创新（Anker）');
      expect(createdRows[0]?.companyName).toBe('安克创新（Anker）');

      const updatedWithoutCompany = await service.update(
        'kb_sum_1',
        {
          name: '更新后的汇总知识库',
          mode: 'SUMMARY',
          summaryText: '无公司名汇总信息。',
        },
        'user_1',
      );
      expect(updatedWithoutCompany.companyName).toBeNull();
      expect(updatedRows[0]?.companyName).toBeNull();
    });
  });
});
