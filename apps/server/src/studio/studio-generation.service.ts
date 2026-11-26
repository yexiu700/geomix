import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BRAND_FACT_TOP_K_CHUNKS,
  GEO_RECIPE_LABELS,
  GEO_REWRITE_ACTION_LABELS,
  GEO_TARGET_FORMAT_LABELS,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  LLM_STREAM_TIMEOUT_MS,
  cleanTitleText,
  containsCjk,
  detectLocaleLeakage,
  evaluateGeoArticle,
  formatComplianceBlockMessage,
  markdownToSanitizedHtml,
  normalizeMissingFactPlaceholdersForMarket,
  postProcessArticleMarkdown,
  resolveEffectiveCategory,
  resolveEffectiveLocale,
  resolveLocaleWritingDirective,
  resolveProductLineLocalName,
  stripInlineJsonLdBlocks,
  type GeoComplianceFlag,
  type GeoEvaluationResult,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoRewriteAction,
  type GeoTargetFormat,
  type SupportedLocale,
} from '@geomix/shared';
import {
  BrandFactIndexRunner,
  type RetrievedBrandFactSnippet,
} from '../brands/brand-fact-index.runner';
import { ComplianceService } from '../infra/compliance';
import {
  LlmService,
  assertCompletionAllowed,
  isFakeOutputAllowed,
  type LlmMessage,
} from '../infra/llm';
import { ProviderError, PROVIDER_KIND } from '../infra/provider-error';
import { buildFakeRewriteSection, streamFakeGeoArticle } from './studio-fake-draft';

