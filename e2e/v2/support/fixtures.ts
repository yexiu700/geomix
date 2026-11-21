import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { TestInfo } from '@playwright/test';

export const E2E_FIXTURE_HOST: string = (
  process.env.E2E_PUBLIC_FIXTURE_HOST?.trim() || 'public.e2e.example'
).toLowerCase();

export const FIXTURE_HOST: string = E2E_FIXTURE_HOST;

const COMPETITOR_NAS_REVIEW_URL = `http://${E2E_FIXTURE_HOST}/competitor/nas-review`;

export const FIXTURE_URLS = {
  cnProduct: `http://${E2E_FIXTURE_HOST}/brands/cn-product`,
  globalProduct: `http://${E2E_FIXTURE_HOST}/brands/global-product`,
  competitorNasReview: COMPETITOR_NAS_REVIEW_URL,
  competitorReview: COMPETITOR_NAS_REVIEW_URL,
  antiScrape403: `http://${E2E_FIXTURE_HOST}/anti-scrape/403`,
  antiScrapeLoginWall: `http://${E2E_FIXTURE_HOST}/anti-scrape/login-wall`,
  antiScrapeSlowTimeout: `http://${E2E_FIXTURE_HOST}/anti-scrape/slow-timeout`,
  ssrfLoopback: 'http://127.0.0.1:3001/api/v1/health',
  ssrfLocalhost: 'http://localhost:3001/api/v1/health',
  ssrfMetadata: 'http://169.254.169.254/latest/meta-data/',
  ssrfPrivate10: 'http://10.0.0.1/internal',
} as const;

export const E2E_SENTINELS = {
  GAP: '[E2E_GAP]',
  NEGATIVE: '[E2E_NEGATIVE]',
  LOW_RANK: '[E2E_LOW_RANK]',
  ECHO_TRAP: '[E2E_ECHO_TRAP]',
  ECHO_ONLY: '[E2E_ECHO_ONLY]',
  FANOUT_SEMI: '[E2E_FANOUT_SEMI]',
  NO_CITATIONS: '[E2E_NO_CITATIONS]',
  COMP_DOMAIN: '[E2E_COMP_DOMAIN]',
  MISSING_FACT: '[E2E_MISSING_FACT]',
  LLM_FAIL: '[E2E_LLM_FAIL]',
  SLOW_STREAM: '[E2E_SLOW_STREAM]',
  IMAGE_FAIL: '[E2E_IMAGE_FAIL]',
} as const;

export const CN_ENGINES = [
  'deepseek',
  'doubao',
  'yuanbao',
  'tongyi',
  'wenxin',
  'nami',
  'kimi',
  'zhipu',
] as const;

export const CN_ENGINE_KEYS = CN_ENGINES;

export const GLOBAL_ENGINES = ['chatgpt', 'perplexity', 'claude', 'gemini', 'google_aio'] as const;

export const GLOBAL_ENGINE_KEYS = GLOBAL_ENGINES;

export const LEGACY_FORBIDDEN_MENUS = [
  '素材源力',
  '关键词管理',
  '写作标题',
  '企业知识库',
  '企业图库',
  '文章分类',
  '写作指令',
  'AI写作任务',
  '流量复刻',
  '全网爆文复刻',
  '批量爆文复刻',
  '敬请期待',
  '账户余额',
  '¥0.00',
] as const;

export const SSRF_BLOCKED_URLS = [
  'http://127.0.0.1:3001/api/v1/health',
  'http://localhost:3000/',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.1/secret',
  'http://192.168.1.1/admin',
  'file:///etc/passwd',
] as const;

export const FAKE_EXIF_MARKER = 'E2E_FAKE_GPS_SECRET_42';

export const SAMPLE_COMPETITOR_PASTE_TEXT = [
  '# 2026 四盘位家用 NAS 深度横向实测对比',
  '',
  '## 1. 核心硬件与扩展接口对比',
  '测试机型均搭载低功耗四核处理器与双 2.5GbE 网口，对比了 M.2 NVMe 缓存加速、DDR5 内存扩展上限与金属散热机身结构。',
  '',
  '## 2. 满载噪声、待机功耗与连续读写实测',
  '在 24℃ 室温暗室环境下测得四盘满载读写功耗 38W–44W，待机功耗 11W–15W，距离 1 米处噪声 18.5dB–25.2dB，SMB 多通道实测连续吞吐 540MB/s。',
  '',
  '## 3. Docker 影音生态与相册 AI 检索体验',
  '支持本地 GPU 硬件转码 4K HDR 视频与离线人脸/语义相册索引，并提供完整的远程访问与快照容灾能力。',
  '',
  '## 4. 选购结论与不同预算人群建议',
  '家庭影视与多端备份优先选择低噪声金属机身与双 2.5GbE 配置；工作室团队需关注 RAID 校验速度、保修周期与技术支持响应。',
].join('\n');

