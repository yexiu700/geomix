import { createHash, randomUUID } from 'node:crypto';
import {
  FAKE_MARK,
  FAKE_TOKEN_COST_MICRO,
  LLM_MAX_RETRIES,
  LLM_TIMEOUT_MS,
  QUALITY_LLM_SCENES,
  readLlmDocument,
  type LlmProviderConfig,
  type LlmRouteConfig,
  type LlmScene,
} from '@geomix/shared';
import { z } from 'zod';
import {
  createDnsResolver,
  requestOnce,
  type DnsResolver,
  type HttpTransport,
} from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,128}$/;
const QUALITY = new Set<string>(QUALITY_LLM_SCENES);

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmCompletion = {
  provider: string;
  model: string;
  fake: boolean;
  text: string;
  tokensIn: number;
  tokensOut: number;
};

export type LlmCostRecord = {
  recordId: string;
  tenantId: string;
  idempotencyKey: string;
  scene: LlmScene;
  provider: string;
  model: string;
  fake: boolean;
  tokensIn: number;
  tokensOut: number;
  costMicro: number;
  costBasis: 'placeholder';
  latencyMs: number;
  fingerprint: string;
};

export type LlmCallResult = LlmCompletion & { cost: LlmCostRecord };

export type LlmCompleteInput = {
  tenantId: string;
  scene: LlmScene;
  messages: LlmMessage[];
  idempotencyKey: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
};

type ProviderCall = {
  scene: LlmScene;
  model: string;
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
};

export interface LlmProvider {
  readonly name: string;
  complete(input: ProviderCall): Promise<LlmCompletion>;
}

const completionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  fake: z.boolean(),
  text: z.string().min(1).max(100_000),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});

const upstreamSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().min(1) }),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

export class FakeLlm implements LlmProvider {
  constructor(readonly name = 'fake') {}

  async complete(input: ProviderCall): Promise<LlmCompletion> {
    if (input.signal.aborted)
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    const digest = createHash('sha256')
      .update(JSON.stringify({ scene: input.scene, messages: input.messages }))
      .digest('hex')
      .slice(0, 12);
    const text = `${FAKE_MARK}GeoMix 开发占位输出，不能当作事实、报价或品牌结论。场景：${input.scene}。校验：${digest}。`;
    return {
      provider: this.name,
      model: input.model,
      fake: true,
      text,
      tokensIn: countTokens(input.messages.map((message) => message.content).join('\n')),
      tokensOut: countTokens(text),
    };
  }
}

export class OpenAiLlm implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly config: Extract<LlmProviderConfig, { kind: 'openai' }>,
    private readonly env: Record<string, string | undefined>,
    private readonly transport: HttpTransport,
    private readonly resolver: DnsResolver,
    private readonly timeoutMs: number,
  ) {}

  async complete(input: ProviderCall): Promise<LlmCompletion> {
    const apiKey = readKey(this.env, this.config.apiKeyEnv);
    const url = joinUrl(this.config.baseUrl, 'chat/completions');
    const response = await requestOnce({
      url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
      }),
      timeoutMs: this.timeoutMs,
      maxBytes: 2_000_000,
      signal: input.signal,
      resolver: this.resolver,
      transport: this.transport,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_refused');
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(PROVIDER_KIND.AUTH, '外部服务拒绝了密钥', 'upstream_auth');
    }
    if (response.status === 429) {
      throw new ProviderError(PROVIDER_KIND.RATE_LIMIT, '外部服务繁忙', 'rate_limit');
    }
    if (response.status === 408)
      throw new ProviderError(PROVIDER_KIND.TIMEOUT, '外部服务超时', 'timeout');
    if (response.status >= 500) {
      throw new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'upstream_5xx');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'status');
    }
    let json: unknown;
    try {
      json = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'json');
    }
    const parsed = upstreamSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
    }
    const choice = parsed.data.choices[0];
    if (!choice)
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
    return {
      provider: this.name,
      model: input.model,
      fake: false,
      text: choice.message.content,
      tokensIn: parsed.data.usage.prompt_tokens,
      tokensOut: parsed.data.usage.completion_tokens,
    };
  }
}

