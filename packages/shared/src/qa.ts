import { deflateSync } from 'node:zlib';

export const E2E_DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
export const E2E_DEFAULT_API_BASE = 'http://127.0.0.1:3001/api/v1';
export const E2E_DEFAULT_FIXTURE_HOST = 'public.e2e.example';

export const E2E_MAIN_FLOW_STEPS = [
  'M01',
  'M02',
  'M03',
  'M04',
  'M05',
  'M06',
  'M07',
  'M08',
  'M09',
] as const;

export const QA_BASELINE_SCREEN_IDS = [
  'S00',
  'S01',
  'S02',
  'S03',
  'S04',
  'S05',
  'S06',
  'S07',
  'S08',
  'S09',
  'S10',
  'S11',
  'S12',
  'S13',
  'S14',
  'S15',
  'S16',
  'S17',
  'S18',
  'S19',
  'S20',
  'S21',
  'S22',
  'S23',
  'S24',
  'S25',
  'S26',
  'S27',
] as const;

export const QA_EXTENDED_SCREEN_IDS = ['L01', 'V01', 'V02', 'A01'] as const;

export type E2eRuntimeConfig = {
  baseUrl: string;
  apiBase: string;
  fixtureHost: string;
};

export function resolveE2eRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): E2eRuntimeConfig {
  const baseUrl = (env.E2E_BASE_URL?.trim() || E2E_DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiBase = (env.E2E_API_BASE?.trim() || E2E_DEFAULT_API_BASE).replace(/\/$/, '');
  const fixtureHost = (env.E2E_PUBLIC_FIXTURE_HOST?.trim() || E2E_DEFAULT_FIXTURE_HOST)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return { baseUrl, apiBase, fixtureHost };
}

export type QaChecklistValidationResult = {
  ok: boolean;
  missingMainSteps: string[];
  missingBaselineScreens: string[];
  missingExtendedScreens: string[];
  uncheckedItems: string[];
  unclosedStatusLines: string[];
  externalImageLinks: string[];
};

export function validateQaChecklistMarkdown(markdown: string): QaChecklistValidationResult {
  const missingMainSteps = E2E_MAIN_FLOW_STEPS.filter((step) => !markdown.includes(`| ${step} |`));
  const missingBaselineScreens = QA_BASELINE_SCREEN_IDS.filter(
    (id) => !markdown.includes(`| \`${id}\` |`),
  );
  const missingExtendedScreens = QA_EXTENDED_SCREEN_IDS.filter(
    (id) => !markdown.includes(`| \`${id}\` |`),
  );

  const lines = markdown.split(/\r?\n/);
  const uncheckedItems = lines.filter((line) => /\[\s\]/.test(line));
  const unclosedStatusLines = lines.filter((line) => {
    if (!line.startsWith('|')) return false;
    return /(待修复|未修复|未关闭差异\s*[1-9]|待闭环|TODO|FIXME)/i.test(line);
  });

  const externalImageLinks: string[] = [];
  const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null = imageRegex.exec(markdown);
  while (match) {
    const target = match[1]?.trim() ?? '';
    if (target) externalImageLinks.push(target);
    match = imageRegex.exec(markdown);
  }

  const ok =
    missingMainSteps.length === 0 &&
    missingBaselineScreens.length === 0 &&
    missingExtendedScreens.length === 0 &&
    uncheckedItems.length === 0 &&
    unclosedStatusLines.length === 0 &&
    externalImageLinks.length === 0 &&
    markdown.includes('GeoMix') &&
    markdown.includes('零未关闭差异');

  return {
    ok,
    missingMainSteps,
    missingBaselineScreens,
    missingExtendedScreens,
    uncheckedItems,
    unclosedStatusLines,
    externalImageLinks,
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0;
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generates a deterministic, dependency-free valid RGB PNG image buffer for E2E uploads.
 */
export function buildSolidRgbPng(
  width = 600,
  height = 400,
  rgb: readonly [number, number, number] = [22, 119, 255],
): Buffer {
  if (!Number.isInteger(width) || width < 1 || width > 4096) {
    throw new RangeError('width must be 1..4096');
  }
  if (!Number.isInteger(height) || height < 1 || height > 4096) {
    throw new RangeError('height must be 1..4096');
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // RGB color type
  ihdr[10] = 0; // deflate compression
  ihdr[11] = 0; // adaptive filter
  ihdr[12] = 0; // non-interlaced

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  const [r, g, b] = rgb;
  const singleRow = Buffer.alloc(rowBytes);
  singleRow[0] = 0; // filter: None
  for (let x = 0; x < width; x += 1) {
    const offset = 1 + x * 3;
    singleRow[offset] = r & 0xff;
    singleRow[offset + 1] = g & 0xff;
    singleRow[offset + 2] = b & 0xff;
  }
  for (let y = 0; y < height; y += 1) {
    singleRow.copy(raw, y * rowBytes);
  }

  const compressed = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
