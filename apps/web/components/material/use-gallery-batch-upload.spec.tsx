// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GALLERY_FILE_FORMAT_MSG,
  GALLERY_FILE_TOO_LARGE_MSG,
  GALLERY_UPLOAD_MAX_FILES,
  IMAGE_MAX_INPUT_BYTES,
  buildStorageSummary,
  type MediaUploadResponse,
} from '@geomix/shared';
import type { GalleryGateway } from '../../lib/gallery';
import { resolveAssetDisplayName, useGalleryBatchUpload } from './use-gallery-batch-upload';

function makeUploadResponse(files: readonly File[]): MediaUploadResponse {
  const storage = buildStorageSummary(256n * 1024n, 100n * 1024n * 1024n);
  return {
    items: files.map((file, idx) => ({
      asset: {
        id: `med_batch_${idx + 1}`,
        categoryId: 'cat_1',
        categoryName: '车间实拍',
        origin: 'UPLOAD' as const,
        objectKey: `tenants/t1/media-batch-${idx + 1}.jpg`,
        originalName: file.name,
        displayName: file.name,
        url: `/api/v1/media-assets/med_batch_${idx + 1}/file`,
        thumbUrl: `/api/v1/media-assets/med_batch_${idx + 1}/thumb`,
        width: 1200,
        height: 800,
        bytes: file.size || 24576,
        mime: 'image/jpeg',
        usedCount: 0,
        createdAt: '2026-11-18T08:00:00.000Z',
      },
      originalName: file.name,
    })),
    warnings: [],
    storage,
  };
}

