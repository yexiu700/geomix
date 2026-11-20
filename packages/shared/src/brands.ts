import { z } from 'zod';
import { IMAGE_MAX_INPUT_BYTES, IMAGE_WARN_WIDTH } from './adapters';

/**
 * GeoMix 2.0 品牌与双市场资产契约（Issue #326 / #328）。
 * 包含 Brand / BrandMarket (CN | GLOBAL) / BrandFact / BrandMediaAsset 领域枚举、
 * 校验 Schema，以及从 v1 抽取复用的分块切分、图库校验与 AI 配图比例工具函数。
 */

export const GEO_MARKETS = ['CN', 'GLOBAL'] as const;
export type GeoMarket = (typeof GEO_MARKETS)[number];

export const GEO_MARKET_LABELS: Record<GeoMarket, string> = {
  CN: '国内市场',
  GLOBAL: '海外市场',
};

export const GEO_MARKET_DEFAULTS: Record<GeoMarket, { locale: string; region: string }> = {
  CN: { locale: 'zh-CN', region: 'CN' },
  GLOBAL: { locale: 'en-US', region: 'US' },
};

export const BRAND_FACT_SLOTS = [
  'PRODUCT_SPECS',
  'DIFFERENTIATORS',
  'CREDENTIALS',
  'CASE_STUDIES',
  'EXTRA_DOC',
] as const;
export type BrandFactSlot = (typeof BRAND_FACT_SLOTS)[number];

export const BRAND_FACT_SLOT_LABELS: Record<BrandFactSlot, string> = {
  PRODUCT_SPECS: '核心产品与参数',
  DIFFERENTIATORS: '差异化卖点',
  CREDENTIALS: '权威资质与背书',
  CASE_STUDIES: '真实客户案例',
  EXTRA_DOC: '补充长文档',
};

export const FACT_SOURCE_TYPES = [
  'MANUAL',
  'URL_EXTRACT',
  'DOC_UPLOAD',
  'STUDIO_FEEDBACK',
] as const;
export type FactSourceType = (typeof FACT_SOURCE_TYPES)[number];

export const FACT_INDEX_STATUSES = ['NONE', 'INDEXING', 'READY', 'FAILED'] as const;
export type FactIndexStatus = (typeof FACT_INDEX_STATUSES)[number];

export const FACT_INDEX_STATUS_LABELS: Record<FactIndexStatus, string> = {
  NONE: '直注免索引',
  INDEXING: '后台索引中',
  READY: '向量检索就绪',
  FAILED: '索引失败',
};

export const BRAND_MEDIA_ORIGINS = ['PRODUCT_UPLOAD', 'AI_INLINE_GEN'] as const;
export type BrandMediaOrigin = (typeof BRAND_MEDIA_ORIGINS)[number];

export const BRAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const BRAND_NAME_MAX = 80 as const;
export const BRAND_CATEGORY_MAX = 60 as const;
export const BRAND_MAX_COMPETITORS = 10 as const;

export const BRAND_FACT_FULL_INJECT_MAX = 6000 as const;
export const BRAND_FACT_CHUNK_SIZE = 600 as const;
export const BRAND_FACT_CHUNK_OVERLAP = 80 as const;
export const BRAND_FACT_TOP_K_CHUNKS = 5 as const;
export const BRAND_FACT_CARD_MAX = 20_000 as const;

export const BRAND_TRUTH_CHECKBOX_LABEL =
  '我确认所填品牌参数、资质与案例真实客观，符合广告与合规要求';

export const BRAND_TRUTH_AGREEMENT_TITLE = 'GeoMix 品牌事实信息真实性与合规承诺协议';

