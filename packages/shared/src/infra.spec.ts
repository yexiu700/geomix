import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR,
  DEFAULT_BILLING_MODE,
  SITE_NAME,
  ok,
  parseEnv,
  parseLlmProviders,
  resolveBillingMode,
} from './infra';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readEnvExample(): Record<string, string> {
  const text = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
  const entries: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    entries[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return entries;
}

describe('infra constants', () => {
  it('uses the GeoMix placeholder and shadow billing by default', () => {
    expect(SITE_NAME).toBe('GeoMix');
    expect(DEFAULT_BILLING_MODE).toBe('SHADOW');
    expect(resolveBillingMode(undefined)).toBe('SHADOW');
    expect(resolveBillingMode('  ')).toBe('SHADOW');
    expect(resolveBillingMode('STRICT')).toBe('STRICT');
  });

  it('rejects an unknown billing mode instead of silently billing', () => {
    expect(() => resolveBillingMode('shadow')).toThrow(/SHADOW or STRICT/);
  });

  it('keeps the public API error codes stable', () => {
    expect(API_ERROR).toEqual({
      BAD_REQUEST: 40001,
      INSUFFICIENT_POINTS: 40201,
      TENANT_EXPIRED: 40301,
      FORBIDDEN_INDUSTRY: 40302,
      QUOTA_EXCEEDED: 40901,
      UPSTREAM_UNAVAILABLE: 42201,
    });
    expect(ok({ service: 'api' })).toEqual({ code: 0, msg: 'ok', data: { service: 'api' } });
  });
});

describe('parseEnv', () => {
  it('fills local defaults when the environment is empty', () => {
    const env = parseEnv({});
    expect(env.WEB_PORT).toBe(3000);
    expect(env.API_PORT).toBe(3001);
    expect(env.NEXT_PUBLIC_API_BASE).toBe('http://localhost:3001/api/v1');
    expect(env.DATABASE_URL.startsWith('postgresql://')).toBe(true);
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.BILLING_MODE).toBe('SHADOW');
    expect(env.FEATURE_AI_IMAGE).toBe(true);
    expect(env.EMBEDDING_DIMENSIONS).toBe(1024);
    expect(env.LLM_PROVIDERS).toEqual({});
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.ARTICLE_RETENTION_DAYS).toBe(30);
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    expect(env.PUBLIC_APP_URL).toBeUndefined();
    expect(env.SHOPIFY_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.SHOPIFY_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(env.SHOPIFY_OAUTH_SCOPES).toBeUndefined();
    expect(env.WECHAT_API_BASE_URL).toBeUndefined();
  });

  it('accepts explicit overrides including optional v2.1/v2.2 distribution env vars', () => {
    const env = parseEnv({
      BILLING_MODE: 'STRICT',
      FEATURE_AI_IMAGE: 'false',
      API_PORT: '4001',
      LLM_PROVIDERS: '{"fake":{"kind":"offline"}}',
      CREDENTIAL_ENCRYPTION_KEY: '  any-placeholder-validated-lazily-by-secretbox  ',
      PUBLIC_APP_URL: 'https://app.geomix.example///',
      SHOPIFY_OAUTH_CLIENT_ID: '  shopify-client-id  ',
      SHOPIFY_OAUTH_CLIENT_SECRET: '  shopify-client-secret  ',
      SHOPIFY_OAUTH_SCOPES: 'read_content,write_content',
      WECHAT_API_BASE_URL: 'https://wechat-mock.example.com///',
    });
    expect(env.BILLING_MODE).toBe('STRICT');
    expect(env.FEATURE_AI_IMAGE).toBe(false);
    expect(env.API_PORT).toBe(4001);
    expect(env.LLM_PROVIDERS).toEqual({ fake: { kind: 'offline' } });
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBe('any-placeholder-validated-lazily-by-secretbox');
    expect(env.PUBLIC_APP_URL).toBe('https://app.geomix.example');
    expect(env.SHOPIFY_OAUTH_CLIENT_ID).toBe('shopify-client-id');
    expect(env.SHOPIFY_OAUTH_CLIENT_SECRET).toBe('shopify-client-secret');
    expect(env.SHOPIFY_OAUTH_SCOPES).toBe('read_content,write_content');
    expect(env.WECHAT_API_BASE_URL).toBe('https://wechat-mock.example.com');

    const blankEnv = parseEnv({
      CREDENTIAL_ENCRYPTION_KEY: '   ',
      PUBLIC_APP_URL: '   ',
      SHOPIFY_OAUTH_CLIENT_ID: '   ',
      SHOPIFY_OAUTH_CLIENT_SECRET: '   ',
      SHOPIFY_OAUTH_SCOPES: '   ',
      WECHAT_API_BASE_URL: '   ',
    });
    expect(blankEnv.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    expect(blankEnv.PUBLIC_APP_URL).toBeUndefined();
    expect(blankEnv.SHOPIFY_OAUTH_CLIENT_ID).toBeUndefined();
    expect(blankEnv.SHOPIFY_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(blankEnv.SHOPIFY_OAUTH_SCOPES).toBeUndefined();
    expect(blankEnv.WECHAT_API_BASE_URL).toBeUndefined();
  });

  it('rejects a bad provider document, billing mode, PUBLIC_APP_URL, or WECHAT_API_BASE_URL', () => {
    expect(() => parseLlmProviders('[]')).toThrow(/JSON object/);
    expect(() => parseEnv({ BILLING_MODE: 'LIVE' })).toThrow(/SHADOW or STRICT/);
    expect(() => parseEnv({ WEB_PORT: '0' })).toThrow();
    expect(() => parseEnv({ PUBLIC_APP_URL: 'not-a-url' })).toThrow(/PUBLIC_APP_URL/);
    expect(() => parseEnv({ PUBLIC_APP_URL: 'ftp://app.geomix.example' })).toThrow(
      /http:\/\/ or https:\/\//,
    );
    expect(() => parseEnv({ WECHAT_API_BASE_URL: 'not-a-url' })).toThrow(/WECHAT_API_BASE_URL/);
    expect(() => parseEnv({ WECHAT_API_BASE_URL: 'ftp://api.weixin.qq.com' })).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });
});

describe('.env.example', () => {
  it('matches the local contract and does not contain live credentials', () => {
    const text = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
    const example = readEnvExample();
    const env = parseEnv(example);

    expect(text).toContain('GeoMix');
    expect(example.BILLING_MODE).toBe('SHADOW');
    expect(env.BILLING_MODE).toBe('SHADOW');
    expect(env.DATABASE_URL.startsWith('postgresql://')).toBe(true);
    expect(env.SHOPIFY_OAUTH_SCOPES).toBe('read_content,write_content');
    expect(env.WECHAT_API_BASE_URL).toBeUndefined();
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(text).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
  });
});
