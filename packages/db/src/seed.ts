import { PrismaClient, QuotaKey, UserRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  DEMO_TENANT_POINTS,
  DEMO_TENANT_VALID_DAYS,
  PRICING_DEFAULTS,
  QUOTA_DEFAULTS,
  type QuotaKeyName,
} from '@geomix/shared/catalog';
import { hashPassword } from './password';

/**
 * 种子可重复执行。
 * 重复执行会把价格表同步为 GeoMix 2.0 的 3 项默认值并清理历史废弃计费项。
 * 点数、口令、有效期、配额上限、已用量、计费模式覆盖和停用状态只在第一次创建时写入。
 * 租户 billingMode 留空，运行时继承全局 BILLING_MODE，默认是 SHADOW。
 * demo 租户保持 0 个品牌，以便首次登录直接体验 60 秒品牌建档流程。
 */

export const PLATFORM_TENANT_ID = 'seed_tenant_platform';
export const DEMO_TENANT_ID = 'seed_tenant_demo';
export const ADMIN_USER_ID = 'seed_user_admin';
export const DEMO_USER_ID = 'seed_user_demo';
export const PLATFORM_EXPIRES_AT = new Date('2099-12-31T00:00:00.000Z');

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;

export type SeedConfig = {
  adminUsername: string;
  adminPassword: string;
  demoUsername: string;
  demoPassword: string;
  demoPoints: number;
  demoValidDays: number;
};

export type SeedAccount = {
  tenantId: string;
  tenantName: string;
  expiresAt: Date;
  points: number;
  userId: string;
  username: string;
  nickname: string;
  role: 'ADMIN' | 'MERCHANT';
  passwordHash: string;
};

export type SeedQuota = {
  tenantId: string;
  key: QuotaKeyName;
  limit: bigint;
};

export type SeedWrites = {
  pricing: readonly { action: string; unitPoints: number }[];
  accounts: readonly SeedAccount[];
  quotas: readonly SeedQuota[];
};

export type SeedSummary = {
  pricing: number;
  tenants: number;
  wallets: number;
  quotas: number;
  users: number;
};

export type SeedOptions = {
  config?: SeedConfig;
  env?: Record<string, string | undefined>;
  now?: Date;
  hashPassword?: (password: string) => string;
};

export function addUtcDays(from: Date, days: number): Date {
  const next = new Date(from.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function text(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function positiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`${key} must be a positive integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${key} must be between 1 and ${max}`);
  }
  return value;
}

export function readSeedConfig(env: Record<string, string | undefined> = process.env): SeedConfig {
  const adminUsername = text(env, 'SEED_ADMIN_USERNAME', 'admin');
  const demoUsername = text(env, 'SEED_DEMO_USERNAME', 'demo');
  const adminPassword = text(env, 'SEED_ADMIN_PASSWORD', 'geomix-admin-dev');
  const demoPassword = text(env, 'SEED_DEMO_PASSWORD', 'geomix-demo-dev');
  if (!USERNAME.test(adminUsername) || !USERNAME.test(demoUsername)) {
    throw new Error('SEED_*_USERNAME must be 2-32 letters, digits, "_" or "-"');
  }
  if (adminUsername.toLowerCase() === demoUsername.toLowerCase()) {
    throw new Error('SEED_ADMIN_USERNAME and SEED_DEMO_USERNAME must differ');
  }
  for (const [key, value] of [
    ['SEED_ADMIN_PASSWORD', adminPassword],
    ['SEED_DEMO_PASSWORD', demoPassword],
  ] as const) {
    if (value.length < 8 || value.length > 128) {
      throw new Error(`${key} must be 8-128 characters`);
    }
  }
  return {
    adminUsername,
    adminPassword,
    demoUsername,
    demoPassword,
    demoPoints: positiveInt(env, 'SEED_DEMO_POINTS', DEMO_TENANT_POINTS, 1_000_000_000),
    demoValidDays: positiveInt(env, 'SEED_DEMO_VALID_DAYS', DEMO_TENANT_VALID_DAYS, 3650),
  };
}

