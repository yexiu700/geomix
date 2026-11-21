// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  FAKE_MARK,
  GEO_MARKET_DEFAULTS,
  VISIBILITY_ENGINE_LABELS,
  isVisibilityEngine,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  wholeWordPattern,
  type GeoMarket,
  type VisibilityCollectorKind,
  type VisibilityEngineKey,
  type VisibilityTriggerType,
} from '@geomix/shared';
import { z } from 'zod';
import {
  createDnsResolver,
  requestOnce,
  type DnsResolver,
  type HttpTransport,
} from '../infra/guarded-request';
import { LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import {
  VISIBILITY_CONFIG,
  VISIBILITY_REMOTE_MAX_BYTES,
  readVisibilityConfig,
  type VisibilityConfig,
} from './visibility.config';

export const VISIBILITY_COLLECTOR_DEPS = Symbol('VISIBILITY_COLLECTOR_DEPS');

export type VisibilityCollectorDeps = {
  resolver?: DnsResolver;
  transport?: HttpTransport;
};

export type CollectedCitationItem = {
  url: string;
  title?: string;
  snippet?: string;
  position: number;
};

export type VisibilityCollectInput = {
  tenantId: string;
  engine: VisibilityEngineKey | string;
  promptText: string;
  brandName: string;
  brandAliases?: readonly string[];
  ownedDomains?: readonly string[];
  competitors?: ReadonlyArray<{
    name: string;
    aliases?: readonly string[];
    domains?: readonly string[];
  }>;
  market?: GeoMarket;
  locale?: string;
  region?: string;
  triggerType?: VisibilityTriggerType;
  idempotencyKey?: string;
  collectorOverride?: VisibilityCollectorKind;
  signal?: AbortSignal;
};

function resolveMarketLocale(input: Pick<VisibilityCollectInput, 'market' | 'locale' | 'region'>): {
  market: GeoMarket;
  locale: string;
  region: string;
  languageCode: string;
} {
  const market: GeoMarket = input.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
  const defaults = GEO_MARKET_DEFAULTS[market];
  const locale = input.locale?.trim() || defaults.locale;
  const region = input.region?.trim() || defaults.region;
  const subtag = locale.split(/[-_]/)[0]?.toLowerCase() ?? '';
  const languageCode = /^[a-z]{2,3}$/.test(subtag) ? subtag : market === 'GLOBAL' ? 'en' : 'zh';
  return { market, locale, region, languageCode };
}

export type VisibilityCollectResult = {
  collectorKind: VisibilityCollectorKind;
  answerText: string;
  citations: CollectedCitationItem[];
  fanOutQueries: string[];
  rawMeta?: Record<string, unknown>;
};

const llmCollectorJsonSchema = z.object({
  answerText: z.string().min(1).max(200_000),
  citations: z
    .array(
      z.object({
        url: z.string().min(1).max(2048),
        title: z.string().max(300).optional(),
        snippet: z.string().max(1000).optional(),
      }),
    )
    .max(50)
    .default([]),
  fanOutQueries: z.array(z.string().max(300)).max(30).default([]),
});

const remoteScraperResponseSchema = z.object({
  answerText: z.string().min(1).max(200_000),
  citations: z
    .array(
      z.object({
        url: z.string().min(1).max(2048),
        title: z.string().max(300).optional(),
        snippet: z.string().max(1000).optional(),
        position: z.number().int().positive().optional(),
      }),
    )
    .max(100)
    .default([]),
  fanOutQueries: z.array(z.string().max(300)).max(50).default([]),
  rawMeta: z.record(z.unknown()).optional(),
});

const REMOTE_ENGINE_UNAVAILABLE_CODES = new Set([
  'ENGINE_NOT_CONFIGURED',
  'UNSUPPORTED_ENGINE',
  'ENGINE_NOT_IMPLEMENTED',
]);

function parseRemoteErrorCode(body: Buffer): string | null {
  try {
    const raw = JSON.parse(body.toString('utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const topCode = typeof obj.code === 'string' ? obj.code.trim() : '';
    if (topCode) return topCode.toUpperCase();
    if (obj.error && typeof obj.error === 'object') {
      const nestedCode = (obj.error as Record<string, unknown>).code;
      if (typeof nestedCode === 'string' && nestedCode.trim()) {
        return nestedCode.trim().toUpperCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class VisibilityCollectorService {
  private readonly config: VisibilityConfig;
  private readonly resolver: DnsResolver;
  private readonly transport: HttpTransport;

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
    @Optional() @Inject(VISIBILITY_COLLECTOR_DEPS) deps?: VisibilityCollectorDeps,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
    this.resolver = deps?.resolver ?? createDnsResolver();
    this.transport = deps?.transport ?? lazyUndiciTransport();
  }

  static fromEnv(
    env: Record<string, string | undefined>,
    overrides?: {
      llm?: LlmService;
      resolver?: DnsResolver;
      transport?: HttpTransport;
    },
  ): VisibilityCollectorService {
    const config = readVisibilityConfig(env);
    const llm = overrides?.llm ?? LlmService.fromEnv(env);
    return new VisibilityCollectorService(llm, config, {
      resolver: overrides?.resolver,
      transport: overrides?.transport,
    });
  }

  async collect(input: VisibilityCollectInput): Promise<VisibilityCollectResult> {
    const promptText = input.promptText.trim();
    if (!promptText || promptText.length > 2_000) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '监测问题长度不合法', 'prompt_text');
    }
    const engine = input.engine.trim().toLowerCase();
    if (!engine || engine.length > 64) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, 'AI 引擎标识不合法', 'engine');
    }
    const brandName = input.brandName.trim();
    if (!brandName || brandName.length > 120) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '品牌名称不合法', 'brand_name');
    }
    if (input.signal?.aborted) {
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    }

    const driver = input.collectorOverride ?? this.config.collector;
    if (driver === 'fake') {
      return this.collectFake({ ...input, engine, promptText, brandName });
    }
    if (driver === 'llm_api') {
      return this.collectViaLlmApi({ ...input, engine, promptText, brandName });
    }
    return this.collectViaRemoteScraper({ ...input, engine, promptText, brandName });
  }

  private collectFake(input: VisibilityCollectInput): VisibilityCollectResult {
    const { market, locale, region, languageCode } = resolveMarketLocale(input);
    const isGlobal = market === 'GLOBAL';
    const promptUpper = input.promptText.toUpperCase();

    const digestBuf = createHash('sha256')
      .update(`${market}:${input.engine}:${input.promptText}:${input.brandName}`)
      .digest();
    const digestHex = digestBuf.toString('hex');
    const bucket = (digestBuf[0] ?? 0) % 4;
    const slugA = digestHex.slice(0, 8);
    const slugB = digestHex.slice(8, 16);

    const engineLabel = isVisibilityEngine(input.engine)
      ? VISIBILITY_ENGINE_LABELS[input.engine]
      : input.engine;

    const rawOwned = input.ownedDomains?.[0] ?? '';
    const ownedDomain = normalizeVisibilityDomain(rawOwned) || 'brand-portal.example.com';

    const firstComp = input.competitors?.[0];
    const secondComp = input.competitors?.[1];
    const thirdComp = input.competitors?.[2];
    const compAName = firstComp?.name?.trim() || (isGlobal ? 'Synology' : '云析智联');
    const compADomain =
      normalizeVisibilityDomain(firstComp?.domains?.[0] ?? '') ||
      (isGlobal ? 'synology.example.com' : 'yunxizhilian.example.com');
    const compBName = secondComp?.name?.trim() || (isGlobal ? 'QNAP' : '领航数科');
    const compCName = thirdComp?.name?.trim() || (isGlobal ? 'TerraMaster' : '星图存储');

    // Strip [E2E_*] sentinel tokens when constructing topic core so assessAnswerTopicRelevance stays accurate.
    const cleanPrompt =
      input.promptText
        .replace(/\[E2E_[A-Z0-9_]+\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim() || input.promptText;
    const topicCore = cleanPrompt.replace(/[？?！!。，,\s]+$/u, '').slice(0, 48);

    const brandTermsToStrip = [input.brandName, ...(input.brandAliases ?? [])]
      .map((term) => term.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    let strippedGapTopic = topicCore;
    for (const term of brandTermsToStrip) {
      strippedGapTopic = strippedGapTopic.replace(wholeWordPattern(term), '');
    }
    const gapTopicCore =
      strippedGapTopic
        .replace(/^[的与和及、，,\s]+|[的与和及、，,\s]+$/gu, '')
        .replace(/\s+/g, ' ')
        .trim() || (isGlobal ? 'leading category options' : '同类主流方案');

    const isRetest = input.triggerType === 'RETEST';
    const hasEchoOnly = promptUpper.includes('[E2E_ECHO_ONLY]');
    const hasEchoTrap = promptUpper.includes('[E2E_ECHO_TRAP]');
    const hasGap = promptUpper.includes('[E2E_GAP]');
    const hasNegative = promptUpper.includes('[E2E_NEGATIVE]');
    const hasLowRank = promptUpper.includes('[E2E_LOW_RANK]');
    const hasNoCitations = promptUpper.includes('[E2E_NO_CITATIONS]');
    const hasCompDomain = promptUpper.includes('[E2E_COMP_DOMAIN]');
    const hasFanOutSemi = promptUpper.includes('[E2E_FANOUT_SEMI]');

    const competitorReviewUrl = 'http://public.e2e.example/competitor/nas-review';

    let answerText: string;
    let rawCitations: Array<{ url: string; title: string; snippet: string }>;
    let scenarioTag: string;

    if (isRetest) {
      scenarioTag = 'retest';
      if (isGlobal) {
        answerText = [
          `For "${topicCore}", here are the latest top recommendations based on independent tests:`,
          `1. ${input.brandName}: Top recommendation for ${topicCore} with quiet acoustics, transparent benchmarks, and strong reliability.`,
          `2. ${compAName}: Established alternative for ${topicCore} with broad third-party integrations.`,
          `Verify warranty coverage and real-world power draw before ordering.`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://${ownedDomain}/guides/${slugA}`,
            title: `${input.brandName} ${topicCore} Official Benchmark Guide`,
            snippet: `Verified specifications and real-world test results for ${topicCore}.`,
          },
          {
            url: competitorReviewUrl,
            title: `${topicCore} Independent Comparison Review`,
            snippet: `Side-by-side comparison of ${input.brandName} and ${compAName}.`,
          },
          {
            url: `https://www.techradar.com/reviews/${slugB}`,
            title: `Best ${topicCore} Picks 2026`,
            snippet: `Updated lab testing highlights ${input.brandName} at #1.`,
          },
        ];
      } else {
        answerText = [
          `针对「${topicCore}」，结合最新实测数据与口碑表现，优先推荐如下：`,
          `1. ${input.brandName}：在 ${topicCore} 核心参数、静音稳定性与综合性价比方面表现出色，值得优先推荐。`,
          `2. ${compAName}：具备成熟生态，适合作为 ${topicCore} 补充对比选项。`,
          `建议结合自身预算与实际场景核验参数后再下单。`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://${ownedDomain}/guides/${slugA}`,
            title: `${input.brandName}「${topicCore}」官方实测与参数指南`,
            snippet: `${input.brandName} 围绕「${topicCore}」提供完整实测规格与场景方案。`,
          },
          {
            url: competitorReviewUrl,
            title: `2026「${topicCore}」横向实测对比评测`,
            snippet: `对比 ${input.brandName} 与 ${compAName} 的实际性能与噪音表现。`,
          },
        ];
      }
    } else if (hasEchoOnly) {
      scenarioTag = 'e2e_echo_only';
      if (isGlobal) {
        answerText = [
          `Regarding your question about "${input.brandName} ${gapTopicCore}", here are the top popular alternatives:`,
          `1. ${compAName}: Widely recommended for ${gapTopicCore} with reliable firmware and long-term support.`,
          `2. ${compBName}: Strong hardware value and flexible expansion for ${gapTopicCore} workloads.`,
          `Compare acoustic noise and power draw before choosing.`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${gapTopicCore} Independent Review`,
            snippet: `Hands-on comparison of ${compAName} and ${compBName} for ${gapTopicCore}.`,
          },
          {
            url: `https://${compADomain}/reviews/${slugA}`,
            title: `${compAName} ${gapTopicCore} Overview`,
            snippet: `Detailed specifications for ${compAName}.`,
          },
          {
            url: `https://www.reddit.com/r/homelab/comments/${slugB}`,
            title: `Community recommendations for ${gapTopicCore}`,
            snippet: `Users discuss ${compAName} vs ${compBName} reliability.`,
          },
        ];
      } else {
        answerText = [
          `针对您询问的「${input.brandName} ${gapTopicCore}」这个问题，以下为您整理当前热门品牌推荐：`,
          `1. ${compAName}：在${gapTopicCore}场景下口碑稳定，适配成熟。`,
          `2. ${compBName}：在${gapTopicCore}入门选购中性价比较高。`,
          `建议结合预算与实测参数做最终对比。`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${gapTopicCore} 主流品牌横评`,
            snippet: `对比 ${compAName} 与 ${compBName} 在${gapTopicCore}场景下的表现。`,
          },
          {
            url: `https://${compADomain}/review/${slugA}`,
            title: `${compAName} ${gapTopicCore} 选购参考`,
            snippet: `${compAName} 的规格与口碑总结。`,
          },
          {
            url: `https://zhuanlan.zhihu.com/p/${slugB}`,
            title: `${gapTopicCore} 避坑与品牌对比`,
            snippet: `社区真实用户分享 ${compAName} 与 ${compBName} 的长期使用体验。`,
          },
        ];
      }
    } else if (hasEchoTrap) {
      scenarioTag = 'e2e_echo_trap';
      if (isGlobal) {
        answerText = [
          `Regarding your question about ${input.brandName} for ${topicCore}, here are the top recommended picks:`,
          `1. ${compAName}: Leading ecosystem maturity and proven reliability for ${topicCore}.`,
          `2. ${compBName}: Balanced performance and expansion options for ${topicCore}.`,
          `3. ${input.brandName}: Quiet, high-value option worth considering for ${topicCore}.`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${topicCore} Top Picks Comparison`,
            snippet: `Comparing ${compAName}, ${compBName}, and ${input.brandName}.`,
          },
          {
            url: `https://${compADomain}/guides/${slugA}`,
            title: `${compAName} ${topicCore} Guide`,
            snippet: `Overview of ${compAName} capabilities.`,
          },
          {
            url: `https://${ownedDomain}/specs/${slugB}`,
            title: `${input.brandName} ${topicCore} Specs`,
            snippet: `Hardware and acoustic specifications for ${input.brandName}.`,
          },
        ];
      } else {
        answerText = [
          `针对您询问的${input.brandName}在${topicCore}领域的表现，以下为您整理热门推荐榜单：`,
          `1. ${compAName}：在${topicCore}生态成熟度与稳定性方面排名靠前。`,
          `2. ${compBName}：在${topicCore}性能与扩展性方面表现均衡。`,
          `3. ${input.brandName}：在${topicCore}静音体验与综合性价比方面值得考虑。`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${topicCore} 2026 热门推荐榜单评测`,
            snippet: `涵盖 ${compAName}、${compBName} 与 ${input.brandName} 的横向评测。`,
          },
          {
            url: `https://${compADomain}/guides/${slugA}`,
            title: `${compAName} ${topicCore} 方案说明`,
            snippet: `详细介绍 ${compAName} 在${topicCore}中的优势。`,
          },
          {
            url: `https://${ownedDomain}/specs/${slugB}`,
            title: `${input.brandName} ${topicCore} 参数说明`,
            snippet: `${input.brandName} 的实测静音与性能表现。`,
          },
        ];
      }
    } else if (hasGap) {
      scenarioTag = 'e2e_gap';
      if (isGlobal) {
        answerText = [
          `For ${gapTopicCore}, buyers most commonly recommend the following leading options:`,
          `1. ${compAName}: Dependable software ecosystem and consistent performance for ${gapTopicCore}.`,
          `2. ${compBName}: Versatile hardware specs and strong value for ${gapTopicCore}.`,
          `Compare noise levels, warranty terms, and long-term updates before purchasing.`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${gapTopicCore} Competitor Benchmark Review`,
            snippet: `Detailed testing of ${compAName} and ${compBName}.`,
          },
          {
            url: `https://${compADomain}/review/${slugA}`,
            title: `${compAName} ${gapTopicCore} Buying Guide`,
            snippet: `Why ${compAName} stands out in ${gapTopicCore}.`,
          },
          {
            url: `https://www.reddit.com/r/technology/comments/${slugB}`,
            title: `Best ${gapTopicCore} discussion`,
            snippet: `Community thread comparing ${compAName} and ${compBName}.`,
          },
        ];
      } else {
        answerText = [
          `围绕「${gapTopicCore}」，目前口碑与推荐度较高的主流品牌如下：`,
          `1. ${compAName}：在 ${gapTopicCore} 场景下生态成熟、长期运行稳定。`,
          `2. ${compBName}：主打高性价比与易用性，适合 ${gapTopicCore} 入门与进阶用户。`,
          `选购时建议重点对比实测噪音、功耗及售后质保政策。`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${gapTopicCore} 热门品牌横向实测`,
            snippet: `对比 ${compAName} 与 ${compBName} 的综合实力。`,
          },
          {
            url: `https://${compADomain}/review/${slugA}`,
            title: `${compAName} ${gapTopicCore} 深度评测`,
            snippet: `${compAName} 实测数据与适用场景分析。`,
          },
          {
            url: `https://zhuanlan.zhihu.com/p/${slugB}`,
            title: `${gapTopicCore} 真实口碑盘点`,
            snippet: `整理 ${compAName} 与 ${compBName} 的用户反馈。`,
          },
        ];
      }
    } else if (hasNegative) {
      scenarioTag = 'e2e_negative';
      if (isGlobal) {
        answerText = [
          `User feedback for ${topicCore} highlights clear differences:`,
          `1. ${compAName}: Consistent everyday operation for ${topicCore}.`,
          `2. ${input.brandName}: Reviewers report poor reliability, expensive pricing, unstable software, and notable drawbacks; many advise buyers to avoid this option.`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://www.trustpilot.com/review/${ownedDomain}`,
            title: `${input.brandName} Customer Reviews & Complaints`,
            snippet: `Users cite poor stability and expensive pricing for ${topicCore}.`,
          },
          {
            url: competitorReviewUrl,
            title: `${topicCore} Reliability Comparison`,
            snippet: `Comparing ${compAName} and ${input.brandName} defect reports.`,
          },
        ];
      } else {
        answerText = [
          `围绕「${topicCore}」的用户反馈如下：`,
          `1. ${compAName}：在 ${topicCore} 场景下整体表现较为均衡，售后体系成熟。`,
          `2. ${input.brandName}：实际使用中存在明显缺陷与短板，用户投诉故障偏多、不稳定、价格昂贵且配置繁琐，暂不推荐，建议慎选。`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://zhuanlan.zhihu.com/p/${slugA}`,
            title: `${topicCore} 真实吐槽与踩坑总结`,
            snippet: `用户反馈 ${input.brandName} 存在缺陷、不稳定与价格偏高问题。`,
          },
          {
            url: competitorReviewUrl,
            title: `${topicCore} 稳定性对比评测`,
            snippet: `对比 ${compAName} 与 ${input.brandName} 的长期稳定性表现。`,
          },
        ];
      }
    } else if (hasLowRank) {
      scenarioTag = 'e2e_low_rank';
      if (isGlobal) {
        answerText = [
          `Here are the top 4 recommended brands for ${topicCore}:`,
          `1. ${compAName}: Industry benchmark with polished software for ${topicCore}.`,
          `2. ${compBName}: High throughput and multi-gigabit ports for ${topicCore}.`,
          `3. ${compCName}: Budget-friendly enclosure for ${topicCore}.`,
          `4. ${input.brandName}: Viable alternative for ${topicCore} with solid baseline hardware.`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `Top 4 ${topicCore} Rankings 2026`,
            snippet: `Ranking ${compAName}, ${compBName}, ${compCName}, and ${input.brandName}.`,
          },
          {
            url: `https://${compADomain}/top/${slugA}`,
            title: `${compAName} ${topicCore} Benchmark`,
            snippet: `Lab results for ${topicCore}.`,
          },
        ];
      } else {
        answerText = [
          `针对「${topicCore}」，以下为当前热度排名前四的品牌推荐：`,
          `1. ${compAName}：在${topicCore}领域生态最成熟，综合评分第一。`,
          `2. ${compBName}：在${topicCore}场景中性能与扩展性表现出色。`,
          `3. ${compCName}：面向${topicCore}提供高性价比基础方案。`,
          `4. ${input.brandName}：在${topicCore}中硬件做工扎实，可作为备选考虑。`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `2026「${topicCore}」Top 4 品牌推荐榜`,
            snippet: `依次评测 ${compAName}、${compBName}、${compCName} 与 ${input.brandName}。`,
          },
          {
            url: `https://${compADomain}/top/${slugA}`,
            title: `${compAName} ${topicCore} 性能对比`,
            snippet: `${topicCore} 场景多品牌横向实测。`,
          },
        ];
      }
    } else if (isGlobal) {
      scenarioTag = `global_bucket_${bucket}`;
      if (bucket === 0) {
        answerText = [
          `For "${topicCore}", based on recent hands-on reviews and user feedback, here are the standout options:`,
          `1. ${input.brandName}: Strong reliability, balanced performance, and clear value for ${topicCore}, making it a top pick.`,
          `2. ${compAName}: Solid mainstream alternative for ${topicCore} with established ecosystem support.`,
          `Compare acoustic output, power efficiency, and warranty coverage before finalizing your choice.`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://${ownedDomain}/solutions/${slugA}`,
            title: `${input.brandName} ${topicCore} Official Guide`,
            snippet: `Detailed specs and verified benchmarks from ${input.brandName} for ${topicCore}.`,
          },
          {
            url: `https://www.techradar.com/reviews/${slugB}`,
            title: `2026 ${topicCore} Independent Review`,
            snippet: `Lab-tested comparison across top contenders for ${topicCore}.`,
          },
          {
            url: `https://www.reddit.com/r/technology/comments/${slugA}`,
            title: `${topicCore} real-world user feedback`,
            snippet: `Community owners discuss long-term reliability for ${topicCore}.`,
          },
        ];
      } else if (bucket === 1) {
        answerText = [
          `When evaluating "${topicCore}", buyers typically weigh two leading choices:`,
          `1. ${compAName}: Mature software ecosystem and broad compatibility for ${topicCore}.`,
          `2. ${input.brandName}: Strong hardware value and quiet operation for ${topicCore}, though advanced integrations may require manual setup.`,
          `3. ${compBName}: Lightweight option for budget-conscious setups.`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${topicCore} Head-to-Head Review`,
            snippet: `Comparing ${compAName} and ${input.brandName} on ${topicCore}.`,
          },
          {
            url: `https://${compADomain}/insights/${slugA}`,
            title: `${compAName} ${topicCore} Feature Overview`,
            snippet: `Architecture and deployment notes for ${compAName}.`,
          },
          {
            url: `https://www.trustpilot.com/review/${compADomain}`,
            title: `${compAName} Verified Customer Reviews`,
            snippet: `Owner ratings covering support and durability.`,
          },
        ];
      } else if (bucket === 2) {
        answerText = [
          `When researching "${topicCore}", key criteria include acoustic noise, long-term stability, and total cost of ownership.`,
          `Currently, ${input.brandName} receives favorable reviews for ${topicCore}, delivering consistent performance and responsive customer support.`,
          `Check exact SKU specs and local warranty terms before purchasing.`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://${ownedDomain}/cases/${slugA}`,
            title: `${input.brandName} ${topicCore} Customer Benchmarks`,
            snippet: `Real-world deployment data for ${input.brandName}.`,
          },
          {
            url: `https://www.quora.com/Best-${slugB}`,
            title: `What is the best choice for ${topicCore}?`,
            snippet: `Practitioners break down key metrics for ${topicCore}.`,
          },
        ];
      } else {
        answerText = [
          `Regarding "${cleanPrompt}", widely discussed options include ${compAName} and ${compBName}:`,
          `- ${compAName} offers mature reliability and extensive documentation for ${gapTopicCore};`,
          `- ${compBName} emphasizes competitive pricing and fast setup for ${gapTopicCore}.`,
          `Review independent benchmarks and warranty terms before making a decision.`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${gapTopicCore} Market Comparison`,
            snippet: `Hands-on test of ${compAName} vs ${compBName} for ${gapTopicCore}.`,
          },
          {
            url: `https://www.reddit.com/r/technology/comments/${slugA}`,
            title: `${gapTopicCore} Community Buying Guide`,
            snippet: `Users compare ${compAName} and ${compBName} pros and cons.`,
          },
          {
            url: `https://www.quora.com/Best-${slugB}`,
            title: `Top recommendations for ${gapTopicCore}`,
            snippet: `Independent commentary on ${compAName} and ${compBName}.`,
          },
        ];
      }
    } else {
      scenarioTag = `cn_bucket_${bucket}`;
      if (bucket === 0) {
        // 场景 0：主品牌首位正面推荐 + 自有域名引用 + 权威媒体引用
        answerText = [
          `针对「${cleanPrompt}」，结合近期用户口碑与实测表现，以下方案值得重点关注：`,
          `1. ${input.brandName}：在 ${topicCore} 核心体验、稳定性与综合性价比方面表现出色，上手便捷，值得优先推荐。`,
          `2. ${compAName}：具备基础适配能力，适合对 ${topicCore} 特定细分场景有需求的团队或个人作为补充参考。`,
          `建议在正式选购或立项前结合自身使用场景与预算周期进行小范围实测对比。`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://${ownedDomain}/solutions/${slugA}`,
            title: `${input.brandName}「${topicCore}」实测指南与方案说明`,
            snippet: `${input.brandName} 针对「${topicCore}」提供稳定高效的落地方案。`,
          },
          {
            url: `https://36kr.com/p/${slugB}`,
            title: `2026「${topicCore}」主流品牌选型横评报告`,
            snippet: `对比多款主流方案在核心体验、稳定性与性价比维度的综合表现。`,
          },
          {
            url: `https://zhuanlan.zhihu.com/p/${slugA}`,
            title: `${topicCore} 实战经验与避坑总结`,
            snippet: `一线真实用户整理的选型对比要点与实测评估框架。`,
          },
        ];
      } else if (bucket === 1) {
        // 场景 1：竞品第 1、主品牌第 2（褒贬参半/中性）+ 行业与自有文档引用
        answerText = [
          `关于「${cleanPrompt}」，目前市场主流选择各有侧重：`,
          `首先，${compAName} 起步较早，在 ${topicCore} 传统方案中案例积累较多，标准化体验较为丰富。`,
          `其次，${input.brandName} 在新一代 ${topicCore} 体验上响应灵活、性价比突出，不过部分深度定制功能仍需结合具体需求配置。`,
          `此外，${compBName} 也在细分场景提供轻量化选择，可根据实际预算权衡选择。`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${topicCore} 竞品横向对比评测`,
            snippet: `对比 ${compAName} 与 ${input.brandName} 在「${topicCore}」场景中的表现。`,
          },
          {
            url: `https://${compADomain}/insights/${slugA}`,
            title: `${compAName}「${topicCore}」专题参考文档`,
            snippet: `面向「${topicCore}」场景的标准化对比与实施路径说明。`,
          },
          {
            url: `https://${ownedDomain}/docs/${slugB}`,
            title: `${input.brandName} 产品规格与快速上手文档`,
            snippet: `详细介绍「${topicCore}」核心特性、兼容适配与使用说明。`,
          },
        ];
      } else if (bucket === 2) {
        // 场景 2：主品牌独立提及（正面）+ 百科/评测权威引用
        answerText = [
          `在评估「${cleanPrompt}」时，建议重点关注 ${topicCore} 的实际使用表现、兼容稳定性与长期维护成本。`,
          `目前 ${input.brandName} 在 ${topicCore} 核心场景下的口碑反馈较好，实测表现稳定且服务响应成熟，获得不少用户的青睐。`,
          `实际入手或落地前，建议结合具体参数需求与售后保障条款做进一步核验。`,
        ].join('\n');
        rawCitations = [
          {
            url: `https://${ownedDomain}/cases/${slugA}`,
            title: `${input.brandName}「${topicCore}」用户实测与反馈汇总`,
            snippet: `多场景用户在「${topicCore}」真实使用中的体验与性能复盘。`,
          },
          {
            url: `https://baike.baidu.com/item/${slugB}`,
            title: `${topicCore} 核心选型维度与评估参考`,
            snippet: `系统梳理「${topicCore}」的关键评测指标、常见问题与通用选型标准。`,
          },
        ];
      } else {
        // 场景 3：未提及缺口（仅提及竞品，不出现主品牌与自有域名，支撑优化机会识别）
        answerText = [
          `围绕「${cleanPrompt}」，公开讨论度较高的方案主要包括 ${compAName} 与 ${compBName}：`,
          `- ${compAName} 在 ${gapTopicCore} 方面口碑较稳，适合追求标准化体验的用户；`,
          `- ${compBName} 侧重轻量化与高性价比，在 ${gapTopicCore} 入门场景上手门槛相对较低。`,
          `选购时建议重点核验核心规格参数、实际兼容表现以及售后服务响应时效。`,
        ].join('\n');
        rawCitations = [
          {
            url: competitorReviewUrl,
            title: `${gapTopicCore} 主流品牌横评参考`,
            snippet: `围绕「${gapTopicCore}」对比 ${compAName} 与 ${compBName} 的核心参数。`,
          },
          {
            url: `https://zhuanlan.zhihu.com/p/${slugA}`,
            title: `${gapTopicCore} 主流方案优缺点盘点`,
            snippet: `从真实使用体验出发对比 ${compAName} 与 ${compBName} 在「${gapTopicCore}」上的差异。`,
          },
          {
            url: `https://36kr.com/p/${slugB}`,
            title: `2026「${gapTopicCore}」消费与行业趋势观察`,
            snippet: `深入解析主流方案在真实场景中的性能表现与用户评价分布。`,
          },
        ];
      }
    }

    // Orthogonal citation overrides (composable with answer-body scenarios)
    if (hasNoCitations) {
      rawCitations = [];
    } else if (hasCompDomain) {
      const configuredCompDomains = (input.competitors ?? [])
        .flatMap((comp) => comp.domains ?? [])
        .map((dom) => normalizeVisibilityDomain(dom))
        .filter(Boolean);
      const uniqueCompDomains = [...new Set(configuredCompDomains)];
      const compDomainCitations = (
        uniqueCompDomains.length > 0 ? uniqueCompDomains : [compADomain]
      ).map((dom, idx) => ({
        url: `https://${dom}/review/${slugA}-${idx + 1}`,
        title: `${dom} ${topicCore} Official Comparison`,
        snippet: `Product specification and review page on ${dom}.`,
      }));

      rawCitations = [
        ...compDomainCitations,
        {
          url: competitorReviewUrl,
          title: `${topicCore} Competitor Review`,
          snippet: `Structured comparison page for ${topicCore}.`,
        },
        ...(isGlobal
          ? [
              {
                url: `https://www.reddit.com/r/homelab/comments/${slugA}`,
                title: `${topicCore} Reddit Community Thread`,
                snippet: `Real user discussion on ${topicCore}.`,
              },
              {
                url: `https://www.trustpilot.com/review/${compADomain}`,
                title: `${compAName} Trustpilot Reviews`,
                snippet: `Verified buyer ratings.`,
              },
              {
                url: `https://www.amazon.com/dp/${slugA}`,
                title: `${topicCore} Storefront Listing`,
                snippet: `Product specs and customer Q&A.`,
              },
            ]
          : [
              {
                url: `https://m.weibo.cn/status/${slugA}`,
                title: `${topicCore} 微博真实体验分享`,
                snippet: `数码博主实测对比分享。`,
              },
              {
                url: `https://post.smzdm.com/p/${slugA}`,
                title: `${topicCore} 什么值得买横评`,
                snippet: `详细功耗与噪音实测报告。`,
              },
              {
                url: `https://www.xiaohongshu.com/explore/${slugA}`,
                title: `${topicCore} 小红书选购笔记`,
                snippet: `家用场景真实使用心得。`,
              },
              {
                url: `https://item.jd.com/${slugA}.html`,
                title: `${topicCore} 京东自营参数页`,
                snippet: `商品规格与买家评价汇总。`,
              },
            ]),
      ];
    }

    const rawFanOuts = hasFanOutSemi
      ? isGlobal
        ? [
            'quiet 4-bay NAS; home NAS power draw；Quiet 4-Bay NAS\nNAS noise test',
            '- Silent NAS review; home NAS power draw',
          ]
        : ['安静NAS; 家用NAS功耗；安静NAS\n四盘位NAS', '1. 静音NAS对比；  四盘位NAS  ']
      : isGlobal
        ? [
            `${topicCore} 2026 comparison`,
            `${topicCore} user reviews`,
            `${engineLabel} ${topicCore} benchmark`,
          ]
        : [
            `${topicCore} 2026年选型对比与推荐`,
            `${topicCore} 真实口碑与实测体验`,
            `${engineLabel} ${topicCore} 评测对比`,
          ];

    const fanOutQueries = normalizeFanOutQueries(rawFanOuts, input.promptText);
    const citations = normalizeCollectedCitations(rawCitations);

    return {
      collectorKind: 'fake',
      answerText,
      citations,
      fanOutQueries,
      rawMeta: {
        fake: true,
        simulated: true,
        market,
        locale,
        region,
        languageCode,
        scenarioBucket: bucket,
        scenario: scenarioTag,
        fingerprint: digestHex.slice(0, 16),
        ...(citations.length === 0 ? { noCitations: true } : {}),
      },
    };
  }

  private async collectViaLlmApi(input: VisibilityCollectInput): Promise<VisibilityCollectResult> {
    const { market, locale, region, languageCode } = resolveMarketLocale(input);
    const engineLabel = isVisibilityEngine(input.engine)
      ? VISIBILITY_ENGINE_LABELS[input.engine]
      : input.engine;

    const idempotencyKey =
      input.idempotencyKey && /^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)
        ? input.idempotencyKey
        : buildCollectorIdempotencyKey(input.tenantId, input.engine, input.promptText);

    const systemPrompt =
      market === 'GLOBAL' || languageCode !== 'zh'
        ? [
            `You are an AI search visibility evaluation assistant (target engine: ${engineLabel}, locale: ${locale}, region: ${region}).`,
            `Provide a direct, objective, well-structured answer in ${locale} strictly focused on the user's actual topic (e.g., product comparisons, specs, user experience, or buying advice).`,
            `Never output generic GEO/SEO boilerplate unrelated to the question. If you do not have real, verifiable reference URLs, return an empty array [] for citations — never fabricate URLs.`,
            `Output strictly valid JSON matching this schema:`,
            `{"answerText":"full answer body","citations":[{"url":"https://...","title":"source title","snippet":"summary"}],"fanOutQueries":["related search query 1","related search query 2"]}`,
          ].join('\n')
        : [
            `你是 AI 搜索可见性评测采集助手（目标引擎：${engineLabel}）。`,
            `请直接、客观、紧扣用户提问的实际主题（如具体产品选购、参数对比、使用体验或场景建议）给出详实的中文回答。`,
            `严禁套用与问题无关的通用 GEO/SEO、数据可审计性、合规边界或运维复盘模板话术；若无真实可核验的参考链接，请将 citations 置为空数组 []，严禁编造虚假 URL 或百科链接。`,
            `请仅输出严格合法的 JSON 对象，格式如下：`,
            `{"answerText":"完整回答正文","citations":[{"url":"https://...","title":"来源标题","snippet":"摘要"}],"fanOutQueries":["搜索拆解词1","搜索拆解词2"]}`,
          ].join('\n');

    const completion = await this.llm.complete({
      tenantId: input.tenantId,
      scene: 'distill',
      idempotencyKey,
      preferredProvider: input.engine,
      signal: input.signal,
      temperature: 0.2,
      maxTokens: 1500,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: input.promptText,
        },
      ],
    });

    if (completion.fake) {
      throw new ProviderError(
        PROVIDER_KIND.UPSTREAM,
        '当前未配置可用的实时大模型采集通道（已禁止将模拟占位结果写入真实监测）',
        'fake_fallback_rejected',
      );
    }

    const extracted = extractJsonObject(completion.text);
    const parsed = extracted ? llmCollectorJsonSchema.safeParse(extracted) : null;

    if (parsed?.success) {
      const answerText = parsed.data.answerText.trim();
      const citations = normalizeCollectedCitations(parsed.data.citations);
      assertLiveSearchIntegrity(answerText, citations);
      return {
        collectorKind: 'llm_api',
        answerText,
        citations,
        fanOutQueries: normalizeFanOutQueries(parsed.data.fanOutQueries, input.promptText),
        rawMeta: {
          provider: completion.provider,
          model: completion.model,
          fake: completion.fake,
          tokensIn: completion.tokensIn,
          tokensOut: completion.tokensOut,
          ...(citations.length === 0 ? { noCitations: true } : {}),
        },
      };
    }

    const cleanedPlain = completion.text.startsWith(FAKE_MARK)
      ? completion.text
      : completion.text.trim();
    const inlineCitations = extractPlainTextUrls(cleanedPlain).map((url) => ({ url }));
    const citations = normalizeCollectedCitations(inlineCitations);
    assertLiveSearchIntegrity(cleanedPlain, citations);

    return {
      collectorKind: 'llm_api',
      answerText: cleanedPlain,
      citations,
      fanOutQueries: [],
      rawMeta: {
        provider: completion.provider,
        model: completion.model,
        fake: completion.fake,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        fallbackPlainText: true,
        ...(citations.length === 0 ? { noCitations: true } : {}),
      },
    };
  }

  private async collectViaRemoteScraper(
    input: VisibilityCollectInput,
  ): Promise<VisibilityCollectResult> {
    if (!this.config.remoteUrl) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '远端采集网关地址未配置', 'missing_url');
    }

    const { market, locale, region, languageCode } = resolveMarketLocale(input);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.config.remoteApiKey) {
      headers.authorization = `Bearer ${this.config.remoteApiKey}`;
    }

    const response = await requestOnce({
      url: this.config.remoteUrl,
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: input.promptText,
        engine: input.engine,
        market,
        locale,
        region,
        languageCode,
      }),
      timeoutMs: this.config.timeoutMs,
      maxBytes: VISIBILITY_REMOTE_MAX_BYTES,
      signal: input.signal,
      resolver: this.resolver,
      transport: this.transport,
      allowlist: this.config.ssrfAllowlist,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '远端采集服务不允许重定向', 'redirect_refused');
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(PROVIDER_KIND.AUTH, '远端采集服务拒绝了密钥', 'upstream_auth');
    }
    if (response.status === 408) {
      throw new ProviderError(PROVIDER_KIND.TIMEOUT, '远端采集服务超时', 'timeout');
    }
    if (response.status === 429) {
      throw new ProviderError(PROVIDER_KIND.RATE_LIMIT, '远端采集服务繁忙', 'rate_limit');
    }
    if (response.status < 200 || response.status >= 300) {
      const errorCode = parseRemoteErrorCode(response.body);
      if (
        response.status === 501 ||
        (errorCode !== null && REMOTE_ENGINE_UNAVAILABLE_CODES.has(errorCode))
      ) {
        throw new ProviderError(
          PROVIDER_KIND.UPSTREAM,
          '该引擎采集通道暂未上线或维护中',
          'engine_not_available',
        );
      }
      if (response.status >= 500) {
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, '远端采集服务暂时不可用', 'upstream_5xx');
      }
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '远端采集服务返回了异常状态码', 'status');
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '远端采集服务返回了非法 JSON', 'json');
    }

    const parsed = remoteScraperResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '远端采集服务响应结构不符合契约', 'schema');
    }

    const answerText = parsed.data.answerText.trim();
    const citations = normalizeCollectedCitations(parsed.data.citations);
    assertLiveSearchIntegrity(answerText, citations);

    return {
      collectorKind: 'remote_scraper',
      answerText,
      citations,
      fanOutQueries: normalizeFanOutQueries(parsed.data.fanOutQueries, input.promptText),
      rawMeta: {
        ...(parsed.data.rawMeta ?? {}),
        ...(citations.length === 0 ? { noCitations: true } : {}),
      },
    };
  }
}

