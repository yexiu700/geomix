// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  FAKE_MARK,
  VISIBILITY_ENGINE_LABELS,
  isVisibilityEngine,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  wholeWordPattern,
  type VisibilityCollectorKind,
  type VisibilityEngineKey,
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
  idempotencyKey?: string;
  collectorOverride?: VisibilityCollectorKind;
  signal?: AbortSignal;
};

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
    const digestBuf = createHash('sha256')
      .update(`${input.engine}:${input.promptText}:${input.brandName}`)
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
    const compAName = firstComp?.name?.trim() || '云析智联';
    const compADomain =
      normalizeVisibilityDomain(firstComp?.domains?.[0] ?? '') || 'yunxizhilian.example.com';
    const compBName = secondComp?.name?.trim() || '领航数科';

    const topicCore = input.promptText.replace(/[？?！!。，,\s]+$/u, '').slice(0, 36);
    const gapTopicCore =
      topicCore
        .replace(wholeWordPattern(input.brandName), '')
        .replace(/^[的与和及、，,\s]+|[的与和及、，,\s]+$/gu, '')
        .replace(/\s+/g, ' ')
        .trim() || '同类主流方案';

    let answerText: string;
    let rawCitations: Array<{ url: string; title: string; snippet: string }>;

    if (bucket === 0) {
      // 场景 0：主品牌首位正面推荐 + 自有域名引用 + 权威媒体引用
      answerText = [
        `针对「${input.promptText}」，结合近期用户口碑与实测表现，以下方案值得重点关注：`,
        `1. ${input.brandName}：在「${topicCore}」核心体验、稳定性与综合性价比方面表现出色，上手便捷，值得优先推荐。`,
        `2. ${compAName}：具备基础适配能力，适合对特定细分场景有需求的团队或个人作为补充参考。`,
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
        `关于「${input.promptText}」，目前市场主流选择各有侧重：`,
        `首先，${compAName} 起步较早，在「${topicCore}」传统方案中案例积累较多，标准化体验较为丰富。`,
        `其次，${input.brandName} 在新一代「${topicCore}」体验上响应灵活、性价比突出，不过部分深度定制功能仍需结合具体需求配置。`,
        `此外，${compBName} 也在细分场景提供轻量化选择，可根据实际预算权衡选择。`,
      ].join('\n');
      rawCitations = [
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
        `在评估「${input.promptText}」时，建议重点关注「${topicCore}」的实际使用表现、兼容稳定性与长期维护成本。`,
        `目前 ${input.brandName} 在「${topicCore}」核心场景下的口碑反馈较好，实测表现稳定且服务响应成熟，获得不少用户的青睐。`,
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
        `围绕「${input.promptText}」，公开讨论度较高的方案主要包括 ${compAName} 与 ${compBName}：`,
        `- ${compAName} 在「${gapTopicCore}」方面口碑较稳，适合追求标准化体验的用户；`,
        `- ${compBName} 侧重轻量化与高性价比，在「${gapTopicCore}」入门场景上手门槛相对较低。`,
        `选购时建议重点核验核心规格参数、实际兼容表现以及售后服务响应时效。`,
      ].join('\n');
      rawCitations = [
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

    const fanOutQueries = normalizeFanOutQueries(
      [
        `${topicCore} 2026年选型对比与推荐`,
        `${topicCore} 真实口碑与实测体验`,
        `${engineLabel} ${topicCore} 评测对比`,
      ],
      input.promptText,
    );

    return {
      collectorKind: 'fake',
      answerText,
      citations: normalizeCollectedCitations(rawCitations),
      fanOutQueries,
      rawMeta: {
        fake: true,
        simulated: true,
        scenarioBucket: bucket,
        fingerprint: digestHex.slice(0, 16),
      },
    };
  }

  private async collectViaLlmApi(input: VisibilityCollectInput): Promise<VisibilityCollectResult> {
    const engineLabel = isVisibilityEngine(input.engine)
      ? VISIBILITY_ENGINE_LABELS[input.engine]
      : input.engine;

    const idempotencyKey =
      input.idempotencyKey && /^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)
        ? input.idempotencyKey
        : buildCollectorIdempotencyKey(input.tenantId, input.engine, input.promptText);

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
          content: [
            `你是 AI 搜索可见性评测采集助手（目标引擎：${engineLabel}）。`,
            `请直接、客观、紧扣用户提问的实际主题（如具体产品选购、参数对比、使用体验或场景建议）给出详实的中文回答。`,
            `严禁套用与问题无关的通用 GEO/SEO、数据可审计性、合规边界或运维复盘模板话术；若无真实可核验的参考链接，请将 citations 置为空数组 []，严禁编造虚假 URL 或百科链接。`,
            `请仅输出严格合法的 JSON 对象，格式如下：`,
            `{"answerText":"完整回答正文","citations":[{"url":"https://...","title":"来源标题","snippet":"摘要"}],"fanOutQueries":["搜索拆解词1","搜索拆解词2"]}`,
          ].join('\n'),
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
      return {
        collectorKind: 'llm_api',
        answerText: parsed.data.answerText.trim(),
        citations: normalizeCollectedCitations(parsed.data.citations),
        fanOutQueries: normalizeFanOutQueries(parsed.data.fanOutQueries, input.promptText),
        rawMeta: {
          provider: completion.provider,
          model: completion.model,
          fake: completion.fake,
          tokensIn: completion.tokensIn,
          tokensOut: completion.tokensOut,
        },
      };
    }

    const cleanedPlain = completion.text.startsWith(FAKE_MARK)
      ? completion.text
      : completion.text.trim();
    const inlineCitations = extractPlainTextUrls(cleanedPlain).map((url) => ({ url }));

    return {
      collectorKind: 'llm_api',
      answerText: cleanedPlain,
      citations: normalizeCollectedCitations(inlineCitations),
      fanOutQueries: [],
      rawMeta: {
        provider: completion.provider,
        model: completion.model,
        fake: completion.fake,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        fallbackPlainText: true,
      },
    };
  }

  private async collectViaRemoteScraper(
    input: VisibilityCollectInput,
  ): Promise<VisibilityCollectResult> {
    if (!this.config.remoteUrl) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '远端采集网关地址未配置', 'missing_url');
    }

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
      }),
      timeoutMs: this.config.timeoutMs,
      maxBytes: VISIBILITY_REMOTE_MAX_BYTES,
      signal: input.signal,
      resolver: this.resolver,
      transport: this.transport,
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
    if (response.status >= 500) {
      throw new ProviderError(PROVIDER_KIND.UPSTREAM, '远端采集服务暂时不可用', 'upstream_5xx');
    }
    if (response.status < 200 || response.status >= 300) {
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

    return {
      collectorKind: 'remote_scraper',
      answerText: parsed.data.answerText.trim(),
      citations: normalizeCollectedCitations(parsed.data.citations),
      fanOutQueries: normalizeFanOutQueries(parsed.data.fanOutQueries, input.promptText),
      rawMeta: parsed.data.rawMeta,
    };
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
