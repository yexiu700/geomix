import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DB_EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_BATCH,
  EMBEDDING_MAX_CHARS,
  FAKE_MARK,
  resolveEmbeddingSettings,
  type EmbeddingSettings,
} from '@geomix/shared';
import { z } from 'zod';
import { requestOnce, type DnsResolver, type HttpTransport } from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';

const vectorSchema = z.array(z.number().finite()).length(DB_EMBEDDING_DIMENSIONS);

export type EmbeddingResult = {
  provider: 'fake' | 'openai';
  model: string;
  fake: boolean;
  dimensions: typeof DB_EMBEDDING_DIMENSIONS;
  vectors: number[][];
  note: string;
};

/**
 * 开发期向量。同一段文本始终得到同一个 1024 维单位向量，不能拿来冒充真实语义。
 */
export function fakeEmbedding(text: string): number[] {
  const values: number[] = [];
  let seed = createHash('sha256').update(text).digest();
  let offset = 0;
  while (values.length < DB_EMBEDDING_DIMENSIONS) {
    if (offset + 4 > seed.length) {
      seed = createHash('sha256').update(seed).update(String(values.length)).digest();
      offset = 0;
    }
    const sample = seed.readUInt32BE(offset);
    offset += 4;
    values.push((sample / 0xffff_ffff) * 2 - 1);
  }
  let square = 0;
  for (const value of values) square += value * value;
  const norm = Math.sqrt(square) || 1;
  return values.map((value) => value / norm);
}

export function assertEmbeddingWidth(vector: number[]): void {
  if (!vectorSchema.safeParse(vector).success) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '向量必须是 1024 维', 'dimensions');
  }
}

export function embeddingColumnIs1024(schemaPath: string): boolean {
  return readFileSync(schemaPath, 'utf8').includes('Unsupported("vector(1024)")');
}

export class EmbeddingService {
  constructor(
    private readonly settings: EmbeddingSettings,
    private readonly env: Record<string, string | undefined> = {},
    private readonly transport?: HttpTransport,
    private readonly resolver?: DnsResolver,
  ) {
    if (settings.dimensions !== DB_EMBEDDING_DIMENSIONS) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '向量必须是 1024 维', 'dimensions');
    }
  }

  static fromEnv(
    env: Record<string, string | undefined>,
    overrides?: { transport?: HttpTransport; resolver?: DnsResolver },
  ): EmbeddingService {
    return new EmbeddingService(
      resolveEmbeddingSettings(env),
      env,
      overrides?.transport,
      overrides?.resolver,
    );
  }

  async embed(input: { texts: string[]; signal?: AbortSignal }): Promise<EmbeddingResult> {
    const texts = normalizeTexts(input.texts);
    if (input.signal?.aborted)
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    if (this.settings.provider === 'fake') {
      return {
        provider: 'fake',
        model: 'fake-bge-m3',
        fake: true,
        dimensions: DB_EMBEDDING_DIMENSIONS,
        vectors: texts.map((text) => fakeEmbedding(text)),
        note: `${FAKE_MARK}GeoMix 占位向量，不能当作真实语义检索结果。`,
      };
    }
    return this.embedUpstream(texts, input.signal);
  }

  private async embedUpstream(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!this.settings.baseUrl || !this.transport || !this.resolver) {
      throw new ProviderError(PROVIDER_KIND.AUTH, 'embedding 传输未配置', 'transport');
    }
    const apiKey = this.env[this.settings.apiKeyEnv]?.trim() ?? '';
    if (!apiKey)
      throw new ProviderError(
        PROVIDER_KIND.AUTH,
        `缺少密钥 ${this.settings.apiKeyEnv}`,
        'missing_key',
      );
    const root = this.settings.baseUrl.endsWith('/')
      ? this.settings.baseUrl
      : `${this.settings.baseUrl}/`;
    const response = await requestOnce({
      url: new URL('embeddings', root),
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ model: this.settings.model, input: texts }),
      timeoutMs: this.settings.timeoutMs,
      maxBytes: 8_000_000,
      signal,
      resolver: this.resolver,
      transport: this.transport,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(PROVIDER_KIND.AUTH, '外部服务拒绝了密钥', 'upstream_auth');
    }
    if (response.status === 429)
      throw new ProviderError(PROVIDER_KIND.RATE_LIMIT, '外部服务繁忙', 'rate_limit');
    if (response.status >= 500)
      throw new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'upstream');
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'status');
    }
    let json: unknown;
    try {
      json = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'json');
    }
    const parsed = z
      .object({
        data: z
          .array(
            z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }),
          )
          .min(1),
      })
      .safeParse(json);
    if (!parsed.success || parsed.data.data.length !== texts.length) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
    }
    const ordered = [...parsed.data.data].sort((left, right) => left.index - right.index);
    return {
      provider: 'openai',
      model: this.settings.model,
      fake: false,
      dimensions: DB_EMBEDDING_DIMENSIONS,
      vectors: ordered.map((row) => {
        assertEmbeddingWidth(row.embedding);
        return row.embedding;
      }),
      note: '',
    };
  }
}

function normalizeTexts(texts: string[]): string[] {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > EMBEDDING_MAX_BATCH) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '向量条数超出范围', 'batch');
  }
  return texts.map((text) => {
    if (typeof text !== 'string')
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '向量文本不正确', 'text');
    const normalized = text.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > EMBEDDING_MAX_CHARS) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '向量文本不正确', 'text');
    }
    return normalized;
  });
}