export const BRAND_TRUTH_AGREEMENT_PARAGRAPHS: readonly string[] = [
  '一、总则与适用范围：本承诺协议适用于商户在 GeoMix 平台创建、编辑及维护品牌资产与事实卡过程中录入的全部文字与图片资料，包括但不限于品牌名称、核心产品参数、差异化卖点、权威资质背书及客户案例。',
  '二、信息真实性义务：商户承诺所填写的品牌主体信息、产品规格、实测数据、交付能力及服务范围均源于真实经营情况，不存在虚构事实、隐瞒关键限制条件或伪造检验检测结论的行为。',
  '三、资质与背书核验：凡在「权威资质与背书」栏目提及专利、软件著作权、管理体系认证、行业奖项或第三方合作关系的，商户应持有合法有效且在有效期内的证明文件备查，不得录入已过期、被撤销或不属于本品牌的资质。',
  '四、案例与数据审慎原则：凡在「真实客户案例」或补充资料中引用项目成效或客户评价的，须具备真实履约依据并已取得必要的商业披露许可；未获书面同意公开名称的，应采用行业泛称脱敏描述，严禁虚构标杆客户。',
  '五、广告合规与公平竞争：商户应严格遵守目标市场适用的广告与反不正当竞争法律法规（中国国内市场遵守《中华人民共和国广告法》，海外市场遵守 FTC 客观评测规范），不得捏造、散布损害其他经营者商业信誉或商品声誉的内容。',
  '六、知识产权合法来源：商户保证所录入文本与上传实拍图片不侵犯任何第三方的著作权、商标权、商业秘密或其他合法权益。',
  '七、AI 辅助生成使用知悉：平台将依据商户录入的品牌事实进行结构化整理、向量检索或内容辅助生成。若底层录入资料失实，由此引发的行政处罚、民事索赔或平台投诉，均由录入商户独立承担全部法律责任。',
  '八、违约处置与留痕存证：平台在勾选确认时自动记录签署时间戳与网络来源地址。一经发现虚假或违法违规资料，平台有权采取拦截保存、下架关联内容直至封禁账号等处置措施。',
];

// ==================== 域名归一化（独立自包含，避免与 visibility.ts 循环依赖） ====================

const NON_WEB_SCHEME = /^(?:javascript|mailto|tel|data|blob|file|about):/i;
const VALID_DOMAIN_LABEL =
  /^[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?$/u;
const IPV4_DOTTED = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function extractRawBrandHost(raw: string): string {
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
  const authority = withoutScheme.split(/[/?#]/)[0] ?? '';
  const withoutUser = authority.includes('@') ? (authority.split('@').pop() ?? '') : authority;
  if (withoutUser.startsWith('[')) {
    const end = withoutUser.indexOf(']');
    return end >= 0 ? withoutUser.slice(1, end) : '';
  }
  return withoutUser.replace(/:\d+$/, '');
}

/**
 * 归一化品牌官网/竞品域名为小写裸域名（去掉协议、www.、端口、路径、锚点与末尾点）。
 * 输入非法时返回空字符串，不抛异常。
 */
export function normalizeBrandDomain(urlOrDomain: string): string {
  if (typeof urlOrDomain !== 'string') return '';
  const trimmed = urlOrDomain.trim();
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return '';
  if (NON_WEB_SCHEME.test(trimmed)) return '';

  let host = '';
  const candidateUrl = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidateUrl)) {
    try {
      const parsed = new URL(candidateUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      host = parsed.hostname;
    } catch {
      host = extractRawBrandHost(trimmed);
    }
  } else {
    try {
      const parsed = new URL(`https://${trimmed}`);
      host = parsed.hostname;
    } catch {
      host = extractRawBrandHost(trimmed);
    }
  }

  const cleaned = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .replace(/^www\./, '');

  if (!cleaned || cleaned.includes(':')) return '';
  if (IPV4_DOTTED.test(cleaned)) return cleaned;

  const parts = cleaned.split('.');
  if (parts.length < 2) return '';
  const tld = parts[parts.length - 1] ?? '';
  if (tld.length < 2 || /^\d+$/.test(tld)) return '';
  if (!parts.every((part) => VALID_DOMAIN_LABEL.test(part))) return '';

  return cleaned;
}

// ==================== 事实分块与品牌名格式化（从 knowledge.ts 抽取） ====================

export function requiresBrandFactVectorIndex(totalChars: number): boolean {
  return totalChars > BRAND_FACT_FULL_INJECT_MAX;
}

/**
 * 按段落感知与固定窗口重叠切分长文档事实（默认每块 600 字，重叠 80 字）。
 */
export function chunkKnowledgeText(
  rawText: string,
  chunkSize: number = BRAND_FACT_CHUNK_SIZE,
  overlap: number = BRAND_FACT_CHUNK_OVERLAP,
): string[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chars = Array.from(normalized);
  if (chars.length <= chunkSize) {
    return [normalized];
  }

  const safeChunk = Math.max(100, chunkSize);
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(safeChunk / 2)));
  const step = safeChunk - safeOverlap;

  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + safeChunk, chars.length);
    if (end < chars.length) {
      const minBreak = start + Math.floor(safeChunk * 0.65);
      for (let cursor = end; cursor > minBreak; cursor -= 1) {
        const ch = chars[cursor - 1];
        if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '；') {
          end = cursor;
          break;
        }
      }
    }
    const piece = chars.slice(start, end).join('').trim();
    if (piece.length > 0) {
      chunks.push(piece);
    }
    if (end >= chars.length) break;
    const nextStart = end - safeOverlap;
    start = nextStart > start ? nextStart : start + step;
  }
  return chunks;
}

