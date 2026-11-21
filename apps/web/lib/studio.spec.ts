import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  authorizedV2Request: vi.fn(),
}));

vi.mock('./sse', () => ({
  streamSsePost: vi.fn(),
}));

import { authorizedV2Request } from './api';
import { streamSsePost } from './sse';
import {
  createBatchJob,
  deleteArticle,
  extractMissingFactSlots,
  fetchArticles,
  fetchBatchJobs,
  getArticle,
  getBatchJob,
  getPromptPreferences,
  mergeFactFeedbackContent,
  replaceMissingFactSlot,
  rewriteArticleSection,
  savePromptPreferences,
  streamGenerateArticle,
  updateArticle,
} from './studio';

const mockReq = vi.mocked(authorizedV2Request);
const mockSse = vi.mocked(streamSsePost);

describe('Studio v2 client (studio.ts)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls exact /api/v2 studio REST routes with encoded params and headers', async () => {
    mockReq.mockResolvedValue({ items: [], total: 0 });
    await fetchArticles('b/1', 'CN', { status: 'DRAFT', tag: 'NAS' });
    expect(mockReq).toHaveBeenLastCalledWith(
      '/brands/b%2F1/articles?market=CN&status=DRAFT&tag=NAS',
      expect.objectContaining({ method: 'GET' }),
    );

    await getArticle('art_1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1',
      expect.objectContaining({ method: 'GET' }),
    );

    await updateArticle('art_1', { title: 'Updated' });
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1',
      expect.objectContaining({ method: 'PATCH', body: { title: 'Updated' } }),
    );

    await deleteArticle('art_1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1',
      expect.objectContaining({ method: 'DELETE' }),
    );

    await rewriteArticleSection('art_1', { selectedText: 'abc', action: 'TO_TABLE' });
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1/rewrite-section',
      expect.objectContaining({
        method: 'POST',
        body: { selectedText: 'abc', action: 'TO_TABLE' },
      }),
    );

    await createBatchJob('b1', { market: 'CN', briefIds: ['br1', 'br2'] }, 'idem-batch-1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/brands/b1/articles/batch',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-batch-1' },
      }),
    );

    await fetchBatchJobs('b1', 'GLOBAL');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/brands/b1/batch-jobs?market=GLOBAL',
      expect.objectContaining({ method: 'GET' }),
    );

    await getBatchJob('b1', 'gb_1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/brands/b1/batch-jobs/gb_1',
      expect.objectContaining({ method: 'GET' }),
    );

    await getPromptPreferences();
    expect(mockReq).toHaveBeenLastCalledWith(
      '/prompt-preferences',
      expect.objectContaining({ method: 'GET' }),
    );

    await savePromptPreferences({ customToneNote: '客观', customForbiddenWords: ['天花板'] });
    expect(mockReq).toHaveBeenLastCalledWith(
      '/prompt-preferences',
      expect.objectContaining({
        method: 'PUT',
        body: { customToneNote: '客观', customForbiddenWords: ['天花板'] },
      }),
    );
  });

  it('dispatches typed SSE stream callbacks via streamGenerateArticle', async () => {
    mockSse.mockImplementationOnce(async (_path, opts) => {
      opts.onEvent({ event: 'meta', rawData: '{}', data: { unitPrice: 10 } });
      opts.onEvent({ event: 'delta', rawData: '{}', data: { text: 'hello' } });
      opts.onEvent({ event: 'complete', rawData: '{}', data: { geoScore: 90 } });
      return { aborted: false, receivedEvents: 3 };
    });

    const onMeta = vi.fn();
    const onDelta = vi.fn();
    const onComplete = vi.fn();
    await streamGenerateArticle(
      'b1',
      { market: 'CN', recipe: 'AUTHORITY_GUIDE', targetPrompt: 'NAS 推荐' },
      { onMeta, onDelta, onComplete },
      { idempotencyKey: 'idem-stream-1' },
    );

    expect(onMeta).toHaveBeenCalledWith({ unitPrice: 10 });
    expect(onDelta).toHaveBeenCalledWith({ text: 'hello' });
    expect(onComplete).toHaveBeenCalledWith({ geoScore: 90 });
  });

  it('merges missing-fact feedback safely without overwriting or duplicating existing facts', () => {
    const slots = extractMissingFactSlots('待机 [待补充：如待机功耗 W]');
    expect(slots).toHaveLength(1);
    expect(replaceMissingFactSlot('待机 [待补充：如待机功耗 W]', slots[0]!, '12.5W')).toBe(
      '待机 12.5W',
    );
    expect(mergeFactFeedbackContent('', '如待机功耗 W', '12.5W')).toBe('- 待机功耗 W：12.5W');
    expect(mergeFactFeedbackContent('- 满载噪音：18.5dB', '如待机功耗 W', '12.5W')).toBe(
      '- 满载噪音：18.5dB\n- 待机功耗 W：12.5W',
    );
    // Deduplicates if value already present
    expect(mergeFactFeedbackContent('- 待机功耗：12.5W', '如待机功耗 W', '12.5W')).toBe(
      '- 待机功耗：12.5W',
    );
  });
});
