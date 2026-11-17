import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_INPUT_BYTES } from './adapters';
import {
  GALLERY_CATEGORY_EMPTY_MSG,
  GALLERY_FILE_FORMAT_MSG,
  GALLERY_FILE_TOO_LARGE_MSG,
  buildStorageSummary,
  checkImageWidthWarning,
  formatGalleryBytes,
  mediaCategoryWriteSchema,
  validateClientUploadFile,
} from './gallery';

describe('gallery shared helpers', () => {
  it('rejects empty category name and normalizes whitespace', () => {
    const empty = mediaCategoryWriteSchema.safeParse({ name: '   ' });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe(GALLERY_CATEGORY_EMPTY_MSG);
    }

    const valid = mediaCategoryWriteSchema.parse({ name: '  工厂实景   车间  ' });
    expect(valid.name).toBe('工厂实景 车间');
  });

  it('rejects files over 100MB and unsupported formats while allowing jpg/png/webp', () => {
    expect(
      validateClientUploadFile({
        name: 'huge.jpg',
        size: IMAGE_MAX_INPUT_BYTES + 1,
        type: 'image/jpeg',
      }),
    ).toEqual({ ok: false, message: GALLERY_FILE_TOO_LARGE_MSG });

    expect(
      validateClientUploadFile({
        name: 'exact-limit.png',
        size: IMAGE_MAX_INPUT_BYTES,
        type: 'image/png',
      }),
    ).toEqual({ ok: true });

    expect(
      validateClientUploadFile({
        name: 'vector.svg',
        size: 1024,
        type: 'image/svg+xml',
      }),
    ).toEqual({ ok: false, message: GALLERY_FILE_FORMAT_MSG });
  });

  it('warns when width < 500 without rejecting >= 500', () => {
    expect(checkImageWidthWarning(360)).toContain('小于建议值 500px');
    expect(checkImageWidthWarning(500)).toBeUndefined();
    expect(checkImageWidthWarning(1200)).toBeUndefined();
  });

  it('formats storage bytes cleanly for quota display', () => {
    expect(formatGalleryBytes(0)).toBe('0 B');
    expect(formatGalleryBytes(1536)).toBe('1.5 KB');
    const summary = buildStorageSummary(2n * 1024n * 1024n, 100n * 1024n * 1024n);
    expect(summary.usedText).toBe('2 MB');
    expect(summary.limitText).toBe('100 MB');
  });
});