export class LlmRouter {
  constructor(
    private readonly route: LlmRouteConfig,
    private readonly providers: Record<string, LlmProvider>,
    private readonly options: { maxRetries: number; timeoutMs: number; retryDelayMs: number },
  ) {}

  async complete(
    input: Omit<LlmCompleteInput, 'tenantId' | 'idempotencyKey'>,
  ): Promise<LlmCompletion> {
    const messages = validateMessages(input.messages);
    const temperature = input.temperature ?? (QUALITY.has(input.scene) ? 0.8 : 0.3);
    const maxTokens = input.maxTokens ?? (QUALITY.has(input.scene) ? 3500 : 1024);
    if (temperature < 0 || temperature > 2) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, 'temperature 超出范围', 'temperature');
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, 'maxTokens 超出范围', 'max_tokens');
    }
    const providerConfig = this.route.route[input.scene];
    const chain = [providerConfig.primary, ...providerConfig.backup];
    let last: ProviderError | null = null;
    for (const name of chain) {
      const provider = this.providers[name];
      const config = this.route.providers[name];
      if (!provider || !config) {
        throw new ProviderError(PROVIDER_KIND.CONTRACT, '模型路由未配置', 'route');
      }
      const model =
        config.kind === 'fake'
          ? QUALITY.has(input.scene)
            ? 'fake-quality'
            : 'fake-cheap'
          : QUALITY.has(input.scene)
            ? config.qualityModel
            : config.cheapModel;
      try {
        return await withRetry(
          () =>
            this.call(provider, {
              scene: input.scene,
              model,
              messages,
              temperature,
              maxTokens,
              signal: input.signal,
            }),
          {
            maxRetries: this.options.maxRetries,
            delayMs: this.options.retryDelayMs,
            signal: input.signal,
          },
        );
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.kind === PROVIDER_KIND.CANCELLED) throw error;
        last = error;
      }
    }
    throw last ?? new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'no_provider');
  }

  private async call(
    provider: LlmProvider,
    input: Omit<ProviderCall, 'signal'> & { signal?: AbortSignal },
  ): Promise<LlmCompletion> {
    if (input.signal?.aborted)
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const result = completionSchema.parse(await provider.complete({ ...input, signal }));
      if (result.provider === 'fake' || result.model.startsWith('fake') || result.fake) {
        if (!result.fake || !result.text.startsWith(FAKE_MARK)) {
          throw new ProviderError(PROVIDER_KIND.CONTRACT, '假输出缺少占位标记', 'fake_mark');
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof z.ZodError) {
        throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
      }
      if (input.signal?.aborted)
        throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
      if (signal.aborted) throw new ProviderError(PROVIDER_KIND.TIMEOUT, '外部服务超时', 'timeout');
      throw new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'transport');
    }
  }
}

export class MemoryCostLedger {
  private readonly rows = new Map<string, LlmCostRecord>();

  put(record: LlmCostRecord): LlmCostRecord {
    this.rows.set(`${record.tenantId}::${record.idempotencyKey}`, record);
    return record;
  }

  get(tenantId: string, idempotencyKey: string): LlmCostRecord | undefined {
    return this.rows.get(`${tenantId}::${idempotencyKey}`);
  }

  list(tenantId: string): LlmCostRecord[] {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }
}

/**
 * 调用和 token 成本记录。成本是占位微元，不写钱包，也不受 SHADOW / STRICT 切换影响。
 * 幂等记录只活在当前进程；持久化表留给后续队列，不新增迁移。
 */
export class LlmService {
  private readonly done = new Map<string, { fingerprint: string; result: LlmCallResult }>();
  private readonly inflight = new Map<
    string,
    { fingerprint: string; promise: Promise<LlmCallResult> }
  >();

  constructor(
    private readonly router: LlmRouter,
    private readonly ledger: MemoryCostLedger = new MemoryCostLedger(),
    private readonly now: () => number = Date.now,
  ) {}

