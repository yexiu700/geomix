// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrand,
  deleteBrand,
  deleteBrandMedia,
  enableBrandMarket,
  extractBrandFacts,
  generateBrandAiImage,
  getBrand,
  getBrandFacts,
  listBrandMedia,
  listBrands,
  resolveMediaUrl,
  saveBrandFacts,
  updateBrand,
  updateBrandMarket,
  updateBrandMediaAlt,
  uploadBrandMedia,
} from './brands';

const requestMock = vi.fn();

vi.mock('./api', () => ({
  authorizedV2Request: (...args: unknown[]) => requestMock(...args),
}));

vi.mock('./session', () => ({
  apiBase: () => 'http://127.0.0.1:3001/api/v1',
}));

afterEach(() => {
  requestMock.mockReset();
});

describe('apps/web/lib/brands v2 API client', () => {
  it('routes Brand CRUD and Market endpoints to exact /api/v2 paths with AbortSignal', async () => {
    const controller = new AbortController();
    requestMock.mockResolvedValue({ items: [] });

    await listBrands({ signal: controller.signal });
    expect(requestMock).toHaveBeenLastCalledWith('/brands', {
      method: 'GET',
      storage: undefined,
      signal: controller.signal,
    });

    await getBrand('b 1');
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b%201', {
      method: 'GET',
      storage: undefined,
      signal: undefined,
    });

    await createBrand({ name: '青松', category: '家用NAS', markets: ['CN'] });
    expect(requestMock).toHaveBeenLastCalledWith('/brands', {
      method: 'POST',
      body: { name: '青松', category: '家用NAS', markets: ['CN'] },
      storage: undefined,
      signal: undefined,
    });

    await updateBrand('b1', { name: '青松Pro' });
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1', {
      method: 'PATCH',
      body: { name: '青松Pro' },
      storage: undefined,
      signal: undefined,
    });

    await deleteBrand('b1');
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1', {
      method: 'DELETE',
      storage: undefined,
      signal: undefined,
    });

    await enableBrandMarket('b1', 'GLOBAL', { localBrandName: 'QingSong' });
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/markets/GLOBAL', {
      method: 'POST',
      body: { localBrandName: 'QingSong' },
      storage: undefined,
      signal: undefined,
    });

    await updateBrandMarket('b1', 'CN', { ownedDomains: ['qingsong.cn'] });
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/markets/CN', {
      method: 'PATCH',
      body: { ownedDomains: ['qingsong.cn'] },
      storage: undefined,
      signal: undefined,
    });
  });

  it('supports JSON and multipart FormData for facts and media endpoints', async () => {
    requestMock.mockResolvedValue({
      brandId: 'b1',
      truthAgreementSignedAt: null,
      items: [
        {
          id: 'f1',
          brandId: 'b1',
          slot: 'PRODUCT_SPECS',
          title: '参数',
          content: '28dB 静音',
          sourceType: 'MANUAL',
          sourceUrl: null,
          indexStatus: 'NONE',
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      ],
    });

    const factsRes = await getBrandFacts('b1');
    expect(factsRes.totalChars).toBe(7);
    expect(factsRes.vectorIndexRequired).toBe(false);

    await saveBrandFacts('b1', {
      facts: [{ slot: 'PRODUCT_SPECS', title: '参数', content: '28dB' }],
      truthAgreed: true,
    });
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/facts', {
      method: 'PUT',
      body: {
        facts: [{ slot: 'PRODUCT_SPECS', title: '参数', content: '28dB' }],
        truthAgreed: true,
      },
      storage: undefined,
      signal: undefined,
    });

    await extractBrandFacts('b1', { sourceType: 'URL_EXTRACT', url: 'https://example.com' });
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/facts/extract', {
      method: 'POST',
      body: { sourceType: 'URL_EXTRACT', url: 'https://example.com' },
      storage: undefined,
      signal: undefined,
    });

    const docFile = new File(['hello specs'], 'specs.md', { type: 'text/markdown' });
    await extractBrandFacts('b1', { file: docFile });
    const fileCall = requestMock.mock.calls[requestMock.mock.calls.length - 1];
    expect(fileCall?.[0]).toBe('/brands/b1/facts/extract');
    expect(fileCall?.[1]?.body).toBeInstanceOf(FormData);

    await listBrandMedia('b1');
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/media', {
      method: 'GET',
      storage: undefined,
      signal: undefined,
    });

    const photo = new File([new Uint8Array([1, 2, 3])], 'front.jpg', { type: 'image/jpeg' });
    await uploadBrandMedia('b1', { file: photo, title: '正面实拍' });
    const uploadCall = requestMock.mock.calls[requestMock.mock.calls.length - 1];
    expect(uploadCall?.[0]).toBe('/brands/b1/media');
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData);

    await updateBrandMediaAlt('b1', 'm1', { title: '更新说明' });
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/media/m1', {
      method: 'PATCH',
      body: { title: '更新说明' },
      storage: undefined,
      signal: undefined,
    });

    await deleteBrandMedia('b1', 'm1');
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b1/media/m1', {
      method: 'DELETE',
      storage: undefined,
      signal: undefined,
    });

    const aiCtrl = new AbortController();
    await generateBrandAiImage(
      'b/1',
      { prompt: '极简四盘位家用NAS风道结构图', ratio: '16:9', title: '风道示意图' },
      'geo_img_test_001',
      { signal: aiCtrl.signal },
    );
    expect(requestMock).toHaveBeenLastCalledWith('/brands/b%2F1/media/ai-gen', {
      method: 'POST',
      body: { prompt: '极简四盘位家用NAS风道结构图', ratio: '16:9', title: '风道示意图' },
      headers: { 'Idempotency-Key': 'geo_img_test_001' },
      storage: undefined,
      signal: aiCtrl.signal,
    });
  });

  it('resolves relative, absolute, data, and blob media URLs cleanly', () => {
    expect(resolveMediaUrl('')).toBe('');
    expect(resolveMediaUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
    expect(resolveMediaUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(resolveMediaUrl('blob:http://localhost:3000/123')).toBe(
      'blob:http://localhost:3000/123',
    );
    expect(resolveMediaUrl('/api/v2/brands/b1/media/m1/thumb?tid=t1&sig=abc')).toBe(
      'http://127.0.0.1:3001/api/v2/brands/b1/media/m1/thumb?tid=t1&sig=abc',
    );
  });
});
