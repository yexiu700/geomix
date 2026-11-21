import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PdfExtractError, extractTextFromPdf } from './pdf-extract';

describe('extractTextFromPdf', () => {
  it('extracts text from uncompressed literal strings and TJ kerning arrays', () => {
    const pdf = Buffer.from(
      `%PDF-1.4
1 0 obj
<< /Length 120 >>
stream
BT
/F1 12 Tf
72 720 Td
(Model X400 Pro: 16GB DDR5, Dual 10GbE) Tj
0 -18 Td
[(Low) -200 (noise) -200 (26 dBA) -200 (ISO9001)] TJ
ET
endstream
endobj
%%EOF`,
      'latin1',
    );

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('Model X400 Pro: 16GB DDR5, Dual 10GbE');
    expect(text).toContain('Low noise 26 dBA ISO9001');
  });

  it('extracts text from FlateDecode compressed streams and UTF-16BE hex strings', () => {
    // Encode "产品规格 28dB 静音" as UTF-16BE hex with BOM FEFF
    const utf16Sample = '产品规格 28dB 静音低功耗设计';
    const hexChars: string[] = ['FEFF'];
    for (let i = 0; i < utf16Sample.length; i += 1) {
      hexChars.push(utf16Sample.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0'));
    }
    const streamBody = `BT\n/F1 12 Tf\n<${hexChars.join('')}> Tj\nET\n`;
    const compressed = deflateSync(Buffer.from(streamBody, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.5\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('产品规格 28dB 静音低功耗设计');
  });

  it('decodes CID hex strings via /ToUnicode CMap tables', () => {
    const cmapStream = `begincmap
2 beginbfchar
<0001> <4EA7>
<0002> <54C1>
endbfchar
1 beginbfrange
<0010> <0019> <0030>
endbfrange
endcmap`;
    const textStream = `BT
/F1 12 Tf
<000100020012001000120016> Tj
0 -14 Td
( Certified ISO9001 Specification Sheet) Tj
ET`;
    const pdf = Buffer.from(
      `%PDF-1.4
1 0 obj
<< /Length ${cmapStream.length} >>
stream
${cmapStream}
endstream
endobj
2 0 obj
<< /Length ${textStream.length} >>
stream
${textStream}
endstream
endobj
%%EOF`,
      'latin1',
    );

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('产品2026');
    expect(text).toContain('Certified ISO9001 Specification Sheet');
  });

  it('rejects non-PDF headers, encrypted PDFs, and image-only empty PDFs with explicit reasons', () => {
    expect(() => extractTextFromPdf(Buffer.from('not a pdf document at all'))).toThrowError(
      PdfExtractError,
    );
    try {
      extractTextFromPdf(Buffer.from('not a pdf document at all'));
    } catch (err) {
      expect((err as PdfExtractError).reason).toBe('invalid_header');
    }

    const encrypted = Buffer.from('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF', 'latin1');
    try {
      extractTextFromPdf(encrypted);
    } catch (err) {
      expect((err as PdfExtractError).reason).toBe('encrypted');
    }

    const imageOnly = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Subtype /Image /Length 12 >>\nstream\n0123456789ab\nendstream\nendobj\n%%EOF',
      'latin1',
    );
    try {
      extractTextFromPdf(imageOnly);
    } catch (err) {
      expect((err as PdfExtractError).reason).toBe('empty_text');
    }
  });

  it('detects /FlateDecode when the stream dictionary contains nested << ... >> sub-dictionaries (1a)', () => {
    const streamBody = 'BT /F1 12 Tf (Aurora DXP4800 Nested Dict Specs 32GB DDR5) Tj ET';
    const compressed = deflateSync(Buffer.from(streamBody, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >> /Length ${compressed.length} >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('Aurora DXP4800 Nested Dict Specs 32GB DDR5');
  });

  it('does not prematurely terminate BT..ET blocks on ET inside literal strings, comments, or nested parens (1b)', () => {
    const streamBody = [
      'BT',
      '/F1 12 Tf',
      '% comment mentioning ET should be ignored',
      '(NETFLIX ET AL (ET) benchmark \\) ET still literal) Tj',
      '0 -14 Td',
      '(Standby power 12W and 22dBA) Tj',
      'ET',
    ].join('\n');
    const compressed = deflateSync(Buffer.from(streamBody, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.5\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('NETFLIX ET AL (ET) benchmark ) ET still literal');
    expect(text).toContain('Standby power 12W and 22dBA');
  });

  it('tolerates partial /ToUnicode CMap hits when an unmapped CID like space 0020 appears (1c)', () => {
    const cmapStream = `begincmap
10 beginbfchar
<0001> <5BB6>
<0002> <7528>
<0003> <50A8>
<0004> <80FD>
<0005> <7535>
<0006> <6E90>
<0007> <5B9E>
<0008> <6D4B>
<0009> <53C2>
<000A> <6570>
endbfchar
endcmap`;
    // 0020 is an unmapped ASCII space CID between mapped CJK glyphs
    const textStream = 'BT\n/F1 12 Tf\n<0001000200200003000400050006000700080009000A> Tj\nET';
    const pdf = Buffer.from(
      `%PDF-1.5
1 0 obj
<< /Length ${cmapStream.length} >>
stream
${cmapStream}
endstream
endobj
2 0 obj
<< /Length ${textStream.length} >>
stream
${textStream}
endstream
endobj
%%EOF`,
      'latin1',
    );

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('家用 储能电源实测参数');
  });

  it('supports PDF 1.7 beginbfrange array syntax alongside linear ranges (1d)', () => {
    const cmapStream = `begincmap
2 beginbfrange
<0001> <0006> [<5BB6> <7528> <50A8> <80FD> <7535> <6E90>]
<0010> <0019> <0030>
endbfrange
endcmap`;
    const textStream = `BT
/F1 12 Tf
<00010002000300040005000600200012001000100010> Tj
0 -14 Td
(Specs 2000Wh LiFePO4) Tj
ET`;
    const pdf = Buffer.from(
      `%PDF-1.7
1 0 obj
<< /Length ${cmapStream.length} >>
stream
${cmapStream}
endstream
endobj
2 0 obj
<< /Length ${textStream.length} >>
stream
${textStream}
endstream
endobj
%%EOF`,
      'latin1',
    );

    const text = extractTextFromPdf(pdf);
    expect(text).toContain('家用储能电源 2000');
    expect(text).toContain('Specs 2000Wh LiFePO4');
  });

  it('ignores >> inside PDF comments placed between stream dictionary and stream keyword', () => {
    const streamBody = 'BT /F1 12 Tf (Comment With Double Angle Bracket 14.5W 24dBA) Tj ET';
    const compressed = deflateSync(Buffer.from(streamBody, 'latin1'));
    const pdfMid = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\n% note: a >> b\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);

    expect(extractTextFromPdf(pdfMid)).toContain('Comment With Double Angle Bracket 14.5W 24dBA');

    const pdfTrailing = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\n% note: trailing >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);

    expect(extractTextFromPdf(pdfTrailing)).toContain(
      'Comment With Double Angle Bracket 14.5W 24dBA',
    );
  });
});
