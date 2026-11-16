import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PHASE1_MODELS = [
  'Tenant',
  'User',
  'Wallet',
  'Quota',
  'PricingItem',
  'PointReservation',
  'PointLog',
  'MoneyLog',
  'Verification',
  'AgreementSignature',
  'Announcement',
  'AuditLog',
  'Keyword',
  'Question',
  'MediaCategory',
  'MediaAsset',
  'KnowledgeBase',
  'KnowledgeChunk',
  'PromptTemplate',
  'ArticleCategory',
  'AiTask',
  'AiTaskItem',
  'Article',
  'RewriteBatch',
  'RewriteRecord',
  'AiImageJob',
  'WorkRun',
  'WorkUnit',
  'ActiveWork',
  'CrudSample',
];

describe('phase-1 migration', () => {
  it('keeps the extension, checks, and HNSW index idempotent', () => {
    const migrationsDir = resolve(packageRoot, 'prisma/migrations');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect([...dirs].sort()).toEqual([
      '20261116120000_init',
      '20261116213000_queue_work',
      '20261116224500_queue_lease_timestamptz',
      '20261117010000_crud_sample',
    ]);
    const sql = readFileSync(
      resolve(migrationsDir, '20261116120000_init', 'migration.sql'),
      'utf8',
    );
    expect(sql).not.toContain('CrudSample');
    expect(sql).not.toContain('WorkUnit');
    const queueSql = readFileSync(
      resolve(migrationsDir, '20261116213000_queue_work', 'migration.sql'),
      'utf8',
    );
    expect(queueSql).toContain('CREATE TABLE "WorkRun"');
    expect(queueSql).toContain('CREATE TABLE "WorkUnit"');
    expect(queueSql).toContain('CREATE TABLE "ActiveWork"');
    expect(queueSql.toLowerCase()).not.toContain('drop table');
    expect(queueSql.toLowerCase()).not.toContain('create extension');
    const leaseSql = readFileSync(
      resolve(migrationsDir, '20261116224500_queue_lease_timestamptz', 'migration.sql'),
      'utf8',
    );
    expect(leaseSql).toContain("AT TIME ZONE 'UTC'");
    expect(leaseSql).toContain('"leaseUntil"');
    expect(leaseSql).toContain('"startedAt"');
    expect(leaseSql).toContain('"finishedAt"');
    expect(leaseSql).toContain('"beatAt"');
    expect(leaseSql.toLowerCase()).not.toContain('drop table');
    expect(queueSql).toContain('"leaseUntil" TIMESTAMP(3)');
    expect(queueSql).not.toContain('WITH TIME ZONE');
    const sampleSql = readFileSync(
      resolve(migrationsDir, '20261117010000_crud_sample', 'migration.sql'),
      'utf8',
    );
    expect(sampleSql).toContain('CREATE TABLE "CrudSample"');
    expect(sampleSql).not.toContain('DROP TABLE');
    expect(sampleSql.toLowerCase()).not.toContain('knowledgechunk');
    expect(sampleSql).not.toContain('WorkUnit');
    const schema = readFileSync(resolve(packageRoot, 'prisma/schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]);
    expect(models).toEqual(PHASE1_MODELS);

    const extensionStatements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => /CREATE\s+EXTENSION/i.test(statement));
    expect(extensionStatements.length).toBeGreaterThan(0);
    for (const statement of extensionStatements) {
      expect(statement).toMatch(/IF\s+NOT\s+EXISTS/i);
      expect(statement.toLowerCase()).toContain('vector');
    }
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(sql).toContain('chk_wallet_nonneg');
    expect(sql).toContain('chk_quota_nonneg');
    expect(sql).toContain('chk_resv');
    expect(sql).toContain('idx_kb_chunk_embedding');
    expect(sql.toLowerCase()).toContain('using hnsw');
    expect(sql.toLowerCase()).toContain('vector_cosine_ops');
    expect(sql.toLowerCase()).toContain('vector(1024)');
  });

  it('passes prisma validate', () => {
    const result = spawnSync('node', ['scripts/prisma-cli.mjs', 'validate'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
