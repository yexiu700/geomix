import { z } from 'zod';

/** 品牌未定前的站名占位。不要换成原站名称。 */
export const SITE_NAME = 'GeoMix' as const;

export const BILLING_MODES = ['SHADOW', 'STRICT'] as const;
export const billingModeSchema = z.enum(BILLING_MODES);
export type BillingMode = z.infer<typeof billingModeSchema>;

/**
 * 计费默认模式。SHADOW 只记账、不实扣；STRICT 才会扣点。
 * 这里只解析配置，不实现冻结、结算或钱包。
 */
export const DEFAULT_BILLING_MODE: BillingMode = 'SHADOW';

/** 接口错误码。业务模块只消费这些常量，不要在各处写魔法数字。 */
export const API_ERROR = {
  BAD_REQUEST: 40001,
  INSUFFICIENT_POINTS: 40201,
  TENANT_EXPIRED: 40301,
  FORBIDDEN_INDUSTRY: 40302,
  QUOTA_EXCEEDED: 40901,
  UPSTREAM_UNAVAILABLE: 42201,
} as const;

export type ApiEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
};

export function ok<T>(data: T, msg = 'ok'): ApiEnvelope<T> {
  return { code: 0, msg, data };
}

export function resolveBillingMode(value: string | undefined | null): BillingMode {
  if (value === undefined || value === null || value.trim() === '') {
    return DEFAULT_BILLING_MODE;
  }
  const parsed = billingModeSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error(`Invalid BILLING_MODE "${value}". Expected SHADOW or STRICT.`);
  }
  return parsed.data;
}

export function parseLlmProviders(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('LLM_PROVIDERS must be a JSON object');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LLM_PROVIDERS must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function blankToUndefined(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function blankOrWhitespaceToUndefined(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return value;
}

function envString(defaultValue: string) {
  return z.preprocess(blankToUndefined, z.string().default(defaultValue));
}

function envNumber(defaultValue: number) {
  return z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(defaultValue));
}

function envBoolean(defaultValue: boolean) {
  return z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false'])
      .default(defaultValue ? 'true' : 'false')
      .transform((value) => value === 'true'),
  );
}

export const envSchema = z.object({
  WEB_PORT: envNumber(3000),
  API_PORT: envNumber(3001),
  WEB_ORIGIN: envString('http://localhost:3000'),
  NEXT_PUBLIC_API_BASE: envString('http://localhost:3001/api/v1'),
  DATABASE_URL: envString('postgresql://geomix:geomix@localhost:5432/geomix?schema=public'),
  REDIS_URL: envString('redis://localhost:6379'),
  S3_ENDPOINT: envString('http://localhost:9000'),
  S3_REGION: envString('us-east-1'),
  S3_BUCKET: envString('geomix'),
  S3_ACCESS_KEY_ID: envString('geomix'),
  S3_SECRET_ACCESS_KEY: envString('geomix-dev-only'),
  S3_FORCE_PATH_STYLE: envBoolean(true),
  JWT_ACCESS_SECRET: envString('change-me-access'),
  JWT_REFRESH_SECRET: envString('change-me-refresh'),
  JWT_ACCESS_TTL: envString('15m'),
  JWT_REFRESH_TTL: envString('7d'),
  AUTH_CAPTCHA_MAX: envNumber(10),
  AUTH_CAPTCHA_WINDOW_SECONDS: envNumber(600),
  AUTH_LOGIN_FAIL_MAX: envNumber(5),
  AUTH_LOGIN_FAIL_WINDOW_SECONDS: envNumber(900),
  LLM_PROVIDERS: z.preprocess((value) => {
    const raw = value === undefined || value === null || value === '' ? '{}' : value;
    if (typeof raw !== 'string') {
      throw new Error('LLM_PROVIDERS must be a JSON object');
    }
    return parseLlmProviders(raw);
  }, z.record(z.unknown())),
  EMBEDDING_PROVIDER: envString('fake'),
  EMBEDDING_DIMENSIONS: envNumber(1024),
  IMAGE_PROVIDER: envString('fake'),
  SEARCH_PROVIDER: envString('link_list'),
  BILLING_MODE: z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return DEFAULT_BILLING_MODE;
    if (typeof value !== 'string') {
      throw new Error('Invalid BILLING_MODE. Expected SHADOW or STRICT.');
    }
    return resolveBillingMode(value);
  }, billingModeSchema),
  FEATURE_AI_IMAGE: envBoolean(true),
  ARTICLE_RETENTION_DAYS: envNumber(30),
  CREDENTIAL_ENCRYPTION_KEY: z.preprocess(blankOrWhitespaceToUndefined, z.string().optional()),
  PUBLIC_APP_URL: z.preprocess(
    blankOrWhitespaceToUndefined,
    z
      .string()
      .url('PUBLIC_APP_URL must be a valid URL')
      .refine((value) => /^https?:\/\//i.test(value), 'PUBLIC_APP_URL must use http:// or https://')
      .transform((value) => value.replace(/\/+$/, ''))
      .optional(),
  ),
});

export type AppEnv = z.infer<typeof envSchema>;

/** 解析环境变量。缺省项使用本地开发默认值，未知变量会被忽略。 */
export function parseEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  return envSchema.parse(source);
}
