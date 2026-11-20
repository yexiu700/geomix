import { describe, expect, it } from 'vitest';
import {
  ARTICLE_EXPORT_FORMATS,
  buildArticleExportZip,
  buildSingleDocxBytes,
  buildZipArchive,
  countArticleWords,
  htmlToExportDocument,
  htmlToExportMarkdown,
  publishRecordCreateSchema,
  readZipStoreEntries,
  sanitizeRichArticleHtml,
} from './geo-delivery';

describe('geo-delivery v2 contracts and extracted export utilities', () => {
  it('validates publish record schema and sanitizes rich HTML with table support', () => {
    expect(ARTICLE_EXPORT_FORMATS).toEqual(['md', 'html', 'docx']);
    expect(
      publishRecordCreateSchema.safeParse({
        publishedUrl: 'https://example.com/blog/nas-guide',
        channel: '官网博客',
      }).success,
    ).toBe(true);
    expect(
      publishRecordCreateSchema.safeParse({
        publishedUrl: 'not-a-url',
        channel: '知乎',
      }).success,
    ).toBe(false);

    const sanitized = sanitizeRichArticleHtml(
      '<h2>对比表</h2><table><thead><tr><th>型号</th></tr></thead><tbody><tr><td>DXP4800</td></tr></tbody></table><script>alert(1)</script>',
    );
    expect(sanitized.contentHtml).toContain('<table>');
    expect(sanitized.contentHtml).not.toContain('<script>');
    expect(countArticleWords(sanitized.contentHtml)).toBeGreaterThan(5);
  });

  it('exports Markdown, HTML, DOCX, and round-trips ZIP archives cleanly', () => {
    const doc = {
      id: 'art_1',
      title: '2026 四盘位 NAS 实测',
      contentHtml: '<h2>核心结论</h2><p>满载噪音 24 dB。</p>',
      contentText: '核心结论\n满载噪音 24 dB。',
    };

    const md = htmlToExportMarkdown(doc);
    expect(md).toContain('# 2026 四盘位 NAS 实测');
    expect(md).toContain('## 核心结论');

    const htmlDoc = htmlToExportDocument(doc);
    expect(htmlDoc).toContain('<!DOCTYPE html>');
    expect(htmlDoc).toContain('满载噪音 24 dB');

    const docx = buildSingleDocxBytes(doc);
    const docxEntries = readZipStoreEntries(docx);
    expect(docxEntries.map((e) => e.path)).toContain('word/document.xml');

    const zip = buildArticleExportZip([doc], 'md');
    const zipEntries = readZipStoreEntries(zip);
    expect(zipEntries).toHaveLength(1);
    expect(zipEntries[0]?.path).toMatch(/^01-.*\.md$/);

    const rawZip = buildZipArchive([
      { path: 'hello.txt', data: new TextEncoder().encode('geomix-v2') },
    ]);
    const parsed = readZipStoreEntries(rawZip);
    expect(new TextDecoder().decode(parsed[0]?.data)).toBe('geomix-v2');
  });
});
