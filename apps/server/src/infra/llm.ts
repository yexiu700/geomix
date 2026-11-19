import { createHash, randomUUID } from 'node:crypto';
import {
  FAKE_MARK,
  LLM_MAX_RETRIES,
  LLM_TIMEOUT_MS,
  QUALITY_LLM_SCENES,
  estimateLlmCallCostMicro,
  parseLlmCostRates,
  readLlmDocument,
  type LlmCostRateMap,
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
  costBasis: 'placeholder' | 'configured';
  latencyMs: number;
  fingerprint: string;
};

export interface LlmCostSink {
  write(record: LlmCostRecord): Promise<void> | void;
}

export type LlmCallResult = LlmCompletion & { cost: LlmCostRecord };

export type LlmCompleteInput = {
  tenantId: string;
  scene: LlmScene;
  messages: LlmMessage[];
  idempotencyKey: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  preferFastModel?: boolean;
  disableThinking?: boolean;
  preferredProvider?: string;
};

type ProviderCall = {
  scene: LlmScene;
  model: string;
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
  signal: AbortSignal;
  disableThinking?: boolean;
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

const contentPartSchema = z.union([
  z.string(),
  z
    .object({
      text: z.string().optional(),
      content: z.string().optional(),
    })
    .passthrough(),
]);

const choiceSchema = z
  .object({
    text: z.string().nullable().optional(),
    message: z
      .object({
        content: z
          .union([z.string(), z.array(contentPartSchema)])
          .nullable()
          .optional(),
        reasoning_content: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    delta: z
      .object({
        content: z
          .union([z.string(), z.array(contentPartSchema)])
          .nullable()
          .optional(),
        reasoning_content: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const usageSchema = z
  .object({
    prompt_tokens: z.number().nonnegative().nullable().optional(),
    completion_tokens: z.number().nonnegative().nullable().optional(),
    input_tokens: z.number().nonnegative().nullable().optional(),
    output_tokens: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();

const upstreamEnvelopeSchema = z
  .object({
    choices: z.array(choiceSchema).min(1),
    usage: usageSchema.nullable().optional(),
  })
  .passthrough();

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
    const urls = resolveChatCompletionsUrls(this.config.baseUrl);
    const promptText = input.messages.map((message) => message.content).join('\n');
    let lastContractError: ProviderError | null = null;

    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index]!;
      try {
        return await this.requestCompletion(url, apiKey, input, promptText);
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.kind === PROVIDER_KIND.CONTRACT &&
          index + 1 < urls.length
        ) {
          lastContractError = error;
          continue;
        }
        throw error;
      }
    }

    throw (
      lastContractError ??
      new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'status')
    );
  }

  private async requestCompletion(
    url: URL,
    apiKey: string,
    input: ProviderCall,
    promptText: string,
  ): Promise<LlmCompletion> {
    const requestTimeoutMs = input.timeoutMs ?? this.timeoutMs;
    const send = (payload: Record<string, unknown>) =>
      requestOnce({
        url,
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs: requestTimeoutMs,
        maxBytes: 2_000_000,
        signal: input.signal,
        resolver: this.resolver,
        transport: this.transport,
      });

    const isReasoner = /reasoner|thinking|qwq|\br1\b/i.test(input.model);
    const effectiveMaxTokens = isReasoner
      ? Math.max(input.maxTokens, requestTimeoutMs <= 25_000 ? 3000 : 4096)
      : input.maxTokens;
    const basePayload: Record<string, unknown> = {
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      max_tokens: effectiveMaxTokens,
      stream: false,
    };
    const thinkingHint = input.disableThinking
      ? resolveDisableThinkingPayload(this.name, this.config.baseUrl, input.model)
      : undefined;

    let response = await send(thinkingHint ? { ...basePayload, ...thinkingHint } : basePayload);

    if (thinkingHint && (response.status === 400 || response.status === 422)) {
      response = await send(basePayload);
    }

    if (
      (response.status === 400 || response.status === 422) &&
      isUnsupportedParamError(response.body.toString('utf8'))
    ) {
      response = await send({
        model: input.model,
        messages: input.messages,
        stream: false,
      });
    }

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

    const parsed = parseUpstreamCompletion(response.body.toString('utf8'), promptText, {
      allowReasoningFallback: !input.disableThinking,
      stripAllThinking: Boolean(input.disableThinking),
    });
    return {
      provider: this.name,
      model: input.model,
      fake: false,
      text: parsed.text,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
    };
  }
}

export class LlmRouter {
  constructor(
    private readonly route: LlmRouteConfig,
    private readonly providers: Record<string, LlmProvider>,
    private readonly options: { maxRetries: number; timeoutMs: number; retryDelayMs: number },
  ) {}

  usesFakePrimary(scene: LlmScene): boolean {
    const { primary } = this.route.route[scene];
    return this.route.providers[primary]?.kind === 'fake';
  }

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
    const effectiveTimeoutMs = input.timeoutMs ?? this.options.timeoutMs;
    const effectiveMaxRetries = input.maxRetries ?? this.options.maxRetries;
    const deadline = input.timeoutMs !== undefined ? Date.now() + effectiveTimeoutMs : undefined;
    const providerConfig = this.route.route[input.scene];
    const baseChain = [providerConfig.primary, ...providerConfig.backup];
    const preferred = input.preferredProvider?.trim();
    const preferredConfig = preferred ? this.route.providers[preferred] : undefined;
    const chain =
      preferred && preferredConfig && preferredConfig.kind !== 'fake'
        ? [preferred, ...baseChain.filter((name) => name !== preferred)]
        : baseChain;
    let last: ProviderError | null = null;
    for (const name of chain) {
      const provider = this.providers[name];
      const config = this.route.providers[name];
      if (!provider || !config) {
        throw new ProviderError(PROVIDER_KIND.CONTRACT, '模型路由未配置', 'route');
      }
      const primaryModel =
        config.kind === 'fake'
          ? QUALITY.has(input.scene)
            ? 'fake-quality'
            : 'fake-cheap'
          : QUALITY.has(input.scene)
            ? config.qualityModel
            : config.cheapModel;
      const canFallbackToCheap =
        config.kind === 'openai' &&
        QUALITY.has(input.scene) &&
        config.cheapModel !== config.qualityModel &&
        !/reasoner|thinking|qwq|\br1\b/i.test(config.cheapModel) &&
        /reasoner|thinking|qwq|\br1\b/i.test(config.qualityModel);
      const models = canFallbackToCheap
        ? input.preferFastModel
          ? [config.cheapModel]
          : [primaryModel, config.cheapModel]
        : [primaryModel];
      for (let mIdx = 0; mIdx < models.length; mIdx += 1) {
        const model = models[mIdx]!;
        let callTimeoutMs = effectiveTimeoutMs;
        if (deadline !== undefined) {
          if (config.kind === 'fake') {
            callTimeoutMs = Math.max(100, deadline - Date.now());
          } else {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              last = last ?? new ProviderError(PROVIDER_KIND.TIMEOUT, '外部服务超时', 'timeout');
              continue;
            }
            callTimeoutMs =
              models.length > 1 && mIdx === 0
                ? Math.max(1, Math.floor(remainingMs * 0.55))
                : remainingMs;
          }
        }
        try {
          return await withRetry(
            () =>
              this.call(provider, {
                scene: input.scene,
                model,
                messages,
                temperature,
                maxTokens,
                timeoutMs: callTimeoutMs,
                signal: input.signal,
                disableThinking: input.disableThinking,
              }),
            {
              maxRetries: mIdx === 0 ? effectiveMaxRetries : 0,
              delayMs: this.options.retryDelayMs,
              signal: input.signal,
            },
          );
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (error.kind === PROVIDER_KIND.CANCELLED) throw error;
          last = error;
          if (error.kind === PROVIDER_KIND.AUTH || error.kind === PROVIDER_KIND.SSRF) {
            break;
          }
        }
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
    const callTimeoutMs = input.timeoutMs ?? this.options.timeoutMs;
    const timeout = AbortSignal.timeout(callTimeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const result = completionSchema.parse(
        await provider.complete({ ...input, timeoutMs: callTimeoutMs, signal }),
      );
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
    private readonly costSink?: LlmCostSink,
    private readonly rates: LlmCostRateMap = {},
  ) {}

  usesFakePrimary(scene: LlmScene): boolean {
    return this.router.usesFakePrimary(scene);
  }

  static fromEnv(
    env: Record<string, string | undefined>,
    overrides?: {
      transport?: HttpTransport;
      resolver?: DnsResolver;
      retryDelayMs?: number;
      timeoutMs?: number;
      costSink?: LlmCostSink;
    },
  ): LlmService {
    const route = readLlmDocument(env);
    const timeoutMs = overrides?.timeoutMs ?? positive(env.LLM_TIMEOUT_MS, LLM_TIMEOUT_MS);
    const rates = parseLlmCostRates(env.LLM_COST_RATES_JSON);
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
    if (env.LLM_FALLBACK_FAKE?.trim() === 'true') {
      const fallbackName = '__fake_fallback__';
      route.providers[fallbackName] = { kind: 'fake' };
      providers[fallbackName] = new FakeLlm('fake');
      for (const entry of Object.values(route.route)) {
        const hasFake = [entry.primary, ...entry.backup].some(
          (name) => route.providers[name]?.kind === 'fake',
        );
        if (!hasFake) {
          entry.backup = [...entry.backup, fallbackName];
        }
      }
    }
    return new LlmService(
      new LlmRouter(route, providers, {
        maxRetries: LLM_MAX_RETRIES,
        timeoutMs,
        retryDelayMs: overrides?.retryDelayMs ?? 50,
      }),
      new MemoryCostLedger(),
      Date.now,
      overrides?.costSink,
      rates,
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
          ...(input.disableThinking ? { disableThinking: true } : {}),
          ...(input.preferredProvider ? { preferredProvider: input.preferredProvider } : {}),
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
    const estimated = estimateLlmCallCostMicro({
      provider: completion.provider,
      model: completion.model,
      fake: completion.fake,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      rates: this.rates,
    });
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
      costMicro: estimated.costMicro,
      costBasis: estimated.costBasis,
      latencyMs: Math.max(0, this.now() - started),
      fingerprint,
    };
    this.ledger.put(record);
    if (this.costSink) {
      void Promise.resolve(this.costSink.write(record)).catch(() => undefined);
    }
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

function resolveChatCompletionsUrls(base: string): URL[] {
  let parsed: URL;
  try {
    parsed = new URL(base.trim());
  } catch {
    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'invalid_url');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(cleanPath)) {
    parsed.pathname = cleanPath;
    return [parsed];
  }
  if (cleanPath === '') {
    const v1 = new URL(parsed.toString());
    v1.pathname = '/v1/chat/completions';
    const root = new URL(parsed.toString());
    root.pathname = '/chat/completions';
    return [v1, root];
  }
  parsed.pathname = `${cleanPath}/chat/completions`;
  return [parsed];
}

function resolveDisableThinkingPayload(
  providerName: string,
  baseUrl: string,
  model: string,
): Record<string, unknown> {
  const hint = `${providerName} ${baseUrl} ${model}`;
  if (/doubao|seed|ark|volces|glm|zhipu/i.test(hint)) {
    return { thinking: { type: 'disabled' } };
  }
  return { enable_thinking: false };
}

function isUnsupportedParamError(rawBody: string): boolean {
  const lower = rawBody.toLowerCase();
  return (
    (lower.includes('temperature') ||
      lower.includes('max_tokens') ||
      lower.includes('max_completion_tokens')) &&
    (lower.includes('unsupported') ||
      lower.includes('not supported') ||
      lower.includes('invalid') ||
      lower.includes('unknown'))
  );
}

type UpstreamParseOptions = {
  allowReasoningFallback?: boolean;
  stripAllThinking?: boolean;
};

function parseUpstreamCompletion(
  rawBody: string,
  promptText: string,
  options: UpstreamParseOptions = {},
): { text: string; tokensIn: number; tokensOut: number } {
  const trimmed = rawBody.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'json');
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed) as unknown;
  } catch {
    const sse = parseSseCompletion(trimmed, promptText, options);
    if (sse) return sse;
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'json');
  }

  const candidate =
    json &&
    typeof json === 'object' &&
    !('choices' in json) &&
    'data' in json &&
    typeof (json as { data?: unknown }).data === 'object' &&
    (json as { data?: unknown }).data !== null
      ? (json as { data: unknown }).data
      : json;

  const parsed = upstreamEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
  }

  const choice = parsed.data.choices[0];
  if (!choice) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
  }

  const text = extractChoiceText(choice, options);
  if (!text) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
  }

  const usage = parsed.data.usage;
  const tokensIn =
    nonNegativeInt(usage?.prompt_tokens ?? usage?.input_tokens) ?? countTokens(promptText);
  const tokensOut =
    nonNegativeInt(usage?.completion_tokens ?? usage?.output_tokens) ?? countTokens(text);

  return { text, tokensIn, tokensOut };
}

