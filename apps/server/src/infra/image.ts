import { createHash } from 'node:crypto';
import { FAKE_MARK, resolveImageSettings, type ImageSettings } from '@geomix/shared';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { compressImage, placeholderPng } from './compress';
import { ComplianceService } from './compliance';
import { requestOnce, type DnsResolver, type HttpTransport } from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';
import { fetchBinary, type FetchDeps } from './public-fetch';
import { StorageService, type StoredObject } from './storage';

const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
const COUNTS = [1, 2, 4] as const;

export type GeneratedImage = {
  fake: boolean;
  note: string;
  model: string;
  stored: StoredObject;
  width: number;
  height: number;
  warning?: string;
};

export type ImageGeneration = {
  provider: 'fake' | 'openai';
  fake: boolean;
  images: GeneratedImage[];
};

type ImageRequest = {
  tenantId: string;
  prompt: string;
  style?: string;
  ratio?: (typeof RATIOS)[number];
  count: (typeof COUNTS)[number];
  idempotencyKey: string;
  signal?: AbortSignal;
};

export class ImageService {
  private readonly done = new Map<string, { fingerprint: string; result: ImageGeneration }>();

  constructor(
    private readonly settings: ImageSettings,
    private readonly storage: StorageService,
    private readonly compliance: ComplianceService,
    private readonly env: Record<string, string | undefined> = {},
    private readonly transport?: HttpTransport,
    private readonly resolver?: DnsResolver,
    private readonly fetchDeps?: FetchDeps,
  ) {}

  static fromEnv(
    env: Record<string, string | undefined>,
    deps: {
      storage: StorageService;
      compliance: ComplianceService;
      transport?: HttpTransport;
      resolver?: DnsResolver;
      fetchDeps?: FetchDeps;
    },
  ): ImageService {
    return new ImageService(
      resolveImageSettings(env),
      deps.storage,
      deps.compliance,
      env,
      deps.transport,
      deps.resolver,
      deps.fetchDeps,
    );
  }

  async generate(input: ImageRequest): Promise<ImageGeneration> {
    const prompt = validatePrompt(input);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          prompt,
          style: input.style ?? '',
          ratio: input.ratio ?? '1:1',
          count: input.count,
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
    if (input.signal?.aborted)
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    const report = await this.compliance.assertAllowed({
      text: prompt,
      action: 'image_prompt',
      tenantId: input.tenantId,
    });
    const raw =
      this.settings.provider === 'fake'
        ? await fakeImages(prompt, input.count)
        : await this.upstreamImages(report.text, input);
    const images: GeneratedImage[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index];
      if (!item) continue;
      const compressed = await compressImage(item.body);
      const stored = await this.storage.put({
        tenantId: input.tenantId,
        name: `image-${fingerprint.slice(0, 16)}-${index + 1}.jpg`,
        body: compressed.body,
        contentType: compressed.contentType,
        idempotencyKey: `${input.idempotencyKey}-${index + 1}`,
      });
      images.push({
        fake: item.fake,
        note: item.fake ? `${FAKE_MARK}GeoMix 占位图，不是真实产品照片或品牌标识。` : '',
        model: item.model,
        stored,
        width: compressed.width,
        height: compressed.height,
        warning: compressed.warning,
      });
    }
    const result: ImageGeneration = {
      provider: this.settings.provider,
      fake: images.every((image) => image.fake),
      images,
    };
    this.done.set(cacheKey, { fingerprint, result });
    return result;
  }

  private async upstreamImages(
    prompt: string,
    input: ImageRequest,
  ): Promise<Array<{ body: Buffer; fake: boolean; model: string }>> {
    if (!this.settings.baseUrl || !this.transport || !this.resolver) {
      throw new ProviderError(PROVIDER_KIND.AUTH, '生图端点未配置', 'endpoint');
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
      url: new URL('images/generations', root),
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: this.settings.model,
        prompt,
        n: input.count,
        size: input.ratio ?? '1:1',
      }),
      timeoutMs: this.settings.timeoutMs,
      maxBytes: 8_000_000,
      signal: input.signal,
      resolver: this.resolver,
      transport: this.transport,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(PROVIDER_KIND.AUTH, '外部服务拒绝了密钥', 'upstream_auth');
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'upstream');
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
          .array(z.object({ b64_json: z.string().optional(), url: z.string().optional() }))
          .min(1),
      })
      .safeParse(json);
    if (!parsed.success)
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
    const images = [];
    for (const row of parsed.data.data.slice(0, input.count)) {
      if (row.b64_json) {
        const body = Buffer.from(row.b64_json, 'base64');
        if (body.length === 0)
          throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'image');
        images.push({ body, fake: false, model: this.settings.model });
        continue;
      }
      if (!row.url || !this.fetchDeps) {
        throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'image');
      }
      const downloaded = await fetchBinary(row.url, {
        ...this.fetchDeps,
        allowTypes: ['image/png', 'image/jpeg', 'image/webp'],
        maxBytes: 20 * 1024 * 1024,
      });
      images.push({ body: downloaded.body, fake: false, model: this.settings.model });
    }
    if (images.length !== input.count) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'count');
    }
    return images;
  }
}

async function fakeImages(
  prompt: string,
  count: number,
): Promise<Array<{ body: Buffer; fake: true; model: string }>> {
  const images = [];
  for (let index = 0; index < count; index += 1) {
    images.push({
      body: await placeholderPng(`${prompt}:${index}`),
      fake: true as const,
      model: 'fake-image',
    });
  }
  return images;
}

function validatePrompt(input: ImageRequest): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.tenantId)) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '租户不正确', 'tenant');
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '幂等键不正确', 'idempotency');
  }
  const prompt = input.prompt?.trim() ?? '';
  if (prompt.length < 5 || prompt.length > 500) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '提示词长度需要在 5 到 500 字', 'prompt');
  }
  if (input.style && input.style.length > 32)
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '风格不正确', 'style');
  if (input.ratio && !RATIOS.includes(input.ratio))
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '比例不正确', 'ratio');
  if (!COUNTS.includes(input.count))
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '张数只能是 1、2 或 4', 'count');
  return prompt;
}

export function isComplianceRejection(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
