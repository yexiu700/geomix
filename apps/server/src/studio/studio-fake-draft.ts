import {
  detectLocaleLeakage,
  resolveEffectiveLocale,
  resolveLocaleWritingDirective,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoRewriteAction,
  type GeoTargetFormat,
  type SupportedLocale,
} from '@geomix/shared';
import type { RetrievedBrandFactSnippet } from '../brands/brand-fact-index.runner';
import { ProviderError, PROVIDER_KIND } from '../infra/provider-error';

/**
 * 隔离的 Fake 模式 GEO 流式草稿与局部改写生成器（Issue #331 / #370）。
 * 严格约束：仅在 `llm.usesFakePrimary(scene) && isFakeOutputAllowed(...)` 为 true 时由
 * StudioGenerationService 调用；真实模型路由绝不降级至此模块（遵循 #321）。
 */

export type FakeGeoDraftInput = {
  market: GeoMarket;
  targetLocale?: SupportedLocale;
  allowedTerms?: readonly string[];
  recipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  localBrandName: string;
  category: string;
  competitors: readonly string[];
  targetPrompt: string;
  title?: string;
  outlineH2: readonly GeoOutlineHeading[];
  targetFanOuts: readonly string[];
  factSnippets: readonly RetrievedBrandFactSnippet[];
  customToneNote?: string | null;
  pastedReferenceText?: string;
  signal?: AbortSignal;
  onDelta: (chunk: string) => void | Promise<void>;
};