export function uniqueTag(
  testInfo: Pick<TestInfo, 'testId' | 'retry'> & { workerIndex?: number },
  prefix = 'e2e',
): string {
  const cleanPrefix =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) || 'e2e';
  const worker = testInfo.workerIndex ?? 0;
  const ts = Date.now().toString(36).slice(-5);
  const rnd = randomBytes(2).toString('hex');
  return `${cleanPrefix}w${worker}r${testInfo.retry}${ts}${rnd}`;
}

export function uniqueIdemKey(prefix: string): string {
  const cleanPrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'v2';
  const safePrefix = cleanPrefix.startsWith('close') ? `k_${cleanPrefix}` : cleanPrefix;
  const ts = Date.now().toString(36);
  const rnd = randomBytes(4).toString('hex');
  return `${safePrefix}-${ts}-${rnd}`.slice(0, 120);
}

export function uniqueIdempotencyKey(
  testInfo: Pick<TestInfo, 'testId' | 'retry'> & { workerIndex?: number },
  prefix: string,
): string {
  return uniqueIdemKey(`${prefix}_${uniqueTag(testInfo, 'ik')}`);
}

export function buildGlobalMarketConfig(
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const slug =
    tag
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 18) || 'brand';
  return {
    locale: 'en-US',
    region: 'US',
    localBrandName: `AstraVault ${tag}`,
    aliases: [`AV-4800-${tag}`, 'AstraVault'],
    ownedDomains: [`astravault-${slug}.example`],
    competitors: [
      {
        name: 'EcoNAS',
        aliases: ['EcoNAS Pro'],
        domains: ['econas.example'],
      },
    ],
    ...overrides,
  };
}

