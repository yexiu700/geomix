import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMA_MODELS = [
  'Tenant',
  'User',
  'Wallet',
  'Quota',
  'PricingItem',
  'PointReservation',
  'PointLog',
  'MoneyLog',
  'Verification',
  'Announcement',
  'AuditLog',
  'WorkRun',
  'WorkUnit',
  'ActiveWork',
  'Brand',
  'BrandMarket',
  'BrandFact',
  'BrandFactChunk',
  'BrandMediaAsset',
  'VisibilityRun',
  'VisibilityObservation',
  'VisibilityCitation',
  'GeoBrief',
  'GeoArticle',
  'GeoPublishRecord',
  'GeoBatchJob',
  'PromptPreference',
  'ChannelConnection',
  'GeoDistributionTask',
  'GeoRetestSchedule',
  'GeoVariantJob',
];

describe('schema migrations contract', () => {
  it('keeps legacy migrations immutable and adds the v2 domain migration with HNSW index', () => {
    const migrationsDir = resolve(packageRoot, 'prisma/migrations');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect([...dirs].sort()).toEqual([
      '20261116120000_init',
      '20261116213000_queue_work',
      '20261116224500_queue_lease_timestamptz',
      '20261117010000_crud_sample',
      '20261117120000_visibility',
      '20261118083000_media_asset_original_name',
      '20261118090000_announcement_audit_fields',
      '20261118120000_ai_task_nullable_media_category',
      '20261118130000_rewrite_optional_gallery',
      '20261118150000_rewrite_batch_brand',
      '20261120100000_geomix_v2_domain_schema',
      '20261122090000_brand_market_local_category',
      '20261123090000_geomix_v2_1_distribution',
      '20261124090000_geomix_v2_1_variant_jobs',
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
    const visibilitySql = readFileSync(
      resolve(migrationsDir, '20261117120000_visibility', 'migration.sql'),
      'utf8',
    );
    expect(visibilitySql).toContain('CREATE TABLE "VisibilityProfile"');
    expect(visibilitySql).toContain('CREATE TABLE "VisibilityRun"');
    expect(visibilitySql).toContain('CREATE TABLE "VisibilityObservation"');
    expect(visibilitySql).toContain('CREATE TABLE "VisibilityCitation"');
    expect(visibilitySql).toContain('VisibilityObservation_runId_promptText_engine_key');
    expect(visibilitySql.toLowerCase()).not.toContain('drop table');
    expect(visibilitySql.toLowerCase()).not.toContain('create extension');
    const mediaNameSql = readFileSync(
      resolve(migrationsDir, '20261118083000_media_asset_original_name', 'migration.sql'),
      'utf8',
    );
    expect(mediaNameSql).toContain('ALTER TABLE "MediaAsset" ADD COLUMN "originalName" TEXT');
    expect(mediaNameSql.toLowerCase()).not.toContain('drop');
    const announcementSql = readFileSync(
      resolve(migrationsDir, '20261118090000_announcement_audit_fields', 'migration.sql'),
      'utf8',
    );
    expect(announcementSql).toContain('ALTER TABLE "Announcement"');
    expect(announcementSql).toContain('ADD COLUMN IF NOT EXISTS "createdAt"');
    expect(announcementSql).toContain('ADD COLUMN IF NOT EXISTS "operatorName"');
    expect(announcementSql.toLowerCase()).not.toContain('drop table');
    expect(announcementSql.toLowerCase()).not.toContain('create extension');
    const rewriteOptGallerySql = readFileSync(
      resolve(migrationsDir, '20261118130000_rewrite_optional_gallery', 'migration.sql'),
      'utf8',
    );
    expect(rewriteOptGallerySql).toContain(
      'ALTER TABLE "RewriteBatch" ALTER COLUMN "mediaCategoryId" DROP NOT NULL;',
    );
    expect(rewriteOptGallerySql).toContain(
      'ALTER TABLE "RewriteRecord" ALTER COLUMN "mediaCategoryId" DROP NOT NULL;',
    );
    expect(rewriteOptGallerySql).toContain('ON DELETE SET NULL');
    expect(rewriteOptGallerySql.toLowerCase()).not.toContain('drop table');
    expect(rewriteOptGallerySql.toLowerCase()).not.toContain('create extension');
    const rewriteBatchBrandSql = readFileSync(
      resolve(migrationsDir, '20261118150000_rewrite_batch_brand', 'migration.sql'),
      'utf8',
    );
    expect(rewriteBatchBrandSql).toContain(
      'ALTER TABLE "RewriteBatch" ADD COLUMN IF NOT EXISTS "brand" TEXT;',
    );
    expect(rewriteBatchBrandSql).toContain('ADD COLUMN IF NOT EXISTS "resultStatus"');
    expect(rewriteBatchBrandSql.toLowerCase()).not.toContain('drop table');
    expect(rewriteBatchBrandSql.toLowerCase()).not.toContain('create extension');
    const v2Sql = readFileSync(
      resolve(migrationsDir, '20261120100000_geomix_v2_domain_schema', 'migration.sql'),
      'utf8',
    );
    expect(v2Sql.toLowerCase()).not.toContain('create extension');
    expect(v2Sql).toContain('DROP TABLE IF EXISTS "Keyword" CASCADE;');
    expect(v2Sql).toContain('DROP TABLE IF EXISTS "VisibilityProfile" CASCADE;');
    expect(v2Sql).toContain('CREATE TABLE "Brand"');
    expect(v2Sql).toContain('CREATE TABLE "BrandMarket"');
    expect(v2Sql).toContain('CREATE TABLE "BrandFactChunk"');
    expect(v2Sql).toContain('CREATE TABLE "GeoBrief"');
    expect(v2Sql).toContain('CREATE TABLE "GeoArticle"');
    expect(v2Sql).toContain('CREATE TABLE "GeoPublishRecord"');
    expect(v2Sql).toContain('CREATE TABLE "GeoBatchJob"');
    expect(v2Sql).toContain('CREATE TABLE "PromptPreference"');
    expect(v2Sql).toContain('idx_brand_fact_chunk_embedding');
    expect(v2Sql.toLowerCase()).toContain('using hnsw');
    expect(v2Sql.toLowerCase()).toContain('vector_cosine_ops');
    expect(v2Sql.toLowerCase()).toContain('vector(1024)');
    const v21Sql = readFileSync(
      resolve(migrationsDir, '20261123090000_geomix_v2_1_distribution', 'migration.sql'),
      'utf8',
    );
    expect(v21Sql).toContain('CREATE TABLE "ChannelConnection"');
    expect(v21Sql).toContain('CREATE TABLE "GeoDistributionTask"');
    expect(v21Sql).toContain('CREATE TABLE "GeoRetestSchedule"');
    expect(v21Sql).toContain('ALTER TABLE "GeoPublishRecord"');
    expect(v21Sql).toContain('VisibilityObservation_runId_promptText_engine_sampleIndex_key');
    expect(v21Sql).toContain("'geo_variant'");
    expect(v21Sql).toContain('ON DELETE SET NULL');
    expect(v21Sql.toLowerCase()).not.toContain('drop table');
    expect(v21Sql.toLowerCase()).not.toContain('create extension');
    const variantJobSql = readFileSync(
      resolve(migrationsDir, '20261124090000_geomix_v2_1_variant_jobs', 'migration.sql'),
      'utf8',
    );
    expect(variantJobSql).toContain('CREATE TABLE IF NOT EXISTS "GeoVariantJob"');
    expect(variantJobSql).toContain('GeoVariantJob_tenantId_articleId_idempotencyKey_key');
    expect(variantJobSql.toLowerCase()).not.toContain('drop table');
    expect(variantJobSql.toLowerCase()).not.toContain('create extension');
    const schema = readFileSync(resolve(packageRoot, 'prisma/schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]);
    expect(models).toEqual(SCHEMA_MODELS);

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
