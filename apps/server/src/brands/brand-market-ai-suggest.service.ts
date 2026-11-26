import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_CATEGORY_MAX,
  BRAND_MARKET_AI_SUGGEST_FIELDS,
  BRAND_MAX_ALIASES,
  BRAND_MAX_COMPETITORS,
  BRAND_MAX_CONTROL_PROMPTS,
  BRAND_NAME_MAX,
  BRAND_SEED_PROMPT_INTENTS,
  BRAND_SEED_PROMPT_INTENT_LABELS,
  brandMarketAiSuggestResponseSchema,
  classifyBrandCategorySegment,
  containsCjk,
  generateBrandSeedPrompts,
  normalizeBrandDomain,
  resolveGlobalCategoryLabel,
  validateControlPromptsAgainstSeeds,
  type BrandCompetitor,
  type BrandMarketAiSuggestField,
  type BrandMarketAiSuggestResponse,
  type BrandSeedPromptIntent,
  type BrandSeedPromptSuggestion,
  type GeoMarket,
  type ParsedBrandMarketAiSuggestInput,
} from '@geomix/shared';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readMarketAiSuggestRateLimit,
} from '../common/free-action-rate-limiter';
import { PublicFetchService } from '../infra/adapters.module';
import { ComplianceService } from '../infra/compliance';
import { extractPlainTextFromHtml } from '../infra/html-extract';
import { LlmService, assertCompletionAllowed } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';

const MAX_SOURCE_PAGE_CHARS = 8_000;
const MAX_FACTS_CONTEXT_CHARS = 8_000;

const FACT_SLOT_PRIORITY: Readonly<Record<string, number>> = {
  PRODUCT_SPECS: 0,
  DIFFERENTIATORS: 1,
  CREDENTIALS: 2,
  CASE_STUDIES: 3,
  EXTRA_DOC: 4,
};

const llmRawCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(BRAND_NAME_MAX),
  aliases: z.array(z.string().trim().min(1).max(BRAND_NAME_MAX)).optional().default([]),
  domains: z.array(z.string().trim().min(1).max(255)).optional().default([]),
});

const llmRawSeedPromptSchema = z.union([
  z.object({
    prompt: z.string().trim().min(2).max(300),
    intent: z.enum(BRAND_SEED_PROMPT_INTENTS).optional(),
  }),
  z.string().trim().min(2).max(300),
]);

const llmRawMarketSuggestSchema = z.object({
  localBrandName: z.string().trim().max(BRAND_NAME_MAX).nullable().optional(),
  localCategory: z.string().trim().max(BRAND_CATEGORY_MAX).nullable().optional(),
  aliases: z.array(z.string().trim()).optional().default([]),
  competitors: z.array(llmRawCompetitorSchema).optional().default([]),
  seedPrompts: z.array(llmRawSeedPromptSchema).optional().default([]),
  controlPrompts: z.array(z.string().trim()).optional().default([]),
});

type StoredMarketSnapshot = {
  market: string;
  locale: string;
  region: string;
  localBrandName: string;
  localCategory?: string | null;
  aliases: string[];
  ownedDomains: string[];
  competitors: Prisma.JsonValue;
  seedPrompts: string[];
  controlPrompts?: string[];
};

type StoredFactSnapshot = {
  slot: string;
  title: string;
  content: string;
};

type SuggestContext = {
  brandName: string;
  brandCategory: string;
  market: GeoMarket;
  locale: string;
  region: string;
  localBrandName: string;
  localCategory: string | null;
  existingAliases: string[];
  ownedDomains: string[];
  existingCompetitors: BrandCompetitor[];
  existingSeedPrompts: string[];
  existingControlPrompts: string[];
  facts: StoredFactSnapshot[];
  sourcePageTitle: string;
  sourcePageText: string;
  focusHint?: string;
  requestedFields: Set<BrandMarketAiSuggestField>;
};

type DraftSuggestionPayload = {
  localBrandName?: string;
  localCategory?: string;
  aliases: string[];
  competitors: BrandCompetitor[];
  seedPrompts: BrandSeedPromptSuggestion[];
  controlPrompts: string[];
};

/**
 * 品牌市场配置 AI 一键补全服务（Issue #405，100% 走 prisma.scoped，只读不写库）：
 * - 0 点免费，接入 FreeActionRateLimiter 按租户防刷限流
 * - 支持可选 1 个商品/产品页 sourceUrl（复用 SSRF 加固 PublicFetchService）
 * - 综合品牌主档、目标市场配置、品牌事实卡生成结构化只读草稿
 * - 对照组问句强制经 validateControlPromptsAgainstSeeds 与已有及本次种子问句去重
 * - LLM 超时/故障/格式异常时优雅降级回退至 generateBrandSeedPrompts 规则模板，不阻断流程
 * - 输入与输出全部经过 ComplianceService 与 Zod 校验
 */