export function buildCnBrandPayload(
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const slug =
    tag
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 18) || 'brand';
  return {
    name: `星曜智储${tag}`,
    category: '家用NAS网络存储',
    markets: [
      {
        market: 'CN',
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: `星曜智储${tag}`,
        aliases: [`XY-4800-${tag}`, '星曜NAS'],
        ownedDomains: [`xingyaonas-${slug}.example`],
        competitors: [
          {
            name: '极空存储',
            aliases: ['极空Z4'],
            domains: ['jikong.example'],
          },
          {
            name: '群晖',
            aliases: ['Synology'],
            domains: ['synology.example'],
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function buildDualMarketBrandPayload(
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const slug =
    tag
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 18) || 'brand';
  return {
    name: `星曜双轨${tag}`,
    category: '私有云 NAS',
    markets: [
      {
        market: 'CN',
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: `星曜双轨${tag}`,
        aliases: [`XY-4800-${tag}`, '星曜NAS'],
        ownedDomains: [`xingyao-${slug}.example`],
        competitors: [
          {
            name: '极空存储',
            aliases: ['极空Z4Pro'],
            domains: ['jikong.example'],
          },
        ],
      },
      {
        market: 'GLOBAL',
        ...buildGlobalMarketConfig(tag),
      },
    ],
    ...overrides,
  };
}

export function buildFourBrandFacts(brandName: string): Array<{
  slot: 'PRODUCT_SPECS' | 'DIFFERENTIATORS' | 'CREDENTIALS' | 'CASE_STUDIES';
  title: string;
  content: string;
  sourceType: 'MANUAL';
}> {
  return [
    {
      slot: 'PRODUCT_SPECS',
      title: `${brandName} 核心硬件与实测参数`,
      content:
        '四盘位航空铝合金机身，搭载 Intel N100 四核处理器与 16GB DDR5 内存，双 2.5GbE 网口与双 M.2 NVMe 缓存槽，最大扩展容量 96TB，实测待机功耗 11.2W、满载功耗 42W、1 米静音测试 18.5dB。',
      sourceType: 'MANUAL',
    },
    {
      slot: 'DIFFERENTIATORS',
      title: `${brandName} 差异化优势与适用场景`,
      content:
        '免工具磁吸快拆盘位，支持 Docker Compose 一键部署与本地离线相册 AI 识别，相较传统入门级塑料机身 NAS 散热温降 7.4℃，适合家庭 4K 影音与小型设计工作室多端协作。',
      sourceType: 'MANUAL',
    },
    {
      slot: 'CREDENTIALS',
      title: `${brandName} 权威资质与公开实测背书`,
      content:
        '通过 ISO9001 质量管理体系认证、国家 3C 与 CE/FCC 电磁兼容认证，持有 14 项静音风道与快照容灾专利，整机提供 3 年质保与 7×12 小时工程师响应。',
      sourceType: 'MANUAL',
    },
    {
      slot: 'CASE_STUDIES',
      title: `${brandName} 真实客户落地案例`,
      content:
        '上海某 12 人影视后期团队部署 2 台 48TB 阵列后，4K 代理素材内网协同传输速率稳定在 540MB/s，月度云盘费用降低 68%，连续运行 420 天零宕机。',
      sourceType: 'MANUAL',
    },
  ];
}

export function buildSizedFactText(targetChars: number, marker: string): string {
  const header = `【权威测试文档 ${marker}】核心实测记录：MTBF 指标与持续读写稳定性说明。\n`;
  const unit = `实测样本段落（${marker}）：四盘位 RAID5 阵列在 24℃ 恒温实验室连续 720 小时压力读写中，双 2.5GbE 聚合吞吐保持 540MB/s，满载功耗 42W，盘位温差低于 2.1℃，噪声维持 18.5dB。\n`;
  if (targetChars <= header.length) {
    return header.slice(0, targetChars);
  }
  const chunks: string[] = [header];
  let total = header.length;
  while (total < targetChars) {
    chunks.push(unit);
    total += unit.length;
  }
  return chunks.join('').slice(0, targetChars);
}

export function buildLongExtraDocFact(
  anchorToken: string,
  minChars = 6600,
): {
  slot: 'EXTRA_DOC';
  title: string;
  content: string;
  sourceType: 'MANUAL';
} {
  return {
    slot: 'EXTRA_DOC',
    title: `超长技术白皮书 ${anchorToken}`,
    content: buildSizedFactText(Math.max(minChars, 6200), anchorToken),
    sourceType: 'MANUAL',
  };
}

export function buildFourBrandFactsPayload(
  tag: string,
  options: {
    truthAgreed?: boolean;
    extraDocChars?: number;
    includeGlobalSpecs?: boolean;
  } = {},
): Record<string, unknown> {
  const facts: Array<Record<string, unknown>> = buildFourBrandFacts(`星曜${tag}`).map((item) => ({
    ...item,
    content:
      options.includeGlobalSpecs && item.slot === 'PRODUCT_SPECS'
        ? `${item.content} English spec: 100% aluminum chassis, Best-in-class 42W full load, Intel N100, dual 2.5GbE.`
        : item.content,
  }));

  if (typeof options.extraDocChars === 'number' && options.extraDocChars > 0) {
    facts.push({
      slot: 'EXTRA_DOC',
      title: `技术白皮书-${tag}`,
      content: buildSizedFactText(options.extraDocChars, `DOC_${tag}`),
      sourceType: 'MANUAL',
    });
  }

  return {
    facts,
    ...(options.truthAgreed !== undefined ? { truthAgreed: options.truthAgreed } : {}),
  };
}

// ---------- Pure-Node IEEE 802.3 CRC-32 + PNG + EXIF JPEG builders ----------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(computeCrc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

/**
 * Pure-Node valid 24-bit RGB PNG encoder (zero external dependencies).
 */
export function buildTestPngBuffer(width = 64, height = 64): Buffer {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: Truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = 1 + w * 3;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type None
    for (let x = 0; x < w; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = (x * 7 + 24) & 0xff;
      raw[px + 1] = (y * 5 + 96) & 0xff;
      raw[px + 2] = ((x + y) * 3 + 160) & 0xff;
    }
  }

  const compressed = deflateSync(raw);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const MINIMAL_16X16_JPEG_BASE64 =
  '/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIACYff/2Q==';

/**
 * Builds a valid 16x16 baseline JPEG with an injected APP1 (`FF E1`) `Exif\0\0`
 * TIFF header carrying `marker` in ImageDescription (Tag 0x010E).
 */
export function buildTestJpegWithExifBuffer(marker = FAKE_EXIF_MARKER): Buffer {
  const baseJpeg = Buffer.from(MINIMAL_16X16_JPEG_BASE64, 'base64');
  const descBytes = Buffer.from(`${marker}\0`, 'ascii');

  // Little-endian TIFF header ("II", 42, IFD0 offset = 8)
  // IFD0: 1 entry (Tag 0x010E ImageDescription, Type ASCII=2, Count=descBytes.length, Offset=26) + nextIFD=0
  const tiffHeader = Buffer.alloc(8 + 2 + 12 + 4);
  tiffHeader.write('II', 0, 'ascii');
  tiffHeader.writeUInt16LE(42, 2);
  tiffHeader.writeUInt32LE(8, 4);
  tiffHeader.writeUInt16LE(1, 8); // 1 IFD entry
  tiffHeader.writeUInt16LE(0x010e, 10); // ImageDescription
  tiffHeader.writeUInt16LE(2, 12); // ASCII
  tiffHeader.writeUInt32LE(descBytes.length, 14);
  tiffHeader.writeUInt32LE(26, 18); // value offset after IFD0
  tiffHeader.writeUInt32LE(0, 22); // next IFD offset = 0

  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiffHeader, descBytes]);
  const app1Header = Buffer.alloc(4);
  app1Header[0] = 0xff;
  app1Header[1] = 0xe1;
  app1Header.writeUInt16BE(exifPayload.length + 2, 2);

  // Splice APP1 immediately after SOI (FF D8)
  return Buffer.concat([baseJpeg.subarray(0, 2), app1Header, exifPayload, baseJpeg.subarray(2)]);
}
