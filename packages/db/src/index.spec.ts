import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB_PROVIDER, VECTOR_EXTENSION, isPostgresUrl } from './index';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('database contract', () => {
  it('recognizes PostgreSQL URLs', () => {
    expect(isPostgresUrl('postgresql://geomix:geomix@localhost:5432/geomix')).toBe(true);
    expect(isPostgresUrl('postgres://localhost/geomix')).toBe(true);
    expect(isPostgresUrl('mysql://localhost/geomix')).toBe(false);
  });

  it('pins PostgreSQL and leaves models for the schema issue', () => {
    const schema = readFileSync(resolve(repoRoot, 'packages/db/prisma/schema.prisma'), 'utf8');
    expect(schema).toContain(`provider = "${DB_PROVIDER}"`);
    expect(schema).toContain('env("DATABASE_URL")');
    expect(schema).not.toMatch(/^model /m);
  });

  it('brings up Postgres with pgvector, Redis, and MinIO', () => {
    const compose = readFileSync(resolve(repoRoot, 'docker-compose.yml'), 'utf8');
    const initSql = readFileSync(resolve(repoRoot, 'docker/postgres/init/01-vector.sql'), 'utf8');

    expect(compose).toContain('pgvector/pgvector:pg16');
    expect(compose).toContain('redis:7-alpine');
    expect(compose).toContain('cgr.dev/chainguard/minio@sha256:');
    expect(compose).toContain('./docker/postgres/init:/docker-entrypoint-initdb.d:ro');
    expect(initSql).toContain(`CREATE EXTENSION IF NOT EXISTS ${VECTOR_EXTENSION}`);
  });
});