export const chunkBrandFactText = chunkKnowledgeText;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 拼接「公司全称（品牌简称）」，避免重复括号。
 */
export function formatCompanyBrandLabel(
  companyName?: string | null,
  brand?: string | null,
): string {
  const cleanCompany = (companyName ?? '').trim();
  const cleanBrand = (brand ?? '').trim();
  if (!cleanCompany) return cleanBrand;
  if (!cleanBrand) return cleanCompany;

  if (cleanCompany.toLowerCase() === cleanBrand.toLowerCase()) {
    return cleanCompany;
  }

  const escaped = escapeRegExp(cleanBrand);
  const parenBrandRegex = new RegExp(`[（(]\\s*${escaped}\\s*[）)]`, 'i');
  if (parenBrandRegex.test(cleanCompany)) {
    const dupRegex = new RegExp(`([（(]\\s*${escaped}\\s*[）)])(?:\\s*\\1)+`, 'gi');
    return cleanCompany.replace(dupRegex, '$1');
  }

  return `${cleanCompany}（${cleanBrand}）`;
}

// ==================== 品牌产品实拍图与存储工具（从 gallery.ts 抽取） ====================

export const BRAND_MEDIA_THUMB_MAX_EDGE = 240 as const;
export const BRAND_MEDIA_UPLOAD_MAX_FILES = 20 as const;
export const BRAND_MEDIA_FILE_TOO_LARGE_MSG = '单张图片不能超过 100MB';
export const BRAND_MEDIA_FILE_FORMAT_MSG = '仅支持 JPG、PNG、WebP 格式图片';

/** 保持 api-exception.filter.ts 兼容的导出别名。 */
export const GALLERY_FILE_TOO_LARGE_MSG = BRAND_MEDIA_FILE_TOO_LARGE_MSG;

export type MediaStorageSummary = {
  used: string;
  limit: string;
  usedText: string;
  limitText: string;
};

const ALLOWED_MIME_SET = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const ALLOWED_EXT_RE = /\.(jpe?g|png|webp)$/i;

export function validateClientUploadFile(input: {
  name: string;
  size: number;
  type?: string;
}): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, message: '图片文件为空' };
  }
  if (input.size > IMAGE_MAX_INPUT_BYTES) {
    return { ok: false, message: BRAND_MEDIA_FILE_TOO_LARGE_MSG };
  }
  const mime = (input.type ?? '').trim().toLowerCase();
  const hasAllowedMime = mime.length > 0 && ALLOWED_MIME_SET.has(mime);
  const hasAllowedExt = ALLOWED_EXT_RE.test(input.name.trim());
  if (!hasAllowedMime && !hasAllowedExt) {
    return { ok: false, message: BRAND_MEDIA_FILE_FORMAT_MSG };
  }
  return { ok: true };
}

export function checkImageWidthWarning(width: number): string | undefined {
  if (Number.isFinite(width) && width > 0 && width < IMAGE_WARN_WIDTH) {
    return `图片宽度 ${width}px 小于建议值 ${IMAGE_WARN_WIDTH}px，仅提示不影响上传`;
  }
  return undefined;
}

export function formatGalleryBytes(value: bigint | number | string): string {
  let bytes: bigint;
  try {
    bytes = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return '0 B';
  }
  if (bytes <= 0n) return '0 B';
  const kb = 1024n;
  const mb = 1024n * 1024n;
  if (bytes >= mb) {
    const whole = bytes / mb;
    const rem = ((bytes % mb) * 10n) / mb;
    return rem === 0n ? `${whole} MB` : `${whole}.${rem} MB`;
  }
  if (bytes >= kb) {
    const whole = bytes / kb;
    const rem = ((bytes % kb) * 10n) / kb;
    return rem === 0n ? `${whole} KB` : `${whole}.${rem} KB`;
  }
  return `${bytes} B`;
}

export function buildStorageSummary(used: bigint, limit: bigint): MediaStorageSummary {
  return {
    used: used.toString(),
    limit: limit.toString(),
    usedText: formatGalleryBytes(used),
    limitText: formatGalleryBytes(limit),
  };
}

