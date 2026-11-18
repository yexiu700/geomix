import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LLM_COST_AUDIT_ACTION } from '@geomix/shared';
import type { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import { LlmService, type LlmCostRecord } from '../infra/llm';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminOfficeService } from './admin-office.service';

const repoRoot = resolve(__dirname, '../../../..');

describe('Issue #24: LLM daily cost report & ops deliverables', () => {
  it('persists LlmCostRecord through costSink and honors LLM_COST_RATES_JSON for real providers', async () => {
    const written: LlmCostRecord[] = [];
    const llm = LlmService.fromEnv(
      {
        LLM_PROVIDERS: '{}',
        LLM_COST_RATES_JSON: JSON.stringify({
          'fake/fake-cheap': { inputMicroPer1k: 5000, outputMicroPer1k: 10000 },
        }),
      },
      {
        costSink: {
          write(record) {
            written.push(record);
          },
        },
      },
    );

    const res = await llm.complete({
      tenantId: 'tenant-ops',
      scene: 'distill',
      idempotencyKey: 'ops-test-key-0001',
      messages: [{ role: 'user', content: '生成主词蒸馏测试问题' }],
    });

    expect(res.fake).toBe(true);
    expect(res.cost.costBasis).toBe('placeholder');
    expect(written).toHaveLength(1);
    expect(written[0]?.scene).toBe('distill');
    expect(written[0]?.tenantId).toBe('tenant-ops');
  });

  it('aggregates AuditLog llm_cost rows with deduplicated AiTaskItem and VisibilityObservation backfill', async () => {
    const now = new Date('2026-11-17T08:00:00.000Z');
    const prismaMock = {
      base: {
        auditLog: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'aud-1',
              tenantId: 'tenant-1',
              action: LLM_COST_AUDIT_ACTION,
              createdAt: new Date('2026-11-17T02:00:00.000Z'),
              payload: {
                idempotencyKey: 'ai_body:item-covered:0',
                scene: 'body',
                provider: 'deepseek',
                model: 'deepseek-chat',
                fake: false,
                tokensIn: 1000,
                tokensOut: 2000,
                costMicro: 18000,
              },
            },
            {
              id: 'aud-2',
              tenantId: 'tenant-1',
              action: LLM_COST_AUDIT_ACTION,
              createdAt: new Date('2026-11-17T03:00:00.000Z'),
              payload: {
                idempotencyKey: 'distill:kw-1',
                scene: 'distill',
                provider: 'fake',
                model: 'fake-cheap',
                fake: true,
                tokensIn: 200,
                tokensOut: 100,
                costMicro: 300,
              },
            },
          ]),
        },
        aiTaskItem: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'item-covered',
              model: 'deepseek-chat',
              tokensIn: 1000,
              tokensOut: 2000,
              finishedAt: new Date('2026-11-17T02:00:05.000Z'),
              task: { tenantId: 'tenant-1' },
            },
            {
              id: 'item-legacy',
              model: 'deepseek-chat',
              tokensIn: 500,
              tokensOut: 1500,
              finishedAt: new Date('2026-11-16T10:00:00.000Z'),
              task: { tenantId: 'tenant-2' },
            },
          ]),
        },
        visibilityObservation: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'obs-legacy',
              tenantId: 'tenant-2',
              judgeModel: 'deepseek-chat',
              tokensIn: 400,
              tokensOut: 100,
              checkedAt: new Date('2026-11-16T11:00:00.000Z'),
            },
          ]),
        },
        tenant: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'tenant-1', name: '甲租户' },
            { id: 'tenant-2', name: '乙租户' },
          ]),
        },
      },
    } as unknown as PrismaService;

    const service = new AdminOfficeService(prismaMock, {} as unknown as BillingService);

    const full = await service.llmCostReport(
      { userId: 'admin-1', role: 'ADMIN' },
      { days: '7', includeFake: 'true' },
      now,
    );

    expect(full.days).toBe(7);
    // aud-1 + aud-2 + item-legacy + obs-legacy = 4 (item-covered is deduplicated!)
    expect(full.totals.calls).toBe(4);
    expect(full.totals.realCalls).toBe(3);
    expect(full.totals.fakeCalls).toBe(1);
    expect(full.byTenant.map((t) => t.tenantName)).toContain('甲租户');
    expect(full.byTenant.map((t) => t.tenantName)).toContain('乙租户');

    const realOnly = await service.llmCostReport(
      { userId: 'admin-1', role: 'ADMIN' },
      { days: '7', includeFake: 'false' },
      now,
    );
    expect(realOnly.totals.calls).toBe(3);
    expect(realOnly.totals.fakeCalls).toBe(0);

    await expect(
      service.llmCostReport({ userId: 'm-1', role: 'MERCHANT' }, {}, now),
    ).rejects.toBeInstanceOf(ApiError);

    await expect(
      service.llmCostReport({ userId: 'admin-1', role: 'ADMIN' }, { days: '999' }, now),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('masks missing tenant names without exposing raw tenant CUIDs in byTenant (#202)', async () => {
    const now = new Date('2026-11-17T08:00:00.000Z');
    const missingCuid = 'cmwkm6lyw001g14g2qj5t1xxb';
    const prismaMock = {
      base: {
        auditLog: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'aud-cuid',
              tenantId: missingCuid,
              action: LLM_COST_AUDIT_ACTION,
              createdAt: new Date('2026-11-17T02:00:00.000Z'),
              payload: {
                idempotencyKey: 'distill:cuid-1',
                scene: 'distill',
                provider: 'fake',
                model: 'fake-cheap',
                fake: true,
                tokensIn: 100,
                tokensOut: 50,
                costMicro: 150,
              },
            },
          ]),
        },
        aiTaskItem: { findMany: vi.fn().mockResolvedValue([]) },
        visibilityObservation: { findMany: vi.fn().mockResolvedValue([]) },
        tenant: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as unknown as PrismaService;

    const service = new AdminOfficeService(prismaMock, {} as unknown as BillingService);
    const report = await service.llmCostReport(
      { userId: 'admin-1', role: 'ADMIN' },
      { days: '7', includeFake: 'true' },
      now,
    );

    expect(report.byTenant).toHaveLength(1);
    expect(report.byTenant[0]?.tenantName).toBe('租户 #5T1XXB');
    expect(report.byTenant[0]?.tenantName).not.toBe(missingCuid);
  });

  it('ships valid Nginx HTTPS template, optional tls compose profile, clean .env.example, and runnable ops scripts', () => {
    const nginxConf = readFileSync(resolve(repoRoot, 'docker/nginx/geomix.conf.template'), 'utf8');
    expect(nginxConf).toContain('listen 443 ssl;');
    expect(nginxConf).toContain('TLSv1.2 TLSv1.3');
    expect(nginxConf).toContain('proxy_pass http://api:3001;');
    expect(nginxConf).toContain('proxy_pass http://web:3000;');
    expect(nginxConf).toContain('X-Real-IP $remote_addr');
    expect(nginxConf).toContain('X-Forwarded-For $proxy_add_x_forwarded_for');
    expect(nginxConf).toContain('client_max_body_size 110m;');

    const prodCompose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    expect(prodCompose).toContain('\n  nginx:');
    expect(prodCompose).toContain("profiles: ['tls']");
    expect(prodCompose).toContain('NGINX_ENVSUBST_FILTER');

    const envExample = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
    expect(envExample).toContain('LLM_COST_RATES_JSON={}');
    expect(envExample).toContain('BILLING_MODE=SHADOW');
    expect(envExample).toContain('NGINX_SERVER_NAME=');
    expect(envExample).toContain('BACKUP_RETENTION_DAYS=7');
    expect(envExample).not.toMatch(/sk-[A-Za-z0-9]{16,}/);

    const manual = readFileSync(resolve(repoRoot, 'docs/运维与部署手册.md'), 'utf8');
    expect(manual).toContain('deploy-staging.sh');
    expect(manual).toContain('backup.sh');
    expect(manual).toContain('restore.sh');
    expect(manual).toContain('LLM_COST_RATES_JSON');

    for (const scriptRel of [
      'scripts/deploy-staging.sh',
      'scripts/backup.sh',
      'scripts/restore.sh',
    ]) {
      execFileSync('bash', ['-n', resolve(repoRoot, scriptRel)]);
    }

    const tmp = mkdtempSync(join(tmpdir(), 'geomix-ops-test-'));
    try {
      const stagingEnv = join(tmp, 'staging.env');
      writeFileSync(
        stagingEnv,
        [
          'GHCR_OWNER=yexiu700',
          'POSTGRES_PASSWORD=strong-staging-pg-pass-123',
          'MINIO_ROOT_PASSWORD=strong-staging-minio-pass-123',
          'JWT_ACCESS_SECRET=strong-staging-jwt-access-secret-123456',
          'JWT_REFRESH_SECRET=strong-staging-jwt-refresh-secret-123456',
          'STAGING_SELF_SIGNED_TLS=true',
          'BILLING_MODE=SHADOW',
        ].join('\n'),
      );

      const deployOut = execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/deploy-staging.sh'),
          '--env-file',
          stagingEnv,
          '--with-tls',
          '--seed',
          '--dry-run',
        ],
        { encoding: 'utf8' },
      );
      expect(deployOut).toContain('[DRY-RUN]');
      expect(deployOut).toContain('--profile tls');

      const backupOut = execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/backup.sh'),
          '--env-file',
          stagingEnv,
          '--output-dir',
          join(tmp, 'backups'),
          '--dry-run',
        ],
        { encoding: 'utf8' },
      );
      expect(backupOut).toContain('pg_dump -Fc');
      expect(backupOut).toContain('minio-data.tar.gz');

      const fakeBackupDir = join(tmp, 'sample-backup');
      execFileSync('mkdir', ['-p', fakeBackupDir]);
      writeFileSync(join(fakeBackupDir, 'postgres.dump'), 'dummy-pg');
      writeFileSync(join(fakeBackupDir, 'minio-data.tar.gz'), 'dummy-minio');
      writeFileSync(join(fakeBackupDir, 'manifest.json'), '{}');
      const sums = ['postgres.dump', 'minio-data.tar.gz', 'manifest.json']
        .map((name) => {
          const digest = createHash('sha256')
            .update(readFileSync(join(fakeBackupDir, name)))
            .digest('hex');
          return `${digest}  ${name}`;
        })
        .join('\n');
      writeFileSync(join(fakeBackupDir, 'SHA256SUMS'), `${sums}\n`);

      const restoreOut = execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/restore.sh'),
          '--backup-dir',
          fakeBackupDir,
          '--env-file',
          stagingEnv,
          '--dry-run',
        ],
        { encoding: 'utf8' },
      );
      expect(restoreOut).toContain('pg_restore');
      expect(restoreOut).toContain('[DRY-RUN]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
