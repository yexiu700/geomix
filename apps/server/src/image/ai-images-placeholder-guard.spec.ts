import { API_ERROR, isPlaceholderImageModel } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/api-error';
import { runInTenant } from '../tenant/tenant-context';
import { AiImagesService } from './ai-images.service';
import {
  ImageJobRunner,
  isProductionPlaceholderImageBlocked,
  resolveImageProviderReadiness,
} from './image-job.runner';
import { LEAKED_PROMPT_FALLBACK_DISPLAY, sanitizeDisplayImagePrompt } from './prompt-optimizer';

describe('AI image production placeholder & readiness guard (#284, #304)', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedImageProvider = process.env.IMAGE_PROVIDER;
  const savedImageBaseUrl = process.env.IMAGE_BASE_URL;
  const savedImageApiKey = process.env.IMAGE_API_KEY;

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedImageProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = savedImageProvider;
    if (savedImageBaseUrl === undefined) delete process.env.IMAGE_BASE_URL;
    else process.env.IMAGE_BASE_URL = savedImageBaseUrl;
    if (savedImageApiKey === undefined) delete process.env.IMAGE_API_KEY;
    else process.env.IMAGE_API_KEY = savedImageApiKey;
  });

  it('identifies placeholder image models, production fake mode, and missing endpoint/key (#284, #304)', () => {
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

    expect(
      resolveImageProviderReadiness({
        NODE_ENV: 'production',
        IMAGE_PROVIDER: 'openai',
        IMAGE_BASE_URL: '',
      }),
    ).toMatchObject({ ready: false, reason: expect.stringContaining('端点') });

    expect(
      resolveImageProviderReadiness({
        NODE_ENV: 'production',
        IMAGE_PROVIDER: 'openai',
        IMAGE_BASE_URL: 'https://api.example.com/v1',
        IMAGE_API_KEY: '',
      }),
    ).toMatchObject({ ready: false, reason: expect.stringContaining('密钥') });

    expect(
      resolveImageProviderReadiness({
        NODE_ENV: 'production',
        IMAGE_PROVIDER: 'openai',
        IMAGE_BASE_URL: 'https://api.example.com/v1',
        IMAGE_API_KEY: 'sk-test',
      }),
    ).toEqual({ ready: true, reason: null });
  });

  it('scrubs leaked LLM chain-of-thought from stored historical prompts (#304)', () => {
    const leaked =
      '用户需要把简短描述扩写成配图提示词，核心约束：需要写80-220字，不要出现品牌Logo。';
    expect(sanitizeDisplayImagePrompt(leaked)).toBe(LEAKED_PROMPT_FALLBACK_DISPLAY);
    expect(sanitizeDisplayImagePrompt('便携显示器双屏办公桌面实拍图，柔和自然光')).toBe(
      '便携显示器双屏办公桌面实拍图，柔和自然光',
    );
  });

  it('rejects create before billing/enqueue, flags providerReady=false, returns billingMode, and scrubs leaked prompts', async () => {
    process.env.NODE_ENV = 'production';
    process.env.IMAGE_PROVIDER = 'openai';
    process.env.IMAGE_BASE_URL = '';

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
              prompt: '用户需要把简短描述扩写成配图提示词，需要写80-220字',
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
      {
        reserve: reserveSpy,
        wallet: vi.fn().mockResolvedValue({ billingMode: 'STRICT' }),
      } as never,
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
      expect(listRes.providerReason).toContain('端点');
      expect(listRes.billingMode).toBe('STRICT');
      expect(listRes.items[0]?.placeholderOutput).toBe(true);
      expect(listRes.items[0]?.prompt).toBe(LEAKED_PROMPT_FALLBACK_DISPLAY);

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