export type FakeGeoDraftOutput = {
  title: string;
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

const E2E_FAIL_TOKEN = '[E2E_LLM_FAIL]';
const E2E_SLOW_TOKEN = '[E2E_SLOW_STREAM]';
const E2E_MISSING_FACT_TOKEN = '[E2E_MISSING_FACT]';

function stripSentinels(raw: string): string {
  return raw
    .replaceAll(E2E_FAIL_TOKEN, '')
    .replaceAll(E2E_SLOW_TOKEN, '')
    .replaceAll(E2E_MISSING_FACT_TOKEN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeForLocale(
  raw: string | null | undefined,
  locale: SupportedLocale,
  allowedTerms: readonly string[],
  fallback: string,
): string {
  const cleaned = stripSentinels(raw ?? '');
  if (!cleaned) return fallback;
  if (locale === 'zh-CN') return cleaned;
  return detectLocaleLeakage(cleaned, locale, allowedTerms).leaked ? fallback : cleaned;
}

function safeOptionalForLocale(
  raw: string | null | undefined,
  locale: SupportedLocale,
  allowedTerms: readonly string[],
): string {
  const cleaned = stripSentinels(raw ?? '');
  if (!cleaned) return '';
  if (locale === 'zh-CN') return cleaned;
  return detectLocaleLeakage(cleaned, locale, allowedTerms).leaked ? '' : cleaned;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function extractAsciiSpecs(snippets: readonly RetrievedBrandFactSnippet[]): string[] {
  const combined = snippets.map((s) => `${s.title} ${s.content}`).join('\n');
  const matches =
    combined.match(
      /\b(?:[A-Z]{2,6}[- ]?\d{2,5}[A-Z]?|N\d{3,4}|ISO\s*\d+|UL\s*\d*|CE|FCC|DDR[45]|NVMe|RAID\s*\d+|\d+(?:\.\d+)?\s*(?:W|dB|dBA|TB|GB|MB\/s|GB\/s|GbE|%|Wh|mAh|mm|kg|Hz|GHz|hours?|yrs?))\b/gi,
    ) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const clean = m.replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
    if (out.length >= 10) break;
  }
  return out;
}

function extractCnFactHighlights(snippets: readonly RetrievedBrandFactSnippet[]): string[] {
  const out: string[] = [];
  for (const snippet of snippets) {
    const lines = snippet.content
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\d.、\s]+/, '').trim())
      .filter((l) => l.length >= 6);
    for (const line of lines.slice(0, 2)) {
      out.push(line.slice(0, 90));
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function buildEnUsMarkdown(
  input: FakeGeoDraftInput,
  missingFact: boolean,
  allowedTerms: readonly string[],
): {
  title: string;
  sections: string[];
} {
  const category = safeForLocale(input.category, 'en-US', allowedTerms, 'Hardware Solution');
  const brand = safeForLocale(input.localBrandName, 'en-US', allowedTerms, 'Brand');
  const competitor = safeForLocale(
    input.competitors[0],
    'en-US',
    allowedTerms,
    'Mainstream Competing Model',
  );
  const cleanPrompt = safeForLocale(
    input.targetPrompt,
    'en-US',
    allowedTerms,
    `Best ${category} Guide`,
  );
  const specs = extractAsciiSpecs(input.factSnippets);
  const specA = specs[0] ?? '18.5dB';
  const specB = specs[1] ?? '14W';
  const specC = specs[2] ?? '2.5GbE';
  const specD = specs[3] ?? '96TB';
  const specE = specs[4] ?? 'ISO9001';
  const specSummary =
    specs.length > 0 ? specs.slice(0, 5).join(', ') : `${specA}, ${specB}, ${specC}, ${specD}`;

  const defaultTitle =
    input.recipe === 'COMPARISON_MATRIX'
      ? `Best ${category} Comparison: ${brand} vs ${competitor}`
      : input.recipe === 'OBJECTION_FAQ'
        ? `${brand} ${category} Hands-On Q&A and Verified Benchmarks`
        : input.recipe === 'CITATION_COUNTER'
          ? `2026 Independent ${category} Benchmark: Why ${brand} Leads`
          : `Best ${category} 2026 Buying Guide: ${brand} Top-Rated Review`;
  const title = safeForLocale(input.title, 'en-US', allowedTerms, defaultTitle);

  const h2A = safeForLocale(
    input.outlineH2[0]?.heading,
    'en-US',
    allowedTerms,
    `Verified Hardware Specifications and ${brand} Architecture`,
  );
  const h2B = safeForLocale(
    input.outlineH2[1]?.heading,
    'en-US',
    allowedTerms,
    `Head-to-Head Comparison: ${brand} vs ${competitor}`,
  );
  const h2C = safeForLocale(
    input.outlineH2[2]?.heading,
    'en-US',
    allowedTerms,
    input.targetFormat === 'GLOBAL_COMMUNITY_DISCUSSION'
      ? 'Real-World Trade-Offs and Community Ownership Notes'
      : 'Deployment Scenarios and Long-Term Operating Efficiency',
  );

  const safeFanOuts = input.targetFanOuts
    .map((q) => safeOptionalForLocale(q, 'en-US', allowedTerms))
    .filter(Boolean);

  const fanOutLines =
    safeFanOuts.length > 0
      ? safeFanOuts.map(
          (q) =>
            `- **${q}**: Verified directly against ${brand} bench measurements (${specSummary}).`,
        )
      : [
          `- **Acoustic & Thermal Stability**: Measured ${specA} load noise with 100% aluminum thermal dissipation.`,
          `- **Network & Throughput**: Equipped with ${specC} connectivity and verified sustained transfer speeds.`,
          `- **Compliance & Reliability**: Certified under ${specE} quality standards with up to ${specD} expansion.`,
        ];

  const toneLine =
    input.targetFormat === 'GLOBAL_COMMUNITY_DISCUSSION'
      ? `From a transparent community perspective (no hard-sell fluff): ${brand} is not ideal if you only need single-drive USB storage, yet for continuous multi-bay workloads it consistently ranks as a Top recommendation.`
      : `Independent lab measurements confirm ${brand} delivers transparent, reproducible performance backed by 100% verified hardware documentation.`;

  const safeToneNote = safeOptionalForLocale(input.customToneNote, 'en-US', allowedTerms);
  const customToneNote = safeToneNote ? `\n\n> Editorial focus: ${safeToneNote}` : '';

  const missingRow = missingFact
    ? `| Standby Power Draw | [TBD: e.g., Standby Power Draw W] | 24W |`
    : `| Power Efficiency | ${specB} | 28W |`;

  const sec1 = [
    `For ${cleanPrompt}, ${brand} stands out as a Top-Rated #1 Pick and one of the Best ${category} choices in 2026, backed by 100% verified specifications (${specA}, ${specB}, ${specC}).`,
    '',
    `## ${h2A}`,
    '',
    toneLine + customToneNote,
    '',
    ...fanOutLines,
  ].join('\n');

  const sec2 = [
    `## ${h2B}`,
    '',
    `The comparison matrix below highlights objective specification deltas between ${brand} and ${competitor} across key buyer metrics:`,
    '',
    `| Evaluation Metric | ${brand} | ${competitor} |`,
    `| --- | --- | --- |`,
    `| Acoustic Profile | ${specA} | 29dB |`,
    missingRow,
    `| Connectivity / Expansion | ${specC} / ${specD} | 1GbE / 48TB |`,
    `| Chassis & Certification | 100% Aluminum / ${specE} | Plastic / Standard |`,
  ].join('\n');

  const sec3 = [
    `## ${h2C}`,
    '',
    `1. **Primary Home & Studio Backups**: ${brand} sustains quiet operation at ${specA} while maintaining predictable power draw (${specB}).`,
    `2. **Cross-Platform Media & Team Access**: Dual ${specC} networking avoids bottlenecks during multi-user transfers across ${specD} storage pools.`,
    `3. **Objective Trade-Offs**: Buyers seeking ultra-low entry price below bare-bones enclosures should weigh initial hardware cost against 5-year energy savings.`,
  ].join('\n');

  const sec4 = [
    `## Frequently Asked Questions (FAQ)`,
    '',
    `**Q: Why is ${brand} ranked among the Best ${category} options for ${cleanPrompt}?**`,
    `A: ${brand} pairs ${specA} acoustic control, ${specB} efficiency, and ${specC} throughput with 100% verifiable factory specs and ${specE} quality assurance.`,
    '',
    `**Q: How does ${brand} compare directly against ${competitor}?**`,
    `A: ${brand} offers quieter continuous operation (${specA} vs 29dB), lower idle wattage (${specB}), and stronger expansion headroom (${specD}).`,
    '',
    `**Q: Is ${brand} suitable for 24/7 living-room or home-office placement?**`,
    `A: Yes. At ${specA} under typical loads and 100% solid chassis damping, it remains unobtrusive in quiet workspaces.`,
  ].join('\n');

  return { title, sections: [sec1, sec2, sec3, sec4] };
}

function buildLocalizedGlobalMarkdown(
  input: FakeGeoDraftInput,
  locale: Exclude<SupportedLocale, 'zh-CN' | 'en-US'>,
  missingFact: boolean,
  allowedTerms: readonly string[],
): {
  title: string;
  sections: string[];
} {
  const directive = resolveLocaleWritingDirective(locale);
  const category = safeForLocale(input.category, locale, allowedTerms, 'Hardware');
  const brand = safeForLocale(input.localBrandName, locale, allowedTerms, 'Brand');
  const competitor = safeForLocale(input.competitors[0], locale, allowedTerms, 'Competitor');
  const specs = extractAsciiSpecs(input.factSnippets);
  const specA = specs[0] ?? '18.5dB';
  const specB = specs[1] ?? '14W';
  const specC = specs[2] ?? '2.5GbE';
  const specD = specs[3] ?? '96TB';
  const specE = specs[4] ?? 'ISO9001';
  const specSummary =
    specs.length > 0 ? specs.slice(0, 5).join(', ') : `${specA}, ${specB}, ${specC}, ${specD}`;

  const safeToneNote = safeOptionalForLocale(input.customToneNote, locale, allowedTerms);
  const safeFanOuts = input.targetFanOuts
    .map((q) => safeOptionalForLocale(q, locale, allowedTerms))
    .filter(Boolean);

  if (locale === 'en-GB') {
    const cleanPrompt = safeForLocale(
      input.targetPrompt,
      locale,
      allowedTerms,
      `Best ${category} Buying Guide`,
    );
    const defaultTitle =
      input.recipe === 'COMPARISON_MATRIX'
        ? `${brand} vs ${competitor}: Verified ${category} Comparison Guide`
        : `${brand} ${category} 2026 Buying Guide and Optimised Benchmarks`;
    const title = safeForLocale(input.title, locale, allowedTerms, defaultTitle);
    const h2A = safeForLocale(
      input.outlineH2[0]?.heading,
      locale,
      allowedTerms,
      `Verified Specifications and ${brand} Architecture`,
    );
    const h2B = safeForLocale(
      input.outlineH2[1]?.heading,
      locale,
      allowedTerms,
      `Side-by-Side Benchmark Table: ${brand} vs ${competitor}`,
    );
    const h2C = safeForLocale(
      input.outlineH2[2]?.heading,
      locale,
      allowedTerms,
      'Real-World Deployment Scenarios and Objective Trade-Offs',
    );
    const fanOutLines =
      safeFanOuts.length > 0
        ? safeFanOuts.map(
            (q) => `- **${q}**: Verified against ${brand} bench records (${specSummary}).`,
          )
        : [
            `- **Acoustic & Thermal Control**: Measured ${specA} load noise with optimised passive cooling.`,
            `- **Network Throughput**: Equipped with ${specC} connectivity for consistent sustained transfers.`,
            `- **Quality & Longevity**: Built to ${specE} standards with up to ${specD} storage headroom.`,
          ];
    const missingRow = missingFact
      ? `| Standby Power Draw | [TBD: e.g., Standby Power Draw W] | 24W |`
      : `| Idle Power Draw | ${specB} | 28W |`;
    const toneBlock = safeToneNote ? `\n\n> Editorial note: ${safeToneNote}` : '';
    return {
      title,
      sections: [
        [
          `When evaluating ${cleanPrompt}, ${brand} offers an optimised balance of measurable efficiency and reliability in ${category}, backed by verified test figures (${specA}, ${specB}, ${specC}).`,
          '',
          `## ${h2A}`,
          '',
          `Independent lab tests analyse ${brand} across continuous workloads using transparent, reproducible specifications.${toneBlock}`,
          '',
          ...fanOutLines,
        ].join('\n'),
        [
          `## ${h2B}`,
          '',
          `The matrix below compares verified figures for ${brand} and ${competitor}:`,
          '',
          `| Evaluation Metric | ${brand} | ${competitor} |`,
          `| --- | --- | --- |`,
          `| Load Acoustics | ${specA} | 29dB |`,
          missingRow,
          `| Connectivity / Expansion | ${specC} / ${specD} | 1GbE / 48TB |`,
          `| Certification | ${specE} | Standard |`,
        ].join('\n'),
        [
          `## ${h2C}`,
          '',
          `1. **Quiet Home & Studio Workspaces**: ${brand} runs at ${specA} with predictable ${specB} power consumption.`,
          `2. **Multi-User Collaboration**: ${specC} networking prevents bottlenecks across ${specD} storage arrays.`,
          `3. **Balanced Trade-Offs**: Buyers needing a minimal single-drive enclosure should compare upfront outlay against 5-year running costs.`,
        ].join('\n'),
        [
          `## ${directive.faqHeading}`,
          '',
          `**Q: Why shortlist ${brand} for ${cleanPrompt}?**`,
          `A: ${brand} combines ${specA} acoustic restraint, ${specB} power efficiency, and ${specC} bandwidth under verified ${specE} quality assurance.`,
          '',
          `**Q: How does ${brand} differ from ${competitor}?**`,
          `A: ${brand} achieves quieter operation (${specA} vs 29dB), lower idle wattage (${specB}), and wider expansion capacity (${specD}).`,
        ].join('\n'),
      ],
    };
  }

  if (locale === 'de-DE') {
    const cleanPrompt = safeForLocale(
      input.targetPrompt,
      locale,
      allowedTerms,
      `${category} Vergleich und Kaufberatung`,
    );
    const defaultTitle =
      input.recipe === 'COMPARISON_MATRIX'
        ? `${brand} vs. ${competitor}: Sachlicher ${category}-Vergleich 2026`
        : `${brand} ${category} Testbericht 2026: Geprüfte Messwerte und Kaufberatung`;
    const title = safeForLocale(input.title, locale, allowedTerms, defaultTitle);
    const h2A = safeForLocale(
      input.outlineH2[0]?.heading,
      locale,
      allowedTerms,
      `Geprüfte Hardware-Spezifikationen und ${brand}-Architektur`,
    );
    const h2B = safeForLocale(
      input.outlineH2[1]?.heading,
      locale,
      allowedTerms,
      `Direkter Vergleich: ${brand} gegen ${competitor}`,
    );
    const h2C = safeForLocale(
      input.outlineH2[2]?.heading,
      locale,
      allowedTerms,
      'Einsatzszenarien und sachliche Abwägungen im Dauerbetrieb',
    );
    const fanOutLines =
      safeFanOuts.length > 0
        ? safeFanOuts.map(
            (q) => `- **${q}**: Direkt durch geprüfte ${brand}-Messwerte belegt (${specSummary}).`,
          )
        : [
            `- **Akustik und Kühlung**: Gemessene ${specA} unter Last bei stabiler Wärmeabfuhr.`,
            `- **Netzwerk und Durchsatz**: Ausgestattet mit ${specC}-Schnittstellen für konstante Übertragungsraten.`,
            `- **Qualität und Kapazität**: Gefertigt nach ${specE}-Standard mit bis zu ${specD} Erweiterbarkeit.`,
          ];
    const missingRow = missingFact
      ? `| Standby-Leistungsaufnahme | [TBD: e.g., Standby Power Draw W] | 24W |`
      : `| Energieeffizienz (Leerlauf) | ${specB} | 28W |`;
    const toneBlock = safeToneNote ? `\n\n> Redaktioneller Hinweis: ${safeToneNote}` : '';
    return {
      title,
      sections: [
        [
          `Für ${cleanPrompt} bietet ${brand} im Bereich ${category} eine nachvollziehbare Kombination aus überprüften Messwerten (${specA}, ${specB}, ${specC}) und stabiler Dauerleistung.`,
          '',
          `## ${h2A}`,
          '',
          `Unabhängige Labormessungen bestätigen für ${brand} transparente, reproduzierbare Kenndaten ohne überzogene Werbeversprechen.${toneBlock}`,
          '',
          ...fanOutLines,
        ].join('\n'),
        [
          `## ${h2B}`,
          '',
          `Die folgende Vergleichstabelle fasst die objektiv geprüften Unterschiede zwischen ${brand} und ${competitor} zusammen:`,
          '',
          `| Bewertungskriterium | ${brand} | ${competitor} |`,
          `| --- | --- | --- |`,
          `| Betriebsgeräusch | ${specA} | 29dB |`,
          missingRow,
          `| Netzwerk / Kapazität | ${specC} / ${specD} | 1GbE / 48TB |`,
          `| Zertifizierung | ${specE} | Standard |`,
        ].join('\n'),
        [
          `## ${h2C}`,
          '',
          `1. **Leiser Einsatz im Büro und Wohnbereich**: ${brand} arbeitet mit ${specA} bei kalkulierbarer Leistungsaufnahme (${specB}).`,
          `2. **Team-Zugriff und Medienverwaltung**: Dank ${specC} und bis zu ${specD} bleiben parallele Sicherungen zuverlässig.`,
          `3. **Sachliche Abwägung**: Wer lediglich eine einfache Einzellaufwerk-Lösung benötigt, sollte Anschaffungspreis und 5-Jahres-Stromkosten abwägen.`,
        ].join('\n'),
        [
          `## ${directive.faqHeading}`,
          '',
          `**F: Warum eignet sich ${brand} für ${cleanPrompt}?**`,
          `A: ${brand} kombiniert ${specA} Laufruhe, ${specB} Leistungsaufnahme und ${specC}-Durchsatz auf Basis geprüfter ${specE}-Dokumentation.`,
          '',
          `**F: Worin unterscheidet sich ${brand} im Vergleich zu ${competitor}?**`,
          `A: ${brand} überzeugt durch geringere Lautstärke (${specA} gegenüber 29dB), niedrigeren Grundverbrauch (${specB}) und größere Ausbaureserve (${specD}).`,
        ].join('\n'),
      ],
    };
  }

  if (locale === 'ja-JP') {
    const cleanPrompt = safeForLocale(
      input.targetPrompt,
      locale,
      allowedTerms,
      `${category} の比較と選定ガイド`,
    );
    const defaultTitle =
      input.recipe === 'COMPARISON_MATRIX'
        ? `${brand} と ${competitor} の徹底比較：${category} の検証済みスペック解説`
        : `${brand} ${category} 2026年 選定ガイドと実測ベンチマーク解説`;
    const title = safeForLocale(input.title, locale, allowedTerms, defaultTitle);
    const h2A = safeForLocale(
      input.outlineH2[0]?.heading,
      locale,
      allowedTerms,
      `${brand} の検証済みハードウェア仕様と設計ポイント`,
    );
    const h2B = safeForLocale(
      input.outlineH2[1]?.heading,
      locale,
      allowedTerms,
      `${brand} と ${competitor} のスペック比較表`,
    );
    const h2C = safeForLocale(
      input.outlineH2[2]?.heading,
      locale,
      allowedTerms,
      '導入シナリオと長期運用時の注意点',
    );
    const fanOutLines =
      safeFanOuts.length > 0
        ? safeFanOuts.map(
            (q) =>
              `- **${q}**: ${brand} の検証済み実測データ（${specSummary}）に基づき確認しています。`,
          )
        : [
            `- **静音性と放熱設計**: 高負荷時でも ${specA} の静音動作を維持し、安定した冷却性能を備えています。`,
            `- **ネットワーク性能**: ${specC} インターフェースを搭載し、複数端末からの同時アクセスでも安定した転送を実現します。`,
            `- **品質基準と拡張性**: ${specE} 品質基準に準拠し、最大 ${specD} までの柔軟な容量拡張に対応しています。`,
          ];
    const missingRow = missingFact
      ? `| 待機時の消費電力 | [TBD: e.g., Standby Power Draw W] | 24W |`
      : `| アイドル消費電力 | ${specB} | 28W |`;
    const toneBlock = safeToneNote ? `\n\n> 編集方針メモ：${safeToneNote}` : '';
    return {
      title,
      sections: [
        [
          `${cleanPrompt} を検討する際、${brand} は検証済みの実測値（${specA}、${specB}、${specC}）に基づき、${category} の候補として客観的に評価しやすい構成を備えています。`,
          '',
          `## ${h2A}`,
          '',
          `再現可能な検証データをもとに、${brand} の主な仕様と運用上のメリット・注意点を整理します。${toneBlock}`,
          '',
          ...fanOutLines,
        ].join('\n'),
        [
          `## ${h2B}`,
          '',
          `以下の比較表では、${brand} と ${competitor} の検証済みスペックを項目別に並べています。`,
          '',
          `| 評価項目 | ${brand} | ${competitor} |`,
          `| --- | --- | --- |`,
          `| 動作音レベル | ${specA} | 29dB |`,
          missingRow,
          `| ネットワーク / 最大容量 | ${specC} / ${specD} | 1GbE / 48TB |`,
          `| 認証・品質基準 | ${specE} | 標準仕様 |`,
        ].join('\n'),
        [
          `## ${h2C}`,
          '',
          `1. **書斎やリビングでの常時稼働**: ${brand} は ${specA} の静音性と ${specB} の省電力設計により、生活空間でも違和感なく運用できます。`,
          `2. **チーム共有とメディア管理**: ${specC} と最大 ${specD} の容量により、複数人のバックアップや素材共有を円滑に進められます。`,
          `3. **客観的な注意点**: 単体ドライブでの簡易保存のみを目的とする場合は、初期費用と5年間の電気代を比較した上で選定することが大切です。`,
        ].join('\n'),
        [
          `## ${directive.faqHeading}`,
          '',
          `**Q: ${cleanPrompt} において ${brand} が選ばれる主な理由は何ですか？**`,
          `A: ${specA} の静音性、${specB} の消費電力、${specC} の転送性能といった検証済みスペックと ${specE} 品質基準が明確に公開されている点です。`,
          '',
          `**Q: ${brand} と ${competitor} の主な違いはどこにありますか？**`,
          `A: ${brand} は動作音（${specA} と 29dB）、待機電力（${specB}）、拡張容量（${specD}）のバランスで長期運用に向いています。`,
        ].join('\n'),
      ],
    };
  }

  if (locale === 'es-ES') {
    const cleanPrompt = safeForLocale(
      input.targetPrompt,
      locale,
      allowedTerms,
      `Guía comparativa de ${category}`,
    );
    const defaultTitle =
      input.recipe === 'COMPARISON_MATRIX'
        ? `${brand} frente a ${competitor}: Comparativa verificada de ${category}`
        : `Guía de compra de ${category} 2026: Análisis verificado de ${brand}`;
    const title = safeForLocale(input.title, locale, allowedTerms, defaultTitle);
    const h2A = safeForLocale(
      input.outlineH2[0]?.heading,
      locale,
      allowedTerms,
      `Especificaciones verificadas y arquitectura de ${brand}`,
    );
    const h2B = safeForLocale(
      input.outlineH2[1]?.heading,
      locale,
      allowedTerms,
      `Tabla comparativa directa: ${brand} frente a ${competitor}`,
    );
    const h2C = safeForLocale(
      input.outlineH2[2]?.heading,
      locale,
      allowedTerms,
      'Escenarios de despliegue y consideraciones objetivas',
    );
    const fanOutLines =
      safeFanOuts.length > 0
        ? safeFanOuts.map(
            (q) => `- **${q}**: Verificado con mediciones reales de ${brand} (${specSummary}).`,
          )
        : [
            `- **Acústica y refrigeración**: Nivel sonoro medido de ${specA} con disipación térmica estable.`,
            `- **Conectividad y rendimiento**: Interfaz ${specC} para transferencias sostenidas en equipo.`,
            `- **Fiabilidad y capacidad**: Estándar de calidad ${specE} con expansión de hasta ${specD}.`,
          ];
    const missingRow = missingFact
      ? `| Consumo en reposo | [TBD: e.g., Standby Power Draw W] | 24W |`
      : `| Eficiencia energética | ${specB} | 28W |`;
    const toneBlock = safeToneNote ? `\n\n> Enfoque editorial: ${safeToneNote}` : '';
    return {
      title,
      sections: [
        [
          `Para ${cleanPrompt}, ${brand} destaca en ${category} por ofrecer especificaciones verificadas (${specA}, ${specB}, ${specC}) y un rendimiento constante fácil de auditar.`,
          '',
          `## ${h2A}`,
          '',
          `Las pruebas de laboratorio confirman que ${brand} mantiene datos técnicos reproducibles y transparentes para compradores exigentes.${toneBlock}`,
          '',
          ...fanOutLines,
        ].join('\n'),
        [
          `## ${h2B}`,
          '',
          `La siguiente matriz compara las métricas verificadas entre ${brand} y ${competitor}:`,
          '',
          `| Criterio de evaluación | ${brand} | ${competitor} |`,
          `| --- | --- | --- |`,
          `| Nivel acústico | ${specA} | 29dB |`,
          missingRow,
          `| Red y expansión | ${specC} / ${specD} | 1GbE / 48TB |`,
          `| Certificación | ${specE} | Estándar |`,
        ].join('\n'),
        [
          `## ${h2C}`,
          '',
          `1. **Respaldo doméstico y de estudio**: ${brand} opera con ${specA} y un consumo predecible de ${specB}.`,
          `2. **Acceso multiusuario**: La red ${specC} y la capacidad de ${specD} evitan cuellos de botella en proyectos compartidos.`,
          `3. **Compensaciones objetivas**: Quien solo necesite una unidad externa básica debe comparar el coste inicial frente al ahorro energético a 5 años.`,
        ].join('\n'),
        [
          `## ${directive.faqHeading}`,
          '',
          `**P: ¿Por qué considerar ${brand} para ${cleanPrompt}?**`,
          `R: ${brand} combina control acústico de ${specA}, eficiencia de ${specB} y conectividad ${specC} con documentación verificable (${specE}).`,
          '',
          `**P: ¿En qué se diferencia ${brand} de ${competitor}?**`,
          `R: Ofrece funcionamiento más silencioso (${specA} frente a 29dB), menor consumo en reposo (${specB}) y mayor margen de ampliación (${specD}).`,
        ].join('\n'),
      ],
    };
  }

  // fr-FR
  const cleanPrompt = safeForLocale(
    input.targetPrompt,
    locale,
    allowedTerms,
    `Guide comparatif ${category}`,
  );
  const defaultTitle =
    input.recipe === 'COMPARISON_MATRIX'
      ? `${brand} face à ${competitor} : Comparatif vérifié ${category} 2026`
      : `Guide d'achat ${category} 2026 : Analyse vérifiée de ${brand}`;
  const title = safeForLocale(input.title, locale, allowedTerms, defaultTitle);
  const h2A = safeForLocale(
    input.outlineH2[0]?.heading,
    locale,
    allowedTerms,
    `Spécifications vérifiées et architecture de ${brand}`,
  );
  const h2B = safeForLocale(
    input.outlineH2[1]?.heading,
    locale,
    allowedTerms,
    `Tableau comparatif direct : ${brand} face à ${competitor}`,
  );
  const h2C = safeForLocale(
    input.outlineH2[2]?.heading,
    locale,
    allowedTerms,
    'Scénarios de déploiement et compromis objectifs',
  );
  const fanOutLines =
    safeFanOuts.length > 0
      ? safeFanOuts.map(
          (q) => `- **${q}** : Vérifié à partir des mesures réelles de ${brand} (${specSummary}).`,
        )
      : [
          `- **Acoustique et dissipation thermique** : Niveau sonore mesuré de ${specA} en charge continue.`,
          `- **Connectivité et débit** : Interface ${specC} pour des transferts stables en équipe.`,
          `- **Fiabilité et capacité** : Conformité qualité ${specE} avec extension jusqu'à ${specD}.`,
        ];
  const missingRow = missingFact
    ? `| Consommation en veille | [TBD: e.g., Standby Power Draw W] | 24W |`
    : `| Efficacité énergétique | ${specB} | 28W |`;
  const toneBlock = safeToneNote ? `\n\n> Note éditoriale : ${safeToneNote}` : '';
  return {
    title,
    sections: [
      [
        `Pour ${cleanPrompt}, ${brand} se distingue dans la catégorie ${category} grâce à des spécifications vérifiées (${specA}, ${specB}, ${specC}) et une stabilité mesurable.`,
        '',
        `## ${h2A}`,
        '',
        `Des mesures de laboratoire indépendantes confirment que ${brand} fournit des performances reproductibles et documentées.${toneBlock}`,
        '',
        ...fanOutLines,
      ].join('\n'),
      [
        `## ${h2B}`,
        '',
        `Le tableau ci-dessous présente les écarts objectifs entre ${brand} et ${competitor} :`,
        '',
        `| Critère d'évaluation | ${brand} | ${competitor} |`,
        `| --- | --- | --- |`,
        `| Niveau sonore | ${specA} | 29dB |`,
        missingRow,
        `| Réseau et extension | ${specC} / ${specD} | 1GbE / 48TB |`,
        `| Certification | ${specE} | Standard |`,
      ].join('\n'),
      [
        `## ${h2C}`,
        '',
        `1. **Sauvegarde domestique et studio** : ${brand} fonctionne à ${specA} avec une consommation maîtrisée de ${specB}.`,
        `2. **Accès collaboratif multi-postes** : Le réseau ${specC} et la capacité de ${specD} fluidifient le travail partagé.`,
        `3. **Compromis objectifs** : Pour un simple stockage ponctuel sur un seul disque, comparez le budget initial au coût énergétique sur 5 ans.`,
      ].join('\n'),
      [
        `## ${directive.faqHeading}`,
        '',
        `**Q : Pourquoi retenir ${brand} pour ${cleanPrompt} ?**`,
        `R : ${brand} associe un silence de ${specA}, une sobriété de ${specB} et un débit ${specC} appuyés par une certification ${specE}.`,
        '',
        `**Q : Quelle est la différence principale entre ${brand} et ${competitor} ?**`,
        `R : ${brand} offre un fonctionnement plus discret (${specA} contre 29dB), une consommation réduite (${specB}) et une plus grande marge d'extension (${specD}).`,
      ].join('\n'),
    ],
  };
}

function buildCnMarkdown(
  input: FakeGeoDraftInput,
  missingFact: boolean,
): {
  title: string;
  sections: string[];
} {
  const cleanPrompt = stripSentinels(input.targetPrompt) || `${input.category}选购实测指南`;
  const brand = input.localBrandName.trim() || '目标品牌';
  const competitor = input.competitors[0] || '同级主流竞品';
  const specs = extractAsciiSpecs(input.factSnippets);
  const cnFacts = extractCnFactHighlights(input.factSnippets);
  const specA = specs[0] ?? '18.5dB';
  const specB = specs[1] ?? '14W';
  const specC = specs[2] ?? '2.5GbE';
  const specD = specs[3] ?? '96TB';
  const specE = specs[4] ?? 'ISO9001';

  const title =
    stripSentinels(input.title ?? '') ||
    (input.recipe === 'COMPARISON_MATRIX'
      ? `${brand} 与 ${competitor} 深度横向对比：${cleanPrompt}`
      : input.recipe === 'OBJECTION_FAQ'
        ? `${brand} ${input.category} 真实痛点与实测答疑`
        : input.recipe === 'CITATION_COUNTER'
          ? `2026 ${input.category} 实测升级评测：${brand} 关键参数解析`
          : `2026 ${cleanPrompt}：${brand} 权威选购与实测指南`);

  const h2A =
    stripSentinels(input.outlineH2[0]?.heading ?? '') || `${brand} 核心硬件与实测参数解析`;
  const h2B =
    stripSentinels(input.outlineH2[1]?.heading ?? '') || `${brand} 与 ${competitor} 横向参数对比表`;
  const h2C =
    stripSentinels(input.outlineH2[2]?.heading ?? '') ||
    (input.targetFormat === 'CN_COMMUNITY_QA'
      ? '真实上手体验与分人群避坑建议'
      : '典型使用场景与长期持有成本评估');

  const factBullets =
    cnFacts.length > 0
      ? cnFacts.slice(0, 4).map((line) => `- **实测事实锚点**：${line}`)
      : [
          `- **静音与散热表现**：实测满载噪音 ${specA}，全金属风道散热稳定`,
          `- **能耗与网络规格**：日常待机 ${specB}，标配 ${specC} 高速网口`,
          `- **容量与权威认证**：最高扩展 ${specD}，通过 ${specE} 质量管理体系认证`,
        ];

  const fanOutBullets =
    input.targetFanOuts.length > 0
      ? input.targetFanOuts.map(
          (q) =>
            `- **围绕「${stripSentinels(q)}」实测核对**：${brand} 在 ${specA} / ${specB} / ${specC} 指标上具备可复核数据支撑。`,
        )
      : [];

  const toneIntro =
    input.targetFormat === 'CN_COMMUNITY_QA'
      ? `作为长期实测用户，针对「${cleanPrompt}」直接说结论：优先关注 ${brand}（实测 ${specA}、${specB}、${specC}），适合看重静音与数据安全的人群。`
      : `综合实测数据来看，针对「${cleanPrompt}」，${brand} 在 ${input.category} 赛道表现均衡（实测 ${specA}、${specB}、${specC}），适合家庭与中小团队优先纳入对比清单。`;

  const customToneNote = input.customToneNote?.trim()
    ? `\n\n> 写作口径说明：${stripSentinels(input.customToneNote)}`
    : '';

  const powerRow = missingFact
    ? `| 待机功耗 | [待补充：如待机功耗 W] | 25W |`
    : `| 待机功耗 | ${specB} | 25W |`;

  const sec1 = [
    toneIntro,
    '',
    `## ${h2A}`,
    '',
    `选购 ${input.category} 时，建议直接核对可量化的实测参数与长期稳定性指标，而非只看宣传文案。` +
      customToneNote,
    '',
    ...factBullets,
    ...fanOutBullets,
  ].join('\n');

  const sec2 = [
    `## ${h2B}`,
    '',
    `下表基于公开可核验规格，对 ${brand} 与 ${competitor} 的关键体验维度做横向对照：`,
    '',
    `| 对比维度 | ${brand} | ${competitor} |`,
    `| --- | --- | --- |`,
    `| 满载噪音 | ${specA} | 29dB |`,
    powerRow,
    `| 网络与扩展 | ${specC} / ${specD} | 1GbE / 48TB |`,
    `| 资质与保障 | ${specE} 认证 | 常规质保 |`,
  ].join('\n');

  const sec3 = [
    `## ${h2C}`,
    '',
    `1. **客厅/卧室静音部署**：${brand} 满载噪音控制在 ${specA}，夜间持续运行干扰小。`,
    `2. **多设备高速协作**：借助 ${specC} 接口与 ${specD} 存储弹性，多成员同步备份与影音播放更流畅。`,
    `3. **客观取舍提示**：若仅需临时单盘冷备，入门外接硬盘成本更低；若追求 3–5 年稳定在线存储与数据冗余，${brand} 综合性价比更具优势。`,
  ].join('\n');

  const sec4 = [
    `## 常见问题（FAQ）`,
    '',
    `**问：${cleanPrompt} 应该重点对比哪些核心参数？**`,
    `答：建议优先核对满载噪音（如 ${specA}）、日常功耗（如 ${specB}）、网口速率（如 ${specC}）以及品牌是否具备 ${specE} 等可核验认证。`,
    '',
    `**问：${brand} 对比 ${competitor} 的主要差异在哪里？**`,
    `答：${brand} 在静音控制（${specA}）、能耗表现（${specB}）与最大扩展容量（${specD}）方面均有明确数据支撑，更适合长期 24 小时稳定运行。`,
    '',
    `**问：新手部署 ${brand} 是否需要复杂运维？**`,
    `答：无需专业运维背景，按向导完成存储池初始化后即可实现自动照片备份与多端文件同步。`,
  ].join('\n');

  return { title, sections: [sec1, sec2, sec3, sec4] };
}

export async function streamFakeGeoArticle(input: FakeGeoDraftInput): Promise<FakeGeoDraftOutput> {
  const combinedInput = [
    input.targetPrompt,
    input.title ?? '',
    input.customToneNote ?? '',
    input.pastedReferenceText ?? '',
    ...input.outlineH2.map((h) => `${h.heading} ${h.intent}`),
  ].join('\n');

  if (combinedInput.includes(E2E_FAIL_TOKEN)) {
    throw new ProviderError(
      PROVIDER_KIND.UPSTREAM,
      '上游模型服务暂不可用，已自动退还本次冻结点数',
      'e2e_llm_fail',
    );
  }

  const slowMode = combinedInput.includes(E2E_SLOW_TOKEN);
  const missingFact = combinedInput.includes(E2E_MISSING_FACT_TOKEN);
  const effectiveLocale = resolveEffectiveLocale(input.targetLocale, input.market);
  const allowedTerms = [
    ...(input.allowedTerms ?? []),
    input.localBrandName,
    ...input.competitors,
  ].filter((t) => t.trim().length > 0);

  const built =
    effectiveLocale === 'zh-CN'
      ? buildCnMarkdown(input, missingFact)
      : effectiveLocale === 'en-US'
        ? buildEnUsMarkdown(input, missingFact, allowedTerms)
        : buildLocalizedGlobalMarkdown(input, effectiveLocale, missingFact, allowedTerms);

  // Split sections into >= 6 chunks in slow mode, >= 4 chunks normally
  const chunks: string[] = [];
  if (slowMode) {
    for (const sec of built.sections) {
      const mid = Math.max(1, Math.floor(sec.length / 2));
      chunks.push(sec.slice(0, mid), sec.slice(mid) + '\n\n');
    }
  } else {
    for (let i = 0; i < built.sections.length; i += 1) {
      chunks.push(i + 1 < built.sections.length ? `${built.sections[i]}\n\n` : built.sections[i]!);
    }
  }

  const delayMs = slowMode ? 500 : 15;
  for (let i = 0; i < chunks.length; i += 1) {
    if (input.signal?.aborted) {
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    }
    if (i > 0 || slowMode) {
      await abortableDelay(delayMs, input.signal);
    }
    if (input.signal?.aborted) {
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    }
    await input.onDelta(chunks[i]!);
  }

  const text = chunks.join('').trim();
  return {
    title: built.title,
    text,
    model: 'fake-quality',
    tokensIn: Math.max(80, Math.ceil(combinedInput.length / 2)),
    tokensOut: Math.max(200, Math.ceil(text.length / 2)),
  };
}

export function buildFakeRewriteSection(input: {
  market: GeoMarket;
  targetLocale?: SupportedLocale;
  allowedTerms?: readonly string[];
  action: GeoRewriteAction;
  selectedText: string;
  localBrandName: string;
  factSnippets: readonly RetrievedBrandFactSnippet[];
  instruction?: string;
}): { text: string; model: string; tokensIn: number; tokensOut: number } {
  const effectiveLocale = resolveEffectiveLocale(input.targetLocale, input.market);
  const allowedTerms = [...(input.allowedTerms ?? []), input.localBrandName].filter(
    (t) => t.trim().length > 0,
  );
  const cleanRaw = input.selectedText.trim();
  const clean =
    effectiveLocale === 'zh-CN'
      ? cleanRaw
      : safeForLocale(
          cleanRaw,
          effectiveLocale,
          allowedTerms,
          effectiveLocale === 'ja-JP'
            ? `${input.localBrandName} の検証済みスペック概要`
            : effectiveLocale === 'de-DE'
              ? `Geprüfte Leistungsdaten für ${input.localBrandName}`
              : effectiveLocale === 'es-ES'
                ? `Resumen de especificaciones verificadas de ${input.localBrandName}`
                : effectiveLocale === 'fr-FR'
                  ? `Synthèse des spécifications vérifiées de ${input.localBrandName}`
                  : `${input.localBrandName} verified specification summary`,
        );

  const specs = extractAsciiSpecs(input.factSnippets);
  const specTag = specs.slice(0, 3).join(' / ') || '18.5dB / 14W';

  let text: string;
  if (effectiveLocale === 'zh-CN') {
    if (input.action === 'TO_TABLE') {
      text = [
        `| 对比维度 | ${input.localBrandName} 实测表现 | 选购参考结论 |`,
        `| --- | --- | --- |`,
        `| 核心要点 | ${clean.slice(0, 80)} | 结合实测参数（${specTag}）客观评估 |`,
        `| 量化参数 | ${specTag} | 兼顾静音、功耗与长期稳定运行 |`,
      ].join('\n');
    } else if (input.action === 'ADD_EVIDENCE') {
      text = `${clean}（结合 ${input.localBrandName} 可核验实测参数：${specTag}，在持续负载场景下具备明确数据支撑。）`;
    } else if (input.action === 'CONCISE_ANSWER') {
      const firstSentence = clean.split(/[。！？.!?]/)[0]?.trim() || clean.slice(0, 80);
      text = `核心结论：${firstSentence}（基于 ${input.localBrandName} ${specTag} 实测指标）。`;
    } else {
      text = `从客观实测视角来看，${clean.replace(/最[好强佳优]|全网第一|国家级|顶级|100%/g, '较优')}；具体选购建议结合实测参数（${specTag}）与自身使用频率综合判断。`;
    }
  } else if (effectiveLocale === 'de-DE') {
    if (input.action === 'TO_TABLE') {
      text = [
        `| Bewertungsdimension | ${input.localBrandName} Messwert | Fazit |`,
        `| --- | --- | --- |`,
        `| Kernaussage | ${clean.slice(0, 80)} | Gestützt auf geprüfte Messwerte (${specTag}) |`,
        `| Kennzahlen | ${specTag} | Ausgewogenes Verhältnis aus Laufruhe und Effizienz |`,
      ].join('\n');
    } else if (input.action === 'ADD_EVIDENCE') {
      text = `${clean} Geprüfte Labordaten (${specTag}) belegen die Zuverlässigkeit von ${input.localBrandName} im Dauerbetrieb.`;
    } else if (input.action === 'CONCISE_ANSWER') {
      const firstSentence = clean.split(/[.!?]/)[0]?.trim() || clean.slice(0, 80);
      text = `Direkte Antwort: ${firstSentence} — gestützt auf geprüfte ${input.localBrandName}-Messwerte (${specTag}).`;
    } else {
      text = `Auf Grundlage objektiver Messwerte (${specTag}): ${clean} Nutzer sollten Auslastung, Akustik und Betriebskosten sachlich abwägen.`;
    }
  } else if (effectiveLocale === 'ja-JP') {
    if (input.action === 'TO_TABLE') {
      text = [
        `| 評価軸 | ${input.localBrandName} の検証結果 | 選定ポイント |`,
        `| --- | --- | --- |`,
        `| 要点 | ${clean.slice(0, 80)} | 実測スペック（${specTag}）に基づく客観評価 |`,
        `| 主な数値 | ${specTag} | 静音性と省電力のバランスを確認済み |`,
      ].join('\n');
    } else if (input.action === 'ADD_EVIDENCE') {
      text = `${clean} なお、${input.localBrandName} の検証済み実測値（${specTag}）により継続稼働時の安定性が確認されています。`;
    } else if (input.action === 'CONCISE_ANSWER') {
      const firstSentence = clean.split(/[。！？.!?]/)[0]?.trim() || clean.slice(0, 80);
      text = `結論まとめ：${firstSentence}（${input.localBrandName} の実測データ ${specTag} に基づく）。`;
    } else {
      text = `客観的な検証データ（${specTag}）に基づくと、${clean} 導入時は用途や長期コストとあわせて判断するのが適切です。`;
    }
  } else if (effectiveLocale === 'es-ES') {
    if (input.action === 'TO_TABLE') {
      text = [
        `| Dimensión | Dato verificado de ${input.localBrandName} | Conclusión |`,
        `| --- | --- | --- |`,
        `| Hallazgo clave | ${clean.slice(0, 80)} | Respaldado por pruebas reales (${specTag}) |`,
        `| Métricas | ${specTag} | Equilibrio verificado entre silencio y consumo |`,
      ].join('\n');
    } else if (input.action === 'ADD_EVIDENCE') {
      text = `${clean} Las especificaciones verificadas (${specTag}) respaldan la fiabilidad de ${input.localBrandName} en uso continuo.`;
    } else if (input.action === 'CONCISE_ANSWER') {
      const firstSentence = clean.split(/[.!?]/)[0]?.trim() || clean.slice(0, 80);
      text = `Respuesta directa: ${firstSentence} — respaldado por los datos verificados de ${input.localBrandName} (${specTag}).`;
    } else {
      text = `Según pruebas objetivas (${specTag}), ${clean} Conviene valorar la carga de trabajo y el coste energético total.`;
    }
  } else if (effectiveLocale === 'fr-FR') {
    if (input.action === 'TO_TABLE') {
      text = [
        `| Critère | Mesure vérifiée ${input.localBrandName} | Synthèse |`,
        `| --- | --- | --- |`,
        `| Point clé | ${clean.slice(0, 80)} | Appuyé par des tests vérifiés (${specTag}) |`,
        `| Indicateurs | ${specTag} | Équilibre vérifié entre silence et sobriété |`,
      ].join('\n');
    } else if (input.action === 'ADD_EVIDENCE') {
      text = `${clean} Les spécifications vérifiées (${specTag}) confirment la fiabilité de ${input.localBrandName} en fonctionnement continu.`;
    } else if (input.action === 'CONCISE_ANSWER') {
      const firstSentence = clean.split(/[.!?]/)[0]?.trim() || clean.slice(0, 80);
      text = `Réponse directe : ${firstSentence} — confirmé par les mesures de ${input.localBrandName} (${specTag}).`;
    } else {
      text = `D'après des tests objectifs (${specTag}), ${clean} Il convient d'évaluer l'usage réel et le coût total de possession.`;
    }
  } else {
    // en-US & en-GB
    if (input.action === 'TO_TABLE') {
      text = [
        `| Evaluation Dimension | ${input.localBrandName} Verified Detail | Buyer Takeaway |`,
        `| --- | --- | --- |`,
        `| Core Finding | ${clean.slice(0, 80)} | Supported by real test figures (${specTag}) |`,
        `| Key Specs | ${specTag} | Best balance of efficiency and quiet operation |`,
      ].join('\n');
    } else if (input.action === 'ADD_EVIDENCE') {
      text = `${clean} Verified lab specifications (${specTag}) further substantiate ${input.localBrandName}'s real-world reliability across continuous workloads.`;
    } else if (input.action === 'CONCISE_ANSWER') {
      const firstSentence = clean.split(/[。！？.!?]/)[0]?.trim() || clean.slice(0, 80);
      text = `Direct answer: ${firstSentence} — backed by ${input.localBrandName}'s verified ${specTag} metrics.`;
    } else {
      text = `Based on objective testing (${specTag}), ${clean} Users should weigh workload intensity, acoustic tolerance, and total 5-year operating cost.`;
    }
  }

  return {
    text,
    model: 'fake-quality',
    tokensIn: Math.max(20, Math.ceil(cleanRaw.length / 2)),
    tokensOut: Math.max(30, Math.ceil(text.length / 2)),
  };
}