function parseSseCompletion(
  raw: string,
  promptText: string,
  options: UpstreamParseOptions = {},
): { text: string; tokensIn: number; tokensOut: number } | null {
  if (!raw.startsWith('data:') && !raw.includes('\ndata:')) return null;
  const contentChunks: string[] = [];
  const reasoningChunks: string[] = [];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let parsedFrames = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let frame: unknown;
    try {
      frame = JSON.parse(payload) as unknown;
    } catch {
      continue;
    }
    const parsed = upstreamEnvelopeSchema.safeParse(frame);
    if (!parsed.success) continue;
    parsedFrames += 1;
    const choice = parsed.data.choices[0];
    if (choice) {
      const deltaText =
        flattenContent(choice.delta?.content) ||
        flattenContent(choice.message?.content) ||
        (choice.text ?? '');
      if (deltaText) contentChunks.push(deltaText);
      const reasoning = choice.delta?.reasoning_content ?? choice.message?.reasoning_content ?? '';
      if (reasoning) reasoningChunks.push(reasoning);
    }
    if (parsed.data.usage) {
      promptTokens =
        nonNegativeInt(parsed.data.usage.prompt_tokens ?? parsed.data.usage.input_tokens) ??
        promptTokens;
      completionTokens =
        nonNegativeInt(parsed.data.usage.completion_tokens ?? parsed.data.usage.output_tokens) ??
        completionTokens;
    }
  }

  if (parsedFrames === 0) return null;
  const rawCombined =
    contentChunks.join('') ||
    (options.allowReasoningFallback === false ? '' : reasoningChunks.join(''));
  const text = stripThinkingTags(rawCombined.trim(), { stripAll: options.stripAllThinking });
  if (!text) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
  }
  return {
    text,
    tokensIn: promptTokens ?? countTokens(promptText),
    tokensOut: completionTokens ?? countTokens(text),
  };
}

