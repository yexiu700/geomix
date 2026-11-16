export const DB_PROVIDER = 'postgresql';
export const VECTOR_EXTENSION = 'vector';

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//.test(url);
}

export { createPrismaClient } from './client';
export { hashPassword, verifyPassword } from './password';
export {
  NULLABLE_TENANT_MODELS,
  REQUIRED_TENANT_MODELS,
  UNSCOPED_OPTIONAL_TENANT_MODELS,
  UNSCOPED_UNOWNED_MODELS,
  createScopedClient,
  createTenantExtension,
} from './tenant-scope';
export {
  ADMIN_USER_ID,
  DEMO_TENANT_ID,
  DEMO_USER_ID,
  PLATFORM_EXPIRES_AT,
  PLATFORM_TENANT_ID,
  addUtcDays,
  applySeed,
  buildSeedWrites,
  readSeedConfig,
} from './seed';
export type { SeedAccount, SeedConfig, SeedOptions, SeedSummary, SeedWrites } from './seed';