function makeUploadGateway(
  uploadImpl?: GalleryGateway['uploadAssets'],
): Pick<GalleryGateway, 'uploadAssets'> {
  return {
    uploadAssets:
      uploadImpl ??
      vi.fn(async (_categoryId, files, onProgress) => {
        onProgress?.(100);
        return makeUploadResponse(files);
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('useGalleryBatchUpload', () => {
  it('rejects oversize (>100MB), empty, unsupported-format, >20 batch files, and empty queue submit', async () => {
    const gateway = makeUploadGateway();
    const { result } = renderHook(() =>
      useGalleryBatchUpload({
        categoryId: 'cat_1',
        gateway,
      }),
    );

    const hugeFile = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(hugeFile, 'size', { value: IMAGE_MAX_INPUT_BYTES + 1 });
    act(() => {
      result.current.appendFiles([hugeFile]);
    });
    expect(result.current.uploadError).toBe(`huge.jpg：${GALLERY_FILE_TOO_LARGE_MSG}`);
    expect(result.current.modalFooterError).toBe(`huge.jpg：${GALLERY_FILE_TOO_LARGE_MSG}`);
    expect(result.current.pendingItems).toEqual([]);

    const emptyFile = new File([], 'empty.png', { type: 'image/png' });
    act(() => {
      result.current.appendFiles([emptyFile]);
    });
    expect(result.current.uploadError).toBe('empty.png：图片文件为空');
    expect(result.current.pendingItems).toEqual([]);

    const gifFile = new File(['gif89a'], 'anim.gif', { type: 'image/gif' });
    act(() => {
      result.current.appendFiles([gifFile]);
    });
    expect(result.current.uploadError).toBe(`anim.gif：${GALLERY_FILE_FORMAT_MSG}`);
    expect(result.current.pendingItems).toEqual([]);

    const tooManyFiles = Array.from(
      { length: GALLERY_UPLOAD_MAX_FILES + 1 },
      (_, idx) => new File(['ok'], `batch_${idx + 1}.jpg`, { type: 'image/jpeg' }),
    );
    act(() => {
      result.current.appendFiles(tooManyFiles);
    });
    expect(result.current.uploadError).toBe(`单次最多选择 ${GALLERY_UPLOAD_MAX_FILES} 张图片`);
    expect(result.current.pendingItems).toEqual([]);

    let submitted = true;
    await act(async () => {
      submitted = await result.current.submitUpload();
    });
    expect(submitted).toBe(false);
    expect(result.current.uploadError).toBe('请至少选择一张图片');
    expect(gateway.uploadAssets).not.toHaveBeenCalled();
  });

  it('probes client dimensions via createImageBitmap, flags <500px widthWarning without blocking, and removes single item', async () => {
    const closeBitmap = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (file: File) => {
        if (file.name === 'narrow-360.png') {
          return { width: 360, height: 240, close: closeBitmap };
        }
        if (file.name === 'narrow-499.webp') {
          return { width: 499, height: 300, close: closeBitmap };
        }
        if (file.name === 'edge-500.jpg') {
          return { width: 500, height: 400, close: closeBitmap };
        }
        return { width: 1200, height: 800, close: closeBitmap };
      }),
    );

    const gateway = makeUploadGateway();
    const { result } = renderHook(() =>
      useGalleryBatchUpload({
        categoryId: 'cat_1',
        gateway,
      }),
    );

    const narrow360 = new File(['a'], 'narrow-360.png', { type: 'image/png' });
    const narrow499 = new File(['b'], 'narrow-499.webp', { type: 'image/webp' });
    const edge500 = new File(['c'], 'edge-500.jpg', { type: 'image/jpeg' });
    const wide1200 = new File(['d'], 'wide-1200.jpg', { type: 'image/jpeg' });

    act(() => {
      result.current.appendFiles([narrow360, narrow499, edge500, wide1200]);
    });

    await waitFor(() => {
      expect(result.current.pendingItems).toHaveLength(4);
      expect(result.current.pendingItems[0]).toMatchObject({
        width: 360,
        height: 240,
        widthWarning: '图片宽度 360px 小于建议值 500px，仅提示不影响上传',
      });
      expect(result.current.pendingItems[1]).toMatchObject({
        width: 499,
        height: 300,
        widthWarning: '图片宽度 499px 小于建议值 500px，仅提示不影响上传',
      });
      expect(result.current.pendingItems[2]).toMatchObject({
        width: 500,
        height: 400,
        widthWarning: undefined,
      });
      expect(result.current.pendingItems[3]).toMatchObject({
        width: 1200,
        height: 800,
        widthWarning: undefined,
      });
    });

    expect(closeBitmap).toHaveBeenCalledTimes(4);
    expect(result.current.uploadError).toBeNull();
    expect(result.current.pendingWidthWarnings).toEqual([
      'narrow-360.png：图片宽度 360px 小于建议值 500px，仅提示不影响上传',
      'narrow-499.webp：图片宽度 499px 小于建议值 500px，仅提示不影响上传',
    ]);

    const firstKey = result.current.pendingItems[0]!.key;
    act(() => {
      result.current.removePendingItem(firstKey);
    });
    expect(result.current.pendingItems.map((item) => item.file.name)).toEqual([
      'narrow-499.webp',
      'edge-500.jpg',
      'wide-1200.jpg',
    ]);
    expect(result.current.pendingWidthWarnings).toEqual([
      'narrow-499.webp：图片宽度 499px 小于建议值 500px，仅提示不影响上传',
    ]);
  });

  it('tracks upload progress (10 -> onProgress -> 100), ignores appendFiles while uploading, and completes non-blockingly', async () => {
    let reportProgress: ((percent: number) => void) | undefined;
    let resolveUpload: ((res: MediaUploadResponse) => void) | undefined;
    const onUploadSuccess = vi.fn();

    const gateway = makeUploadGateway(
      vi.fn(async (_categoryId, _files, onProgress) => {
        reportProgress = onProgress;
        return await new Promise<MediaUploadResponse>((resolve) => {
          resolveUpload = resolve;
        });
      }),
    );

    const { result } = renderHook(() =>
      useGalleryBatchUpload({
        categoryId: 'cat_1',
        gateway,
        onUploadSuccess,
      }),
    );

    const benchFile = new File(['img'], 'bench.png', { type: 'image/png' });
    act(() => {
      result.current.appendFiles([benchFile]);
    });
    expect(result.current.pendingItems).toHaveLength(1);

    let submitPromise!: Promise<boolean>;
    act(() => {
      submitPromise = result.current.submitUpload();
    });

    expect(result.current.uploading).toBe(true);
    expect(result.current.uploadStatus).toBe('uploading');
    expect(result.current.uploadProgress).toBe(10);
    expect(result.current.showProgress).toBe(true);
    expect(result.current.progressStatus).toBe('active');
    expect(result.current.isUploadComplete).toBe(false);

    // Selecting or removing files while uploading is ignored
    const extraFile = new File(['extra'], 'extra.jpg', { type: 'image/jpeg' });
    act(() => {
      result.current.appendFiles([extraFile]);
      result.current.removePendingItem(result.current.pendingItems[0]!.key);
    });
    expect(result.current.pendingItems.map((item) => item.file.name)).toEqual(['bench.png']);

    act(() => {
      reportProgress?.(65);
    });
    expect(result.current.uploadProgress).toBe(65);

    const response = makeUploadResponse([benchFile]);
    let ok = false;
    await act(async () => {
      resolveUpload?.(response);
      ok = await submitPromise;
    });

    expect(ok).toBe(true);
    expect(result.current.uploading).toBe(false);
    expect(result.current.uploadStatus).toBe('success');
    expect(result.current.uploadProgress).toBe(100);
    expect(result.current.progressStatus).toBe('success');
    expect(result.current.isUploadComplete).toBe(true);
    expect(result.current.pendingItems).toEqual([]);
    expect(result.current.lastUploaded).toEqual(response.items);
    expect(onUploadSuccess).toHaveBeenCalledTimes(1);
    expect(onUploadSuccess).toHaveBeenCalledWith(response);
  });

  it('preserves pendingItems and progress on upload error with null modalFooterError and recovers on retry', async () => {
    let attempt = 0;
    const gateway = makeUploadGateway(
      vi.fn(async (_categoryId, files, onProgress) => {
        attempt += 1;
        onProgress?.(85);
        if (attempt === 1) {
          throw new Error('对象存储暂时不可用');
        }
        onProgress?.(100);
        return makeUploadResponse(files);
      }),
    );

    const { result } = renderHook(() =>
      useGalleryBatchUpload({
        categoryId: 'cat_1',
        gateway,
      }),
    );

    const retryFile = new File(['retry'], 'retry-photo.jpg', { type: 'image/jpeg' });
    act(() => {
      result.current.appendFiles([retryFile]);
    });

    let firstAttemptOk = true;
    await act(async () => {
      firstAttemptOk = await result.current.submitUpload();
    });

    expect(firstAttemptOk).toBe(false);
    expect(result.current.uploading).toBe(false);
    expect(result.current.uploadStatus).toBe('error');
    expect(result.current.uploadProgress).toBe(85);
    expect(result.current.showProgress).toBe(true);
    expect(result.current.progressStatus).toBe('exception');
    expect(result.current.uploadError).toBe('对象存储暂时不可用');
    expect(result.current.modalFooterError).toBeNull();
    expect(result.current.pendingItems.map((item) => item.file.name)).toEqual(['retry-photo.jpg']);

    let retryOk = false;
    await act(async () => {
      retryOk = await result.current.submitUpload();
    });

    expect(retryOk).toBe(true);
    expect(gateway.uploadAssets).toHaveBeenCalledTimes(2);
    expect(result.current.uploadStatus).toBe('success');
    expect(result.current.uploadProgress).toBe(100);
    expect(result.current.uploadError).toBeNull();
    expect(result.current.pendingItems).toEqual([]);
    expect(result.current.isUploadComplete).toBe(true);
    expect(result.current.lastUploaded).toHaveLength(1);
  });

  it('resets state machine cleanly via resetUpload, cancels stale dimension probes, and resets success status on new selection', async () => {
    let resolveSlowBitmap:
      ((bitmap: { width: number; height: number; close: () => void }) => void) | undefined;
    const closeBitmap = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise<{ width: number; height: number; close: () => void }>((resolve) => {
            resolveSlowBitmap = resolve;
          }),
      ),
    );

    const gateway = makeUploadGateway();
    const { result } = renderHook(() =>
      useGalleryBatchUpload({
        categoryId: 'cat_1',
        gateway,
      }),
    );

    const slowFile = new File(['slow'], 'slow.png', { type: 'image/png' });
    act(() => {
      result.current.appendFiles([slowFile]);
    });
    expect(result.current.pendingItems).toHaveLength(1);

    act(() => {
      result.current.resetUpload();
    });
    expect(result.current.pendingItems).toEqual([]);
    expect(result.current.uploadStatus).toBe('idle');
    expect(result.current.uploadProgress).toBe(0);
    expect(result.current.showProgress).toBe(false);
    expect(result.current.lastUploaded).toEqual([]);
    expect(result.current.dragActive).toBe(false);
    expect(result.current.uploadError).toBeNull();

    // Late resolution from cancelled session is ignored
    await act(async () => {
      resolveSlowBitmap?.({ width: 320, height: 240, close: closeBitmap });
      await Promise.resolve();
    });
    expect(closeBitmap).toHaveBeenCalledTimes(1);
    expect(result.current.pendingItems).toEqual([]);
    expect(result.current.pendingWidthWarnings).toEqual([]);

    // Complete an upload to 'success', then select a new file -> resets uploadStatus to 'idle'
    vi.unstubAllGlobals();
    const firstValid = new File(['one'], 'first.jpg', { type: 'image/jpeg' });
    act(() => {
      result.current.appendFiles([firstValid]);
    });
    await act(async () => {
      await result.current.submitUpload();
    });
    expect(result.current.uploadStatus).toBe('success');
    expect(result.current.isUploadComplete).toBe(true);

    const nextValid = new File(['two'], 'second.jpg', { type: 'image/jpeg' });
    act(() => {
      result.current.appendFiles([nextValid]);
    });
    expect(result.current.uploadStatus).toBe('idle');
    expect(result.current.uploadProgress).toBe(0);
    expect(result.current.isUploadComplete).toBe(false);
    expect(result.current.pendingItems.map((item) => item.file.name)).toEqual(['second.jpg']);
  });

  it('respects readOnly guard and sanitizes asset display names without leaking objectKey', async () => {
    const gateway = makeUploadGateway();
    const { result } = renderHook(() =>
      useGalleryBatchUpload({
        categoryId: 'cat_1',
        gateway,
        readOnly: true,
      }),
    );

    expect(result.current.fileInputProps.disabled).toBe(true);

    const validFile = new File(['ok'], 'readonly.jpg', { type: 'image/jpeg' });
    act(() => {
      result.current.appendFiles([validFile]);
    });
    expect(result.current.pendingItems).toEqual([]);

    let submitted = true;
    await act(async () => {
      submitted = await result.current.submitUpload();
    });
    expect(submitted).toBe(false);
    expect(gateway.uploadAssets).not.toHaveBeenCalled();

    expect(
      resolveAssetDisplayName({
        id: 'med_explicit_01',
        origin: 'UPLOAD',
        displayName: '  精雕主轴实拍.png  ',
        originalName: 'tenants/secret/raw.png',
      }),
    ).toBe('精雕主轴实拍.png');

    expect(
      resolveAssetDisplayName({
        id: 'med_path_02',
        origin: 'UPLOAD',
        displayName: '   ',
        originalName: 'C:\\fakepath\\车间\u0007全景图.webp',
      }),
    ).toBe('车间全景图.webp');

    const uploadFallback = resolveAssetDisplayName({
      id: 'med_987654',
      origin: 'UPLOAD',
      displayName: undefined,
      originalName: null,
    });
    expect(uploadFallback).toBe('上传图片-987654.jpg');
    expect(uploadFallback).not.toContain('tenants/');

    const aiFallback = resolveAssetDisplayName(
      {
        id: 'med_abcdef',
        origin: 'AI_IMAGE',
        displayName: '',
        originalName: undefined,
      },
      '..',
    );
    expect(aiFallback).toBe('AI生成图片-abcdef.jpg');
    expect(aiFallback).not.toContain('tenants/');
  });
});
