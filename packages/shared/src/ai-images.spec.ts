import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_RATIOS,
  aiImageCreateSchema,
  aiImageExportTable,
  aiImageSaveToGallerySchema,
  formatAiImageSubmitLabel,
  quoteAiImagePoints,
  resolveAiImageRatioDimensions,
} from './ai-images';

describe('ai-images shared helpers and schemas', () => {
  it('exposes all 9 required aspect ratios with 16:9 as default and valid >=600px dimensions', () => {
    expect(AI_IMAGE_DEFAULT_RATIO).toBe('16:9');
    expect(AI_IMAGE_RATIOS).toEqual([
      '21:9',
      '16:9',
      '4:3',
      '3:2',
      '1:1',
      '2:3',
      '3:4',
      '9:16',
      '9:21',
    ]);
    for (const ratio of AI_IMAGE_RATIOS) {
      const dims = resolveAiImageRatioDimensions(ratio);
      expect(dims.width).toBeGreaterThanOrEqual(600);
      expect(dims.height).toBeGreaterThanOrEqual(540);
      expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(1600);
    }
  });

  it('validates prompt length (5..500), count (1/2/4), and defaults ratio to 16:9', () => {
    const tooShort = aiImageCreateSchema.safeParse({ prompt: '太短' });
    expect(tooShort.success).toBe(false);

    const badCount = aiImageCreateSchema.safeParse({
      prompt: '简约现代商业办公桌面与产品实物陈列摄影',
      count: 3,
    });
    expect(badCount.success).toBe(false);

    const valid = aiImageCreateSchema.parse({
      prompt: '简约现代商业办公桌面与产品实物陈列摄影',
    });
    expect(valid.ratio).toBe('16:9');
    expect(valid.count).toBe(1);
  });

  it('quotes upfront reserve points and formats submit button label clearly', () => {
    expect(quoteAiImagePoints(2, 5)).toEqual({
      count: 2,
      unitPoints: 5,
      totalPoints: 10,
    });
    expect(formatAiImageSubmitLabel(4, 5)).toBe('生成图片（5点数/张，合计预冻 20 点）');
  });

  it('validates zero-copy save-to-gallery schema and exports user-friendly labels', () => {
    const parsed = aiImageSaveToGallerySchema.parse({
      categoryId: 'mcat_001',
    });
    expect(parsed.categoryId).toBe('mcat_001');

    const table = aiImageExportTable([
      {
        id: 'img_1',
        orderNo: 'IMG20261118-000001',
        prompt: '现代办公空间产品陈列摄影',
        style: '写实摄影',
        ratio: '16:9',
        count: 1,
        successCount: 1,
        refAssetId: null,
        saveCategoryId: null,
        saveCategoryName: null,
        status: 'COMPLETED',
        error: null,
        model: 'fake',
        unitPoints: 5,
        reservedPoints: 5,
        settledPoints: 5,
        releasedPoints: 0,
        createdAt: '2026-11-18T00:00:00.000Z',
        assets: [],
      },
    ]);
    expect(table.headers).toContain('归属图库分组');
    expect(table.rows[0]).toContain('未存入图库');
    expect(table.rows[0]?.[table.headers.indexOf('创建时间')]).toBe('2026-11-18 08:00:00');
  });
});
