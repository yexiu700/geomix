import {
  BRAND_CATEGORY_MAX,
  BRAND_FACT_CORE_SLOTS,
  BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
  BRAND_MAX_ALIASES,
  BRAND_MAX_COMPETITORS,
  BRAND_MAX_CONTROL_PROMPTS,
  BRAND_MAX_SEED_PROMPTS,
  BRAND_NAME_MAX,
  BRAND_SEED_PROMPT_INTENTS,
  generateBrandSeedPrompts,
  normalizeBrandDomain,
  sanitizeMediaOriginalName,
  validateControlPromptsAgainstSeeds,
  type BrandCompetitor,
  type BrandFactCoreSlot,
  type BrandMarketAiSuggestResponse,
  type BrandSeedPromptIntent,
  type FactSourceType,
  type GeoMarket,
} from '@geomix/shared';

export type CompetitorDraftRow = {
  key: string;
  name: string;
  domainsText: string;
  aliasesText?: string;
};

export const CORE_FACT_SLOTS: readonly BrandFactCoreSlot[] = BRAND_FACT_CORE_SLOTS;

export const FACT_EXTRACT_ACCEPT = '.txt,.md,.pdf';
export const FACT_EXTRACT_MAX_BYTES = BRAND_FACT_EXTRACT_MAX_FILE_BYTES;

export const FACT_SOURCE_LABELS: Record<FactSourceType, string> = {
  MANUAL: '手工维护',
  URL_EXTRACT: '官网提炼',
  DOC_UPLOAD: '文档提炼',
  STUDIO_FEEDBACK: '写作反哺',
};

export const FACT_SLOT_PLACEHOLDERS: Record<BrandFactCoreSlot, string> = {
  PRODUCT_SPECS:
    '填写核心型号、价格带、硬件规格与实测指标（例如：DXP4800 四盘位 NAS，Intel N100 四核，16GB DDR5，满载噪音 28dB，待机功耗 14W）',
  DIFFERENTIATORS:
    '填写相比主流竞品的客观优势与适用人群（例如：免工具快拆盘架、本地 AI 离线相册识别、静音风道噪音降低 35%）',
  CREDENTIALS:
    '填写有效认证、专利、行业奖项或公开检测背书（例如：ISO9001 质量体系认证、国家 3C 认证、2025 红点工业设计奖）',
  CASE_STUDIES:
    '填写可核验的应用场景与落地成效（例如：已服务 12,000+ 家庭与影视工作室，某 4K 剪辑团队素材回传耗时缩短 42%）',
};

