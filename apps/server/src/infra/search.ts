import { resolveSearchSettings, type SearchSettings } from '@geomix/shared';
import { z } from 'zod';
import { requestOnce, type DnsResolver, type HttpTransport } from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';
import { assertPublicUrl, UrlPolicyError } from './ssrf';

const TRACKING = /^(utm_|fbclid$|gclid$)/i;

export type SearchHit = {
  url: string;
  title: string;
  snippet: string;
  /** 摘要不能当正文。调用方只应使用 url，标题也只在远端契约提供时保留。 */
  useSnippetAsBody: false;
};

export type SearchResult = {
  provider: 'link_list' | 'remote';
  fake: boolean;
  hits: SearchHit[];
  rejected: Array<{ line: number; reason: string }>;
};

/**
 * 默认适配器是链接清单，不会请求这些 URL。
 * 博查、Bing、SerpAPI 的厂商报文没有写死；只有 SEARCH_PROVIDER=remote 且配了端点时，才按下面的契约解析。
 */
export class SearchService {
  constructor(
    private readonly settings: SearchSettings,
    private readonly env: Record<string, string | undefined> = {},
    private readonly transport?: HttpTransport,
    private readonly resolver?: DnsResolver,
  ) {}

  static fromEnv(
    env: Record<string, string | undefined>,
    overrides?: { transport?: HttpTransport; resolver?: DnsResolver },
  ): SearchService {
    return new SearchService(
      resolveSearchSettings(env),
      env,
      overrides?.transport,
      overrides?.resolver,
    );
  }

  isRemoteReady(): boolean {
    if (this.settings.provider !== 'remote' || !this.settings.endpoint) return false;
    const apiKey = this.env[this.settings.apiKeyEnv]?.trim() ?? '';
    return apiKey.length > 0;
  }

  async search(input: {
    keyword: string;
    limit: number;
    links?: string;
    signal?: AbortSignal;
  }): Promise<SearchResult> {
    if (
      typeof input.keyword !== 'string' ||
      input.keyword.trim() === '' ||
      input.keyword.length > 200
    ) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '搜索词不正确', 'keyword');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 150) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '搜索条数超出范围', 'limit');
    }
    if (input.signal?.aborted)
      throw new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
    if (this.settings.provider === 'link_list')
      return searchLinkList(input.links ?? '', input.limit);
    return this.searchRemote(input.keyword, input.limit, input.signal);
  }

  private async searchRemote(
    keyword: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    if (!this.settings.endpoint || !this.transport || !this.resolver) {
      throw new ProviderError(PROVIDER_KIND.AUTH, '搜索端点未配置', 'endpoint');
    }
    const apiKey = this.env[this.settings.apiKeyEnv]?.trim() ?? '';
    if (!apiKey)
      throw new ProviderError(
        PROVIDER_KIND.AUTH,
        `缺少密钥 ${this.settings.apiKeyEnv}`,
        'missing_key',
      );
    const response = await requestOnce({
      url: this.settings.endpoint,
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ keyword, limit }),
      timeoutMs: this.settings.timeoutMs,
      maxBytes: 1_000_000,
      signal,
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
        results: z.array(
          z.object({
            url: z.string(),
            title: z.string().optional(),
            snippet: z.string().optional(),
          }),
        ),
      })
      .safeParse(json);
    if (!parsed.success)
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema');
    const hits: SearchHit[] = [];
    const rejected: SearchResult['rejected'] = [];
    parsed.data.results.forEach((row, index) => {
      const normalized = normalizeCandidate(row.url);
      if (!normalized) {
        rejected.push({ line: index + 1, reason: 'url' });
        return;
      }
      if (hits.length >= limit || hits.some((hit) => hit.url === normalized)) return;
      hits.push({
        url: normalized,
        title: (row.title ?? '').slice(0, 200),
        snippet: (row.snippet ?? '').slice(0, 300),
        useSnippetAsBody: false,
      });
    });
    return { provider: 'remote', fake: false, hits, rejected };
  }
}

export function searchLinkList(raw: string, limit: number): SearchResult {
  const hits: SearchHit[] = [];
  const rejected: SearchResult['rejected'] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const normalized = normalizeCandidate(trimmed);
    if (!normalized) {
      rejected.push({ line: index + 1, reason: 'url' });
      return;
    }
    if (hits.some((hit) => hit.url === normalized)) return;
    if (hits.length >= limit) return;
    hits.push({ url: normalized, title: '', snippet: '', useSnippetAsBody: false });
  });
  return { provider: 'link_list', fake: false, hits, rejected };
}

function normalizeCandidate(raw: string): string | null {
  let url: URL;
  try {
    url = assertPublicUrl(raw);
  } catch (error) {
    if (error instanceof UrlPolicyError || error instanceof ProviderError) return null;
    return null;
  }
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING.test(key))
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.toString();
}