function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export function sanitizeMediaOriginalName(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripControlChars(raw).split(/[/\\]/).pop()?.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return Array.from(cleaned).slice(0, 160).join('');
}

// ==================== 行内 AI 配图常量与比例（从 ai-images.ts 抽取） ====================

export const AI_IMAGE_PROMPT_MIN = 5;
export const AI_IMAGE_PROMPT_MAX = 500;
export const AI_IMAGE_DEFAULT_UNIT_POINTS = 5;

export const AI_IMAGE_RATIOS = [
  '21:9',
  '16:9',
  '4:3',
  '3:2',
  '1:1',
  '2:3',
  '3:4',
  '9:16',
  '9:21',
] as const;
export type AiImageRatio = (typeof AI_IMAGE_RATIOS)[number];

export const AI_IMAGE_DEFAULT_RATIO: AiImageRatio = '16:9';

export const AI_IMAGE_RATIO_LABELS: Record<AiImageRatio, string> = {
  '21:9': '21:9 超宽横幅',
  '16:9': '16:9 宽屏横图',
  '4:3': '4:3 标准横图',
  '3:2': '3:2 摄影横图',
  '1:1': '1:1 方形构图',
  '2:3': '2:3 摄影竖图',
  '3:4': '3:4 标准竖图',
  '9:16': '9:16 竖屏长图',
  '9:21': '9:21 超长竖图',
};

export const AI_IMAGE_STYLES = [
  '写实摄影',
  '产品静物',
  '商务科技',
  '生活场景',
  '扁平插画',
  '3D立体',
] as const;
export type AiImageStyle = (typeof AI_IMAGE_STYLES)[number];

export function isAiImageRatio(value: string): value is AiImageRatio {
  return (AI_IMAGE_RATIOS as readonly string[]).includes(value);
}