  static fromEnv(
    env: Record<string, string | undefined>,
    overrides?: {
      transport?: HttpTransport;
      resolver?: DnsResolver;
      retryDelayMs?: number;
      timeoutMs?: number;
    },
  ): LlmService {
    const route = readLlmDocument(env);
    const timeoutMs = overrides?.timeoutMs ?? positive(env.LLM_TIMEOUT_MS, LLM_TIMEOUT_MS);
    const providers: Record<string, LlmProvider> = {};
    for (const [name, config] of Object.entries(route.providers)) {
      if (config.kind === 'fake') {
        providers[name] = new FakeLlm(name);
        continue;
      }
      providers[name] = new OpenAiLlm(
        name,
        config,
        env,
        overrides?.transport ?? liveTransport(),
        overrides?.resolver ?? createDnsResolver(),
        timeoutMs,
      );
    }
    return new LlmService(
      new LlmRouter(route, providers, {
        maxRetries: LLM_MAX_RETRIES,
        timeoutMs,
        retryDelayMs: overrides?.retryDelayMs ?? 50,
      }),
    );
  }

  async complete(input: LlmCompleteInput): Promise<LlmCallResult> {
    if (!TENANT_ID.test(input.tenantId)) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '租户不正确', 'tenant');
    }
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '幂等键不正确', 'idempotency');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          scene: input.scene,
          messages: input.messages,
          temperature: input.temperature ?? null,
          maxTokens: input.maxTokens ?? null,
        }),
      )
      .digest('hex');
    const cacheKey = `${input.tenantId}::${input.idempotencyKey}`;
    const cached = this.done.get(cacheKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new ProviderError(
          PROVIDER_KIND.CONFLICT,
          '同一个幂等键不能改用不同输入',
          'idempotency',
        );
      }
      return cached.result;
    }
    const pending = this.inflight.get(cacheKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new ProviderError(
          PROVIDER_KIND.CONFLICT,
          '同一个幂等键不能改用不同输入',
          'idempotency',
        );
      }
      return pending.promise;
    }
    const promise = this.run(input, fingerprint);
    this.inflight.set(cacheKey, { fingerprint, promise });
    try {
      const result = await promise;
      this.done.set(cacheKey, { fingerprint, result });
      return result;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  listCosts(tenantId: string): LlmCostRecord[] {
    if (!TENANT_ID.test(tenantId))
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '租户不正确', 'tenant');
    return this.ledger.list(tenantId);
  }

  private async run(input: LlmCompleteInput, fingerprint: string): Promise<LlmCallResult> {
    const started = this.now();
    const completion = await this.router.complete(input);
    const record: LlmCostRecord = {
      recordId: randomUUID(),
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      scene: input.scene,
      provider: completion.provider,
      model: completion.model,
      fake: completion.fake,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      costMicro: (completion.tokensIn + completion.tokensOut) * FAKE_TOKEN_COST_MICRO,
      costBasis: 'placeholder',
      latencyMs: Math.max(0, this.now() - started),
      fingerprint,
    };
    this.ledger.put(record);
    return { ...completion, cost: record };
  }
}

function liveTransport(): HttpTransport {
  return async (request) => {
    const { createUndiciTransport } = await import('./undici-transport');
    return createUndiciTransport()(request);
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; delayMs: number; signal?: AbortSignal },
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!(error instanceof ProviderError) || !error.retryable || attempt === options.maxRetries)
        throw error;
      if (options.signal?.aborted)
        throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
      if (options.delayMs > 0) await delay(options.delayMs * 2 ** attempt, options.signal);
    }
  }
  throw last;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled'));
      },
      { once: true },
    );
  });
}

function validateMessages(messages: LlmMessage[]): LlmMessage[] {
  if (messages.length < 1 || messages.length > 40) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '消息不能为空', 'messages');
  }
  let chars = 0;
  for (const message of messages) {
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '消息角色不正确', 'role');
    }
    if (
      typeof message.content !== 'string' ||
      message.content.trim() === '' ||
      message.content.length > 20_000
    ) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '消息内容不正确', 'content');
    }
    chars += message.content.length;
  }
  if (chars > 60_000) throw new ProviderError(PROVIDER_KIND.CONTRACT, '消息过长', 'content');
  if (!messages.some((message) => message.role === 'user')) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '至少需要一条用户消息', 'messages');
  }
  return messages;
}

function countTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function readKey(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (!value) throw new ProviderError(PROVIDER_KIND.AUTH, `缺少密钥 ${name}`, 'missing_key');
  return value;
}

function joinUrl(base: string, path: string): URL {
  const root = base.endsWith('/') ? base : `${base}/`;
  return new URL(path, root);
}

function positive(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
