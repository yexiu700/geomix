import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  authorizedV2Request: vi.fn(),
  authorizedV2RawRequest: vi.fn(),
}));

vi.mock('./sse', () => ({
  streamSsePost: vi.fn(),
}));

import { authorizedV2RawRequest, authorizedV2Request } from './api';
import { streamSsePost } from './sse';
import {
  buildMarkdownImageToken,
  createBatchJob,
  createPublishRecord,
  createStudioIdempotencyKey,
  deleteArticle,
  evaluateArticleGeo,
  exportArticleFile,
  extractMissingFactSlots,
  fetchArticles,
  fetchBatchJobs,
  fetchPublishRecords,
  getArticle,
  getBatchJob,
  getPromptPreferences,
  insertMarkdownAtCursor,
  mergeFactFeedbackContent,
  parseExportFilename,
  replaceMissingFactSlot,
  rewriteArticleSection,
  rewritePreviewRelativeMediaUrls,
  savePromptPreferences,
  streamGenerateArticle,
  triggerPublishRetest,
  updateArticle,
} from './studio';

const mockReq = vi.mocked(authorizedV2Request);
const mockRawReq = vi.mocked(authorizedV2RawRequest);
const mockSse = vi.mocked(streamSsePost);

describe('Studio v2 client (studio.ts)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls exact /api/v2 studio REST routes with encoded params and headers', async () => {
    mockReq.mockResolvedValue({ items: [], total: 0 });
    await fetchArticles('b/1', 'CN', { status: 'DRAFT', tag: 'NAS', productLineId: ' pl_1 ' });
    expect(mockReq).toHaveBeenLastCalledWith(
      '/brands/b%2F1/articles?market=CN&status=DRAFT&tag=NAS&productLineId=pl_1',
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
    // Deduplicates if value already present on matching line
    expect(mergeFactFeedbackContent('- 待机功耗：12.5W', '如待机功耗 W', '12.5W')).toBe(
      '- 待机功耗：12.5W',
    );
    // Tier 5 #7: Must NOT drop distinct short/numeric facts due to substring match (e.g. '10' inside '1000W')
    expect(mergeFactFeedbackContent('- 整机功率：1000W', '待机功率', '10')).toBe(
      '- 整机功率：1000W\n- 待机功率：10',
    );
    expect(mergeFactFeedbackContent('- 保修年限：2', '盘位数', '2')).toBe(
      '- 保修年限：2\n- 盘位数：2',
    );
    expect(mergeFactFeedbackContent('- 待机功率：10', '待机功率', '10')).toBe('- 待机功率：10');
  });

  it('builds sanitized Markdown image tokens, inserts at cursor, and rewrites relative preview media URLs', () => {
    expect(createStudioIdempotencyKey('img').startsWith('geo_img_')).toBe(true);
    expect(
      buildMarkdownImageToken('DXP4800 [实拍]\n正面', ' /api/v2/brands/b1/media/m1/file '),
    ).toBe('![DXP4800 实拍 正面](/api/v2/brands/b1/media/m1/file)');
    expect(buildMarkdownImageToken('   ', '/api/v2/brands/b1/media/m1/file')).toBe(
      '![产品配图](/api/v2/brands/b1/media/m1/file)',
    );

    const token = '![产品图](/api/v2/brands/b1/media/m1/file)';
    expect(insertMarkdownAtCursor('', token, null)).toBe(token);
    expect(insertMarkdownAtCursor('首段内容', token, null)).toBe(`首段内容\n\n${token}`);
    expect(insertMarkdownAtCursor('第一段\n\n第二段', token, 3)).toBe(
      `第一段\n\n${token}\n\n第二段`,
    );

    const html =
      '<p>正文 /api/v2/brands/b1/media/m1/file</p>' +
      '<img src="/api/v2/brands/b1/media/m1/file?tid=t1&amp;exp=123&amp;sig=abc" alt="实拍" />' +
      '<img src="https://cdn.example.com/a.jpg" alt="外链" />';
    const rewritten = rewritePreviewRelativeMediaUrls(html, (rel) => `http://127.0.0.1:3001${rel}`);
    expect(rewritten).toContain(
      '<img src="http://127.0.0.1:3001/api/v2/brands/b1/media/m1/file?tid=t1&amp;exp=123&amp;sig=abc"',
    );
    expect(rewritten).toContain('<img src="https://cdn.example.com/a.jpg"');
    expect(rewritten).toContain('<p>正文 /api/v2/brands/b1/media/m1/file</p>');

    const escaped = rewritePreviewRelativeMediaUrls(
      '<img src="/api/v2/brands/b1/media/m1/file?tid=t1&amp;sig=abc" alt="x" />',
      (rel) => `https://cdn.example.com"onerror="<alert>${rel}`,
    );
    expect(escaped).toContain(
      '<img src="https://cdn.example.com&quot;onerror=&quot;&lt;alert&gt;/api/v2/brands/b1/media/m1/file?tid=t1&amp;sig=abc"',
    );
  });

  it('calls M5 evaluate-geo, export, publish-records, and retest endpoints cleanly', async () => {
    expect(createStudioIdempotencyKey('retest').startsWith('geo_retest_')).toBe(true);
    expect(
      parseExportFilename(
        `attachment; filename="fallback.docx"; filename*=UTF-8''${encodeURIComponent('实测指南.docx')}`,
        'default.docx',
      ),
    ).toBe('实测指南.docx');

    mockReq.mockResolvedValue({ geoScore: 91 });
    await evaluateArticleGeo('art_1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1/evaluate-geo',
      expect.objectContaining({ method: 'POST', body: {} }),
    );

    mockReq.mockResolvedValue({ items: [] });
    await fetchPublishRecords('art_1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1/publish-records',
      expect.objectContaining({ method: 'GET' }),
    );

    await createPublishRecord('art_1', {
      publishedUrl: 'https://example.com/posts/1',
      channel: '官网博客',
    });
    expect(mockReq).toHaveBeenLastCalledWith(
      '/articles/art_1/publish-records',
      expect.objectContaining({
        method: 'POST',
        body: { publishedUrl: 'https://example.com/posts/1', channel: '官网博客' },
      }),
    );

    await triggerPublishRetest('pub_1', { engines: ['deepseek'] }, 'idem-retest-1');
    expect(mockReq).toHaveBeenLastCalledWith(
      '/publish-records/pub_1/retest',
      expect.objectContaining({
        method: 'POST',
        body: { engines: ['deepseek'] },
        headers: { 'Idempotency-Key': 'idem-retest-1' },
      }),
    );

    mockRawReq.mockResolvedValueOnce(
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'content-disposition': 'attachment; filename="geo-guide.docx"',
        },
      }),
    );
    const exported = await exportArticleFile('art_1', 'docx');
    expect(mockRawReq).toHaveBeenCalledWith(
      '/articles/art_1/export?format=docx',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(exported.filename).toBe('geo-guide.docx');
    expect(exported.mime).toContain('wordprocessingml');

    mockRawReq.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 40001, msg: '格式不支持', data: null }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(exportArticleFile('art_1', 'md')).rejects.toThrow(/格式不支持/);
  });
});
