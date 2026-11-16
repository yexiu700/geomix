import { PrismaClient } from '@prisma/client';

/** 不传 URL 时使用 DATABASE_URL。传入时只覆盖这一次连接。 */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  if (!databaseUrl) return new PrismaClient();
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
