import {
  BRAND_FACT_CORE_SLOTS,
  BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
  BRAND_MAX_COMPETITORS,
  normalizeBrandDomain,
  sanitizeMediaOriginalName,
  type BrandCompetitor,
  type BrandFactCoreSlot,
  type FactSourceType,
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
