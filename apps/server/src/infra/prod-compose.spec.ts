import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv, resolveStorageSettings } from '@geomix/shared';

const repoRoot = resolve(__dirname, '../../../..');

describe('production deployment & auto-merge CD configuration (#63)', () => {
  it('enforces s3 storage driver and complete MinIO env mapping for api and worker in docker-compose.prod.yml', () => {
    const compose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    const apiSection = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
    const workerSection = compose.slice(
      compose.indexOf('\n  worker:'),
      compose.indexOf('\n  web:'),
    );

    for (const [name, section] of [
      ['api', apiSection],
      ['worker', workerSection],
    ] as const) {
      expect(section, `${name} should set STORAGE_DRIVER=s3`).toContain(
        'STORAGE_DRIVER: ${STORAGE_DRIVER:-s3}',
      );
      expect(section, `${name} should wait for minio-init bucket creation`).toContain(
        'minio-init:',
      );
      expect(section, `${name} should configure S3_ENDPOINT`).toContain('http://minio:9000');
      expect(section, `${name} should configure S3_BUCKET`).toContain(
        'S3_BUCKET: ${S3_BUCKET:-geomix}',
      );
      expect(section, `${name} should map S3_ACCESS_KEY_ID`).toContain('S3_ACCESS_KEY_ID:');
      expect(section, `${name} should map S3_SECRET_ACCESS_KEY`).toContain('S3_SECRET_ACCESS_KEY:');
      expect(section, `${name} should configure S3_FORCE_PATH_STYLE`).toContain(
        'S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-true}',
      );
    }

    const simulatedProdEnv = {
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'geomix',
      S3_ACCESS_KEY_ID: 'geomix',
      S3_SECRET_ACCESS_KEY: 'prod-minio-secret',
      S3_FORCE_PATH_STYLE: 'true',
    };
    expect(resolveStorageSettings(simulatedProdEnv).driver).toBe('s3');
    const parsed = parseEnv(simulatedProdEnv);
    expect(parsed.S3_ENDPOINT).toBe('http://minio:9000');
    expect(parsed.S3_SECRET_ACCESS_KEY).toBe('prod-minio-secret');
  });

  it('matches PR branch name without owner prefix and chains cd.yml in auto-merge.yml', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/auto-merge.yml'), 'utf8');
    expect(workflow).not.toContain('--head "${OWNER}:${HEAD_BRANCH}"');
    expect(workflow).toContain('--head "$HEAD_BRANCH"');
    expect(workflow).toContain('uses: ./.github/workflows/cd.yml');
    expect(workflow).toContain("needs.merge-on-ci.outputs.should_deploy == 'true'");
  });
});