export function splitDomainRawTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,，;；\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function parseDomainTokens(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of splitDomainRawTokens(raw)) {
    const normalized = normalizeBrandDomain(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function validateDomainListInput(raw: string | undefined): {
  domains: string[];
  invalidTokens: string[];
} {
  const domains: string[] = [];
  const invalidTokens: string[] = [];
  const seen = new Set<string>();
  for (const token of splitDomainRawTokens(raw)) {
    const normalized = normalizeBrandDomain(token);
    if (!normalized) {
      invalidTokens.push(token);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      domains.push(normalized);
    }
  }
  return { domains, invalidTokens };
}

export function parseCompetitorAliases(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[,，;；\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function hydrateCompetitorRows(
  competitors: readonly BrandCompetitor[],
): CompetitorDraftRow[] {
  return competitors.slice(0, BRAND_MAX_COMPETITORS).map((item, idx) => ({
    key: `comp-${idx}-${item.name}`,
    name: item.name,
    domainsText: item.domains.join(', '),
    aliasesText: item.aliases.join(', '),
  }));
}

export function serializeCompetitorRows(rows: readonly CompetitorDraftRow[]): {
  competitors: BrandCompetitor[];
  invalidDomainRows: string[];
} {
  const competitors: BrandCompetitor[] = [];
  const invalidDomainRows: string[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(0, BRAND_MAX_COMPETITORS)) {
    const name = row.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const { domains, invalidTokens } = validateDomainListInput(row.domainsText);
    if (invalidTokens.length > 0) {
      invalidDomainRows.push(`${name}（无效域名：${invalidTokens.join('、')}）`);
    }
    const aliases = parseCompetitorAliases(row.aliasesText);
    competitors.push({ name, aliases, domains });
  }

  return { competitors, invalidDomainRows };
}

export function validateFactUploadFile(file: {
  name: string;
  size: number;
  type?: string;
}): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, message: '所选文档为空，请重新选择' };
  }
  if (file.size > FACT_EXTRACT_MAX_BYTES) {
    return { ok: false, message: '资料文档大小不能超过 10MB' };
  }
  if (!/\.(?:txt|md|pdf)$/i.test(file.name.trim())) {
    return { ok: false, message: '仅支持上传 TXT、MD、PDF 格式的产品资料' };
  }
  return { ok: true };
}

export function defaultAltFromFilename(fileName: string): string {
  const sanitized = sanitizeMediaOriginalName(fileName);
  if (!sanitized) return '产品实拍图';
  const stripped = sanitized.replace(/\.[^.]+$/, '').trim();
  return stripped ? stripped.slice(0, 120) : '产品实拍图';
}

export function computeTotalFactChars(items: ReadonlyArray<{ content: string }>): number {
  return items.reduce((sum, item) => sum + item.content.length, 0);
}

export type BrandMarketAiSuggestSelection = {
  localBrandName?: string;
  localCategory?: string;
  aliases: string[];
  competitors: BrandCompetitor[];
  seedPrompts: string[];
  controlPrompts: string[];
};

export type MergeAiMarketSuggestionsInput = {
  market: GeoMarket;
  current: {
    localBrandName: string;
    localCategory: string;
    aliases: readonly string[];
    competitors: readonly BrandCompetitor[];
    seedPrompts: readonly string[];
    controlPrompts: readonly string[];
  };
  selection: BrandMarketAiSuggestSelection;
};

export type MergeAiMarketSuggestionsResult = {
  localBrandName: string;
  localCategory: string;
  aliases: string[];
  competitors: BrandCompetitor[];
  seedPrompts: string[];
  controlPrompts: string[];
  addedCounts: {
    localBrandName: boolean;
    localCategory: boolean;
    aliases: number;
    competitors: number;
    seedPrompts: number;
    controlPrompts: number;
  };
  truncatedCounts: {
    aliases: number;
    competitors: number;
    seedPrompts: number;
    controlPrompts: number;
  };
  skippedControlOverlaps: number;
};

function normalizePromptComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 将用户在 AI 预填预览弹窗中勾选的建议以「只追加去重、不覆盖已有手调内容」规则合并至当前表单状态，
 * 严格遵循别名 20、竞品 10、种子问句 50、对照组 5 的上限及对照组与种子问句去重约束。
 */
export function mergeAiMarketSuggestions(
  input: MergeAiMarketSuggestionsInput,
): MergeAiMarketSuggestionsResult {
  const { market, current, selection } = input;

  let nextLocalBrandName = current.localBrandName;
  let localBrandNameChanged = false;
  if (market === 'GLOBAL' && selection.localBrandName?.trim()) {
    const candidate = selection.localBrandName.trim().slice(0, BRAND_NAME_MAX);
    if (candidate !== current.localBrandName.trim()) {
      nextLocalBrandName = candidate;
      localBrandNameChanged = true;
    }
  }

  let nextLocalCategory = current.localCategory;
  let localCategoryChanged = false;
  if (market === 'GLOBAL' && selection.localCategory?.trim()) {
    const candidate = selection.localCategory.trim().slice(0, BRAND_CATEGORY_MAX);
    if (candidate !== current.localCategory.trim()) {
      nextLocalCategory = candidate;
      localCategoryChanged = true;
    }
  }

  // 1. Aliases (append-only, case-insensitive dedupe, cap 20)
  const nextAliases = [...current.aliases];
  const aliasSeen = new Set(nextAliases.map((item) => item.trim().toLowerCase()));
  let addedAliases = 0;
  let truncatedAliases = 0;
  for (const raw of selection.aliases) {
    const cleaned = raw.trim().slice(0, BRAND_NAME_MAX);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (aliasSeen.has(key)) continue;
    if (nextAliases.length >= BRAND_MAX_ALIASES) {
      truncatedAliases += 1;
      continue;
    }
    aliasSeen.add(key);
    nextAliases.push(cleaned);
    addedAliases += 1;
  }

  // 2. Competitors (append-only, name dedupe, normalized domains, cap 10)
  const nextCompetitors: BrandCompetitor[] = current.competitors.map((comp) => ({
    name: comp.name,
    aliases: [...comp.aliases],
    domains: [...comp.domains],
  }));
  const compSeen = new Set(
    nextCompetitors.map((item) => item.name.trim().toLowerCase()).filter(Boolean),
  );
  let addedCompetitors = 0;
  let truncatedCompetitors = 0;
  for (const comp of selection.competitors) {
    const name = comp.name.trim().slice(0, BRAND_NAME_MAX);
    if (!name) continue;
    const key = name.toLowerCase();
    if (compSeen.has(key)) continue;
    if (nextCompetitors.length >= BRAND_MAX_COMPETITORS) {
      truncatedCompetitors += 1;
      continue;
    }
    compSeen.add(key);
    const normalizedDomains = Array.from(
      new Set(comp.domains.map(normalizeBrandDomain).filter(Boolean)),
    ).slice(0, 10);
    const normalizedAliases = Array.from(
      new Set(
        comp.aliases
          .map((a) => a.trim().slice(0, BRAND_NAME_MAX))
          .filter((a) => a.length > 0 && a.toLowerCase() !== key),
      ),
    ).slice(0, BRAND_MAX_ALIASES);
    nextCompetitors.push({ name, aliases: normalizedAliases, domains: normalizedDomains });
    addedCompetitors += 1;
  }

  // 3. Seed prompts (append-only, normalized dedupe against existing seeds & controls, cap 50)
  const nextSeedPrompts = [...current.seedPrompts];
  const seedSeen = new Set(nextSeedPrompts.map(normalizePromptComparison).filter(Boolean));
  const existingControlKeys = new Set(
    current.controlPrompts.map(normalizePromptComparison).filter(Boolean),
  );
  let addedSeedPrompts = 0;
  let truncatedSeedPrompts = 0;
  for (const raw of selection.seedPrompts) {
    const cleaned = raw.trim().slice(0, 300);
    if (cleaned.length < 2) continue;
    const key = normalizePromptComparison(cleaned);
    if (seedSeen.has(key) || existingControlKeys.has(key)) continue;
    if (nextSeedPrompts.length >= BRAND_MAX_SEED_PROMPTS) {
      truncatedSeedPrompts += 1;
      continue;
    }
    seedSeen.add(key);
    nextSeedPrompts.push(cleaned);
    addedSeedPrompts += 1;
  }

  // 4. Control prompts (append-only, dedupe against existing controls AND all seeds, cap 5)
  const nextControlPrompts = [...current.controlPrompts];
  const controlSeen = new Set(nextControlPrompts.map(normalizePromptComparison).filter(Boolean));
  let addedControlPrompts = 0;
  let truncatedControlPrompts = 0;
  let skippedControlOverlaps = 0;
  for (const raw of selection.controlPrompts) {
    const cleaned = raw.trim().slice(0, 300);
    if (cleaned.length < 2) continue;
    const key = normalizePromptComparison(cleaned);
    if (controlSeen.has(key)) continue;
    const overlap = validateControlPromptsAgainstSeeds([cleaned], nextSeedPrompts);
    if (!overlap.ok) {
      skippedControlOverlaps += 1;
      continue;
    }
    if (nextControlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS) {
      truncatedControlPrompts += 1;
      continue;
    }
    controlSeen.add(key);
    nextControlPrompts.push(cleaned);
    addedControlPrompts += 1;
  }

  return {
    localBrandName: nextLocalBrandName,
    localCategory: nextLocalCategory,
    aliases: nextAliases,
    competitors: nextCompetitors,
    seedPrompts: nextSeedPrompts,
    controlPrompts: nextControlPrompts,
    addedCounts: {
      localBrandName: localBrandNameChanged,
      localCategory: localCategoryChanged,
      aliases: addedAliases,
      competitors: addedCompetitors,
      seedPrompts: addedSeedPrompts,
      controlPrompts: addedControlPrompts,
    },
    truncatedCounts: {
      aliases: truncatedAliases,
      competitors: truncatedCompetitors,
      seedPrompts: truncatedSeedPrompts,
      controlPrompts: truncatedControlPrompts,
    },
    skippedControlOverlaps,
  };
}

function inferStaticSeedIntent(prompt: string, index: number): BrandSeedPromptIntent {
  const lower = prompt.toLowerCase();
  if (/\bvs\b|对比|还是|compar/.test(lower)) return 'COMPETITOR_VS';
  if (/怎么样|口碑|值得买|worth\s+buying|pros,?\s+cons|review/.test(lower)) {
    return 'BRAND_REPUTATION';
  }
  if (/痛点|避坑|问题|challenge|issue|maintenance/.test(lower)) return 'SCENARIO_PAIN';
  if (/推荐|怎么挑|怎么选|哪个品牌|best|top|how\s+to/.test(lower)) return 'BUYING_GUIDE';
  return BRAND_SEED_PROMPT_INTENTS[index % BRAND_SEED_PROMPT_INTENTS.length]!;
}

/**
 * 当「按当前品类重新生成种子问句」请求 AI 接口失败时，客户端兜底回退静态 generateBrandSeedPrompts 模板。
 */
export function buildFallbackSeedPromptSuggestionResponse(input: {
  market: GeoMarket;
  brandName: string;
  category: string;
  localCategory?: string | null;
  competitors?: ReadonlyArray<{ name: string }>;
  existingSeedPrompts?: readonly string[];
  existingControlPrompts?: readonly string[];
}): BrandMarketAiSuggestResponse {
  const existingSet = new Set(
    [...(input.existingSeedPrompts ?? []), ...(input.existingControlPrompts ?? [])]
      .map(normalizePromptComparison)
      .filter(Boolean),
  );
  const generated = generateBrandSeedPrompts({
    market: input.market,
    brandName: input.brandName,
    category: input.category,
    localCategory: input.localCategory,
    competitors: input.competitors,
  });

  const seedPrompts = generated
    .filter((prompt) => !existingSet.has(normalizePromptComparison(prompt)))
    .map((prompt, index) => ({
      prompt,
      intent: inferStaticSeedIntent(prompt, index),
    }));

  return {
    market: input.market,
    aliases: [],
    competitors: [],
    seedPrompts,
    controlPrompts: [],
    fallbackUsed: true,
    warnings: ['AI 建议接口暂不可用，已自动回退至品类规则模板，您可勾选并追加至当前表单。'],
  };
}
