// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { describe, expect, it } from 'vitest';
import { type LlmRouteConfig } from '@geomix/shared';
import type { DnsResolver, HttpTransport, TransportRequest } from '../infra/guarded-request';
import { LlmRouter, LlmService, type LlmProvider } from '../infra/llm';
import { PROVIDER_KIND } from '../infra/provider-error';
import {
  VisibilityCollectorService,
  detectOfflineKnowledgeCutoff,
} from './visibility-collector.service';
import { readVisibilityConfig } from './visibility.config';

function createScriptedLlm(text: string): LlmService {
  const provider: LlmProvider = {
    name: 'scripted',
    async complete(call) {
      return {
        provider: 'scripted',
        model: call.model,
        fake: false,
        text,
        tokensIn: 24,
        tokensOut: 48,
      };
    },
  };
  const route: LlmRouteConfig = {
    providers: {
      scripted: {
        kind: 'openai',
        baseUrl: 'https://llm.example.com/v1',
        apiKeyEnv: 'SCRIPTED_KEY',
        cheapModel: 'scripted-cheap',
        qualityModel: 'scripted-quality',
      },
    },
    route: {
      distill: { primary: 'scripted', backup: [] },
      title: { primary: 'scripted', backup: [] },
      body: { primary: 'scripted', backup: [] },
      rewrite: { primary: 'scripted', backup: [] },
      image_prompt: { primary: 'scripted', backup: [] },
      fact_extract: { primary: 'scripted', backup: [] },
      geo_brief: { primary: 'scripted', backup: [] },
      geo_write: { primary: 'scripted', backup: [] },
      geo_rewrite: { primary: 'scripted', backup: [] },
    },
  };
  return new LlmService(
    new LlmRouter(
      route,
      { scripted: provider },
      {
        maxRetries: 0,
        timeoutMs: 5_000,
        retryDelayMs: 0,
      },
    ),
  );
}

describe('visibility config', () => {
  it('defaults to fake collector and validates collector kind and timeout', () => {
    expect(readVisibilityConfig({})).toEqual({
      collector: 'fake',
      remoteUrl: null,
      remoteApiKey: null,
      timeoutMs: 30_000,
      featureEnabled: true,
    });

    expect(
      readVisibilityConfig({
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/collect',
        VISIBILITY_REMOTE_API_KEY: 'secret-token',
        VISIBILITY_TIMEOUT_MS: '15000',
        FEATURE_VISIBILITY: 'false',
      }),
    ).toEqual({
      collector: 'remote_scraper',
      remoteUrl: 'https://scraper.example.com/collect',
      remoteApiKey: 'secret-token',
      timeoutMs: 15_000,
      featureEnabled: false,
    });

    expect(() => readVisibilityConfig({ VISIBILITY_COLLECTOR: 'unsupported_driver' })).toThrow(
      /VISIBILITY_COLLECTOR/,
    );
    expect(() => readVisibilityConfig({ VISIBILITY_TIMEOUT_MS: '50' })).toThrow(
      /VISIBILITY_TIMEOUT_MS/,
    );
  });
});

