import { API_ERROR, isPlaceholderImageModel } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/api-error';
import { runInTenant } from '../tenant/tenant-context';
import { AiImagesService } from './ai-images.service';
import { ImageJobRunner, isProductionPlaceholderImageBlocked } from './image-job.runner';

describe('AI image production placeholder guard (#284)', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedImageProvider = process.env.IMAGE_PROVIDER;

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedImageProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = savedImageProvider;
  });

  it('identifies placeholder image models and production fake provider configuration', () => {
    expect(isPlaceholderImageModel('fake-image')).toBe(true);
    expect(isPlaceholderImageModel('fake-v2')).toBe(true);
    expect(isPlaceholderImageModel('gpt-image-1')).toBe(false);
    expect(isPlaceholderImageModel(null)).toBe(false);

    expect(
      isProductionPlaceholderImageBlocked({ NODE_ENV: 'production', IMAGE_PROVIDER: 'fake' }),
    ).toBe(true);
    expect(isProductionPlaceholderImageBlocked({ NODE_ENV: 'production' })).toBe(true);
    expect(
      isProductionPlaceholderImageBlocked({
        NODE_ENV: 'production',
        IMAGE_PROVIDER: 'openai',
        IMAGE_BASE_URL: 'https://api.example.com/v1',
      }),
    ).toBe(false);
    expect(isProductionPlaceholderImageBlocked({ NODE_ENV: 'test', IMAGE_PROVIDER: 'fake' })).toBe(
      false,
    );
  });

  it('rejects createJob before billing/enqueue and flags providerReady=false & placeholderOutput=true in production fake mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.IMAGE_PROVIDER = 'fake';

    const reserveSpy = vi.fn();
    const enqueueSpy = vi.fn();
    const prismaMock = {
      base: {
        pricingItem: { findUnique: vi.fn().mockResolvedValue(null) },
        pointReservation: { findMany: vi.fn().mockResolvedValue([]) },
        mediaCategory: { findMany: vi.fn().mockResolvedValue([]) },
      },
      scoped: {
        aiImageJob: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'img_hist_1',
              tenantId: 't_prod',
              prompt: '便携显示器办公桌场景',
              style: '写实摄影',
              ratio: '16:9',
              count: 1,
              refAssetId: null,
              saveCategoryId: null,
              status: 'COMPLETED',
              successCount: 1,
              error: null,
              model: 'fake-image',
              createdAt: new Date('2026-11-19T03:00:00.000Z'),
              assets: [],
            },
          ]),
          findFirst: vi.fn().mockResolvedValue({ id: 'img_hist_1', model: 'fake-image' }),
        },
        mediaCategory: {
          findFirst: vi.fn().mockResolvedValue({ id: 'cat_1', name: '产品图库' }),
        },
      },
    };

    const service = new AiImagesService(
      prismaMock as never,
      { reserve: reserveSpy } as never,
      {} as never,
      {} as never,
      { assertAllowed: vi.fn() } as never,
      {} as never,
      { enqueueImageJob: enqueueSpy },
    );

    await runInTenant('t_prod', async () => {
      await expect(
        service.create({
          prompt: '便携显示器双屏办公桌面实拍图',
          ratio: '16:9',
          count: 1,
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: API_ERROR.UPSTREAM_UNAVAILABLE,
      });

      expect(reserveSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();

      const listRes = await service.list({ page: 1, pageSize: 25 });
      expect(listRes.providerReady).toBe(false);
      expect(listRes.items[0]?.placeholderOutput).toBe(true);

      await expect(
        service.saveToGallery('img_hist_1', { categoryId: 'cat_1' }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  it('rejects queued fake jobs in ImageJobRunner under production, releases reservation, and marks FAILED', async () => {
    process.env.NODE_ENV = 'production';
    process.env.IMAGE_PROVIDER = 'fake';

    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const updateSpy = vi.fn().mockResolvedValue({});
    const generateRawSpy = vi.fn();

    const prismaMock = {
      base: {
        aiImageJob: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'img_queued_1',
            tenantId: 't_prod',
            prompt: '便携显示器双屏办公桌面实拍图',
            style: '写实摄影',
            ratio: '16:9',
            count: 1,
            saveCategoryId: null,
            status: 'QUEUED',
          }),
          update: updateSpy,
        },
        pointReservation: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'resv_1',
            tenantId: 't_prod',
            frozen: 5,
            status: 'OPEN',
          }),
        },
      },
    };

    const runner = new ImageJobRunner(
      prismaMock as never,
      { close: closeSpy } as never,
      {} as never,
      {} as never,
      { generateRaw: generateRawSpy } as never,
    );

    await runner.process({ tenantId: 't_prod', jobId: 'img_queued_1' });

    expect(generateRawSpy).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledWith({ tenantId: 't_prod', reservationId: 'resv_1' });
    expect(updateSpy).toHaveBeenLastCalledWith({
      where: { id: 'img_queued_1' },
      data: expect.objectContaining({
        status: 'FAILED',
        successCount: 0,
        error: expect.stringContaining('演示占位图'),
      }),
    });
  });
});