export function resolveAiImageRatioDimensions(ratio: AiImageRatio): {
  width: number;
  height: number;
} {
  switch (ratio) {
    case '21:9':
      return { width: 1260, height: 540 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '4:3':
      return { width: 1024, height: 768 };
    case '3:2':
      return { width: 1080, height: 720 };
    case '1:1':
      return { width: 960, height: 960 };
    case '2:3':
      return { width: 720, height: 1080 };
    case '3:4':
      return { width: 768, height: 1024 };
    case '9:16':
      return { width: 720, height: 1280 };
    case '9:21':
      return { width: 600, height: 1400 };
  }
}

export function isPlaceholderImageModel(model: string | null | undefined): boolean {
  const normalized = (model ?? '').trim().toLowerCase();
  return normalized === 'fake-image' || normalized.startsWith('fake-');
}

// ==================== Zod Schemas & DTOs ====================

export const brandCompetitorSchema = z.object({
  name: z.string().trim().min(1, '请填写竞品名称').max(BRAND_NAME_MAX),
  aliases: z.array(z.string().trim().min(1).max(BRAND_NAME_MAX)).max(20).default([]),
  domains: z
    .array(z.string().trim().min(1).max(255))
    .max(10)
    .default([])
    .transform((items) =>
      Array.from(new Set(items.map((d) => normalizeBrandDomain(d)).filter(Boolean))),
    ),
});

export type BrandCompetitor = z.output<typeof brandCompetitorSchema>;

export const brandMarketConfigSchema = z.object({
  market: z.enum(GEO_MARKETS),
  locale: z.string().trim().min(2).max(16).optional(),
  region: z.string().trim().min(2).max(16).optional(),
  localBrandName: z.string().trim().min(1, '请填写当地品牌名称').max(BRAND_NAME_MAX).optional(),
  aliases: z.array(z.string().trim().min(1).max(BRAND_NAME_MAX)).max(20).default([]),
  ownedDomains: z.array(z.string().trim().min(1).max(255)).max(20).default([]),
  competitors: z.array(brandCompetitorSchema).max(BRAND_MAX_COMPETITORS).default([]),
  seedPrompts: z.array(z.string().trim().min(2).max(300)).max(50).default([]),
});

const brandMarketEntrySchema = z.union([
  z.enum(GEO_MARKETS).transform((market) => ({
    market,
    aliases: [] as string[],
    ownedDomains: [] as string[],
    competitors: [] as BrandCompetitor[],
    seedPrompts: [] as string[],
  })),
  brandMarketConfigSchema,
]);

export const createBrandSchema = z.object({
  name: z.string().trim().min(1, '请填写品牌名称').max(BRAND_NAME_MAX),
  category: z.string().trim().min(1, '请填写所属品类').max(BRAND_CATEGORY_MAX),
  markets: z
    .array(brandMarketEntrySchema)
    .min(1, '请至少选择一个目标市场')
    .max(2)
    .refine((ms) => new Set(ms.map((m) => m.market)).size === ms.length, '目标市场不能重复'),
  ownedDomains: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  competitors: z.array(brandCompetitorSchema).max(BRAND_MAX_COMPETITORS).optional(),
  truthAgreed: z.boolean().optional(),
});

export type CreateBrandInput = z.input<typeof createBrandSchema>;
export type ParsedCreateBrandInput = z.output<typeof createBrandSchema>;

export const updateBrandSchema = z
  .object({
    name: z.string().trim().min(1, '请填写品牌名称').max(BRAND_NAME_MAX).optional(),
    category: z.string().trim().min(1, '请填写所属品类').max(BRAND_CATEGORY_MAX).optional(),
    truthAgreed: z.boolean().optional(),
  })
  .refine((val) => Object.keys(val).length > 0, '至少修改一项品牌信息');

export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;

export const upsertBrandMarketSchema = brandMarketConfigSchema.omit({ market: true });

export type UpsertBrandMarketInput = z.input<typeof upsertBrandMarketSchema>;
export type ParsedUpsertBrandMarketInput = z.output<typeof upsertBrandMarketSchema>;

export const brandFactItemInputSchema = z.object({
  slot: z.enum(BRAND_FACT_SLOTS),
  title: z.string().trim().min(1, '请填写事实卡标题').max(120),
  content: z.string().trim().max(BRAND_FACT_CARD_MAX),
  sourceType: z.enum(FACT_SOURCE_TYPES).default('MANUAL'),
  sourceUrl: z.string().trim().url('来源链接格式不正确').max(2048).nullable().optional(),
});

export const upsertBrandFactsSchema = z.object({
  facts: z.array(brandFactItemInputSchema).min(1, '请至少保存一条事实卡').max(20),
  truthAgreed: z.boolean().optional(),
});

export type UpsertBrandFactsInput = z.input<typeof upsertBrandFactsSchema>;

export const extractBrandFactsSchema = z
  .object({
    sourceType: z.enum(['URL_EXTRACT', 'DOC_UPLOAD', 'MANUAL']),
    url: z.string().trim().url('请输入有效的官网链接').max(2048).optional(),
    rawText: z.string().trim().min(10, '资料内容至少 10 字').max(50_000).optional(),
    fileName: z.string().trim().max(160).optional(),
  })
  .refine((data) => Boolean(data.url || data.rawText), '请提供官网链接或粘贴产品资料');

export type ExtractBrandFactsInput = z.infer<typeof extractBrandFactsSchema>;

export const inlineAiImageGenSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(AI_IMAGE_PROMPT_MIN, `提示词至少 ${AI_IMAGE_PROMPT_MIN} 个字`)
    .max(AI_IMAGE_PROMPT_MAX, `提示词不超过 ${AI_IMAGE_PROMPT_MAX} 个字`),
  ratio: z.enum(AI_IMAGE_RATIOS).default(AI_IMAGE_DEFAULT_RATIO),
  style: z.string().trim().max(32).optional(),
  title: z.string().trim().max(120).optional(),
});

export type InlineAiImageGenInput = z.input<typeof inlineAiImageGenSchema>;

export type BrandMarketRecord = {
  id: string;
  brandId: string;
  market: GeoMarket;
  locale: string;
  region: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: BrandCompetitor[];
  seedPrompts: string[];
  createdAt: string;
  updatedAt: string;
};

export type BrandFactRecord = {
  id: string;
  brandId: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  indexStatus: FactIndexStatus;
  createdAt: string;
  updatedAt: string;
};

export type BrandMediaAssetRecord = {
  id: string;
  brandId: string;
  origin: BrandMediaOrigin;
  title: string;
  objectKey: string;
  thumbKey: string | null;
  url: string;
  thumbUrl: string | null;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  aiPrompt: string | null;
  aiModel: string | null;
  usedCount: number;
  createdAt: string;
};

export type BrandRecord = {
  id: string;
  name: string;
  category: string;
  truthAgreementSignedAt: string | null;
  createdAt: string;
  updatedAt: string;
  markets: BrandMarketRecord[];
  factCount?: number;
  mediaCount?: number;
};

export type BrandListResponse = {
  items: BrandRecord[];
};