describe('VisibilityCollectorService - fake driver', () => {
  it('produces deterministic Chinese GEO answers, citations, and fanOutQueries across scenarios', async () => {
    const collector = VisibilityCollectorService.fromEnv({ VISIBILITY_COLLECTOR: 'fake' });

    const baseInput = {
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '2026年企业级GEO内容优化系统哪家值得选？',
      brandName: 'GeoMix',
      ownedDomains: ['geomix.cn'],
      competitors: [
        { name: '竞品甲', domains: ['alphageo.com'] },
        { name: '竞品乙', domains: ['betageo.com'] },
      ],
    };

    const first = await collector.collect(baseInput);
    const second = await collector.collect(baseInput);
    expect(second).toEqual(first);
    expect(first.collectorKind).toBe('fake');
    expect(first.citations.length).toBeGreaterThanOrEqual(2);
    expect(first.citations.map((c) => c.position)).toEqual(
      first.citations.map((_, idx) => idx + 1),
    );
    expect(first.fanOutQueries.length).toBeGreaterThanOrEqual(2);
    expect(first.fanOutQueries).not.toContain(baseInput.promptText);

    // Sweep prompts to confirm deterministic variability covers brand-hit and competitor-only gap buckets
    const seenBuckets = new Set<number>();
    let sawBrandMention = false;
    let sawCompetitorOnlyGap = false;

    for (let i = 1; i <= 24; i += 1) {
      const sample = await collector.collect({
        ...baseInput,
        promptText: `测试行业选型问题编号 ${i}：企业如何评估多平台AI可见度？`,
      });
      const bucket = Number(sample.rawMeta?.scenarioBucket);
      seenBuckets.add(bucket);
      if (sample.answerText.includes('GeoMix')) {
        sawBrandMention = true;
      } else if (sample.answerText.includes('竞品甲')) {
        sawCompetitorOnlyGap = true;
      }
    }

    expect(seenBuckets.size).toBe(4);
    expect(sawBrandMention).toBe(true);
    expect(sawCompetitorOnlyGap).toBe(true);
  });

  it('keeps fake collector topic-aware for consumer hardware prompts without injecting GEO/audit boilerplate (#217)', async () => {
    const collector = VisibilityCollectorService.fromEnv({ VISIBILITY_COLLECTOR: 'fake' });
    const forbiddenBoilerplate = [
      '数据可审计性',
      '合规边界',
      '中文语义理解',
      '引用溯源归类',
      '生成式引擎优化（GEO）',
    ];

    for (let i = 1; i <= 16; i += 1) {
      const sample = await collector.collect({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: `Switch外接ARZOPA便携屏怎么样 实测${i}`,
        brandName: 'ARZOPA',
        ownedDomains: ['arzopa.com'],
        competitors: [
          { name: '联想ThinkVision', domains: ['lenovo.com'] },
          { name: '小米', domains: ['mi.com'] },
        ],
      });

      expect(sample.rawMeta?.simulated).toBe(true);
      for (const bad of forbiddenBoilerplate) {
        expect(sample.answerText).not.toContain(bad);
      }
    }
  });

  it('strips brandAliases in addition to brandName from collectFake bucket 3 gapTopicCore (#217)', async () => {
    const collector = VisibilityCollectorService.fromEnv({ VISIBILITY_COLLECTOR: 'fake' });
    let sawBucket3 = false;

    for (let i = 1; i <= 24; i += 1) {
      const sample = await collector.collect({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: `阿卓帕便携屏实测${i}`,
        brandName: 'ARZOPA',
        brandAliases: ['阿卓帕'],
        ownedDomains: ['arzopa.com'],
        competitors: [
          { name: '联想ThinkVision', domains: ['lenovo.com'] },
          { name: '小米', domains: ['mi.com'] },
        ],
      });
      if (Number(sample.rawMeta?.scenarioBucket) !== 3) continue;
      sawBucket3 = true;

      // Strip quoted prompt echo in line 1, then verify brand & brandAlias do not appear in gap body or citation titles
      const bodyLines = sample.answerText.split('\n').slice(1).join('\n');
      expect(bodyLines).not.toContain('ARZOPA');
      expect(bodyLines).not.toContain('阿卓帕');
      for (const cite of sample.citations) {
        expect(cite.title ?? '').not.toContain('阿卓帕');
        expect(cite.snippet ?? '').not.toContain('阿卓帕');
      }
      break;
    }

    expect(sawBucket3).toBe(true);
  });
});

