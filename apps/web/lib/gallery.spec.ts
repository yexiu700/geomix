// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GalleryApiError, httpGalleryGateway, readImageDimensions } from './gallery';
import { saveSession, type SessionStorageLike } from './session';

function memoryStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gallery gateway & media helpers', () => {
  it('guards non-JSON HTML proxy responses (502/413) with readable GalleryApiError instead of SyntaxError', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'access-token', 'refresh-token');
    const gw = httpGalleryGateway(storage);
    const progressValues: number[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    const file = new File(['abc'], 'sample.png', { type: 'image/png' });
    await expect(
      gw.uploadAssets('cat_1', [file], (pct) => progressValues.push(pct)),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof GalleryApiError &&
        err.status === 502 &&
        err.message.includes('502') &&
        !err.message.includes('Unexpected token'),
    );
    expect(progressValues).not.toContain(90);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body><h1>413 Request Entity Too Large</h1></body></html>', {
            status: 413,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    await expect(gw.uploadAssets('cat_1', [file])).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof GalleryApiError && err.status === 413 && err.message.includes('网关限制'),
    );
  });

  it('reads dimensions via createImageBitmap and closes bitmap', async () => {
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 320, height: 240, close })),
    );

    const file = new File(['png'], 'tiny.png', { type: 'image/png' });
    await expect(readImageDimensions(file)).resolves.toEqual({ width: 320, height: 240 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('falls back to Image + URL.createObjectURL and always revokes object URL', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const createObjectURL = vi.fn(() => 'blob:mock-preview-1');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    class MockImage {
      naturalWidth = 480;
      naturalHeight = 300;
      width = 480;
      height = 300;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_val: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', MockImage);

    const file = new File(['png'], 'fallback.png', { type: 'image/png' });
    await expect(readImageDimensions(file)).resolves.toEqual({ width: 480, height: 300 });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview-1');
  });

  it('returns null gracefully in jsdom when image decoding APIs are unavailable', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const file = new File(['png'], 'jsdom.png', { type: 'image/png' });
    await expect(readImageDimensions(file)).resolves.toBeNull();
  });
});
