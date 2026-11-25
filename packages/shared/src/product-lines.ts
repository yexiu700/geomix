import { z } from 'zod';
import {
  BRAND_CATEGORY_MAX,
  BRAND_MAX_COMPETITORS,
  BRAND_NAME_MAX,
  brandCompetitorSchema,
  containsCjk,
  resolveGlobalCategoryLabel,
  type BrandCompetitor,
  type GeoMarket,
} from './brands';

export const BRAND_MAX_PRODUCT_LINES = 20 as const;
export const PRODUCT_LINE_MAX_SEED_PROMPTS = 50 as const;

export type ProductLineLocalNames = Partial<Record<GeoMarket, string>>;
export type ProductLineLocalCategories = Partial<Record<GeoMarket, string>>;
export type ProductLineSeedPrompts = Partial<Record<GeoMarket, string[]>>;
export type ProductLineCompetitors = Partial<Record<GeoMarket, BrandCompetitor[]>>;

export type BrandProductLineDto = {
  id: string;
  brandId: string;
  name: string;
  localNamesJson: ProductLineLocalNames;
  category: string;
  localCategoriesJson: ProductLineLocalCategories;
  seedPromptsJson: ProductLineSeedPrompts;
  competitorsJson: ProductLineCompetitors;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type BrandProductLineListResponse = {
  items: BrandProductLineDto[];
};

export type BrandProductLineDeleteResponse = {
  deleted: number;
  id: string;
};

function optionalMarketStringSchema(max: number, label: string) {
  return z.preprocess(
    (value) => {
      if (value === null || value === undefined) return undefined;
      if (typeof value === 'string' && value.trim() === '') return undefined;
      return value;
    },
    z.string().trim().max(max, `${label}不超过 ${max} 字`).optional(),
  );
}

function dedupePromptsCaseInsensitive(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function marketSeedPromptsSchema() {
  return z
    .array(z.string().trim().min(2, '监控问题至少 2 个字').max(300, '监控问题最多 300 字'))
    .max(PRODUCT_LINE_MAX_SEED_PROMPTS, `最多配置 ${PRODUCT_LINE_MAX_SEED_PROMPTS} 条监控问题`)
    .transform((items) => dedupePromptsCaseInsensitive(items));
}

function compactMarketRecord<T>(
  raw: Partial<Record<GeoMarket, T | undefined>>,
): Partial<Record<GeoMarket, T>> {
  const out: Partial<Record<GeoMarket, T>> = {};
  if (raw.CN !== undefined) out.CN = raw.CN;
  if (raw.GLOBAL !== undefined) out.GLOBAL = raw.GLOBAL;
  return out;
}

export const productLineLocalNamesSchema = z
  .object({
    CN: optionalMarketStringSchema(BRAND_NAME_MAX, '国内产品线名'),
    GLOBAL: optionalMarketStringSchema(BRAND_NAME_MAX, '海外产品线名'),
  })
  .strict()
  .transform((val): ProductLineLocalNames => compactMarketRecord(val));

export const productLineLocalCategoriesSchema = z
  .object({
    CN: optionalMarketStringSchema(BRAND_CATEGORY_MAX, '国内产品线品类'),
    GLOBAL: optionalMarketStringSchema(BRAND_CATEGORY_MAX, '海外产品线品类'),
  })
  .strict()
  .transform((val): ProductLineLocalCategories => compactMarketRecord(val));

export const productLineSeedPromptsSchema = z
  .object({
    CN: marketSeedPromptsSchema().optional(),
    GLOBAL: marketSeedPromptsSchema().optional(),
  })
  .strict()
  .transform((val): ProductLineSeedPrompts => compactMarketRecord(val));

export const productLineCompetitorsSchema = z
  .object({
    CN: z
      .array(brandCompetitorSchema)
      .max(BRAND_MAX_COMPETITORS, `最多配置 ${BRAND_MAX_COMPETITORS} 个竞品`)
      .optional(),
    GLOBAL: z
      .array(brandCompetitorSchema)
      .max(BRAND_MAX_COMPETITORS, `最多配置 ${BRAND_MAX_COMPETITORS} 个竞品`)
      .optional(),
  })
  .strict()
  .transform((val): ProductLineCompetitors => compactMarketRecord(val));

export const createProductLineSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '请填写产品线名称')
    .max(BRAND_NAME_MAX, `产品线名称不超过 ${BRAND_NAME_MAX} 字`),
  localNamesJson: productLineLocalNamesSchema.optional().default({}),
  category: z
    .string()
    .trim()
    .min(1, '请填写产品线品类')
    .max(BRAND_CATEGORY_MAX, `产品线品类不超过 ${BRAND_CATEGORY_MAX} 字`),
  localCategoriesJson: productLineLocalCategoriesSchema.optional().default({}),
  seedPromptsJson: productLineSeedPromptsSchema.optional().default({}),
  competitorsJson: productLineCompetitorsSchema.optional().default({}),
  sortOrder: z.number().int().min(0).max(1000).optional().default(0),
});

export type CreateProductLineInput = z.input<typeof createProductLineSchema>;
export type ParsedCreateProductLineInput = z.output<typeof createProductLineSchema>;