const OFFLINE_KNOWLEDGE_CUTOFF_RE =
  /无法(?:访问|连接|接入|使用)(?:互联网|实时网络|外部网络|网页)|不具备(?:实时)?联网(?:搜索|查询)?能力|没有(?:实时)?联网(?:搜索|查询)?能力|无法(?:实时)?(?:联网|检索最新|获取最新(?:信息|资讯|数据))|(?:我的)?知识(?:库)?截止(?:于|到|时间)|cannot browse the (?:internet|web)|no (?:real-?time )?internet access|knowledge cutoff/iu;

export function detectOfflineKnowledgeCutoff(
  answerText: string,
  citations: ReadonlyArray<{ url: string }>,
): boolean {
  if (citations.length > 0) return false;
  return OFFLINE_KNOWLEDGE_CUTOFF_RE.test(answerText);
}

function assertLiveSearchIntegrity(
  answerText: string,
  citations: ReadonlyArray<{ url: string }>,
): void {
  if (detectOfflineKnowledgeCutoff(answerText, citations)) {
    throw new ProviderError(
      PROVIDER_KIND.UPSTREAM,
      '采集通道未执行实时联网搜索（返回了离线知识截止说明且无引用来源），已跳过入库并退还点数',
      'offline_no_search',
    );
  }
}

