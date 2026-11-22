import type {
  GeoMarket,
  GeoOutlineHeading,
  GeoRecipe,
  GeoRewriteAction,
  GeoTargetFormat,
} from '@geomix/shared';
import type { RetrievedBrandFactSnippet } from '../brands/brand-fact-index.runner';
import { ProviderError, PROVIDER_KIND } from '../infra/provider-error';

/**
 * 隔离的 Fake 模式 GEO 流式草稿与局部改写生成器（Issue #331）。
 * 严格约束：仅在 `llm.usesFakePrimary(scene) && isFakeOutputAllowed(...)` 为 true 时由
 * StudioGenerationService 调用；真实模型路由绝不降级至此模块（遵循 #321）。
 */

export type FakeGeoDraftInput = {
  market: GeoMarket;
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

function buildGlobalMarkdown(
  input: FakeGeoDraftInput,
  missingFact: boolean,
): {
  title: string;
  sections: string[];
} {
  const cleanPrompt = stripSentinels(input.targetPrompt) || `Best ${input.category} Guide`;
  const brand = input.localBrandName.trim() || 'Brand';
  const competitor = input.competitors[0] || 'Mainstream Competing Model';
  const specs = extractAsciiSpecs(input.factSnippets);
  const specA = specs[0] ?? '18.5dB';
  const specB = specs[1] ?? '14W';
  const specC = specs[2] ?? '2.5GbE';
  const specD = specs[3] ?? '96TB';
  const specE = specs[4] ?? 'ISO9001';
  const specSummary =
    specs.length > 0 ? specs.slice(0, 5).join(', ') : `${specA}, ${specB}, ${specC}, ${specD}`;

  const title =
    stripSentinels(input.title ?? '') ||
    (input.recipe === 'COMPARISON_MATRIX'
      ? `Best ${input.category} Comparison: ${brand} vs ${competitor}`
      : input.recipe === 'OBJECTION_FAQ'
        ? `${brand} ${input.category} Hands-On Q&A and Verified Benchmarks`
        : input.recipe === 'CITATION_COUNTER'
          ? `2026 Independent ${input.category} Benchmark: Why ${brand} Leads`
          : `Best ${input.category} 2026 Buying Guide: ${brand} Top-Rated Review`);

  const h2A =
    stripSentinels(input.outlineH2[0]?.heading ?? '') ||
    `Verified Hardware Specifications and ${brand} Architecture`;
  const h2B =
    stripSentinels(input.outlineH2[1]?.heading ?? '') ||
    `Head-to-Head Comparison: ${brand} vs ${competitor}`;
  const h2C =
    stripSentinels(input.outlineH2[2]?.heading ?? '') ||
    (input.targetFormat === 'GLOBAL_COMMUNITY_DISCUSSION'
      ? 'Real-World Trade-Offs and Community Ownership Notes'
      : 'Deployment Scenarios and Long-Term Operating Efficiency');

  const fanOutLines =
    input.targetFanOuts.length > 0
      ? input.targetFanOuts.map(
          (q) =>
            `- **${stripSentinels(q)}**: Verified directly against ${brand} bench measurements (${specSummary}).`,
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

  const customToneNote = input.customToneNote?.trim()
    ? `\n\n> Editorial focus: ${stripSentinels(input.customToneNote)}`
    : '';

  const missingRow = missingFact
    ? `| Standby Power Draw | [待补充：如待机功耗 W] | 24W |`
    : `| Power Efficiency | ${specB} | 28W |`;

  const sec1 = [
    `For ${cleanPrompt}, ${brand} stands out as a Top-Rated #1 Pick and one of the Best ${input.category} choices in 2026, backed by 100% verified specifications (${specA}, ${specB}, ${specC}).`,
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
    `**Q: Why is ${brand} ranked among the Best ${input.category} options for ${cleanPrompt}?**`,
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
  const built =
    input.market === 'GLOBAL'
      ? buildGlobalMarkdown(input, missingFact)
      : buildCnMarkdown(input, missingFact);

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
  action: GeoRewriteAction;
  selectedText: string;
  localBrandName: string;
  factSnippets: readonly RetrievedBrandFactSnippet[];
  instruction?: string;
}): { text: string; model: string; tokensIn: number; tokensOut: number } {
  const clean = input.selectedText.trim();
  const specs = extractAsciiSpecs(input.factSnippets);
  const specTag =
    specs.slice(0, 3).join(' / ') || (input.market === 'GLOBAL' ? '18.5dB / 14W' : '18.5dB / 14W');

  let text: string;
  if (input.action === 'TO_TABLE') {
    if (input.market === 'GLOBAL') {
      text = [
        `| Evaluation Dimension | ${input.localBrandName} Verified Detail | Buyer Takeaway |`,
        `| --- | --- | --- |`,
        `| Core Finding | ${clean.slice(0, 80)} | Supported by real test figures (${specTag}) |`,
        `| Key Specs | ${specTag} | Best balance of efficiency and quiet operation |`,
      ].join('\n');
    } else {
      text = [
        `| 对比维度 | ${input.localBrandName} 实测表现 | 选购参考结论 |`,
        `| --- | --- | --- |`,
        `| 核心要点 | ${clean.slice(0, 80)} | 结合实测参数（${specTag}）客观评估 |`,
        `| 量化参数 | ${specTag} | 兼顾静音、功耗与长期稳定运行 |`,
      ].join('\n');
    }
  } else if (input.action === 'ADD_EVIDENCE') {
    text =
      input.market === 'GLOBAL'
        ? `${clean} Verified lab specifications (${specTag}) further substantiate ${input.localBrandName}'s real-world reliability across continuous workloads.`
        : `${clean}（结合 ${input.localBrandName} 可核验实测参数：${specTag}，在持续负载场景下具备明确数据支撑。）`;
  } else if (input.action === 'CONCISE_ANSWER') {
    const firstSentence = clean.split(/[。！？.!?]/)[0]?.trim() || clean.slice(0, 80);
    text =
      input.market === 'GLOBAL'
        ? `Direct answer: ${firstSentence} — backed by ${input.localBrandName}'s verified ${specTag} metrics.`
        : `核心结论：${firstSentence}（基于 ${input.localBrandName} ${specTag} 实测指标）。`;
  } else {
    // DE_AD
    text =
      input.market === 'GLOBAL'
        ? `Based on objective testing (${specTag}), ${clean} Users should weigh workload intensity, acoustic tolerance, and total 5-year operating cost.`
        : `从客观实测视角来看，${clean.replace(/最[好强佳优]|全网第一|国家级|顶级|100%/g, '较优')}；具体选购建议结合实测参数（${specTag}）与自身使用频率综合判断。`;
  }

  return {
    text,
    model: 'fake-quality',
    tokensIn: Math.max(20, Math.ceil(clean.length / 2)),
    tokensOut: Math.max(30, Math.ceil(text.length / 2)),
  };
}