@Injectable()
export class BrandMarketAiSuggestService {
  private readonly logger = new Logger(BrandMarketAiSuggestService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(PublicFetchService) private readonly publicFetch: PublicFetchService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(FreeActionRateLimiter) private readonly rateLimiter: FreeActionRateLimiter,
  ) {}

  async suggest(
    tenantId: string,
    userId: string,
    brandId: string,
    market: GeoMarket,
    input: ParsedBrandMarketAiSuggestInput,
  ): Promise<BrandMarketAiSuggestResponse> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: {
        markets: {
          orderBy: { market: 'asc' },
        },
      },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    const existingMarket = (brand.markets as StoredMarketSnapshot[]).find(
      (item) => item.market === market,
    );
    if (!existingMarket) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该市场尚未开启');
    }

    this.rateLimiter.assertAllowed(
      'brand_market_ai_suggest',
      tenantId,
      readMarketAiSuggestRateLimit(),
    );

    const factRows = (await this.prisma.scoped.brandFact.findMany({
      where: { brandId },
      select: { slot: true, title: true, content: true },
      orderBy: [{ updatedAt: 'desc' }],
    })) as StoredFactSnapshot[];

    const warnings: string[] = [];
    let sourcePageTitle = '';
    let sourcePageText = '';

    if (input.sourceUrl) {
      try {
        const page = await this.publicFetch.fetch(input.sourceUrl);
        const extracted = extractPlainTextFromHtml(page.body);
        sourcePageTitle = extracted.title;
        sourcePageText = extracted.text.slice(0, MAX_SOURCE_PAGE_CHARS).trim();
        if (sourcePageText.replace(/\s+/g, '').length < 10) {
          warnings.push('商品页未提取到足够正文，已基于品牌档案与事实卡生成建议。');
          sourcePageText = '';
        }
      } catch (error) {
        if (error instanceof ProviderError) {
          if (error.kind === PROVIDER_KIND.SSRF) {
            throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标地址不允许访问');
          }
          if (error.kind === PROVIDER_KIND.CONTRACT) {
            throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message || '链接格式不正确');
          }
          const briefMessage =
            (error.message || '网页暂不可达').trim().slice(0, 120) || '网页暂不可达';
          warnings.push(`商品页抓取失败（${briefMessage}），已基于品牌档案与事实卡生成建议。`);
        } else {
          warnings.push('商品页抓取失败，已基于品牌档案与事实卡生成建议。');
        }
      }
    }

    const inputComplianceText = [
      brand.name,
      brand.category,
      existingMarket.localBrandName,
      existingMarket.localCategory ?? '',
      input.focusHint ?? '',
      sourcePageTitle,
      sourcePageText,
    ]
      .filter(Boolean)
      .join('\n');

    await this.compliance.assertAllowed({
      text: inputComplianceText,
      action: 'brand_market_ai_suggest',
      market,
      tenantId,
      userId,
    });

    const requestedFields = resolveRequestedFields(market, input.fields);
    const context: SuggestContext = {
      brandName: brand.name,
      brandCategory: brand.category,
      market,
      locale: existingMarket.locale,
      region: existingMarket.region,
      localBrandName: existingMarket.localBrandName,
      localCategory: existingMarket.localCategory ?? null,
      existingAliases: Array.isArray(existingMarket.aliases) ? existingMarket.aliases : [],
      ownedDomains: Array.isArray(existingMarket.ownedDomains) ? existingMarket.ownedDomains : [],
      existingCompetitors: parseStoredCompetitors(existingMarket.competitors),
      existingSeedPrompts: Array.isArray(existingMarket.seedPrompts)
        ? existingMarket.seedPrompts
        : [],
      existingControlPrompts: Array.isArray(existingMarket.controlPrompts)
        ? existingMarket.controlPrompts
        : [],
      facts: sortFactsByPriority(factRows),
      sourcePageTitle,
      sourcePageText,
      focusHint: input.focusHint,
      requestedFields,
    };

    let fallbackUsed = false;
    let draft: DraftSuggestionPayload;

    const promptBody = buildLlmUserPrompt(context);
    const digest = createHash('sha256').update(promptBody).digest('hex').slice(0, 16);
    const idempotencyKey = `market_suggest:${brandId}:${market}:${digest}:${randomBytes(4).toString('hex')}`;

    try {
      const completion = await this.llm.complete({
        tenantId,
        scene: 'fact_extract',
        messages: [
          {
            role: 'system',
            content: buildLlmSystemPrompt(market, requestedFields),
          },
          {
            role: 'user',
            content: promptBody,
          },
        ],
        idempotencyKey,
        temperature: 0.3,
        maxTokens: 2048,
        disableThinking: true,
      });

      assertCompletionAllowed({
        completion,
        llm: this.llm,
        scene: 'fact_extract',
      });

      if (completion.fake) {
        fallbackUsed = true;
        warnings.push(
          '当前处于离线演示模型模式，已基于品牌事实与规则模板生成建议，可直接勾选或微调。',
        );
        draft = buildFallbackMarketSuggestions(context);
      } else {
        draft = parseAndSanitizeLlmSuggestions(completion.text, context, warnings);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        throw error;
      }
      this.logger.warn(
        `market ai-suggest degraded to fallback for brand=${brandId} market=${market}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      fallbackUsed = true;
      warnings.push('AI 模型响应超时或暂时不可用，已自动回退至品类规则模板建议，可勾选后微调。');
      draft = buildFallbackMarketSuggestions(context);
    }

    const sanitizedDraft = await this.enforceOutputCompliance(draft, market, tenantId, userId);
    const finalDraft = enforceFinalInvariants(sanitizedDraft, context);
    const safeWarnings = warnings
      .map((item) => item.trim().slice(0, 300))
      .filter((item) => item.length > 0);

    return brandMarketAiSuggestResponseSchema.parse({
      market,
      ...(finalDraft.localBrandName ? { localBrandName: finalDraft.localBrandName } : {}),
      ...(finalDraft.localCategory ? { localCategory: finalDraft.localCategory } : {}),
      aliases: finalDraft.aliases,
      competitors: finalDraft.competitors,
      seedPrompts: finalDraft.seedPrompts,
      controlPrompts: finalDraft.controlPrompts,
      fallbackUsed,
      ...(safeWarnings.length > 0 ? { warnings: safeWarnings } : {}),
    });
  }

  private async enforceOutputCompliance(
    draft: DraftSuggestionPayload,
    market: GeoMarket,
    tenantId: string,
    userId: string,
  ): Promise<DraftSuggestionPayload> {
    const serialized = [
      draft.localBrandName ?? '',
      draft.localCategory ?? '',
      ...draft.aliases,
      ...draft.competitors.flatMap((c) => [c.name, ...c.aliases]),
      ...draft.seedPrompts.map((s) => s.prompt),
      ...draft.controlPrompts,
    ]
      .filter(Boolean)
      .join('\n');

    if (serialized.length > 0) {
      await this.compliance.assertAllowed({
        text: serialized,
        action: 'brand_market_ai_suggest_output',
        market,
        tenantId,
        userId,
      });
    }

    const cleanText = (value: string): string => {
      const scanned = this.compliance.scan(value, { market });
      return (scanned.text || value).trim();
    };

    return {
      localBrandName: draft.localBrandName ? cleanText(draft.localBrandName) : undefined,
      localCategory: draft.localCategory ? cleanText(draft.localCategory) : undefined,
      aliases: draft.aliases.map(cleanText).filter(Boolean),
      competitors: draft.competitors
        .map((comp) => ({
          name: cleanText(comp.name),
          aliases: comp.aliases.map(cleanText).filter(Boolean),
          domains: comp.domains,
        }))
        .filter((comp) => comp.name.length > 0),
      seedPrompts: draft.seedPrompts
        .map((item) => ({
          prompt: cleanText(item.prompt),
          intent: item.intent,
        }))
        .filter((item) => item.prompt.length >= 2),
      controlPrompts: draft.controlPrompts.map(cleanText).filter((item) => item.length >= 2),
    };
  }
}

function resolveRequestedFields(
  market: GeoMarket,
  fields?: readonly BrandMarketAiSuggestField[],
): Set<BrandMarketAiSuggestField> {
  if (fields && fields.length > 0) {
    const set = new Set<BrandMarketAiSuggestField>(fields);
    if (market !== 'GLOBAL') {
      set.delete('localIdentity');
    }
    return set;
  }
  const defaults = new Set<BrandMarketAiSuggestField>(BRAND_MARKET_AI_SUGGEST_FIELDS);
  if (market !== 'GLOBAL') {
    defaults.delete('localIdentity');
  }
  return defaults;
}

function sortFactsByPriority(rows: readonly StoredFactSnapshot[]): StoredFactSnapshot[] {
  return [...rows]
    .filter((row) => row.content.trim().length > 0)
    .sort((a, b) => (FACT_SLOT_PRIORITY[a.slot] ?? 9) - (FACT_SLOT_PRIORITY[b.slot] ?? 9));
}

function parseStoredCompetitors(raw: Prisma.JsonValue): BrandCompetitor[] {
  if (!Array.isArray(raw)) return [];
  const out: BrandCompetitor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;
    const aliases = Array.isArray(obj.aliases)
      ? obj.aliases.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const domains = Array.isArray(obj.domains)
      ? obj.domains
          .filter((x): x is string => typeof x === 'string')
          .map(normalizeBrandDomain)
          .filter(Boolean)
      : [];
    out.push({ name, aliases, domains });
  }
  return out;
}

function normalizePromptKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildLlmSystemPrompt(
  market: GeoMarket,
  requestedFields: ReadonlySet<BrandMarketAiSuggestField>,
): string {
  const fieldList = [...requestedFields].join(', ');
  const langRule =
    market === 'GLOBAL'
      ? '目标市场为海外市场（GLOBAL / en-US），所有建议的 localBrandName、localCategory、seedPrompts、controlPrompts 必须使用自然专业英文，严禁混入中文字符。'
      : '目标市场为中国国内市场（CN / zh-CN），所有建议的 seedPrompts、controlPrompts 必须使用自然中文，符合中国广告法规范，避免使用“全网第一、绝对、最好”等违禁极限词。';

  const intentDesc = BRAND_SEED_PROMPT_INTENTS.map(
    (code) => `${code}(${BRAND_SEED_PROMPT_INTENT_LABELS[code]})`,
  ).join('、');

  return [
    '你是 GeoMix GEO 品牌市场配置规划助手。请根据品牌档案、目标市场配置、已有品牌事实卡与可选商品页信息，输出严格 JSON 对象（不要包含 Markdown 代码块之外的任何说明文字）。',
    langRule,
    `本次需要生成的字段集合：[${fieldList}]。未在集合中的字段请输出空数组或省略。`,
    'JSON 结构如下：',
    '{',
    market === 'GLOBAL'
      ? '  "localBrandName": "纯英文品牌名（仅在需要 localIdentity 时提供）",'
      : '',
    market === 'GLOBAL'
      ? '  "localCategory": "纯英文细分行业品类（仅在需要 localIdentity 时提供）",'
      : '',
    '  "aliases": ["核心 SKU 型号、系列词或常见品牌别名，最多 12 个，不可与已有别名或品牌主名重复"],',
    '  "competitors": [{"name": "竞品名", "aliases": ["竞品别名"], "domains": ["competitor.com"]}],',
    `  "seedPrompts": [{"prompt": "用户真实向 AI 提问的高频监控问句", "intent": "上述 5 类意图之一"}],`,
    '  "controlPrompts": ["最多 5 条未发稿基线对照组问句，必须与已有及本次生成的 seedPrompts 语义与字面均不重复"]',
    '}',
    `要求：`,
    `1) 若生成 seedPrompts，请产出 10–15 条真实、具体、结合品牌 SKU/场景的高频问句，覆盖 ${intentDesc}；`,
    `2) 若生成 controlPrompts，请产出 3–5 条同品类邻近但独立的基线问句，绝对不得与已有或本次 seedPrompts 重复；`,
    '3) 若生成 competitors，请给出 3–6 家同市场真实直接竞品及其标准官网域名（裸域名，如 domain.com）；',
    '4) 所有输出必须客观、真实、合规，禁止涉及任何违法或高危行业内容。',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildLlmUserPrompt(ctx: SuggestContext): string {
  const lines: string[] = [
    `目标市场：${ctx.market}（${ctx.locale} / ${ctx.region}）`,
    `品牌主名：${ctx.brandName}`,
    `品牌主品类：${ctx.brandCategory}`,
    `当前市场当地品牌名：${ctx.localBrandName}`,
    ctx.localCategory ? `当前市场当地品类：${ctx.localCategory}` : '',
    ctx.ownedDomains.length > 0 ? `自有官网域名：${ctx.ownedDomains.join(', ')}` : '',
    ctx.existingAliases.length > 0
      ? `已有别名/SKU（请去重）：${ctx.existingAliases.join(', ')}`
      : '',
    ctx.existingCompetitors.length > 0
      ? `已有竞品（请去重）：${ctx.existingCompetitors.map((c) => c.name).join(', ')}`
      : '',
    ctx.existingSeedPrompts.length > 0
      ? `已有种子问句（请去重）：\n${ctx.existingSeedPrompts
          .slice(0, 20)
          .map((p) => `- ${p}`)
          .join('\n')}`
      : '',
    ctx.existingControlPrompts.length > 0
      ? `已有对照组问句（请去重）：\n${ctx.existingControlPrompts.map((p) => `- ${p}`).join('\n')}`
      : '',
    ctx.focusHint ? `用户补充侧重点：${ctx.focusHint}` : '',
  ].filter(Boolean);

  if (ctx.facts.length > 0) {
    lines.push('--- 品牌事实卡（按优先级排序） ---');
    let remaining = MAX_FACTS_CONTEXT_CHARS;
    for (const fact of ctx.facts) {
      if (remaining <= 0) break;
      const snippet = fact.content.trim().slice(0, remaining);
      lines.push(`[${fact.slot}] ${fact.title}: ${snippet}`);
      remaining -= snippet.length;
    }
  }

  if (ctx.sourcePageText) {
    lines.push('--- 补充商品/产品页正文 ---');
    if (ctx.sourcePageTitle) {
      lines.push(`页面标题：${ctx.sourcePageTitle}`);
    }
    lines.push(ctx.sourcePageText);
  }

  return lines.join('\n');
}

function sanitizeGlobalIdentityCandidate(
  raw: string | null | undefined,
  maxLen: number,
): string | undefined {
  const trimmed = raw?.trim().slice(0, maxLen) ?? '';
  if (!trimmed || containsCjk(trimmed)) return undefined;
  return trimmed;
}

function parseAndSanitizeLlmSuggestions(
  rawText: string,
  ctx: SuggestContext,
  warnings: string[],
): DraftSuggestionPayload {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const jsonStart = stripped.indexOf('{');
  const jsonEnd = stripped.lastIndexOf('}');
  const candidate =
    jsonStart >= 0 && jsonEnd > jsonStart ? stripped.slice(jsonStart, jsonEnd + 1) : stripped;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    throw new Error('LLM output is not valid JSON');
  }

  const parsed = llmRawMarketSuggestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error('LLM output failed schema validation');
  }

  const data = parsed.data;
  const want = ctx.requestedFields;

  const rawLocalBrandName = data.localBrandName?.trim() ?? '';
  let localBrandName =
    ctx.market === 'GLOBAL' && want.has('localIdentity')
      ? sanitizeGlobalIdentityCandidate(rawLocalBrandName, BRAND_NAME_MAX)
      : undefined;
  let cjkIdentityFiltered = false;
  if (
    ctx.market === 'GLOBAL' &&
    want.has('localIdentity') &&
    rawLocalBrandName &&
    !localBrandName
  ) {
    cjkIdentityFiltered = true;
    localBrandName = sanitizeGlobalIdentityCandidate(
      deriveFallbackGlobalBrandName(ctx),
      BRAND_NAME_MAX,
    );
  }

  const rawLocalCategory = data.localCategory?.trim() ?? '';
  let localCategory =
    ctx.market === 'GLOBAL' && want.has('localIdentity')
      ? sanitizeGlobalIdentityCandidate(rawLocalCategory, BRAND_CATEGORY_MAX)
      : undefined;
  if (ctx.market === 'GLOBAL' && want.has('localIdentity') && rawLocalCategory && !localCategory) {
    cjkIdentityFiltered = true;
    localCategory = sanitizeGlobalIdentityCandidate(
      resolveGlobalCategoryLabel(ctx.brandCategory, ctx.localCategory),
      BRAND_CATEGORY_MAX,
    );
  }

  if (cjkIdentityFiltered) {
    warnings.push('AI 建议的海外品牌名或品类包含中文，已自动过滤并替换为英文建议。');
  }

  const aliases = want.has('aliases') ? sanitizeAliases(data.aliases, ctx) : [];

  const competitors = want.has('competitors') ? sanitizeCompetitors(data.competitors, ctx) : [];

  const seedPrompts = want.has('seedPrompts') ? sanitizeSeedPrompts(data.seedPrompts, ctx) : [];

  const controlPrompts = want.has('controlPrompts')
    ? sanitizeControlPrompts(data.controlPrompts, ctx, seedPrompts)
    : [];

  return {
    ...(localBrandName ? { localBrandName } : {}),
    ...(localCategory ? { localCategory } : {}),
    aliases,
    competitors,
    seedPrompts,
    controlPrompts,
  };
}

function sanitizeAliases(rawAliases: readonly string[], ctx: SuggestContext): string[] {
  const excluded = new Set(
    [ctx.brandName, ctx.localBrandName, ...ctx.existingAliases]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: string[] = [];
  for (const raw of rawAliases) {
    const cleaned = raw.trim().slice(0, BRAND_NAME_MAX);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (excluded.has(key)) continue;
    excluded.add(key);
    out.push(cleaned);
    if (out.length >= BRAND_MAX_ALIASES) break;
  }
  return out;
}

function sanitizeCompetitors(
  rawCompetitors: ReadonlyArray<{ name: string; aliases?: string[]; domains?: string[] }>,
  ctx: SuggestContext,
): BrandCompetitor[] {
  const excluded = new Set(
    [ctx.brandName, ctx.localBrandName, ...ctx.existingCompetitors.map((c) => c.name)]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const ownedDomainSet = new Set(ctx.ownedDomains.map((d) => d.toLowerCase()));

  const out: BrandCompetitor[] = [];
  for (const item of rawCompetitors) {
    const name = item.name.trim().slice(0, BRAND_NAME_MAX);
    if (!name) continue;
    const key = name.toLowerCase();
    if (excluded.has(key)) continue;
    excluded.add(key);

    const aliasSeen = new Set<string>([key]);
    const aliases: string[] = [];
    for (const rawAlias of item.aliases ?? []) {
      const a = rawAlias.trim().slice(0, BRAND_NAME_MAX);
      if (!a || aliasSeen.has(a.toLowerCase())) continue;
      aliasSeen.add(a.toLowerCase());
      aliases.push(a);
      if (aliases.length >= BRAND_MAX_ALIASES) break;
    }

    const domainSeen = new Set<string>();
    const domains: string[] = [];
    for (const rawDomain of item.domains ?? []) {
      const normalized = normalizeBrandDomain(rawDomain);
      if (!normalized || domainSeen.has(normalized) || ownedDomainSet.has(normalized)) continue;
      domainSeen.add(normalized);
      domains.push(normalized);
      if (domains.length >= 10) break;
    }

    out.push({ name, aliases, domains });
    if (out.length >= BRAND_MAX_COMPETITORS) break;
  }
  return out;
}

function inferPromptIntent(prompt: string, idx: number): BrandSeedPromptIntent {
  const lower = prompt.toLowerCase();
  if (/\bvs\b|对比|还是|区别|compar|alternative/.test(lower)) return 'COMPETITOR_VS';
  if (/\b[a-z]{1,5}[- ]?\d{2,5}\b|评测|实测|参数|specs?|benchmark|review/.test(lower)) {
    return 'SKU_REVIEW';
  }
  if (/怎么样|口碑|值得买|优缺点|worth\s+buying|pros,?\s+cons|reputation/.test(lower)) {
    return 'BRAND_REPUTATION';
  }
  if (/痛点|避坑|问题|场景|适合|workflow|challenge|issue|pain|use\s+case/.test(lower)) {
    return 'SCENARIO_PAIN';
  }
  if (/推荐|怎么挑|怎么选|哪个品牌|best|top|how\s+to\s+choose|buying\s+guide/.test(lower)) {
    return 'BUYING_GUIDE';
  }
  return BRAND_SEED_PROMPT_INTENTS[idx % BRAND_SEED_PROMPT_INTENTS.length]!;
}

function sanitizeSeedPrompts(
  rawPrompts: ReadonlyArray<string | { prompt: string; intent?: BrandSeedPromptIntent }>,
  ctx: SuggestContext,
): BrandSeedPromptSuggestion[] {
  const seen = new Set(
    [...ctx.existingSeedPrompts, ...ctx.existingControlPrompts]
      .map(normalizePromptKey)
      .filter(Boolean),
  );
  const out: BrandSeedPromptSuggestion[] = [];

  for (let i = 0; i < rawPrompts.length; i += 1) {
    const entry = rawPrompts[i]!;
    const rawPrompt = typeof entry === 'string' ? entry : entry.prompt;
    const prompt = rawPrompt.trim().slice(0, 300);
    if (prompt.length < 2) continue;
    const key = normalizePromptKey(prompt);
    if (seen.has(key)) continue;
    seen.add(key);
    const intent =
      typeof entry === 'string' || !entry.intent ? inferPromptIntent(prompt, i) : entry.intent;
    out.push({ prompt, intent });
    if (out.length >= 15) break;
  }

  return out;
}

function sanitizeControlPrompts(
  rawControls: readonly string[],
  ctx: SuggestContext,
  suggestedSeeds: readonly BrandSeedPromptSuggestion[],
): string[] {
  const allSeeds = [...ctx.existingSeedPrompts, ...suggestedSeeds.map((s) => s.prompt)];
  const existingControlKeys = new Set(
    ctx.existingControlPrompts.map(normalizePromptKey).filter(Boolean),
  );
  const seen = new Set<string>(existingControlKeys);

  const candidates: string[] = [];
  for (const raw of rawControls) {
    const cleaned = raw.trim().slice(0, 300);
    if (cleaned.length < 2) continue;
    const key = normalizePromptKey(cleaned);
    if (seen.has(key)) continue;
    // Enforce non-overlap with both existing and newly suggested seedPrompts via shared validator
    const check = validateControlPromptsAgainstSeeds([cleaned], allSeeds);
    if (!check.ok) continue;
    seen.add(key);
    candidates.push(cleaned);
    if (candidates.length >= BRAND_MAX_CONTROL_PROMPTS) break;
  }

  return candidates;
}

function enforceFinalInvariants(
  draft: DraftSuggestionPayload,
  ctx: SuggestContext,
): DraftSuggestionPayload {
  const want = ctx.requestedFields;

  const aliases = want.has('aliases') ? sanitizeAliases(draft.aliases, ctx) : [];
  const competitors = want.has('competitors') ? sanitizeCompetitors(draft.competitors, ctx) : [];
  const seedPrompts = want.has('seedPrompts') ? sanitizeSeedPrompts(draft.seedPrompts, ctx) : [];
  const controlPrompts = want.has('controlPrompts')
    ? sanitizeControlPrompts(draft.controlPrompts, ctx, seedPrompts)
    : [];

  // Double-check controlPrompts against both existing and suggested seeds
  const allSeedTexts = [...ctx.existingSeedPrompts, ...seedPrompts.map((item) => item.prompt)];
  const overlap = validateControlPromptsAgainstSeeds(controlPrompts, allSeedTexts);
  const safeControlPrompts = overlap.ok
    ? controlPrompts
    : controlPrompts.filter((prompt) => {
        const dupSet = new Set(overlap.duplicates.map(normalizePromptKey));
        return !dupSet.has(normalizePromptKey(prompt));
      });

  const safeLocalBrandName =
    ctx.market === 'GLOBAL' && want.has('localIdentity')
      ? sanitizeGlobalIdentityCandidate(draft.localBrandName, BRAND_NAME_MAX)
      : undefined;
  const safeLocalCategory =
    ctx.market === 'GLOBAL' && want.has('localIdentity')
      ? sanitizeGlobalIdentityCandidate(draft.localCategory, BRAND_CATEGORY_MAX)
      : undefined;

  return {
    ...(safeLocalBrandName ? { localBrandName: safeLocalBrandName } : {}),
    ...(safeLocalCategory ? { localCategory: safeLocalCategory } : {}),
    aliases,
    competitors,
    seedPrompts,
    controlPrompts: safeControlPrompts.slice(0, BRAND_MAX_CONTROL_PROMPTS),
  };
}

// ==================== 确定性回退模板（复用 generateBrandSeedPrompts） ====================

const SKU_TOKEN_RE = /\b[A-Z]{1,6}[- ]?\d{2,5}[A-Z0-9+]{0,4}\b/g;
const GENERIC_DOMAIN_ROOTS = new Set([
  'example',
  'localhost',
  'test',
  'demo',
  'sample',
  'website',
  'official',
]);

function extractSkuTokens(sources: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const skipSet = new Set([
    'ISO9001',
    'ISO27001',
    'SOC2',
    'DDR4',
    'DDR5',
    'USB4',
    'WIFI6',
    'WIFI7',
  ]);

  for (const text of sources) {
    const matches = text.match(SKU_TOKEN_RE) ?? [];
    for (const raw of matches) {
      const token = raw.trim().replace(/\s+/g, ' ');
      const compact = token.replace(/[-\s]/g, '').toUpperCase();
      if (skipSet.has(compact) || seen.has(token.toLowerCase())) continue;
      if (/^(?:19|20)\d{2}$/.test(compact)) continue;
      seen.add(token.toLowerCase());
      found.push(token);
      if (found.length >= 10) return found;
    }
  }
  return found;
}

function deriveFallbackGlobalBrandName(ctx: SuggestContext): string | undefined {
  if (ctx.localBrandName.trim() && !containsCjk(ctx.localBrandName)) {
    return ctx.localBrandName.trim();
  }
  if (ctx.brandName.trim() && !containsCjk(ctx.brandName)) {
    return ctx.brandName.trim();
  }
  for (const alias of ctx.existingAliases) {
    const trimmed = alias.trim();
    if (trimmed && !containsCjk(trimmed) && /^[A-Za-z][A-Za-z0-9\s-]{1,40}$/.test(trimmed)) {
      return trimmed;
    }
  }
  for (const domain of ctx.ownedDomains) {
    const root = domain.split('.')[0]?.trim().toLowerCase() ?? '';
    if (root.length >= 2 && !GENERIC_DOMAIN_ROOTS.has(root) && /^[a-z0-9-]+$/.test(root)) {
      return root
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    }
  }
  return undefined;
}

export function buildFallbackMarketSuggestions(ctx: SuggestContext): DraftSuggestionPayload {
  const want = ctx.requestedFields;

  const localBrandName =
    ctx.market === 'GLOBAL' && want.has('localIdentity')
      ? deriveFallbackGlobalBrandName(ctx)
      : undefined;

  const localCategory =
    ctx.market === 'GLOBAL' && want.has('localIdentity')
      ? resolveGlobalCategoryLabel(ctx.brandCategory, ctx.localCategory)
      : undefined;

  const skuSources = [
    ...ctx.facts.map((f) => `${f.title}\n${f.content}`),
    ctx.sourcePageTitle,
    ctx.sourcePageText,
    ctx.focusHint ?? '',
  ];
  const detectedSkus = extractSkuTokens(skuSources);
  const aliases = want.has('aliases') ? sanitizeAliases(detectedSkus, ctx) : [];

  const effectiveBrandName =
    ctx.market === 'GLOBAL'
      ? localBrandName ||
        (!containsCjk(ctx.localBrandName)
          ? ctx.localBrandName
          : deriveFallbackGlobalBrandName(ctx) || 'this brand')
      : ctx.localBrandName.trim() || ctx.brandName;

  const effectiveCategory =
    ctx.market === 'GLOBAL'
      ? localCategory || resolveGlobalCategoryLabel(ctx.brandCategory, ctx.localCategory)
      : ctx.localCategory?.trim() || ctx.brandCategory;

  const primarySku = aliases[0] ?? ctx.existingAliases[0];
  const comp1 = ctx.existingCompetitors[0]?.name;
  const segment = classifyBrandCategorySegment(`${ctx.localCategory ?? ''} ${ctx.brandCategory}`);

  let seedPrompts: BrandSeedPromptSuggestion[] = [];
  if (want.has('seedPrompts')) {
    const basePrompts = generateBrandSeedPrompts({
      market: ctx.market,
      brandName: effectiveBrandName,
      category: ctx.brandCategory,
      localCategory: ctx.market === 'GLOBAL' ? effectiveCategory : ctx.localCategory,
      competitors: ctx.existingCompetitors,
    });

    const expanded: Array<{ prompt: string; intent: BrandSeedPromptIntent }> = [
      ...basePrompts.map((prompt, idx) => ({
        prompt,
        intent: inferPromptIntent(prompt, idx),
      })),
    ];

    if (ctx.market === 'CN') {
      expanded.push(
        {
          prompt: `新手入手${effectiveCategory}容易踩哪些坑？选购避坑清单`,
          intent: 'BUYING_GUIDE',
        },
        {
          prompt: `${effectiveCategory}长期使用稳定性、售后与维护成本怎么样？`,
          intent: 'SCENARIO_PAIN',
        },
        {
          prompt: `${effectiveBrandName}${effectiveCategory}适合哪些使用场景？真实用户评价汇总`,
          intent: 'BRAND_REPUTATION',
        },
        {
          prompt: comp1
            ? `${effectiveBrandName}和${comp1}的核心参数与性价比差距大吗？`
            : `${effectiveBrandName}与同价位主流${effectiveCategory}对比有哪些差异？`,
          intent: 'COMPETITOR_VS',
        },
        {
          prompt: primarySku
            ? `${effectiveBrandName} ${primarySku} 实测表现与核心参数评测`
            : `${effectiveBrandName}${effectiveCategory}主力型号参数配置怎么选？`,
          intent: 'SKU_REVIEW',
        },
        {
          prompt: ctx.focusHint
            ? `针对「${ctx.focusHint.slice(0, 30)}」场景，${effectiveCategory}怎么选更合适？`
            : `预算有限选${effectiveCategory}，哪些核心配置不能省？`,
          intent: 'SCENARIO_PAIN',
        },
      );
    } else {
      expanded.push(
        {
          prompt: `${effectiveCategory} buying checklist: mistakes to avoid in 2026`,
          intent: 'BUYING_GUIDE',
        },
        {
          prompt: `Long-term reliability and maintenance tips for ${effectiveCategory}`,
          intent: 'SCENARIO_PAIN',
        },
        {
          prompt: `${effectiveBrandName} ${effectiveCategory} real user feedback and warranty support`,
          intent: 'BRAND_REPUTATION',
        },
        {
          prompt: comp1
            ? `${effectiveBrandName} vs ${comp1}: key specs and value comparison`
            : `How does ${effectiveBrandName} compare to leading ${effectiveCategory} brands?`,
          intent: 'COMPETITOR_VS',
        },
        {
          prompt: primarySku
            ? `${effectiveBrandName} ${primarySku} hands-on specs and benchmark review`
            : `${effectiveBrandName} ${effectiveCategory} model lineup and specs comparison`,
          intent: 'SKU_REVIEW',
        },
        {
          prompt:
            segment === 'B2B_SAAS'
              ? `Security compliance and onboarding checklist for ${effectiveCategory}`
              : `Key performance specs that actually matter when choosing a ${effectiveCategory}`,
          intent: 'SCENARIO_PAIN',
        },
      );
    }

    seedPrompts = sanitizeSeedPrompts(expanded, ctx);
  }

  let controlPrompts: string[] = [];
  if (want.has('controlPrompts')) {
    const rawControls =
      ctx.market === 'CN'
        ? [
            `${effectiveCategory}行业最新技术标准与发展趋势解读`,
            `${effectiveCategory}常见故障排查与日常保养注意事项`,
            `入门级与专业级${effectiveCategory}的核心结构区别是什么？`,
            `${effectiveCategory}选购前需要提前准备哪些配件或使用环境？`,
            `${effectiveCategory}保修政策与官方售后网点通常怎么看？`,
          ]
        : [
            `How ${effectiveCategory} technology standards are evolving in 2026`,
            `Routine troubleshooting and preventive care guide for ${effectiveCategory}`,
            `Entry-level vs pro-grade ${effectiveCategory}: core architecture differences`,
            `Setup prerequisites and accessories to prepare before installing a ${effectiveCategory}`,
            `What warranty coverage and service terms are standard for ${effectiveCategory}?`,
          ];
    controlPrompts = sanitizeControlPrompts(rawControls, ctx, seedPrompts);
  }

  return {
    ...(localBrandName ? { localBrandName } : {}),
    ...(localCategory ? { localCategory } : {}),
    aliases,
    competitors: [],
    seedPrompts,
    controlPrompts,
  };
}