describe('VisibilityCollectorService - llm_api driver', () => {
  it('rejects fake LLM fallback output instead of persisting 【FAKE】 placeholder text (#217)', async () => {
    const fakeLlm = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const collector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm: fakeLlm },
    );

    await expect(
      collector.collect({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: 'Switch外接ARZOPA便携屏怎么样',
        brandName: 'ARZOPA',
      }),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.UPSTREAM,
      reason: 'fake_fallback_rejected',
    });
  });

  it('routes llm_api collection to provider matching target engine when configured (#217)', async () => {
    const calledProviders: string[] = [];
    const makeProv = (name: string): LlmProvider => ({
      name,
      async complete(call) {
        calledProviders.push(name);
        return {
          provider: name,
          model: call.model,
          fake: false,
          text: JSON.stringify({
            answerText: `由 ${name} 回答：Switch 外接 ARZOPA 便携屏支持 Type-C 一线直连。`,
            citations: [],
            fanOutQueries: ['Switch便携屏一线直连'],
          }),
          tokensIn: 20,
          tokensOut: 30,
        };
      },
    });
    const route: LlmRouteConfig = {
      providers: {
        deepseek: {
          kind: 'openai',
          baseUrl: 'https://ds.example.com/v1',
          apiKeyEnv: 'DS_KEY',
          cheapModel: 'deepseek-chat',
          qualityModel: 'deepseek-chat',
        },
        tongyi: {
          kind: 'openai',
          baseUrl: 'https://ty.example.com/v1',
          apiKeyEnv: 'TY_KEY',
          cheapModel: 'qwen-plus',
          qualityModel: 'qwen-max',
        },
      },
      route: {
        distill: { primary: 'deepseek', backup: ['tongyi'] },
        title: { primary: 'deepseek', backup: ['tongyi'] },
        body: { primary: 'deepseek', backup: ['tongyi'] },
        rewrite: { primary: 'deepseek', backup: ['tongyi'] },
        image_prompt: { primary: 'deepseek', backup: ['tongyi'] },
        fact_extract: { primary: 'deepseek', backup: ['tongyi'] },
        geo_brief: { primary: 'deepseek', backup: ['tongyi'] },
        geo_write: { primary: 'deepseek', backup: ['tongyi'] },
        geo_rewrite: { primary: 'deepseek', backup: ['tongyi'] },
      },
    };
    const llm = new LlmService(
      new LlmRouter(
        route,
        { deepseek: makeProv('deepseek'), tongyi: makeProv('tongyi') },
        { maxRetries: 0, timeoutMs: 5_000, retryDelayMs: 0 },
      ),
    );
    const collector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm },
    );

    const res = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'tongyi',
      promptText: 'Switch外接ARZOPA便携屏怎么样',
      brandName: 'ARZOPA',
    });

    expect(calledProviders).toEqual(['tongyi']);
    expect(res.rawMeta?.provider).toBe('tongyi');
    expect(res.answerText).toContain('tongyi');
  });

  it('parses fenced JSON collector output and normalizes citations & fanOutQueries', async () => {
    const llm = createScriptedLlm(
      [
        '```json',
        JSON.stringify({
          answerText: '综合评测来看，GeoMix 在多模型可见性监测领域表现稳定，部署快速。',
          citations: [
            {
              url: 'https://docs.geomix.cn/overview',
              title: 'GeoMix 官方文档',
              snippet: '企业级 AI 可见度追踪说明',
            },
            {
              url: 'javascript:alert(1)',
              title: 'bad scheme should be dropped',
            },
          ],
          fanOutQueries: ['企业GEO工具推荐', '  企业geo工具推荐  ', '如何提升DeepSeek品牌提及率'],
        }),
        '```',
      ].join('\n'),
    );

    const collector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm },
    );

    const result = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '企业GEO工具推荐',
      brandName: 'GeoMix',
    });

    expect(result.collectorKind).toBe('llm_api');
    expect(result.answerText).toContain('GeoMix');
    expect(result.citations).toEqual([
      {
        url: 'https://docs.geomix.cn/overview',
        title: 'GeoMix 官方文档',
        snippet: '企业级 AI 可见度追踪说明',
        position: 1,
      },
    ]);
    expect(result.fanOutQueries).toEqual(['如何提升DeepSeek品牌提及率']);
  });

  it('falls back cleanly when LLM returns plain text instead of JSON', async () => {
    const llm = createScriptedLlm(
      '在内容营销场景下，GeoMix 提供了完整的关键词蒸馏与监测能力，详见 https://geomix.cn/guide 。',
    );
    const collector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm },
    );

    const result = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'doubao',
      promptText: '内容营销工具对比',
      brandName: 'GeoMix',
    });

    expect(result.answerText).toContain('GeoMix 提供了完整的关键词蒸馏');
    expect(result.citations).toEqual([{ url: 'https://geomix.cn/guide', position: 1 }]);
    expect(result.rawMeta?.fallbackPlainText).toBe(true);
  });
});

