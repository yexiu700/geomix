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
];

describe('phase-1 migration', () => {
  it('keeps the extension, checks, and HNSW index idempotent', () => {
    const migrationsDir = resolve(packageRoot, 'prisma/migrations');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(dirs).toHaveLength(1);
    const sql = readFileSync(resolve(migrationsDir, dirs[0] ?? '', 'migration.sql'), 'utf8');
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