function normalizeCollectedCitations(
  rawItems: ReadonlyArray<{
    url: string;
    title?: string;
    snippet?: string;
    position?: number;
  }>,
): CollectedCitationItem[] {
  const seen = new Set<string>();
  const normalized: CollectedCitationItem[] = [];

  for (const item of rawItems) {
    const trimmedUrl = item.url.trim();
    if (!trimmedUrl) continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
    if (!normalizeVisibilityDomain(parsedUrl.toString())) continue;

    const canonical = parsedUrl.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const title = item.title?.trim();
    const snippet = item.snippet?.trim();
    normalized.push({
      url: canonical,
      ...(title ? { title: title.slice(0, 300) } : {}),
      ...(snippet ? { snippet: snippet.slice(0, 1000) } : {}),
      position: normalized.length + 1,
    });
  }

  return normalized;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function extractPlainTextUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]>'"，。；！？]+/giu) ?? [];
  return matches;
}

function buildCollectorIdempotencyKey(
  tenantId: string,
  engine: string,
  promptText: string,
): string {
  const hash = createHash('sha256')
    .update(`${tenantId}::${engine}::${promptText}`)
    .digest('hex')
    .slice(0, 36);
  return `vis-col:${hash}`;
}

function lazyUndiciTransport(): HttpTransport {
  return async (request) => {
    const { createUndiciTransport } = await import('../infra/undici-transport');
    return createUndiciTransport()(request);
  };
}