describe('VisibilityCollectorService - remote_scraper SSRF & contract guards', () => {
  const publicResolver: DnsResolver = {
    async resolve() {
      return [{ address: '192.0.2.10', family: 4 }];
    },
  };

  it('blocks loopback, metadata, private IPs, non-80/443 ports, and missing URL before transport', async () => {
    let transportCalls = 0;
    const forbiddenTransport: HttpTransport = async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    };

    const blockedUrls = [
      '',
      'http://127.0.0.1/collect',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/internal',
      'https://scraper.example.com:8080/collect',
      'ftp://scraper.example.com/collect',
    ];

    for (const badUrl of blockedUrls) {
      const collector = VisibilityCollectorService.fromEnv(
        {
          VISIBILITY_COLLECTOR: 'remote_scraper',
          VISIBILITY_REMOTE_URL: badUrl,
        },
        { resolver: publicResolver, transport: forbiddenTransport },
      );

      await expect(
        collector.collect({
          tenantId: 'tenant_demo',
          engine: 'deepseek',
          promptText: '测试问题',
          brandName: 'GeoMix',
        }),
      ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });
    }

    expect(transportCalls).toBe(0);
  });

  it('blocks DNS resolving to private IP (10.0.0.1 / 169.254.169.254) before transport', async () => {
    let transportCalls = 0;
    const privateDnsResolver: DnsResolver = {
      async resolve() {
        return [{ address: '10.0.0.1', family: 4 }];
      },
    };
    const transport: HttpTransport = async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    };

    const collector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://rebind.example.com/collect',
      },
      { resolver: privateDnsResolver, transport },
    );

    await expect(
      collector.collect({
        tenantId: 'tenant_demo',
        engine: 'kimi',
        promptText: '测试DNS重绑定拦截',
        brandName: 'GeoMix',
      }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    expect(transportCalls).toBe(0);
  });

  it('refuses 302 redirect responses without following to internal hosts', async () => {
    let transportCalls = 0;
    const redirectTransport: HttpTransport = async () => {
      transportCalls += 1;
      return {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        body: Buffer.alloc(0),
      };
    };

    const collector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/collect',
      },
      { resolver: publicResolver, transport: redirectTransport },
    );

    await expect(
      collector.collect({
        tenantId: 'tenant_demo',
        engine: 'yuanbao',
        promptText: '测试302重定向拦截',
        brandName: 'GeoMix',
      }),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.SSRF,
      reason: 'redirect_refused',
    });

    expect(transportCalls).toBe(1);
  });

  it('posts { prompt, engine } with Bearer key and validates standard JSON response', async () => {
    let capturedRequest: TransportRequest | null = null;
    const okTransport: HttpTransport = async (req) => {
      capturedRequest = req;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            answerText: '远端网关返回：GeoMix 在自动化内容运营维度表现优秀。',
            citations: [
              {
                url: 'https://www.geomix.cn/product',
                title: 'GeoMix 产品介绍',
                snippet: '核心能力一览',
              },
            ],
            fanOutQueries: ['GeoMix 功能评测', '测试远端采集'],
            rawMeta: { latencyMs: 412 },
          }),
          'utf8',
        ),
      };
    };

    const collector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
        VISIBILITY_REMOTE_API_KEY: 'rk-test-123',
      },
      { resolver: publicResolver, transport: okTransport },
    );

    const res = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'tongyi',
      promptText: '测试远端采集',
      brandName: 'GeoMix',
    });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.headers.authorization).toBe('Bearer rk-test-123');
    expect(JSON.parse(capturedRequest!.body ?? '{}')).toEqual({
      prompt: '测试远端采集',
      engine: 'tongyi',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      languageCode: 'zh',
    });

    expect(res).toEqual({
      collectorKind: 'remote_scraper',
      answerText: '远端网关返回：GeoMix 在自动化内容运营维度表现优秀。',
      citations: [
        {
          url: 'https://www.geomix.cn/product',
          title: 'GeoMix 产品介绍',
          snippet: '核心能力一览',
          position: 1,
        },
      ],
      fanOutQueries: ['GeoMix 功能评测'],
      rawMeta: { latencyMs: 412 },
    });
  });

  it('allows internal sonargate and SSRF_ALLOWLIST hosts for remote_scraper GEO observation', async () => {
    const privateDnsResolver: DnsResolver = {
      async resolve() {
        return [{ address: '172.18.0.5', family: 4 }];
      },
    };
    const okTransport: HttpTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          answerText: 'sonargate GEO 观测返回正常。',
          citations: [{ url: 'https://www.geomix.cn/geo', title: 'GEO' }],
          fanOutQueries: [],
        }),
        'utf8',
      ),
    });

    const sonarCollector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'http://sonargate:8080/v1/collect',
      },
      { resolver: privateDnsResolver, transport: okTransport },
    );

    const sonarRes = await sonarCollector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '测试 sonargate 观测',
      brandName: 'GeoMix',
    });
    expect(sonarRes.collectorKind).toBe('remote_scraper');
    expect(sonarRes.answerText).toBe('sonargate GEO 观测返回正常。');

    const allowlistCollector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'http://geo-obs.internal:9000/v1/collect',
        SSRF_ALLOWLIST: 'geo-obs.internal:9000',
      },
      { resolver: privateDnsResolver, transport: okTransport },
    );

    const allowlistRes = await allowlistCollector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '测试白名单观测',
      brandName: 'GeoMix',
    });
    expect(allowlistRes.collectorKind).toBe('remote_scraper');
    expect(allowlistRes.answerText).toBe('sonargate GEO 观测返回正常。');
  });

  it('rejects offline knowledge-cutoff answers with zero citations and marks empty-citation samples (#321)', async () => {
    expect(
      detectOfflineKnowledgeCutoff(
        '抱歉，我无法访问互联网，且我的知识截止于 2024 年，无法获取最新信息。',
        [],
      ),
    ).toBe(true);
    expect(
      detectOfflineKnowledgeCutoff('抱歉，我的知识截止于 2024 年，但以下链接可供参考。', [
        { url: 'https://example.com/a' },
      ]),
    ).toBe(false);

    const offlineLlm = createScriptedLlm(
      JSON.stringify({
        answerText: '抱歉，我目前不具备实时联网搜索能力，无法查询该品牌最新口碑。',
        citations: [],
        fanOutQueries: [],
      }),
    );
    const llmCollector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm: offlineLlm },
    );

    await expect(
      llmCollector.collect({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: '美迈通勤平底鞋怎么样',
        brandName: '美迈',
      }),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.UPSTREAM,
      reason: 'offline_no_search',
    });

    const noCiteLlm = createScriptedLlm(
      JSON.stringify({
        answerText: '美迈通勤平底鞋主打轻量化与缓震鞋垫，适合日常通勤步行。',
        citations: [],
        fanOutQueries: ['美迈通勤平底鞋口碑'],
      }),
    );
    const noCiteCollector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm: noCiteLlm },
    );
    const res = await noCiteCollector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '美迈通勤平底鞋怎么样',
      brandName: '美迈',
    });
    expect(res.citations).toEqual([]);
    expect(res.rawMeta?.noCitations).toBe(true);
  });

  it('maps 400 UNSUPPORTED_ENGINE and 501 ENGINE_NOT_CONFIGURED to offline message while keeping 500/502/503/504 as upstream unavailable (#324)', async () => {
    const publicDns: DnsResolver = {
      async resolve() {
        return [{ address: '93.184.216.34', family: 4 }];
      },
    };
    const runCase = async (status: number, body: string) => {
      const collector = VisibilityCollectorService.fromEnv(
        {
          VISIBILITY_COLLECTOR: 'remote_scraper',
          VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
        },
        {
          resolver: publicDns,
          transport: async () => ({
            status,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(body, 'utf8'),
          }),
        },
      );
      return collector.collect({
        tenantId: 'tenant_demo',
        engine: 'yuanbao',
        promptText: '测试引擎未上线文案映射',
        brandName: 'GeoMix',
      });
    };

    // 400 + UNSUPPORTED_ENGINE -> offline/maintenance message
    await expect(
      runCase(400, JSON.stringify({ code: 'UNSUPPORTED_ENGINE', message: 'not supported' })),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.UPSTREAM,
      reason: 'engine_not_available',
      message: '该引擎采集通道暂未上线或维护中',
    });

    // 400 + nested error.code ENGINE_NOT_IMPLEMENTED -> offline/maintenance message
    await expect(
      runCase(400, JSON.stringify({ error: { code: 'ENGINE_NOT_IMPLEMENTED' } })),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.UPSTREAM,
      reason: 'engine_not_available',
      message: '该引擎采集通道暂未上线或维护中',
    });

    // 501 + ENGINE_NOT_CONFIGURED -> offline/maintenance message
    await expect(
      runCase(501, JSON.stringify({ code: 'ENGINE_NOT_CONFIGURED' })),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.UPSTREAM,
      reason: 'engine_not_available',
      message: '该引擎采集通道暂未上线或维护中',
    });

    // 501 with non-JSON body -> still offline/maintenance message
    await expect(runCase(501, 'Not Implemented')).rejects.toMatchObject({
      kind: PROVIDER_KIND.UPSTREAM,
      reason: 'engine_not_available',
      message: '该引擎采集通道暂未上线或维护中',
    });

    // Real 5xx (500 / 502 / 503 / 504) -> upstream unavailable (not "未上线")
    for (const status of [500, 502, 503, 504]) {
      await expect(
        runCase(status, JSON.stringify({ code: 'INTERNAL_ERROR' })),
      ).rejects.toMatchObject({
        kind: PROVIDER_KIND.UPSTREAM,
        reason: 'upstream_5xx',
        message: '远端采集服务暂时不可用',
      });
    }

    // Other 400 without unsupported-engine code -> contract status error
    await expect(runCase(400, JSON.stringify({ code: 'INVALID_PROMPT' }))).rejects.toMatchObject({
      kind: PROVIDER_KIND.CONTRACT,
      reason: 'status',
      message: '远端采集服务返回了异常状态码',
    });
  });

  it('forwards market, locale, region, languageCode to remote_scraper and maps 408 to TIMEOUT', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const okTransport: HttpTransport = async (req) => {
      payloads.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            answerText: 'Top NAS picks include Synology, QNAP, and AcmeNAS.',
            citations: [{ url: 'https://www.reddit.com/r/homelab/1', title: 'Homelab' }],
            fanOutQueries: ['quiet NAS; home NAS power；quiet NAS'],
          }),
          'utf8',
        ),
      };
    };

    const collector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      { resolver: publicResolver, transport: okTransport },
    );

    const globalRes = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'perplexity',
      promptText: '[E2E_GAP] Best quiet 4-bay NAS for home office',
      brandName: 'AcmeNAS',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
    });

    expect(payloads[0]).toEqual({
      prompt: '[E2E_GAP] Best quiet 4-bay NAS for home office',
      engine: 'perplexity',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      languageCode: 'en',
    });
    // Security invariant: [E2E_*] tokens are NEVER intercepted by remote_scraper
    expect(globalRes.collectorKind).toBe('remote_scraper');
    expect(globalRes.answerText).toContain('AcmeNAS');
    expect(globalRes.fanOutQueries).toEqual(['quiet NAS', 'home NAS power']);

    await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: 'Leiser Heim-NAS Vergleich',
      brandName: 'AcmeNAS',
      market: 'GLOBAL',
      locale: 'de-DE',
      region: 'DE',
    });
    expect(payloads[1]).toMatchObject({
      market: 'GLOBAL',
      locale: 'de-DE',
      region: 'DE',
      languageCode: 'de',
    });

    const timeoutCollector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      {
        resolver: publicResolver,
        transport: async () => ({
          status: 408,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ code: 'TIMEOUT' }), 'utf8'),
        }),
      },
    );

    await expect(
      timeoutCollector.collect({
        tenantId: 'tenant_demo',
        engine: 'doubao',
        promptText: '家用 NAS 推荐',
        brandName: '绿联',
        market: 'CN',
      }),
    ).rejects.toMatchObject({
      kind: PROVIDER_KIND.TIMEOUT,
      reason: 'timeout',
    });
  });

  it('uses English system prompt in llm_api mode for GLOBAL market and ignores [E2E_*] tokens', async () => {
    let capturedSystem = '';
    const mockLlm = {
      complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
        capturedSystem = input.messages.find((m) => m.role === 'system')?.content ?? '';
        return {
          provider: 'openai',
          model: 'gpt-4o-mini',
          fake: false,
          tokensIn: 100,
          tokensOut: 120,
          text: JSON.stringify({
            answerText: 'Top picks for home NAS include AcmeNAS and Synology.',
            citations: [{ url: 'https://www.techradar.com/reviews/nas', title: 'TechRadar' }],
            fanOutQueries: ['best home NAS 2026'],
          }),
        };
      },
    } as unknown as LlmService;

    const collector = VisibilityCollectorService.fromEnv(
      { VISIBILITY_COLLECTOR: 'llm_api' },
      { llm: mockLlm },
    );

    const res = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: '[E2E_ECHO_TRAP] Best home NAS 2026',
      brandName: 'AcmeNAS',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
    });

    expect(capturedSystem).toContain('en-US');
    expect(capturedSystem).toContain('region: US');
    expect(res.collectorKind).toBe('llm_api');
    expect(res.answerText).toContain('AcmeNAS');
  });

  it('emits market-aware GLOBAL answers and deterministic [E2E_*] / RETEST scenarios exclusively in fake mode', async () => {
    const collector = VisibilityCollectorService.fromEnv({ VISIBILITY_COLLECTOR: 'fake' });
    const baseInput = {
      tenantId: 'tenant_demo',
      brandName: '极光NAS',
      ownedDomains: ['jiguangnas.cn'],
      competitors: [
        { name: '群晖', domains: ['synology.com'] },
        { name: '极空间', domains: ['zspace.cn'] },
        { name: '威联通', domains: ['qnap.com'] },
      ],
    };

    const globalDefault = await collector.collect({
      ...baseInput,
      brandName: 'AcmeNAS',
      ownedDomains: ['acmenas.com'],
      engine: 'perplexity',
      promptText: 'Best quiet 4-bay NAS for home office',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
    });
    expect(globalDefault.rawMeta?.market).toBe('GLOBAL');
    expect(globalDefault.rawMeta?.languageCode).toBe('en');
    expect(/[a-zA-Z]{5,}/.test(globalDefault.answerText)).toBe(true);

    const gapRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_GAP] 家用静音四盘位NAS推荐',
      market: 'CN',
    });
    expect(gapRes.answerText).not.toContain('极光NAS');
    expect(gapRes.answerText).toContain('群晖');
    expect(gapRes.answerText).toContain('极空间');
    expect(gapRes.citations.some((c) => c.url.includes('jiguangnas.cn'))).toBe(false);

    const retestRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_GAP] 家用静音四盘位NAS推荐',
      market: 'CN',
      triggerType: 'RETEST',
    });
    expect(retestRes.rawMeta?.scenario).toBe('retest');
    expect(retestRes.answerText).toContain('1. 极光NAS');
    expect(retestRes.citations[0]?.url).toContain('jiguangnas.cn');

    const negRes = await collector.collect({
      ...baseInput,
      engine: 'doubao',
      promptText: '[E2E_NEGATIVE] 家用静音NAS评价',
      market: 'CN',
    });
    expect(negRes.answerText).toContain('极光NAS');
    expect(negRes.answerText).toContain('缺陷');

    const lowRankRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_LOW_RANK] 四盘位NAS推荐',
      market: 'CN',
    });
    expect(lowRankRes.answerText).toContain('4. 极光NAS');

    const echoTrapRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_ECHO_TRAP] 极光NAS 家用静音表现如何',
      market: 'CN',
    });
    expect(echoTrapRes.answerText).toContain('1. 群晖');
    expect(echoTrapRes.answerText).toContain('3. 极光NAS');

    const echoOnlyRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_ECHO_ONLY] 极光NAS 家用推荐',
      market: 'CN',
    });
    expect(echoOnlyRes.citations.some((c) => c.url.includes('jiguangnas.cn'))).toBe(false);

    const fanOutRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_FANOUT_SEMI] 静音NAS推荐',
      market: 'CN',
    });
    expect(fanOutRes.fanOutQueries).toEqual(['安静NAS', '家用NAS功耗', '四盘位NAS', '静音NAS对比']);

    const noCiteRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_NO_CITATIONS] 家用NAS选购',
      market: 'CN',
    });
    expect(noCiteRes.citations).toEqual([]);
    expect(noCiteRes.rawMeta?.noCitations).toBe(true);

    const compDomRes = await collector.collect({
      ...baseInput,
      engine: 'deepseek',
      promptText: '[E2E_COMP_DOMAIN] 家用NAS横评',
      market: 'CN',
    });
    const urls = compDomRes.citations.map((c) => c.url);
    expect(urls.some((u) => u.includes('synology.com'))).toBe(true);
    expect(urls.some((u) => u.includes('http://public.e2e.example/competitor/nas-review'))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes('m.weibo.cn'))).toBe(true);
    expect(urls.some((u) => u.includes('post.smzdm.com'))).toBe(true);
    expect(urls.some((u) => u.includes('xiaohongshu.com'))).toBe(true);
    expect(urls.some((u) => u.includes('item.jd.com'))).toBe(true);
  });

  it('guarantees RETEST overrides gap/negative/low-rank in both CN and GLOBAL fake mode without leaking into real remote_scraper/llm_api', async () => {
    const fakeCollector = VisibilityCollectorService.fromEnv({ VISIBILITY_COLLECTOR: 'fake' });
    const triggers = ['[E2E_GAP]', '[E2E_NEGATIVE]', '[E2E_LOW_RANK]'];

    for (const token of triggers) {
      const cnRetest = await fakeCollector.collect({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: `${token} 家用静音四盘位NAS推荐`,
        brandName: '极光NAS',
        ownedDomains: ['jiguangnas.cn'],
        competitors: [{ name: '群晖', domains: ['synology.com'] }],
        market: 'CN',
        triggerType: 'RETEST',
      });
      expect(cnRetest.rawMeta?.scenario).toBe('retest');
      expect(cnRetest.answerText).toContain('1. 极光NAS');
      expect(cnRetest.citations.some((c) => c.url.includes('jiguangnas.cn'))).toBe(true);

      const globalRetest = await fakeCollector.collect({
        tenantId: 'tenant_demo',
        engine: 'perplexity',
        promptText: `${token} Best quiet 4-bay NAS 2026`,
        brandName: 'AuroraNAS',
        ownedDomains: ['auroranas.example.com'],
        competitors: [{ name: 'Synology', domains: ['synology.com'] }],
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        triggerType: 'RETEST',
      });
      expect(globalRetest.rawMeta?.scenario).toBe('retest');
      expect(globalRetest.answerText).toContain('1. AuroraNAS');
      expect(globalRetest.citations.some((c) => c.url.includes('auroranas.example.com'))).toBe(
        true,
      );
    }

    // Security invariant: remote_scraper NEVER includes triggerType or alters real requests
    const capturedBodies: Array<Record<string, unknown>> = [];
    const remoteCollector = VisibilityCollectorService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      {
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
        transport: async (req) => {
          capturedBodies.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(
              JSON.stringify({
                answerText: 'Remote answer without fake override.',
                citations: [],
                fanOutQueries: [],
              }),
              'utf8',
            ),
          };
        },
      },
    );

    const remoteRes = await remoteCollector.collect({
      tenantId: 'tenant_demo',
      engine: 'perplexity',
      promptText: '[E2E_GAP] Best 4-bay NAS',
      brandName: 'AuroraNAS',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      triggerType: 'RETEST',
    });
    expect(remoteRes.collectorKind).toBe('remote_scraper');
    expect(remoteRes.answerText).toBe('Remote answer without fake override.');
    expect(capturedBodies[0]).not.toHaveProperty('triggerType');
  });

  it('emits deterministic rawMeta retrieval signals for CN/deepseek & GLOBAL chatgpt/claude while omitting them for perplexity/gemini/google_aio', async () => {
    const fakeCollector = VisibilityCollectorService.fromEnv({ VISIBILITY_COLLECTOR: 'fake' });

    const cnInput = {
      tenantId: 'tenant_nm',
      engine: 'deepseek',
      promptText: '2026 四盘位静音家用 NAS 推荐',
      brandName: '极光NAS',
      ownedDomains: ['jiguangnas.cn'],
      competitors: [{ name: '群晖', domains: ['synology.com'] }],
      market: 'CN' as const,
    };
    const cnFirst = await fakeCollector.collect(cnInput);
    const cnSecond = await fakeCollector.collect(cnInput);
    expect(cnSecond).toEqual(cnFirst);
    expect(cnFirst.rawMeta?.provider).toBe('fake');
    expect(typeof cnFirst.rawMeta?.latencyMs).toBe('number');
    expect(cnFirst.rawMeta?.serverToolSearchCount).toBe(2);
    expect(cnFirst.rawMeta?.serverToolFetchCount).toBe(2);
    expect(Array.isArray(cnFirst.rawMeta?.retrievedSources)).toBe(true);
    expect(Array.isArray(cnFirst.rawMeta?.openedPages)).toBe(true);
    const cnSources = cnFirst.rawMeta?.retrievedSources as Array<{ url: string; opened?: boolean }>;
    const cnOpened = cnFirst.rawMeta?.openedPages as string[];
    expect(cnSources.some((s) => s.url.includes('jiguangnas.cn/near-miss/opened-'))).toBe(true);
    expect(cnSources.some((s) => s.url.includes('jiguangnas.cn/near-miss/retrieved-'))).toBe(true);
    expect(cnOpened.some((u) => u.includes('zhuanlan.zhihu.com/p/nm-'))).toBe(true);

    const chatgptRes = await fakeCollector.collect({
      ...cnInput,
      engine: 'chatgpt',
      promptText: 'Best quiet 4-bay NAS 2026',
      brandName: 'AuroraNAS',
      ownedDomains: ['auroranas.example.com'],
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
    });
    expect(Array.isArray(chatgptRes.rawMeta?.retrievedSources)).toBe(true);
    expect(Array.isArray(chatgptRes.rawMeta?.openedPages)).toBe(true);

    for (const fallbackEngine of ['perplexity', 'gemini', 'google_aio'] as const) {
      const res = await fakeCollector.collect({
        ...cnInput,
        engine: fallbackEngine,
        promptText: 'Best quiet 4-bay NAS 2026',
        brandName: 'AuroraNAS',
        ownedDomains: ['auroranas.example.com'],
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
      });
      expect(res.rawMeta?.provider).toBe('fake');
      expect(typeof res.rawMeta?.latencyMs).toBe('number');
      expect(res.rawMeta?.retrievedSources).toBeUndefined();
      expect(res.rawMeta?.openedPages).toBeUndefined();
      if (fallbackEngine === 'google_aio') {
        expect(res.rawMeta?.aiOverviewTriggered).toBe(true);
      }
    }
  });
});