export const updateProductLineSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '请填写产品线名称')
      .max(BRAND_NAME_MAX, `产品线名称不超过 ${BRAND_NAME_MAX} 字`)
      .optional(),
    localNamesJson: productLineLocalNamesSchema.optional(),
    category: z
      .string()
      .trim()
      .min(1, '请填写产品线品类')
      .max(BRAND_CATEGORY_MAX, `产品线品类不超过 ${BRAND_CATEGORY_MAX} 字`)
      .optional(),
    localCategoriesJson: productLineLocalCategoriesSchema.optional(),
    seedPromptsJson: productLineSeedPromptsSchema.optional(),
    competitorsJson: productLineCompetitorsSchema.optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine((val) => Object.values(val).some((v) => v !== undefined), '至少修改一项产品线信息');

export type UpdateProductLineInput = z.input<typeof updateProductLineSchema>;
export type ParsedUpdateProductLineInput = z.output<typeof updateProductLineSchema>;

export type EffectiveCategoryBrandInput = {
  category: string;
};

export type EffectiveCategoryMarketInput = {
  market: GeoMarket;
  localCategory?: string | null;
};

export type EffectiveCategoryProductLineInput = {
  category?: string | null;
  localCategoriesJson?: unknown;
};

export function readProductLineMarketString(rawMap: unknown, market: GeoMarket): string | null {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return null;
  const val = (rawMap as Record<string, unknown>)[market];
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 统一解析生效品类（单品牌多产品线 / 单产品线兼容）：
 * - CN 市场：优先 productLine.localCategoriesJson.CN → productLine.category → market.localCategory → brand.category
 * - GLOBAL 市场：优先非中文 productLine.localCategoriesJson.GLOBAL → 非中文 productLine.category →
 *   映射后的产品线中文品类 → 非中文 market.localCategory → 非中文 brand.category → resolveGlobalCategoryLabel 兜底，
 *   保证 GLOBAL 输出永不泄漏中文品类字符。
 */
export function resolveEffectiveCategory(
  brand: EffectiveCategoryBrandInput,
  market: EffectiveCategoryMarketInput,
  productLine?: EffectiveCategoryProductLineInput | null,
): string {
  const lineLocalCat = readProductLineMarketString(productLine?.localCategoriesJson, market.market);
  const lineBaseCat = typeof productLine?.category === 'string' ? productLine.category.trim() : '';
  const marketLocalCat =
    typeof market.localCategory === 'string' ? market.localCategory.trim() : '';
  const brandBaseCat = typeof brand.category === 'string' ? brand.category.trim() : '';

  if (market.market === 'CN') {
    return lineLocalCat || lineBaseCat || marketLocalCat || brandBaseCat || '';
  }

  if (lineLocalCat && !containsCjk(lineLocalCat)) {
    return lineLocalCat;
  }
  if (lineBaseCat && !containsCjk(lineBaseCat)) {
    return lineBaseCat;
  }
  if (lineLocalCat || lineBaseCat) {
    const mappedLine = resolveGlobalCategoryLabel(lineBaseCat, lineLocalCat);
    if (mappedLine && mappedLine !== 'product' && !containsCjk(mappedLine)) {
      return mappedLine;
    }
  }
  if (marketLocalCat && !containsCjk(marketLocalCat)) {
    return marketLocalCat;
  }
  if (brandBaseCat && !containsCjk(brandBaseCat)) {
    return brandBaseCat;
  }
  return resolveGlobalCategoryLabel(
    lineBaseCat || brandBaseCat,
    lineLocalCat || marketLocalCat || null,
  );
}

export function resolveProductLineLocalName(
  productLine: { name?: string | null; localNamesJson?: unknown } | null | undefined,
  market: GeoMarket,
): string | null {
  if (!productLine) return null;
  const localized = readProductLineMarketString(productLine.localNamesJson, market);
  if (localized && (market === 'CN' || !containsCjk(localized))) {
    return localized;
  }
  const baseName = typeof productLine.name === 'string' ? productLine.name.trim() : '';
  if (!baseName) return null;
  if (market === 'GLOBAL' && containsCjk(baseName)) {
    return null;
  }
  return baseName;
}

export function readProductLineMarketSeedPrompts(rawMap: unknown, market: GeoMarket): string[] {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return [];
  const rawList = (rawMap as Record<string, unknown>)[market];
  if (!Array.isArray(rawList)) return [];
  const valid = rawList.filter((item): item is string => typeof item === 'string');
  return dedupePromptsCaseInsensitive(valid).slice(0, PRODUCT_LINE_MAX_SEED_PROMPTS);
}

export function readProductLineMarketCompetitors(
  rawMap: unknown,
  market: GeoMarket,
): BrandCompetitor[] {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return [];
  const rawList = (rawMap as Record<string, unknown>)[market];
  if (!Array.isArray(rawList)) return [];
  const out: BrandCompetitor[] = [];
  for (const item of rawList) {
    const parsed = brandCompetitorSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    }
    if (out.length >= BRAND_MAX_COMPETITORS) break;
  }
  return out;
}
