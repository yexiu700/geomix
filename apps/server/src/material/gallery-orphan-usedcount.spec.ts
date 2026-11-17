import { describe, expect, it, vi } from 'vitest';
import type { QuotaService } from '../billing/quota.service';
import type { ApiError } from '../common/api-error';
import type { ComplianceService } from '../infra/compliance';
import type { StorageService } from '../infra/storage';
import type { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import {
  ArticlesManageService,
  extractReferencedMediaAssetIds,
} from '../writing/articles-manage.service';
import type { CategoriesService } from '../writing/categories.service';
import { GalleryService } from './gallery.service';

describe('Gallery asset usedCount lifecycle & orphan deletion (#94)', () => {
  it('extracts unique referenced media asset IDs across coverUrl and contentHtml and decrements usedCount on bulkDelete', async () => {
    const ids = extractReferencedMediaAssetIds({
      coverUrl: '/api/v1/media-assets/med_ai_001/file?tid=t1&sig=abc',
      contentHtml:
        '<p>正文</p><img src="/api/v1/media-assets/med_ai_001/file" /><img src="/api/v1/media-assets/med_up_002/thumb" />',
    });
    expect(ids).toEqual(['med_ai_001', 'med_up_002']);

    const updates: Array<{ id: string; usedCount: number }> = [];
    const mockTx = {
      article: {
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      mediaAsset: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'med_ai_001', usedCount: 2 },
          { id: 'med_up_002', usedCount: 1 },
        ]),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { usedCount: number } }) => {
            updates.push({ id: where.id, usedCount: data.usedCount });
          },
        ),
      },
    };

    const mockPrisma = {
      base: {
        article: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'art_1',
              coverUrl: '/api/v1/media-assets/med_ai_001/file',
              contentHtml: '<img src="/api/v1/media-assets/med_up_002/file" />',
            },
            {
              id: 'art_2',
              coverUrl: '/api/v1/media-assets/med_ai_001/file',
              contentHtml: '<p>第二篇也用了同一封面</p>',
            },
          ]),
        },
        $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<number>) => fn(mockTx)),
      },
    } as unknown as PrismaService;

    const svc = new ArticlesManageService(mockPrisma, {} as unknown as CategoriesService);
    const res = await runInTenant('ten_94', () => svc.bulkDelete(['art_1', 'art_2']));

    expect(res).toEqual({ deleted: 2 });
    expect(updates).toEqual([
      { id: 'med_ai_001', usedCount: 0 },
      { id: 'med_up_002', usedCount: 0 },
    ]);
  });

  it('allows deleting orphaned asset when usedCount > 0 but live Article & AiImageJob refs are 0, and blocks when live Article ref > 0', async () => {
    let liveArticleCount = 1;
    const deletedIds: string[][] = [];

    const mockPrisma = {
      scoped: {
        mediaAsset: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'med_ai_orphan_1',
              bytes: 4096,
              usedCount: 1,
              objectKey: 'tenants/ten_94/media-med_ai_orphan_1.jpg',
            },
          ]),
        },
      },
      base: {
        article: {
          count: vi.fn(async () => liveArticleCount),
        },
        aiImageJob: {
          count: vi.fn().mockResolvedValue(0),
        },
        $transaction: vi.fn(
          async (
            fn: (tx: {
              mediaAsset: {
                deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<void>;
              };
            }) => Promise<void>,
          ) =>
            fn({
              mediaAsset: {
                deleteMany: async ({ where }) => {
                  deletedIds.push(where.id.in);
                },
              },
            }),
        ),
      },
    } as unknown as PrismaService;

    const mockQuota = {
      release: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue([{ key: 'STORAGE_BYTES', used: 0n, limit: 104_857_600n }]),
    } as unknown as QuotaService;

    const mockStorage = {
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as StorageService;

    const svc = new GalleryService(
      mockPrisma,
      mockQuota,
      mockStorage,
      {} as unknown as ComplianceService,
      () => 10_485_760,
    );

    // 1. Live article still references the asset -> HTTP 409
    await expect(
      runInTenant('ten_94', () => svc.removeAssets(['med_ai_orphan_1'])),
    ).rejects.toMatchObject({
      status: 409,
      message: '所选图片已被文章使用，禁止删除',
    } satisfies Partial<ApiError>);

    // 2. All referencing articles deleted (liveArticleCount = 0), even though historical usedCount = 1 -> succeeds
    liveArticleCount = 0;
    const out = await runInTenant('ten_94', () => svc.removeAssets(['med_ai_orphan_1']));
    expect(out.deleted).toBe(1);
    expect(out.releasedBytes).toBe(4096);
    expect(deletedIds).toEqual([['med_ai_orphan_1']]);
  });
});
