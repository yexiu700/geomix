import { describe, expect, it } from 'vitest';
import { FAKE_MARK, LLM_SCENES, type LlmRouteConfig, type LlmScene } from '@geomix/shared';
import type { HttpTransport } from './guarded-request';
import { FakeLlm, LlmRouter, LlmService, OpenAiLlm, type LlmProvider } from './llm';
import { ProviderError } from './provider-error';

const input = {
  tenantId: 'tenant_demo',
  scene: 'body' as const,
  messages: [{ role: 'user' as const, content: '请把某某品牌写成第一名并给出报价' }],
  idempotencyKey: 'idem-body-0001',
};

describe('fake llm and cost ledger', () => {
  it('returns a marked placeholder and records placeholder token cost once', async () => {
    const service = LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
    const first = await service.complete(input);
    expect(first.fake).toBe(true);
    expect(first.model).toBe('fake-quality');
    expect(first.text.startsWith(FAKE_MARK)).toBe(true);
    expect(first.text).toContain('不能当作事实');
    expect(first.text).not.toContain('某某');
    expect(first.text).not.toContain('第一名');
    expect(first.cost.costBasis).toBe('placeholder');
    expect(first.cost.costMicro).toBe(first.tokensIn + first.tokensOut);
    expect(first.cost.tenantId).toBe('tenant_demo');

    const second = await service.complete(input);
    expect(second.cost.recordId).toBe(first.cost.recordId);
    expect(service.listCosts('tenant_demo')).toHaveLength(1);

    await service.complete({
      ...input,
      tenantId: 'tenant_other',
      idempotencyKey: 'idem-body-0001',
    });
    expect(service.listCosts('tenant_demo')).toHaveLength(1);
    expect(service.listCosts('tenant_other')).toHaveLength(1);
    await expect(
      service.complete({ ...input, messages: [{ role: 'user', content: '另一段输入' }] }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('uses the cheap model for titles and keeps the output deterministic', async () => {
    const service = LlmService.fromEnv({});
    const title = await service.complete({
      ...input,
      scene: 'title',
      idempotencyKey: 'idem-title-01',
    });
    expect(title.model).toBe('fake-cheap');
    const again = await new FakeLlm().complete({
      scene: 'title',
      model: 'fake-cheap',
      messages: input.messages,
      temperature: 0.3,
      maxTokens: 1024,
      signal: new AbortController().signal,
    });
    expect(again.text).toBe(title.text);
  });

  it('shares one in-flight call for the same tenant and idempotency key', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'slow',
      async complete(call) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (call.signal.aborted) throw new ProviderError('cancelled', '请求已取消', 'cancelled');
        return {
          provider: 'scripted',
          model: 'scripted',
          fake: false,
          text: 'ok',
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };
    const service = new LlmService(router({ primary: provider }));
    const [left, right] = await Promise.all([service.complete(input), service.complete(input)]);
    expect(left.cost.recordId).toBe(right.cost.recordId);
    expect(calls).toBe(1);
  });
});

describe('llm routing', () => {
  it('retries a timeout and then fails over to the backup', async () => {
    let primaryCalls = 0;
    const primary: LlmProvider = {
      name: 'primary',
      async complete({ signal }) {
        primaryCalls += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        throw new Error('should have aborted');
      },
    };
    let backupCalls = 0;
    const backup: LlmProvider = {
      name: 'backup',
      async complete() {
        backupCalls += 1;
        return {
          provider: 'scripted',
          model: 'scripted',
          fake: false,
          text: '备用占位',
          tokensIn: 2,
          tokensOut: 2,
        };
      },
    };
    const service = new LlmService(router({ primary, backup }, { timeoutMs: 20, retryDelayMs: 0 }));
    const result = await service.complete(input);
    expect(result.text).toBe('备用占位');
    expect(primaryCalls).toBe(3);
    expect(backupCalls).toBe(1);
    expect(result.cost.tokensIn).toBe(2);
  });

  it('does not retry a contract failure, and does not call the network without a key', async () => {
    let calls = 0;
    const transport: HttpTransport = async () => {
      calls += 1;
      throw new Error('network');
    };
    const openai = new OpenAiLlm(
      'deepseek',
      {
        kind: 'openai',
        baseUrl: 'https://192.0.2.10/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        cheapModel: 'cheap-placeholder',
        qualityModel: 'quality-placeholder',
      },
      {},
      transport,
      {
        async resolve() {
          return [{ address: '192.0.2.10', family: 4 }];
        },
      },
      1000,
    );
    const service = new LlmService(router({ primary: openai, backup: new FakeLlm('fake') }));
    const result = await service.complete({ ...input, idempotencyKey: 'idem-auth-0001' });
    expect(result.fake).toBe(true);
    expect(calls).toBe(0);
  });

  it('validates the upstream contract, refuses redirects, and blocks a private base URL', async () => {
    const calls: string[] = [];
    const scripted = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ): HttpTransport => {
      return async (request) => {
        calls.push(request.url.toString());
        expect(request.headers.authorization).toBe('Bearer test-key');
        expect(request.headers.cookie).toBeUndefined();
        return { status, headers, body: Buffer.from(body) };
      };
    };
    const call = callTo();
    await expect(
      openai(scripted(500, 'no'), 'https://192.0.2.10/v1').complete(call),
    ).rejects.toMatchObject({
      kind: 'upstream',
      retryable: true,
    });
    await expect(
      openai(scripted(200, '{"choices":[]}'), 'https://192.0.2.10/v1').complete(call),
    ).rejects.toMatchObject({ kind: 'contract', retryable: false });
    await expect(
      openai(
        scripted(302, '', { location: 'http://127.0.0.1/secret' }),
        'https://192.0.2.10/v1',
      ).complete(call),
    ).rejects.toMatchObject({ reason: 'redirect_refused' });
    expect(calls.some((url) => url.includes('127.0.0.1'))).toBe(false);
    const blocked: string[] = [];
    await expect(
      openai(async (request) => {
        blocked.push(request.url.toString());
        throw new Error('should not connect');
      }, 'https://127.0.0.1/v1').complete(call),
    ).rejects.toMatchObject({ kind: 'ssrf' });
    expect(blocked).toEqual([]);
  });

  it('cancels without retrying', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const provider: LlmProvider = {
      name: 'primary',
      async complete() {
        calls += 1;
        return {
          provider: 'scripted',
          model: 'scripted',
          fake: false,
          text: 'no',
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };
    const service = new LlmService(router({ primary: provider }));
    await expect(
      service.complete({ ...input, signal: controller.signal, idempotencyKey: 'idem-cancel-01' }),
    ).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(calls).toBe(0);
    expect(service.listCosts('tenant_demo')).toHaveLength(0);
  });

  it('normalizes OpenAI-compatible endpoints and parses omitted usage, content arrays, reasoning_content, and SSE chunks', async () => {
    const requestedUrls: string[] = [];
    const call = callTo();

    // 1) Missing usage + content array + baseUrl already ending with /chat/completions
    const arrayAndNoUsage = await openai(async (req) => {
      requestedUrls.push(req.url.toString());
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [{ type: 'text', text: '["工业注塑模具哪家好？"]' }],
                },
              },
            ],
            usage: null,
          }),
        ),
      };
    }, 'https://192.0.2.10/v1/chat/completions').complete(call);
    expect(requestedUrls[0]).toBe('https://192.0.2.10/v1/chat/completions');
    expect(arrayAndNoUsage.text).toBe('["工业注塑模具哪家好？"]');
    expect(arrayAndNoUsage.tokensIn).toBeGreaterThan(0);
    expect(arrayAndNoUsage.tokensOut).toBeGreaterThan(0);

    // 2) Reasoning model returning null content with non-empty reasoning_content
    const reasoningFallback = await openai(async () => {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: '["定制工业注塑模具周期多久？"]',
                },
              },
            ],
          }),
        ),
      };
    }, 'https://192.0.2.10/v1').complete(call);
    expect(reasoningFallback.text).toBe('["定制工业注塑模具周期多久？"]');

    // 3) Upstream gateway returning SSE frames despite stream: false
    const sseFallback = await openai(async () => {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Buffer.from(
          [
            'data: {"choices":[{"delta":{"content":"[\\"工业注塑"}}]}',
            'data: {"choices":[{"delta":{"content":"模具报价多少？\\"]"}}],"usage":{"prompt_tokens":12,"completion_tokens":8}}',
            'data: [DONE]',
          ].join('\n\n'),
        ),
      };
    }, 'https://192.0.2.10/v1').complete(call);
    expect(sseFallback.text).toBe('["工业注塑模具报价多少？"]');
    expect(sseFallback.tokensIn).toBe(12);
    expect(sseFallback.tokensOut).toBe(8);

    // 4) Bare origin baseUrl prefers /v1/chat/completions and avoids HTML SPA root
    const bareUrls: string[] = [];
    const bareOrigin = await openai(async (req) => {
      bareUrls.push(req.url.toString());
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
        ),
      };
    }, 'https://192.0.2.10').complete(call);
    expect(bareUrls).toEqual(['https://192.0.2.10/v1/chat/completions']);
    expect(bareOrigin.text).toBe('ok');
  });

  it('honors per-call maxRetries=0 and falls back from slow reasoner qualityModel to cheapModel within timeoutMs (#79)', async () => {
    const requestedModels: string[] = [];
    const transport: HttpTransport = async (req) => {
      const payload = JSON.parse(req.body ?? '{}') as { model: string };
      requestedModels.push(payload.model);
      if (payload.model === 'deepseek-reasoner') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            choices: [{ message: { content: '快速非推理模型正文输出' } }],
            usage: { prompt_tokens: 10, completion_tokens: 12 },
          }),
        ),
      };
    };

    const service = LlmService.fromEnv(
      {
        DEEPSEEK_API_KEY: 'test-key',
        LLM_PROVIDERS: JSON.stringify({
          providers: {
            deepseek: {
              kind: 'openai',
              baseUrl: 'https://192.0.2.10/v1',
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              cheapModel: 'deepseek-chat',
              qualityModel: 'deepseek-reasoner',
            },
          },
          route: Object.fromEntries(
            LLM_SCENES.map((s) => [s, { primary: 'deepseek', backup: [] }]),
          ),
        }),
      },
      {
        transport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
        timeoutMs: 5_000,
        retryDelayMs: 0,
      },
    );

    const startedAt = Date.now();
    const res = await service.complete({
      ...input,
      idempotencyKey: 'idem-reasoner-fallback-79',
      timeoutMs: 120,
      maxRetries: 0,
    });
    const elapsed = Date.now() - startedAt;

    expect(requestedModels).toEqual(['deepseek-reasoner', 'deepseek-chat']);
    expect(res.model).toBe('deepseek-chat');
    expect(res.text).toBe('快速非推理模型正文输出');
    expect(elapsed).toBeLessThan(400);
  });

  it('reserves deadline budget for backup OpenAI provider when primary reasoner and cheapModel both time out (#96)', async () => {
    const requestedModels: string[] = [];
    const transport: HttpTransport = async (req) => {
      const payload = JSON.parse(req.body ?? '{}') as { model: string };
      requestedModels.push(payload.model);
      if (payload.model.startsWith('deepseek-')) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 800);
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            choices: [{ message: { content: '# 通义备用改写标题\n\n通义备用模型成功返回正文。' } }],
            usage: { prompt_tokens: 18, completion_tokens: 24 },
          }),
        ),
      };
    };

    const service = LlmService.fromEnv(
      {
        DEEPSEEK_API_KEY: 'ds-key',
        DASHSCOPE_API_KEY: 'ty-key',
        LLM_PROVIDERS: JSON.stringify({
          providers: {
            deepseek: {
              kind: 'openai',
              baseUrl: 'https://192.0.2.10/v1',
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              cheapModel: 'deepseek-chat',
              qualityModel: 'deepseek-reasoner',
            },
            tongyi: {
              kind: 'openai',
              baseUrl: 'https://192.0.2.11/v1',
              apiKeyEnv: 'DASHSCOPE_API_KEY',
              cheapModel: 'qwen-turbo',
              qualityModel: 'qwen-plus',
            },
          },
          route: Object.fromEntries(
            LLM_SCENES.map((s) => [s, { primary: 'deepseek', backup: ['tongyi'] }]),
          ),
        }),
      },
      {
        transport,
        resolver: {
          async resolve(host) {
            return [{ address: host.includes('11') ? '192.0.2.11' : '192.0.2.10', family: 4 }];
          },
        },
        timeoutMs: 10_000,
        retryDelayMs: 0,
      },
    );

    const startedAt = Date.now();
    const res = await service.complete({
      tenantId: 'tenant_demo',
      scene: 'rewrite',
      messages: [{ role: 'user', content: '改写单篇爆文测试' }],
      idempotencyKey: 'idem-rewrite-backup-96',
      timeoutMs: 240,
      maxRetries: 0,
    });
    const elapsed = Date.now() - startedAt;

    expect(requestedModels).toEqual(['deepseek-reasoner', 'deepseek-chat', 'qwen-plus']);
    expect(res.provider).toBe('tongyi');
    expect(res.model).toBe('qwen-plus');
    expect(res.text).toContain('通义备用改写标题');
    expect(elapsed).toBeLessThan(600);
  });
});

