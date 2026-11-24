import { Inject, Injectable, Optional } from '@nestjs/common';
import { isSafeDistributionHttpUrl } from '@geomix/shared';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { UrlPolicyError, type SsrfAllowlist } from '../infra/ssrf';
import { collectSecretCandidates, redactSecrets } from './connectors/types';

export const DEFAULT_INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const DEFAULT_INDEXNOW_TIMEOUT_MS = 5_000;
export const INDEXNOW_OPTIONS = Symbol('INDEXNOW_OPTIONS');

export type IndexNowOptions = {
  endpointUrl?: string;
  timeoutMs?: number;
  allowlistOverride?: SsrfAllowlist | string;
};

export type SubmitIndexNowInput = {
  urls: string[];
  indexNowKey?: string | null;
  host?: string;
  keyLocation?: string;
  timeoutMs?: number;
  endpointUrl?: string;
  allowlistOverride?: SsrfAllowlist | string;
};

export type IndexNowStatus = 'SUBMITTED' | 'SKIPPED' | 'FAILED';

export type IndexNowReason =
  'OK' | 'NO_KEY' | 'NO_URLS' | 'TIMEOUT' | 'SSRF' | 'UPSTREAM_HTTP' | 'UPSTREAM_ERROR';

export type IndexNowSubmitResult = {
  submitted: boolean;
  status: IndexNowStatus;
  reason: IndexNowReason;
  statusText: string;
  httpStatus?: number;
  submittedUrls: string[];
  error?: string;
};

/**
 * IndexNow 实时索引推送服务：
 * - 全部经由 OutboundHttpClient（受 SSRF 策略与超时保护）外发
 * - 绝不抛出异常，任何缺少 Key、超时、SSRF 或上游错误均安全降级为 SKIPPED / FAILED
 * - 错误信息严格脱敏，绝不泄露 indexNowKey
 */
@Injectable()
export class IndexNowService {
  private readonly defaultEndpointUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultAllowlistOverride?: SsrfAllowlist | string;

  constructor(
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional() @Inject(INDEXNOW_OPTIONS) options?: IndexNowOptions,
  ) {
    this.defaultEndpointUrl = options?.endpointUrl?.trim() || DEFAULT_INDEXNOW_ENDPOINT;
    this.defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_INDEXNOW_TIMEOUT_MS;
    this.defaultAllowlistOverride = options?.allowlistOverride;
  }

  async submit(input: SubmitIndexNowInput): Promise<IndexNowSubmitResult> {
    const key = typeof input.indexNowKey === 'string' ? input.indexNowKey.trim() : '';
    if (!key) {
      return {
        submitted: false,
        status: 'SKIPPED',
        reason: 'NO_KEY',
        statusText: 'SKIPPED',
        submittedUrls: [],
      };
    }

    const secretCandidates = collectSecretCandidates({
      indexNowKey: key,
      ...(input.keyLocation?.trim() ? { keyLocation: input.keyLocation.trim() } : {}),
    });

    const validUrls: Array<{ raw: string; host: string }> = [];
    const seen = new Set<string>();
    for (const candidate of input.urls ?? []) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed) || !isSafeDistributionHttpUrl(trimmed)) continue;
      try {
        const parsed = new URL(trimmed);
        seen.add(trimmed);
        validUrls.push({ raw: trimmed, host: parsed.hostname.toLowerCase() });
      } catch {
        // Ignore malformed URLs
      }
    }

    if (validUrls.length === 0) {
      return {
        submitted: false,
        status: 'SKIPPED',
        reason: 'NO_URLS',
        statusText: 'SKIPPED',
        submittedUrls: [],
      };
    }

    const explicitHost = input.host?.trim().toLowerCase() || '';
    const resolvedHost = explicitHost || validUrls[0]?.host || '';
    if (!resolvedHost) {
      return {
        submitted: false,
        status: 'SKIPPED',
        reason: 'NO_URLS',
        statusText: 'SKIPPED',
        submittedUrls: [],
      };
    }

    const urlList = validUrls
      .filter((entry) => entry.host === resolvedHost)
      .map((entry) => entry.raw);

    if (urlList.length === 0) {
      return {
        submitted: false,
        status: 'SKIPPED',
        reason: 'NO_URLS',
        statusText: 'SKIPPED',
        submittedUrls: [],
      };
    }

    let keyLocation: string | undefined;
    if (input.keyLocation?.trim() && isSafeDistributionHttpUrl(input.keyLocation.trim())) {
      try {
        const parsedKeyLoc = new URL(input.keyLocation.trim());
        if (parsedKeyLoc.hostname.toLowerCase() === resolvedHost) {
          keyLocation = input.keyLocation.trim();
        }
      } catch {
        // Ignore malformed keyLocation
      }
    }

    const endpointUrl = input.endpointUrl?.trim() || this.defaultEndpointUrl;
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const allowlistOverride = input.allowlistOverride ?? this.defaultAllowlistOverride;

    const payload: {
      host: string;
      key: string;
      keyLocation?: string;
      urlList: string[];
    } = {
      host: resolvedHost,
      key,
      ...(keyLocation ? { keyLocation } : {}),
      urlList,
    };

    try {
      const response = await this.http.request({
        url: endpointUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs,
        allowlistOverride,
      });

      if (response.status === 200 || response.status === 202) {
        return {
          submitted: true,
          status: 'SUBMITTED',
          reason: 'OK',
          statusText: 'SUBMITTED',
          httpStatus: response.status,
          submittedUrls: urlList,
        };
      }

      return {
        submitted: false,
        status: 'FAILED',
        reason: 'UPSTREAM_HTTP',
        statusText: `FAILED:HTTP_${response.status}`,
        httpStatus: response.status,
        submittedUrls: urlList,
        error: redactSecrets(
          `IndexNow upstream returned HTTP ${response.status}`,
          secretCandidates,
          200,
        ),
      };
    } catch (error) {
      if (
        error instanceof UrlPolicyError ||
        (error instanceof ProviderError && error.kind === PROVIDER_KIND.SSRF)
      ) {
        return {
          submitted: false,
          status: 'FAILED',
          reason: 'SSRF',
          statusText: 'FAILED:SSRF',
          submittedUrls: urlList,
          error: 'IndexNow endpoint blocked by SSRF policy',
        };
      }

      if (error instanceof ProviderError && error.kind === PROVIDER_KIND.TIMEOUT) {
        return {
          submitted: false,
          status: 'FAILED',
          reason: 'TIMEOUT',
          statusText: 'FAILED:TIMEOUT',
          submittedUrls: urlList,
          error: 'IndexNow request timed out',
        };
      }

      const rawError = error instanceof Error ? error.message : 'IndexNow request failed';
      return {
        submitted: false,
        status: 'FAILED',
        reason: 'UPSTREAM_ERROR',
        statusText: 'FAILED:UPSTREAM',
        submittedUrls: urlList,
        error: redactSecrets(rawError, secretCandidates, 200) || 'IndexNow request failed',
      };
    }
  }
}
