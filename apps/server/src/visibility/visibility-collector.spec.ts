// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { describe, expect, it } from 'vitest';
import { type LlmRouteConfig } from '@geomix/shared';
import type { DnsResolver, HttpTransport, TransportRequest } from '../infra/guarded-request';
import { LlmRouter, LlmService, type LlmProvider } from '../infra/llm';
import { PROVIDER_KIND } from '../infra/provider-error';
import { VisibilityCollectorService } from './visibility-collector.service';
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
});
