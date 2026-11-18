import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_INPUT_BYTES } from './adapters';
import {
  GALLERY_CATEGORY_EMPTY_MSG,
  GALLERY_FILE_FORMAT_MSG,
  GALLERY_FILE_TOO_LARGE_MSG,
  buildStorageSummary,
  checkImageWidthWarning,
  formatGalleryBytes,
  mediaAssetExportTable,
  mediaCategoryWriteSchema,
  safeMediaDisplayName,
  sanitizeMediaOriginalName,
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

  it('sanitizes original filenames and never leaks tenant objectKey in displayName or export table', () => {
    expect(sanitizeMediaOriginalName('../../secret/product-01.png')).toBe('product-01.png');
    expect(sanitizeMediaOriginalName('C:\\fakepath\\便携屏实拍.png')).toBe('便携屏实拍.png');
    expect(sanitizeMediaOriginalName('   ')).toBeNull();

    expect(
      safeMediaDisplayName({
        id: 'med_abcdef123456',
        origin: 'UPLOAD',
        originalName: 'anker.png',
      }),
    ).toBe('anker.png');
    expect(
      safeMediaDisplayName({
        id: 'med_abcdef123456',
        origin: 'UPLOAD',
        originalName: null,
      }),
    ).toBe('上传图片-123456.jpg');
    expect(
      safeMediaDisplayName({
        id: 'med_abcdef123456',
        origin: 'AI_IMAGE',
        originalName: null,
      }),
    ).toBe('AI生成图片-123456.jpg');

    const table = mediaAssetExportTable([
      {
        id: 'med_abcdef123456',
        categoryId: 'cat_1',
        categoryName: '便携屏',
        origin: 'UPLOAD',
        objectKey: 'tenants/seed_tenant_platform/media-med_abcdef123456.jpg',
        originalName: 'arzopa-1.png',
        url: '/api/v1/media-assets/med_abcdef123456/file',
        thumbUrl: '/api/v1/media-assets/med_abcdef123456/thumb',
        width: 500,
        height: 300,
        bytes: 4900,
        mime: 'image/jpeg',
        usedCount: 0,
        createdAt: '2026-11-18T08:00:00.000Z',
      },
    ]);
    expect(table.rows[0]?.[2]).toBe('arzopa-1.png');
    expect(table.rows[0]?.join(',')).not.toContain('seed_tenant_platform');
  });
});
