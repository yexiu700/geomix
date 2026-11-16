import { z } from 'zod';

/**
 * 外部适配层的稳定常量（issue #5）。
 * 向量维数必须和已落地的 KnowledgeChunk.embedding vector(1024) 一致，不能在这里改库。
 * token 成本是占位微元，不是厂商报价，也不进入点数钱包。计费默认仍由 BILLING_MODE 决定。
 */

export const DB_EMBEDDING_DIMENSIONS = 1024 as const;

export const LLM_SCENES = ['distill', 'title', 'body', 'rewrite', 'image_prompt'] as const;
export type LlmScene = (typeof LLM_SCENES)[number];

/** 正文和改写走高质量模型。蒸馏、标题、生图提示词走便宜模型。 */
export const QUALITY_LLM_SCENES = ['body', 'rewrite'] as const;

export const FAKE_MARK = '【FAKE】';

/** 每个 token 记 1 微元。这是开发占位，不是任何厂商的价目。 */
export const FAKE_TOKEN_COST_MICRO = 1;

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 3;
export const ROBOTS_CACHE_MS = 60 * 60 * 1000;
export const FETCH_USER_AGENT = 'GeoMixBot/1.0 (GeoMix; public-page)';

export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const IMAGE_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;
export const IMAGE_WARN_WIDTH = 500;
export const IMAGE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const STORAGE_MAX_OBJECT_BYTES = 100 * 1024 * 1024;

export const LLM_MAX_RETRIES = 2;
export const LLM_TIMEOUT_MS = 30_000;
export const EMBEDDING_TIMEOUT_MS = 15_000;
export const EMBEDDING_MAX_BATCH = 32;
export const EMBEDDING_MAX_CHARS = 8_000;

const KEY_ENV = /^[A-Z][A-Z0-9_]{0,63}$/;

const fakeProviderSchema = z
  .object({
    kind: z.literal('fake'),
  })
  .strict();

const openaiProviderSchema = z
  .object({
    kind: z.literal('openai'),
    baseUrl: z.string().min(1).max(300),
    apiKeyEnv: z.string().regex(KEY_ENV),
    cheapModel: z.string().min(1).max(128),
    qualityModel: z.string().min(1).max(128),
  })
  .strict();

const providerSchema = z.discriminatedUnion('kind', [fakeProviderSchema, openaiProviderSchema]);

const routeEntrySchema = z
  .object({
    primary: z.string().min(1).max(64),
    backup: z.array(z.string().min(1).max(64)).max(3).default([]),
  })
  .strict();

export type LlmProviderConfig = z.infer<typeof providerSchema>;

export type LlmRouteConfig = {
  providers: Record<string, LlmProviderConfig>;
  route: Record<LlmScene, { primary: string; backup: string[] }>;
};

function readObject(source: Record<string, string | undefined>, key: string): unknown {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '' || raw.trim() === '{}') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be a JSON object`);
  }
}

function assertHttpsBase(baseUrl: string, label: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${label} baseUrl is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} baseUrl must use https`);
  if (url.username || url.password)
    throw new Error(`${label} baseUrl must not include credentials`);
  if (url.hash) throw new Error(`${label} baseUrl must not include a hash`);
}

function defaultRoute(names: string[]): LlmRouteConfig['route'] {
  const has = (name: string) => names.includes(name);
  const primary = has('deepseek') ? 'deepseek' : has('fake') ? 'fake' : (names[0] ?? 'fake');
  const backup = ['tongyi', 'doubao'].filter((name) => has(name) && name !== primary);
  const entry = { primary, backup };
  return {
    distill: entry,
    title: entry,
    body: entry,
    rewrite: entry,
    image_prompt: entry,
  };
}

/**
 * `{}` 表示全部场景使用假 Provider。
 * 配了 deepseek / tongyi / doubao 且没有 route 时，正文和改写的主模型是 deepseek，备用按通义、豆包的顺序。
 * 厂商 baseUrl 不写死，由配置提供，调用前还会做 SSRF 校验。
 */
export function resolveLlmRoute(document: unknown): LlmRouteConfig {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('LLM_PROVIDERS must be a JSON object');
  }
  const record = document as Record<string, unknown>;
  if (Object.keys(record).length === 0) {
    return {
      providers: { fake: { kind: 'fake' } },
      route: defaultRoute(['fake']),
    };
  }
  const parsed = z
    .object({
      providers: z.record(z.string().min(1).max(64), providerSchema),
      route: z.record(z.enum(LLM_SCENES), routeEntrySchema).optional(),
    })
    .strict()
    .parse(record);

  for (const [name, provider] of Object.entries(parsed.providers)) {
    if (provider.kind === 'openai') assertHttpsBase(provider.baseUrl, name);
  }
  const names = Object.keys(parsed.providers);
  if (names.length === 0) throw new Error('LLM_PROVIDERS needs at least one provider');

  const route = defaultRoute(names);
  if (parsed.route) {
    for (const scene of LLM_SCENES) {
      const entry = parsed.route[scene];
      if (!entry) continue;
      route[scene] = { primary: entry.primary, backup: [...entry.backup] };
    }
  }
  for (const scene of LLM_SCENES) {
    const entry = route[scene];
    const chain = [entry.primary, ...entry.backup];
    if (new Set(chain).size !== chain.length) {
      throw new Error(`LLM route for ${scene} repeats a provider`);
    }
    for (const name of chain) {
      if (!parsed.providers[name]) {
        throw new Error(`LLM route for ${scene} references unknown provider ${name}`);
      }
    }
  }
  return { providers: parsed.providers, route };
}