export function buildSeedWrites(input: {
  config: SeedConfig;
  now: Date;
  hashPassword?: (password: string) => string;
}): SeedWrites {
  const hash = input.hashPassword ?? hashPassword;
  const accounts: SeedAccount[] = [
    {
      tenantId: PLATFORM_TENANT_ID,
      tenantName: 'GeoMix 平台',
      expiresAt: PLATFORM_EXPIRES_AT,
      points: 0,
      userId: ADMIN_USER_ID,
      username: input.config.adminUsername,
      nickname: '管理员',
      role: 'ADMIN',
      passwordHash: hash(input.config.adminPassword),
    },
    {
      tenantId: DEMO_TENANT_ID,
      tenantName: 'GeoMix 演示',
      expiresAt: addUtcDays(input.now, input.config.demoValidDays),
      points: input.config.demoPoints,
      userId: DEMO_USER_ID,
      username: input.config.demoUsername,
      nickname: '演示用户',
      role: 'MERCHANT',
      passwordHash: hash(input.config.demoPassword),
    },
  ];
  const quotas: SeedQuota[] = [];
  for (const account of accounts) {
    for (const quota of QUOTA_DEFAULTS) {
      quotas.push({
        tenantId: account.tenantId,
        key: quota.key,
        limit: BigInt(quota.limit),
      });
    }
  }
  return {
    pricing: PRICING_DEFAULTS.map((item) => ({
      action: item.action,
      unitPoints: item.unitPoints,
    })),
    accounts,
    quotas,
  };
}

function summarize(writes: SeedWrites): SeedSummary {
  return {
    pricing: writes.pricing.length,
    tenants: writes.accounts.length,
    wallets: writes.accounts.length,
    quotas: writes.quotas.length,
    users: writes.accounts.length,
  };
}

async function writeAll(tx: Prisma.TransactionClient, writes: SeedWrites): Promise<void> {
  const validActions = writes.pricing.map((item) => item.action);
  await tx.pricingItem.deleteMany({
    where: { action: { notIn: validActions } },
  });
  for (const item of writes.pricing) {
    await tx.pricingItem.upsert({
      where: { action: item.action },
      create: { action: item.action, unitPoints: item.unitPoints, enabled: true },
      update: { unitPoints: item.unitPoints, enabled: true },
    });
  }

  for (const account of writes.accounts) {
    await tx.tenant.upsert({
      where: { id: account.tenantId },
      create: {
        id: account.tenantId,
        name: account.tenantName,
        billingMode: null,
        expiresAt: account.expiresAt,
        isActive: true,
      },
      update: { name: account.tenantName },
    });
    await tx.wallet.upsert({
      where: { tenantId: account.tenantId },
      create: {
        tenantId: account.tenantId,
        points: account.points,
        pointsReserved: 0,
        money: '0.00',
      },
      update: {},
    });
    await tx.user.upsert({
      where: { id: account.userId },
      create: {
        id: account.userId,
        tenantId: account.tenantId,
        username: account.username,
        passwordHash: account.passwordHash,
        nickname: account.nickname,
        role: account.role === 'ADMIN' ? UserRole.ADMIN : UserRole.MERCHANT,
      },
      update: {
        username: account.username,
        nickname: account.nickname,
        role: account.role === 'ADMIN' ? UserRole.ADMIN : UserRole.MERCHANT,
      },
    });
  }

  for (const quota of writes.quotas) {
    await tx.quota.upsert({
      where: { tenantId_key: { tenantId: quota.tenantId, key: QuotaKey[quota.key] } },
      create: {
        tenantId: quota.tenantId,
        key: QuotaKey[quota.key],
        limit: quota.limit,
        used: 0n,
      },
      update: {},
    });
  }
}

export async function applySeed(
  prisma: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const config = options.config ?? readSeedConfig(options.env);
  const writes = buildSeedWrites({
    config,
    now: options.now ?? new Date(),
    hashPassword: options.hashPassword,
  });
  await prisma.$transaction((tx) => writeAll(tx, writes), {
    timeout: 20_000,
    maxWait: 10_000,
  });
  return summarize(writes);
}
