import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_RATIOS,
  aiImageCreateSchema,
  aiImageSaveToGallerySchema,
  formatAiImageSubmitLabel,
  quoteAiImagePoints,
  resolveAiImageRatioDimensions,
} from './ai-images';

describe('ai-images shared helpers and schemas', () => {
  it('exposes all 9 required aspect ratios with 21:9 as default and valid >=600px dimensions', () => {
    expect(AI_IMAGE_DEFAULT_RATIO).toBe('21:9');
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

  it('validates prompt length (5..500), count (1/2/4), and defaults ratio to 21:9', () => {
    const tooShort = aiImageCreateSchema.safeParse({ prompt: '太短' });
    expect(tooShort.success).toBe(false);

    const badCount = aiImageCreateSchema.safeParse({
      prompt: '现代化数控激光切割车间整洁产线实景拍摄',
      count: 3,
    });
    expect(badCount.success).toBe(false);

    const valid = aiImageCreateSchema.parse({
      prompt: '现代化数控激光切割车间整洁产线实景拍摄',
    });
    expect(valid.ratio).toBe('21:9');
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

  it('validates zero-copy save-to-gallery schema', () => {
    const parsed = aiImageSaveToGallerySchema.parse({
      categoryId: 'mcat_001',
    });
    expect(parsed.categoryId).toBe('mcat_001');
  });
});