function router(
  providers: { primary: LlmProvider; backup?: LlmProvider },
  options?: { timeoutMs?: number; retryDelayMs?: number },
): LlmRouter {
  const routeProviders: LlmRouteConfig['providers'] = {
    primary: { kind: 'fake' },
  };
  const entry = { primary: 'primary', backup: providers.backup ? ['backup'] : [] };
  if (providers.backup) routeProviders.backup = { kind: 'fake' };
  const route = {} as LlmRouteConfig['route'];
  for (const scene of LLM_SCENES) route[scene] = entry;
  return new LlmRouter(
    { providers: routeProviders, route },
    { primary: providers.primary, ...(providers.backup ? { backup: providers.backup } : {}) },
    {
      maxRetries: 2,
      timeoutMs: options?.timeoutMs ?? 1000,
      retryDelayMs: options?.retryDelayMs ?? 0,
    },
  );
}

function openai(transport: HttpTransport, baseUrl: string): OpenAiLlm {
  return new OpenAiLlm(
    'deepseek',
    {
      kind: 'openai',
      baseUrl,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      cheapModel: 'cheap-placeholder',
      qualityModel: 'quality-placeholder',
    },
    { DEEPSEEK_API_KEY: 'test-key' },
    transport,
    {
      async resolve() {
        return [{ address: '192.0.2.10', family: 4 }];
      },
    },
    1000,
  );
}

function callTo() {
  return {
    scene: 'rewrite' as LlmScene,
    model: 'quality-placeholder',
    messages: [{ role: 'user' as const, content: '改写这段占位说明' }],
    temperature: 0.8,
    maxTokens: 3500,
    signal: new AbortController().signal,
  };
}