function stripThinkingTags(raw: string, options: { stripAll?: boolean } = {}): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (options.stripAll) {
    const withoutClosed = trimmed
      .replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
      .trim();
    return withoutClosed.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '').trim();
  }
  const stripped = trimmed.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
  return stripped || trimmed;
}

function extractChoiceText(
  choice: z.infer<typeof choiceSchema>,
  options: UpstreamParseOptions = {},
): string {
  const stripOpts = { stripAll: options.stripAllThinking };
  const messageContent = stripThinkingTags(flattenContent(choice.message?.content), stripOpts);
  if (messageContent) return messageContent;
  const deltaContent = stripThinkingTags(flattenContent(choice.delta?.content), stripOpts);
  if (deltaContent) return deltaContent;
  const legacyText = stripThinkingTags(choice.text ?? '', stripOpts);
  if (legacyText) return legacyText;
  if (options.allowReasoningFallback === false) {
    return '';
  }
  const reasoning = stripThinkingTags(
    choice.message?.reasoning_content ?? choice.delta?.reasoning_content ?? '',
    stripOpts,
  );
  return reasoning;
}

function flattenContent(
  content: z.infer<typeof contentPartSchema>[] | string | null | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : (part.text ?? part.content ?? '')))
    .join('');
}

function nonNegativeInt(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function positive(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