function readPositiveEnvMs(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type StudioBrandContext = {
  id: string;
  name: string;
  category: string;
};

export type StudioMarketContext = {
  id: string;
  market: GeoMarket;
  locale: string;
  region: string;
  localBrandName: string;
  localCategory?: string | null;
  aliases: readonly string[];
  ownedDomains: readonly string[];
  competitors: readonly string[];
};

export type StudioProductLineContext = {
  id?: string;
  name?: string | null;
  localNamesJson?: unknown;
  category?: string | null;
  localCategoriesJson?: unknown;
  competitorsJson?: unknown;
};

export type StudioGenerateArticleParams = {
  tenantId: string;
  articleId: string;
  brand: StudioBrandContext;
  market: StudioMarketContext;
  productLine?: StudioProductLineContext | null;
  recipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  targetLocale?: SupportedLocale;
  targetPrompt: string;
  title?: string;
  outlineH2: readonly GeoOutlineHeading[];
  targetFanOuts: readonly string[];
  factSnippets: readonly RetrievedBrandFactSnippet[];
  matchedFactIds: readonly string[];
  customToneNote?: string | null;
  customForbiddenWords?: readonly string[];
  recipeOverride?: string | null;
  sourceCitationUrl?: string;
  pastedReferenceText?: string;
  wordCountTarget?: number;
  reservationShadow: boolean;
  signal?: AbortSignal;
  onDelta: (chunk: string) => void | Promise<void>;
};

export type StudioGeneratedArticleResult = {
  title: string;
  targetLocale: SupportedLocale;
  contentMarkdown: string;
  contentHtml: string;
  complianceFlags: GeoComplianceFlag[];
  evaluation: GeoEvaluationResult;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

export type StudioRewriteSectionParams = {
  tenantId: string;
  articleId: string;
  market: StudioMarketContext;
  brand: StudioBrandContext;
  productLineId?: string | null;
  productLine?: StudioProductLineContext | null;
  targetLocale?: SupportedLocale;
  action: GeoRewriteAction;
  selectedText: string;
  instruction?: string;
  surroundingContext?: string;
  customToneNote?: string | null;
  customForbiddenWords?: readonly string[];
};

export type StudioRewriteSectionResult = {
  rewrittenText: string;
  complianceFlags: GeoComplianceFlag[];
  model: string;
  tokensIn: number;
  tokensOut: number;
};

/**
 * GEO 写作与局部改写核心引擎（零依赖 BrandsModule/AuthModule），
 * 供 ApiModule 的 StudioService 与 WorkerModule 的 GeoBatchRunner 共同复用。
 */
@Injectable()
export class StudioGenerationService {
  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(BrandFactIndexRunner) private readonly factIndexRunner: BrandFactIndexRunner,
  ) {}

  async retrieveFacts(
    tenantId: string,
    brandId: string,
    query: string,
    productLineId?: string | null,
  ): Promise<RetrievedBrandFactSnippet[]> {
    return this.factIndexRunner.retrieveRelevantBrandFacts(
      tenantId,
      brandId,
      query,
      BRAND_FACT_TOP_K_CHUNKS,
      productLineId,
    );
  }

  async streamArticle(params: StudioGenerateArticleParams): Promise<StudioGeneratedArticleResult> {
    const started = Date.now();
    const effectiveLocale = resolveEffectiveLocale(
      params.targetLocale ?? params.market.locale,
      params.market.market,
    );
    const effectiveCategory = resolveEffectiveCategory(
      params.brand,
      params.market,
      params.productLine,
    );
    const allowedTerms = collectAllowedTerms(params.brand, params.market, params.productLine);
    const usesFakePrimary = this.llm.usesFakePrimary('geo_write');
    let rawText = '';
    let suggestedTitle = params.title ?? '';
    let model = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (usesFakePrimary) {
      if (
        !isFakeOutputAllowed({
          llm: this.llm,
          scene: 'geo_write',
          reservationShadow: params.reservationShadow,
        })
      ) {
        throw new ProviderError(
          PROVIDER_KIND.UPSTREAM,
          '真实大模型未配置，正式计费环境下禁止使用占位模板交付并已退还预扣点数',
          'fake_fallback_rejected',
        );
      }

      const fakeResult = await streamFakeGeoArticle({
        market: params.market.market,
        targetLocale: effectiveLocale,
        allowedTerms,
        recipe: params.recipe,
        targetFormat: params.targetFormat,
        localBrandName: params.market.localBrandName,
        category: effectiveCategory,
        competitors: params.market.competitors,
        targetPrompt: params.targetPrompt,
        title: params.title,
        outlineH2: params.outlineH2,
        targetFanOuts: params.targetFanOuts,
        factSnippets: params.factSnippets,
        customToneNote: params.customToneNote,
        pastedReferenceText: params.pastedReferenceText,
        signal: params.signal,
        onDelta: params.onDelta,
      });

      rawText = fakeResult.text;
      suggestedTitle = fakeResult.title || suggestedTitle;
      model = fakeResult.model;
      tokensIn = fakeResult.tokensIn;
      tokensOut = fakeResult.tokensOut;

      this.llm.recordSyntheticCost({
        tenantId: params.tenantId,
        idempotencyKey: `geo_article:${params.articleId}`,
        scene: 'geo_write',
        completion: {
          provider: 'fake',
          model,
          fake: true,
          text: rawText,
          tokensIn,
          tokensOut,
        },
        latencyMs: Math.max(0, Date.now() - started),
      });
    } else {
      const messages = buildGeoWriteMessages(params);
      const streamTimeoutMs = readPositiveEnvMs(
        process.env.LLM_STREAM_TIMEOUT_MS,
        LLM_STREAM_TIMEOUT_MS,
      );
      const streamIdleTimeoutMs = readPositiveEnvMs(
        process.env.LLM_STREAM_IDLE_TIMEOUT_MS,
        LLM_STREAM_IDLE_TIMEOUT_MS,
      );
      const result = await this.llm.streamComplete({
        tenantId: params.tenantId,
        scene: 'geo_write',
        messages,
        idempotencyKey: `geo_article:${params.articleId}`,
        timeoutMs: streamTimeoutMs,
        idleTimeoutMs: streamIdleTimeoutMs,
        signal: params.signal,
        allowFakeFallback: isFakeOutputAllowed({
          llm: this.llm,
          scene: 'geo_write',
          reservationShadow: params.reservationShadow,
        }),
        onDelta: params.onDelta,
      });
      assertCompletionAllowed({
        completion: result,
        llm: this.llm,
        scene: 'geo_write',
        reservationShadow: params.reservationShadow,
      });
      rawText = result.text;
      model = result.model;
      tokensIn = result.tokensIn;
      tokensOut = result.tokensOut;
    }

    const preparedRaw = ensureLocalizedStructuralMarkers(
      rawText,
      effectiveLocale,
      params.market.localBrandName,
    );
    const processed = postProcessArticleMarkdown(preparedRaw, {
      question: params.targetPrompt,
      brand: params.market.localBrandName,
      market: params.market.market,
    });

    const bodyScan = this.compliance.scan(processed.cleanedMarkdown, {
      market: params.market.market,
      customForbiddenWords: params.customForbiddenWords,
    });
    if (bodyScan.blocked) {
      throw new ProviderError(
        PROVIDER_KIND.CONTRACT,
        formatComplianceBlockMessage(
          bodyScan.hits.map((hit) => hit.label),
          { market: params.market.market, context: 'generate' },
        ),
        'compliance_blocked',
      );
    }

    const candidateTitle =
      suggestedTitle.trim() ||
      extractFirstH1(rawText) ||
      cleanTitleText(params.targetPrompt, params.targetPrompt);
    const titleScan = this.compliance.scan(candidateTitle, {
      market: params.market.market,
      customForbiddenWords: params.customForbiddenWords,
    });
    const finalTitle = cleanTitleText(
      titleScan.blocked ? params.targetPrompt : titleScan.text,
      params.targetPrompt,
      4,
      120,
    );

    const finalMarkdown = normalizeMissingFactPlaceholdersForMarket(
      bodyScan.text,
      params.market.market,
    );

    const leakage = detectLocaleLeakage(
      `${finalTitle}\n${finalMarkdown}`,
      effectiveLocale,
      allowedTerms,
    );
    if (leakage.leaked) {
      throw new ProviderError(
        PROVIDER_KIND.CONTRACT,
        formatLocaleLeakageError(effectiveLocale),
        'locale_leakage_blocked',
      );
    }

    const finalHtml = markdownToSanitizedHtml(finalMarkdown);
    const mergedFlags = mergeComplianceFlags(titleScan.geoFlags, bodyScan.geoFlags);

    const evaluation = evaluateGeoArticle({
      market: params.market.market,
      locale: effectiveLocale,
      localBrandName: params.market.localBrandName,
      category: effectiveCategory,
      localCategory: effectiveCategory,
      ownedDomains: params.market.ownedDomains,
      title: finalTitle,
      targetPrompt: params.targetPrompt,
      contentMarkdown: finalMarkdown,
      targetFanOuts: params.targetFanOuts,
      matchedFactIds: params.matchedFactIds,
      brandFactTexts: params.factSnippets.map((f) => f.content),
      complianceFlags: mergedFlags,
    });

    return {
      title: finalTitle,
      targetLocale: effectiveLocale,
      contentMarkdown: finalMarkdown,
      contentHtml: finalHtml,
      complianceFlags: mergedFlags,
      evaluation,
      model,
      tokensIn,
      tokensOut,
    };
  }

  async generateArticle(
    params: Omit<StudioGenerateArticleParams, 'onDelta'>,
  ): Promise<StudioGeneratedArticleResult> {
    return this.streamArticle({
      ...params,
      onDelta: () => undefined,
    });
  }

  async rewriteSection(params: StudioRewriteSectionParams): Promise<StudioRewriteSectionResult> {
    const effectiveLocale = resolveEffectiveLocale(
      params.targetLocale ?? params.market.locale,
      params.market.market,
    );
    const allowedTerms = collectAllowedTerms(params.brand, params.market, params.productLine);
    const factSnippets = await this.retrieveFacts(
      params.tenantId,
      params.brand.id,
      params.selectedText.slice(0, 300),
      params.productLineId ?? params.productLine?.id ?? null,
    );
    const usesFakePrimary = this.llm.usesFakePrimary('geo_rewrite');
    let rawRewritten = '';
    let model = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (usesFakePrimary) {
      if (
        !isFakeOutputAllowed({
          llm: this.llm,
          scene: 'geo_rewrite',
          reservationShadow: true,
        })
      ) {
        throw new ProviderError(
          PROVIDER_KIND.UPSTREAM,
          '真实大模型未配置，正式计费环境下禁止使用占位模板改写',
          'fake_fallback_rejected',
        );
      }
      const fake = buildFakeRewriteSection({
        market: params.market.market,
        targetLocale: effectiveLocale,
        allowedTerms,
        action: params.action,
        selectedText: params.selectedText,
        localBrandName: params.market.localBrandName,
        factSnippets,
        instruction: params.instruction,
      });
      rawRewritten = fake.text;
      model = fake.model;
      tokensIn = fake.tokensIn;
      tokensOut = fake.tokensOut;
    } else {
      const messages = buildRewriteMessages(params, factSnippets, effectiveLocale);
      const idempotencyKey = `geo_rw_${params.articleId.slice(0, 20)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const result = await this.llm.complete({
        tenantId: params.tenantId,
        scene: 'geo_rewrite',
        messages,
        idempotencyKey,
      });
      assertCompletionAllowed({
        completion: result,
        llm: this.llm,
        scene: 'geo_rewrite',
        reservationShadow: true,
      });
      rawRewritten = result.text.trim();
      model = result.model;
      tokensIn = result.tokensIn;
      tokensOut = result.tokensOut;
    }

    const scanned = this.compliance.scan(rawRewritten, {
      market: params.market.market,
      customForbiddenWords: params.customForbiddenWords,
    });
    if (scanned.blocked) {
      throw new ProviderError(
        PROVIDER_KIND.CONTRACT,
        formatComplianceBlockMessage(
          scanned.hits.map((hit) => hit.label),
          { market: params.market.market, context: 'rewrite' },
        ),
        'compliance_blocked',
      );
    }

    const finalRewritten = scanned.text.trim();
    const leakage = detectLocaleLeakage(finalRewritten, effectiveLocale, allowedTerms);
    if (leakage.leaked) {
      throw new ProviderError(
        PROVIDER_KIND.CONTRACT,
        formatLocaleLeakageError(effectiveLocale),
        'locale_leakage_blocked',
      );
    }

    return {
      rewrittenText: finalRewritten,
      complianceFlags: scanned.geoFlags,
      model,
      tokensIn,
      tokensOut,
    };
  }
}

function collectAllowedTerms(
  brand: StudioBrandContext,
  market: StudioMarketContext,
  productLine?: StudioProductLineContext | null,
): string[] {
  const lineLocalName = resolveProductLineLocalName(productLine, market.market);
  const rawLineName = typeof productLine?.name === 'string' ? productLine.name.trim() : '';
  const safeLineName =
    rawLineName && (market.market === 'CN' || !containsCjk(rawLineName)) ? rawLineName : null;
  return [
    brand.name,
    market.localBrandName,
    ...market.aliases,
    ...market.competitors,
    ...(safeLineName ? [safeLineName] : []),
    ...(lineLocalName ? [lineLocalName] : []),
  ].filter((term) => term.trim().length > 0);
}

function formatLocaleLeakageError(locale: SupportedLocale): string {
  return locale === 'ja-JP'
    ? '日语（ja-JP）生成结果检测到疑似简体中文字符或缺失假名特征，已拦截并退还本次点数'
    : `目标语种（${locale}）生成结果检测到未翻译的非品牌中文/CJK 字符，已拦截并退还本次点数`;
}

const STUDIO_PLEASANTRY_LINE =
  /^(好的|当然|没问题|收到|以下为您|以下是|下面为您|为您整理|这是一篇|根据您的要求)[^\n]*\n+/u;
const STUDIO_LEADING_H1 = /^#\s+[^\n]+\n+/u;
const STUDIO_RAW_URL_PATTERN = /https?:\/\/[^\s)>"'】）]+/gi;

function ensureLocalizedStructuralMarkers(
  rawMarkdown: string,
  locale: SupportedLocale,
  brandName: string,
): string {
  if (locale === 'zh-CN' || locale === 'en-US') {
    return rawMarkdown;
  }
  const directive = resolveLocaleWritingDirective(locale);
  let out = rawMarkdown.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(out);
  if (fenced) {
    out = fenced[1]!.trim();
  }
  out = stripInlineJsonLdBlocks(out).trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(STUDIO_PLEASANTRY_LINE, '').replace(STUDIO_LEADING_H1, '').trim();
    if (next === out) break;
    out = next;
  }

  if (!/^##\s+/m.test(out)) {
    out = `## ${directive.keyTakeawaysHeading}\n\n${out}`;
  }
  const faqProbeText = out.replace(STUDIO_RAW_URL_PATTERN, '');
  if (!/FAQ|常见问题|Frequently Asked Questions/i.test(faqProbeText)) {
    const safeBrand = brandName.trim() || 'Solution';
    const fallbackFaqByLocale: Record<Exclude<SupportedLocale, 'zh-CN' | 'en-US'>, string> = {
      'en-GB': `**Q: What verified metrics should buyers review for ${safeBrand}?**\nA: Compare documented specifications, acoustic and power measurements, and warranty coverage against your workload.`,
      'de-DE': `**F: Welche geprüften Kennzahlen sind bei ${safeBrand} entscheidend?**\nA: Vergleichen Sie dokumentierte Messwerte, Leistungsaufnahme und Garantiebedingungen sachlich mit Ihrem Einsatzprofil.`,
      'ja-JP': `**Q: ${safeBrand} を選定する際に確認すべき主な指標は何ですか？**\nA: 公開されている検証済みスペック、実測データ、長期運用時の保守条件を用途と照らし合わせて比較してください。`,
      'es-ES': `**P: ¿Qué métricas verificadas conviene revisar para ${safeBrand}?**\nA: Compare las especificaciones documentadas, las mediciones reales y la garantía frente a sus necesidades operativas.`,
      'fr-FR': `**Q : Quels indicateurs vérifiés examiner pour ${safeBrand} ?**\nR : Comparez les spécifications documentées, les mesures réelles et les conditions de garantie selon votre usage.`,
    };
    out = `${out.trimEnd()}\n\n## ${directive.faqHeading}\n${fallbackFaqByLocale[locale]}`;
  }
  return out;
}

function extractFirstH1(raw: string): string {
  const match = /^#\s+(.+)$/m.exec(raw);
  return match?.[1]?.trim() ?? '';
}

function mergeComplianceFlags(
  a: readonly GeoComplianceFlag[],
  b: readonly GeoComplianceFlag[],
): GeoComplianceFlag[] {
  const seen = new Set<string>();
  const out: GeoComplianceFlag[] = [];
  for (const flag of [...a, ...b]) {
    const key = `${flag.code}::${flag.market}::${flag.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flag);
  }
  return out;
}

function buildGeoWriteMessages(params: StudioGenerateArticleParams): LlmMessage[] {
  const effectiveLocale = resolveEffectiveLocale(
    params.targetLocale ?? params.market.locale,
    params.market.market,
  );
  const directive = resolveLocaleWritingDirective(effectiveLocale);
  const crossLingualRule =
    effectiveLocale !== 'zh-CN'
      ? `Even when Brand Facts below are written in Chinese or another language, cross-lingually translate and integrate all verified numbers, models, certifications, and advantages into natural ${directive.nativeLabel} (${directive.locale}) prose.`
      : '';

  const formatDesc = GEO_TARGET_FORMAT_LABELS[params.targetFormat];
  const recipeDesc = GEO_RECIPE_LABELS[params.recipe];
  const effectiveCategory = resolveEffectiveCategory(
    params.brand,
    params.market,
    params.productLine,
  );

  const placeholderExample =
    effectiveLocale !== 'zh-CN' ? '[TBD: e.g., Standby Power Draw W]' : '[待补充：如待机功耗 W]';
  const placeholderShort = effectiveLocale !== 'zh-CN' ? '[TBD: ...]' : '[待补充：...]';

  const systemParts = [
    'You are an expert GEO (Generative Engine Optimization) technical editor.',
    `Target Locale: ${directive.locale} (${directive.nativeLabel}, html lang="${directive.htmlLang}").`,
    `Language Directive: ${directive.writingLanguageInstruction}`,
    ...(crossLingualRule ? [crossLingualRule] : []),
    `Compliance Standard (${directive.complianceNoticeKey}): ${directive.complianceInstruction}`,
    `Recipe: ${params.recipe} (${recipeDesc}). Target channel format: ${params.targetFormat} (${formatDesc}).`,
    'Structure requirements:',
    '1. Start with a concise direct-answer opening paragraph (60-120 chars/words) before the first H2.',
    `2. Include at least 3 clear Markdown H2 (##) sections, a GFM comparison table (| col | ... |), bullet lists, and a closing FAQ section titled "## ${directive.faqHeading}".`,
    `3. Ground all specifications in the provided Brand Facts. Never fabricate numbers; if a critical spec is absent from Brand Facts, insert a plain placeholder like ${placeholderExample} — NEVER wrap it in a Markdown link such as ${placeholderShort}(#faq).`,
    '4. Never output legacy template variables such as {训练词占位符} or 【品牌1】.',
    '5. Do NOT output <script type="application/ld+json">, raw JSON-LD blocks, or HTML <script> tags inside the Markdown article body; structured JSON-LD Schema is generated separately by the delivery panel.',
  ];

  if (params.customToneNote?.trim()) {
    systemParts.push(`Custom tone preference: ${params.customToneNote.trim()}`);
  }
  if (params.recipeOverride?.trim()) {
    systemParts.push(`Recipe custom guidance: ${params.recipeOverride.trim()}`);
  }
  if ((params.customForbiddenWords?.length ?? 0) > 0) {
    systemParts.push(
      `Never use any of these tenant-forbidden words: ${params.customForbiddenWords!.join(', ')}`,
    );
  }

  const factBlock =
    params.factSnippets.length > 0
      ? params.factSnippets
          .map((f, idx) => `[Fact ${idx + 1} · ${f.slot} · ${f.title}]\n${f.content}`)
          .join('\n\n')
      : `(No structured brand facts provided yet; keep claims conservative and mark missing specs with ${placeholderShort}.)`;

  const userParts = [
    `Brand: ${params.market.localBrandName} (Category: ${effectiveCategory})`,
    `Competitors: ${params.market.competitors.join(', ') || 'Mainstream competitors'}`,
    `Target Locale: ${directive.locale} (${directive.nativeLabel})`,
    `Target Prompt: ${params.targetPrompt}`,
  ];
  if (params.title) userParts.push(`Preferred Title: ${params.title}`);
  if (params.outlineH2.length > 0) {
    userParts.push(
      `Outline H2:\n${params.outlineH2.map((h) => `- ${h.heading}${h.intent ? ` (${h.intent})` : ''}`).join('\n')}`,
    );
  }
  if (params.targetFanOuts.length > 0) {
    userParts.push(`Target Fan-Out Queries to cover: ${params.targetFanOuts.join('; ')}`);
  }
  if (params.wordCountTarget) {
    userParts.push(`Target length: ~${params.wordCountTarget} chars/words.`);
  }
  if (params.pastedReferenceText?.trim()) {
    userParts.push(
      `Reference competitor content to surpass:\n${params.pastedReferenceText.trim().slice(0, 6000)}`,
    );
  }
  userParts.push(`Verified Brand Facts:\n${factBlock}`);

  return [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

function buildRewriteMessages(
  params: StudioRewriteSectionParams,
  factSnippets: readonly RetrievedBrandFactSnippet[],
  effectiveLocale: SupportedLocale,
): LlmMessage[] {
  const isZh = effectiveLocale === 'zh-CN';
  const directive = resolveLocaleWritingDirective(effectiveLocale);
  const actionLabel = GEO_REWRITE_ACTION_LABELS[params.action];
  const actionRule: Record<GeoRewriteAction, string> = {
    DE_AD: isZh
      ? '去除硬广与夸张营销口吻，改写为客观、理性、可验证的评测表述，严禁广告法极限词。'
      : `Make the passage more objective, evidence-driven, and remove promotional fluff in natural ${directive.nativeLabel} (${directive.locale}).`,
    TO_TABLE: isZh
      ? '将选中内容提炼为结构清晰的 GFM Markdown 对比表格（含表头与 | --- | 分隔行）。'
      : `Convert the passage into a clean GFM Markdown comparison table in ${directive.nativeLabel} (${directive.locale}) (| Metric | Value | Notes |).`,
    ADD_EVIDENCE: isZh
      ? '结合下方品牌事实卡补充可核验的数据论据与规格锚点，禁止编造未提供的参数。'
      : `Enrich the passage in ${directive.nativeLabel} (${directive.locale}) with concrete specifications and verifiable facts from the Brand Facts below.`,
    CONCISE_ANSWER: isZh
      ? '精简为 60-120 字直答结论，开门见山便于 AI 直接引用。'
      : `Condense the passage into a crisp 2-3 sentence direct answer in ${directive.nativeLabel} (${directive.locale}) ideal for AI answer extraction.`,
  };

  const factsText = factSnippets
    .slice(0, 4)
    .map((f) => `- ${f.title}: ${f.content.slice(0, 400)}`)
    .join('\n');

  return [
    {
      role: 'system',
      content: [
        `You are a GEO section editor performing action ${params.action} (${actionLabel}).`,
        `Target Locale: ${directive.locale} (${directive.nativeLabel}, html lang="${directive.htmlLang}").`,
        `Language Directive: ${directive.writingLanguageInstruction}`,
        `Compliance Standard (${directive.complianceNoticeKey}): ${directive.complianceInstruction}`,
        actionRule[params.action],
        'Return ONLY the rewritten Markdown passage without preamble or wrapper fences.',
        params.customToneNote?.trim() ? `Tone note: ${params.customToneNote.trim()}` : '',
        (params.customForbiddenWords?.length ?? 0) > 0
          ? `Forbidden words: ${params.customForbiddenWords!.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: [
        `Brand: ${params.market.localBrandName}`,
        `Target Locale: ${directive.locale} (${directive.nativeLabel})`,
        params.instruction ? `Extra instruction: ${params.instruction}` : '',
        params.surroundingContext ? `Surrounding context:\n${params.surroundingContext}` : '',
        factsText ? `Brand Facts:\n${factsText}` : '',
        `Selected passage to rewrite:\n${params.selectedText}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}