export type EmbeddingSettings = {
  provider: 'fake' | 'openai';
  dimensions: typeof DB_EMBEDDING_DIMENSIONS;
  baseUrl: string | null;
  apiKeyEnv: 'EMBEDDING_API_KEY';
  model: string;
  timeoutMs: number;
};

export function resolveEmbeddingSettings(
  source: Record<string, string | undefined>,
): EmbeddingSettings {
  const provider = (source.EMBEDDING_PROVIDER ?? 'fake').trim() || 'fake';
  if (provider !== 'fake' && provider !== 'openai') {
    throw new Error('EMBEDDING_PROVIDER must be fake or openai');
  }
  const rawDimensions = (source.EMBEDDING_DIMENSIONS ?? '').trim();
  const dimensions = rawDimensions === '' ? DB_EMBEDDING_DIMENSIONS : Number(rawDimensions);
  if (dimensions !== DB_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must be ${DB_EMBEDDING_DIMENSIONS} to match vector(1024)`,
    );
  }
  const model = (source.EMBEDDING_MODEL ?? 'bge-m3').trim() || 'bge-m3';
  const baseUrl = (source.EMBEDDING_BASE_URL ?? '').trim();
  if (provider === 'openai') {
    if (!baseUrl)
      throw new Error('EMBEDDING_BASE_URL is required for the openai embedding provider');
    assertHttpsBase(baseUrl, 'embedding');
  }
  return {
    provider,
    dimensions,
    baseUrl: baseUrl || null,
    apiKeyEnv: 'EMBEDDING_API_KEY',
    model,
    timeoutMs: positiveInt(
      source.EMBEDDING_TIMEOUT_MS,
      EMBEDDING_TIMEOUT_MS,
      'EMBEDDING_TIMEOUT_MS',
    ),
  };
}

export type ImageSettings = {
  provider: 'fake' | 'openai';
  baseUrl: string | null;
  apiKeyEnv: 'IMAGE_API_KEY';
  model: string;
  timeoutMs: number;
};

export function resolveImageSettings(source: Record<string, string | undefined>): ImageSettings {
  const provider = (source.IMAGE_PROVIDER ?? 'fake').trim() || 'fake';
  if (provider !== 'fake' && provider !== 'openai') {
    throw new Error('IMAGE_PROVIDER must be fake or openai');
  }
  const baseUrl = (source.IMAGE_BASE_URL ?? '').trim();
  if (provider === 'openai') {
    if (!baseUrl) throw new Error('IMAGE_BASE_URL is required for the openai image provider');
    assertHttpsBase(baseUrl, 'image');
  }
  return {
    provider,
    baseUrl: baseUrl || null,
    apiKeyEnv: 'IMAGE_API_KEY',
    model: (source.IMAGE_MODEL ?? 'fake-image').trim() || 'fake-image',
    timeoutMs: positiveInt(source.IMAGE_TIMEOUT_MS, LLM_TIMEOUT_MS, 'IMAGE_TIMEOUT_MS'),
  };
}

export type SearchSettings = {
  provider: 'link_list' | 'remote';
  endpoint: string | null;
  apiKeyEnv: 'SEARCH_REMOTE_API_KEY';
  timeoutMs: number;
};

export function resolveSearchSettings(source: Record<string, string | undefined>): SearchSettings {
  const provider = (source.SEARCH_PROVIDER ?? 'link_list').trim() || 'link_list';
  if (provider !== 'link_list' && provider !== 'remote') {
    throw new Error('SEARCH_PROVIDER must be link_list or remote');
  }
  const endpoint = (source.SEARCH_REMOTE_ENDPOINT ?? '').trim();
  if (provider === 'remote') {
    if (!endpoint)
      throw new Error('SEARCH_REMOTE_ENDPOINT is required when SEARCH_PROVIDER=remote');
    assertHttpsBase(endpoint, 'search');
  }
  return {
    provider,
    endpoint: endpoint || null,
    apiKeyEnv: 'SEARCH_REMOTE_API_KEY',
    timeoutMs: positiveInt(source.SEARCH_TIMEOUT_MS, FETCH_TIMEOUT_MS, 'SEARCH_TIMEOUT_MS'),
  };
}

export type FetchSettings = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  robotsCacheMs: number;
};

export function resolveFetchSettings(source: Record<string, string | undefined>): FetchSettings {
  return {
    timeoutMs: positiveInt(source.FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS, 'FETCH_TIMEOUT_MS'),
    maxBytes: positiveInt(source.FETCH_MAX_BYTES, FETCH_MAX_BYTES, 'FETCH_MAX_BYTES'),
    maxRedirects: positiveInt(
      source.FETCH_MAX_REDIRECTS,
      FETCH_MAX_REDIRECTS,
      'FETCH_MAX_REDIRECTS',
    ),
    robotsCacheMs: positiveInt(source.ROBOTS_CACHE_MS, ROBOTS_CACHE_MS, 'ROBOTS_CACHE_MS'),
  };
}

export type StorageSettings = {
  driver: 'memory' | 's3';
  maxObjectBytes: number;
};

export function resolveStorageSettings(
  source: Record<string, string | undefined>,
): StorageSettings {
  const driver = (source.STORAGE_DRIVER ?? 'memory').trim() || 'memory';
  if (driver !== 'memory' && driver !== 's3')
    throw new Error('STORAGE_DRIVER must be memory or s3');
  return {
    driver,
    maxObjectBytes: positiveInt(
      source.STORAGE_MAX_OBJECT_BYTES,
      STORAGE_MAX_OBJECT_BYTES,
      'STORAGE_MAX_OBJECT_BYTES',
    ),
  };
}

export function readLlmDocument(source: Record<string, string | undefined>): LlmRouteConfig {
  return resolveLlmRoute(readObject(source, 'LLM_PROVIDERS'));
}

function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be a positive integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
  return value;
}
