import { describe, expect, it } from 'vitest';
import {
  articleCreateSchema,
  buildArticleExportZip,
  countArticleWords,
  parseArticleManageQuery,
  readZipStoreEntries,
  sanitizeRichArticleHtml,
} from './articles';

describe('articles shared helpers', () => {
  it('defaults manual article status to NORMAL and parses full manage filters', () => {
    const parsed = articleCreateSchema.parse({
      title: '光纤激光切割机日常保养清单',
      categoryId: 'cat_001',
      contentHtml: '<h2>日常点检</h2><p>每日开机前检查水冷机温度与保护镜片。</p>',
    });
    expect(parsed.status).toBe('NORMAL');

    const query = parseArticleManageQuery({
      page: '2',
      pageSize: '25',
      categoryId: 'cat_001',
      taskId: 'task_001',
      keyword: '保养',
      status: 'PENDING',
      sendCount: '0',
      videoCount: '0',
      createdFrom: '2026-11-01',
      createdTo: '2026-11-30',
      sort: 'sendCount',
      order: 'asc',
    });
    expect(query).toMatchObject({
      page: 2,
      pageSize: 25,
      categoryId: 'cat_001',
      taskId: 'task_001',
      keyword: '保养',
      status: 'PENDING',
      sendCount: 0,
      videoCount: 0,
      sort: 'sendCount',
      order: 'asc',
    });
  });

  it('sanitizes rich HTML while stripping scripts/handlers and counts plain-text words accurately', () => {
    const res = sanitizeRichArticleHtml(
      '<h1>激光选型</h1><script>alert(1)</script><p onclick="evil()">精密板材加工<b>核心指标</b></p><img src="javascript:evil()" /><img src="/uploads/a.jpg" alt="实景" />',
    );
    expect(res.contentHtml).not.toContain('<script');
    expect(res.contentHtml).not.toContain('onclick');
    expect(res.contentHtml).not.toContain('javascript:');
    expect(res.contentHtml).toContain('<h2>激光选型</h2>');
    expect(res.contentHtml).toContain('<strong>核心指标</strong>');
    expect(res.contentHtml).toContain('<img src="/uploads/a.jpg" alt="实景"');
    expect(countArticleWords(res.contentHtml)).toBe(14);
  });

  it('builds valid openable ZIP archives for Markdown, HTML, and Word Docx with UTF-8 titles', () => {
    const sampleDocs = [
      {
        id: 'art_1',
        title: '双交换台激光切割机选型指南',
        categoryName: '装备科普',
        coverUrl: '/uploads/cover1.jpg',
        contentHtml:
          '<h2>一、床身结构</h2><p>分段焊接高温退火床身能够稳定保持长期加工精度。</p><ul><li>检查导轨平行度</li><li>核验除尘风道</li></ul>',
        contentText: '一、床身结构 分段焊接高温退火床身能够稳定保持长期加工精度。',
      },
      {
        id: 'art_2',
        title: '板管一体机气路配置说明',
        categoryName: '装备科普',
        coverUrl: null,
        contentHtml: '<h2>氮气与氧气切换</h2><p>薄板不锈钢切割通常采用高压氮气保护切口。</p>',
        contentText: '氮气与氧气切换 薄板不锈钢切割通常采用高压氮气保护切口。',
      },
    ];

    const decoder = new TextDecoder('utf-8');

    // 1. Markdown ZIP
    const mdZip = buildArticleExportZip(sampleDocs, 'md');
    const mdEntries = readZipStoreEntries(mdZip);
    expect(mdEntries.map((e) => e.path)).toEqual([
      '01-双交换台激光切割机选型指南.md',
      '02-板管一体机气路配置说明.md',
    ]);
    const mdText = decoder.decode(mdEntries[0]!.data);
    expect(mdText).toContain('# 双交换台激光切割机选型指南');
    expect(mdText).toContain('## 一、床身结构');
    expect(mdText).toContain('- 检查导轨平行度');

    // 2. HTML ZIP
    const htmlZip = buildArticleExportZip(sampleDocs, 'html');
    const htmlEntries = readZipStoreEntries(htmlZip);
    expect(htmlEntries[0]!.path).toBe('01-双交换台激光切割机选型指南.html');
    const htmlText = decoder.decode(htmlEntries[0]!.data);
    expect(htmlText).toContain('<!DOCTYPE html>');
    expect(htmlText).toContain('<h1>双交换台激光切割机选型指南</h1>');

    // 3. DOCX ZIP (nested OOXML .docx inside outer .zip)
    const docxZip = buildArticleExportZip(sampleDocs, 'docx');
    const docxEntries = readZipStoreEntries(docxZip);
    expect(docxEntries.map((e) => e.path)).toEqual([
      '01-双交换台激光切割机选型指南.docx',
      '02-板管一体机气路配置说明.docx',
    ]);
    const innerDocxParts = readZipStoreEntries(docxEntries[0]!.data);
    expect(innerDocxParts.map((p) => p.path)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    const wordXml = decoder.decode(innerDocxParts[2]!.data);
    expect(wordXml).toContain('<w:document');
    expect(wordXml).toContain('双交换台激光切割机选型指南');
    expect(wordXml).toContain('分段焊接高温退火床身能够稳定保持长期加工精度。');
  });
});
