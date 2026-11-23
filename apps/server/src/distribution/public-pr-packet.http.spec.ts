import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  parseEnv,
  type GeoPublishRecordDto,
  type PublicPrPacketDto,
  type PublicPrPacketSubmitResultDto,
} from '@geomix/shared';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { createApiApp } from '../common/create-api-app';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PrismaService } from '../prisma/prisma.service';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { currentTenantId } from '../tenant/tenant-context';
import { PublicPrPacketService } from './public-pr-packet.service';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type TaskRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  channelLabel: string;
  variantTitle: string;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: Record<string, unknown>;
  status: string;
  remotePublishedUrl: string | null;
  publishedAt: Date | null;
  lastError: string | null;
  shareTokenHash: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
};

type PublishRecordRow = {
  id: string;
  tenantId: string;
  articleId: string;
  distributionTaskId: string | null;
  publishedUrl: string;
  channel: string;
  publishedAt: Date;
};

const EXPECTED_PUBLIC_PR_KEYS = [
  'brandName',
  'category',
  'channelLabel',
  'draftHtml',
  'draftMarkdown',
  'expiresAt',
  'keyAngles',
  'locale',
  'market',
  'status',
  'submittedUrl',
  'suggestedTitle',
  'targetFanOuts',
  'targetPrompt',
  'verifiedFacts',
];

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

describe('PublicPrPacketController & PublicPrPacketService HTTP v2 (unauthenticated)', () => {
  const savedEnv = { ...process.env };
  let app: INestApplication;
  let baseUrl: string;
  let publicPrService: PublicPrPacketService;
  let tokenTenantB: string;

  const VALID_TOKEN = 'valid_pr_token_abcdefghijklmnopqrstuvwxyz_1234';
  const EXPIRED_TOKEN = 'expired_pr_token_abcdefghijklmnopqrstuvwxyz_56';
  const REVOKED_TOKEN = 'revoked_pr_token_abcdefghijklmnopqrstuvwxyz_78';
  const ARCHIVED_TOKEN = 'archived_pr_token_abcdefghijklmnopqrstuvwxyz_9';
  const UNKNOWN_TOKEN = 'unknown_pr_token_abcdefghijklmnopqrstuvwxyz_00';

  const tasks = new Map<string, TaskRow>();
  const publishRecords: PublishRecordRow[] = [];
  let createPublishRecordSpy: MockInstance<GeoDeliveryService['createPublishRecord']>;

  function seedState(): void {
    tasks.clear();
    publishRecords.length = 0;
    publicPrService?.resetRateLimits();

    const future = new Date(Date.now() + 30 * 86_400_000);
    const past = new Date(Date.now() - 3_600_000);

    const baseTask: Omit<
      TaskRow,
      'id' | 'shareTokenHash' | 'shareExpiresAt' | 'shareRevokedAt' | 'status'
    > = {
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_1',
      channelLabel: 'Tech Review Media',
      variantTitle: 'Acme Solar Power 2026 Press Kit',
      variantMarkdown: '## Highlights\n\nVerified 1200Wh LiFePO4 battery.',
      variantHtml: '<h2>Highlights</h2><p>Verified 1200Wh LiFePO4 battery.</p>',
      variantExtrasJson: {
        templateKey: 'PR_MEDIA_PACKET',
        _internalBatchKey: 'must_never_leak',
        factSheet: {
          brandName: 'Acme Energy',
          category: 'Portable Power',
          targetPrompt: 'Best portable solar generator 2026',
          targetFanOuts: ['1200Wh runtime', 'LiFePO4 safety'],
          keyAngles: ['Lab-tested 3000 cycles', 'Zero-noise camping mode'],
          verifiedFacts: [
            { title: 'Battery Capacity', summary: '1200Wh LiFePO4 rated for 3000 cycles' },
          ],
        },
      },
      remotePublishedUrl: null,
      publishedAt: null,
      lastError: null,
    };

    tasks.set('task_valid', {
      ...baseTask,
      id: 'task_valid',
      status: 'DRAFT_VARIANT',
      shareTokenHash: sha256(VALID_TOKEN),
      shareExpiresAt: future,
      shareRevokedAt: null,
    });
    tasks.set('task_expired', {
      ...baseTask,
      id: 'task_expired',
      status: 'DRAFT_VARIANT',
      shareTokenHash: sha256(EXPIRED_TOKEN),
      shareExpiresAt: past,
      shareRevokedAt: null,
    });
    tasks.set('task_revoked', {
      ...baseTask,
      id: 'task_revoked',
      status: 'DRAFT_VARIANT',
      shareTokenHash: sha256(REVOKED_TOKEN),
      shareExpiresAt: future,
      shareRevokedAt: past,
    });
    tasks.set('task_archived', {
      ...baseTask,
      id: 'task_archived',
      status: 'ARCHIVED',
      shareTokenHash: sha256(ARCHIVED_TOKEN),
      shareExpiresAt: future,
      shareRevokedAt: null,
    });
  }

  beforeAll(async () => {
    const env = parseEnv(process.env);
    app = await createApiApp();

    const future = new Date(Date.now() + 30 * 86_400_000);
    const prismaSvc = app.get(PrismaService) as unknown as { base: unknown; scoped: unknown };

    const scoped = {
      $disconnect: async () => undefined,
      auditLog: {
        findMany: async () => [],
        create: async () => ({ id: 'audit_1' }),
      },
      user: {
        findUnique: async (args: { where: { id?: string } }) => {
          if (args.where.id !== 'user_b') return null;
          return {
            id: 'user_b',
            tenantId: 'tenant_b',
            username: 'user_b',
            nickname: 'User B',
            role: 'MERCHANT',
            status: 'ACTIVE',
            passwordHash: 'hashed_pw',
            lastLoginAt: null,
            tenant: { id: 'tenant_b', name: 'Tenant B', isActive: true, expiresAt: future },
          };
        },
      },
      geoDistributionTask: {
        findUnique: async (args: { where: { shareTokenHash?: string } }) => {
          for (const row of tasks.values()) {
            if (row.shareTokenHash === args.where.shareTokenHash) {
              return { ...row };
            }
          }
          return null;
        },
        findFirst: async (args: { where: { id?: string } }) => {
          const tid = currentTenantId();
          const row = args.where.id ? tasks.get(args.where.id) : undefined;
          if (!row || row.tenantId !== tid) return null;
          return {
            ...row,
            brand: {
              name: 'Acme Energy',
              category: 'Portable Power',
              facts: [{ title: 'Private Fact', content: 'Fallback fact summary' }],
            },
            brandMarket: {
              market: 'GLOBAL',
              locale: 'en-US',
              localBrandName: 'Acme Energy',
              localCategory: 'Portable Power',
            },
            article: {
              targetPrompt: 'Best portable solar generator 2026',
              brief: { targetFanOuts: ['Fallback fanout'], outlineH2: ['Fallback angle'] },
            },
            publishRecords: publishRecords
              .filter((r) => r.tenantId === tid && r.distributionTaskId === row.id)
              .map((r) => ({ publishedUrl: r.publishedUrl })),
          };
        },
        update: async (args: { where: { id: string }; data: Partial<TaskRow> }) => {
          const tid = currentTenantId();
          const row = tasks.get(args.where.id);
          if (!row || row.tenantId !== tid) throw new Error('Not found');
          Object.assign(row, args.data);
          return { ...row };
        },
      },
      geoPublishRecord: {
        findFirst: async (args: { where: { articleId?: string; publishedUrl?: string } }) => {
          const tid = currentTenantId();
          return (
            publishRecords.find(
              (r) =>
                r.tenantId === tid &&
                r.articleId === args.where.articleId &&
                r.publishedUrl === args.where.publishedUrl,
            ) ?? null
          );
        },
      },
    };

    prismaSvc.base = scoped;
    prismaSvc.scoped = scoped;

    // Intercept DNS lookup inside OutboundHttpClient ONLY for our synthetic public hostname
    // while keeping real SSRF rejection for 127.0.0.1, 10.x, 169.254.169.254, localhost, sonargate
    const outbound = app.get(OutboundHttpClient);
    const origAssert = outbound.assertAllowedUrl.bind(outbound);
    vi.spyOn(outbound, 'assertAllowedUrl').mockImplementation(async (rawUrl, opts) => {
      const parsed = new URL(rawUrl);
      if (parsed.hostname === 'media.public-press.example') {
        return parsed;
      }
      return origAssert(rawUrl, opts);
    });

    const geoDelivery = app.get(GeoDeliveryService);
    createPublishRecordSpy = vi
      .spyOn(geoDelivery, 'createPublishRecord')
      .mockImplementation(async (articleId, input, auth): Promise<GeoPublishRecordDto> => {
        const now = new Date();
        const created: PublishRecordRow = {
          id: `pr_${publishRecords.length + 1}`,
          tenantId: auth.tenantId,
          articleId,
          distributionTaskId: input.distributionTaskId ?? null,
          publishedUrl: input.publishedUrl,
          channel: input.channel,
          publishedAt: now,
        };
        publishRecords.push(created);
        return {
          id: created.id,
          brandId: 'brand_a',
          brandMarketId: 'bm_global',
          articleId,
          publishedUrl: created.publishedUrl,
          channel: created.channel,
          publishedAt: now.toISOString(),
          baselineRunId: null,
          latestRetestRunId: null,
          beforeMetrics: null,
          afterMetrics: null,
          distributionTaskId: created.distributionTaskId,
          crawlStatus: 'PENDING',
          crawlCheckedAt: null,
          crawlReportJson: null,
          indexNowSubmitted: false,
          retestSchedules: [],
        };
      });

    publicPrService = app.get(PublicPrPacketService);

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const fp = passwordFingerprint('hashed_pw');
    const nowSec = Math.floor(Date.now() / 1000);
    tokenTenantB = signToken(
      {
        sub: 'user_b',
        tid: 'tenant_b',
        role: 'MERCHANT',
        typ: 'access',
        fp,
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );
  });

  beforeEach(() => {
    delete process.env.PUBLIC_PR_PACKET_GET_RATE_LIMIT_MAX;
    delete process.env.PUBLIC_PR_PACKET_SUBMIT_RATE_LIMIT_MAX;
    seedState();
    createPublishRecordSpy.mockClear();
  });

  afterAll(async () => {
    publicPrService?.resetRateLimits();
    if (app) await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
  });

  it('serves GET /api/v2/public/pr-packets/:token unauthenticated with strict 15-key allowlist and overrides cross-tenant bearer context', async () => {
    const res = await fetch(`${baseUrl}/api/v2/public/pr-packets/${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<PublicPrPacketDto>;
    expect(body.code).toBe(0);

    const keys = Object.keys(body.data).sort();
    expect(keys).toEqual(EXPECTED_PUBLIC_PR_KEYS);
    const serialized = JSON.stringify(body.data);
    expect(serialized).not.toContain('tenant_a');
    expect(serialized).not.toContain('brand_a');
    expect(serialized).not.toContain('art_1');
    expect(serialized).not.toContain('task_valid');
    expect(serialized).not.toContain('must_never_leak');
    expect(serialized).not.toContain(sha256(VALID_TOKEN));
    expect(body.data.brandName).toBe('Acme Energy');
    expect(body.data.verifiedFacts).toHaveLength(1);

    // Even when a logged-in user from Tenant B visits Tenant A's public PR link, runInTenant overrides cleanly
    const crossAuthRes = await fetch(`${baseUrl}/api/v2/public/pr-packets/${VALID_TOKEN}`, {
      headers: { authorization: `Bearer ${tokenTenantB}` },
    });
    expect(crossAuthRes.status).toBe(200);
    const crossBody = (await crossAuthRes.json()) as Envelope<PublicPrPacketDto>;
    expect(crossBody.data.brandName).toBe('Acme Energy');
  });

  it('returns uniform 404 for malformed, unknown, expired, revoked, and archived tokens on both GET and POST /submit (no token oracle)', async () => {
    const badTokens = ['short', UNKNOWN_TOKEN, EXPIRED_TOKEN, REVOKED_TOKEN, ARCHIVED_TOKEN];
    const seenMessages = new Set<string>();

    for (const tok of badTokens) {
      const getRes = await fetch(`${baseUrl}/api/v2/public/pr-packets/${tok}`);
      const getBody = (await getRes.json()) as Envelope<null>;
      expect(getRes.status).toBe(404);
      expect(getBody.code).toBe(AUTH_ERROR.NOT_FOUND);
      seenMessages.add(getBody.msg);

      // Even with a private IP payload, invalid tokens MUST still return 404 (not 400!)
      const postRes = await fetch(`${baseUrl}/api/v2/public/pr-packets/${tok}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publishedUrl: 'http://127.0.0.1/internal' }),
      });
      const postBody = (await postRes.json()) as Envelope<null>;
      expect(postRes.status).toBe(404);
      expect(postBody.code).toBe(AUTH_ERROR.NOT_FOUND);
      seenMessages.add(postBody.msg);
    }

    expect(seenMessages.size).toBe(1);
  });

  it('blocks SSRF / private IP URLs with 400 and idempotently records valid public URLs with autoRetest', async () => {
    const ssrfTargets = [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/secret',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/health',
      'http://sonargate:8080/api',
    ];

    for (const url of ssrfTargets) {
      const res = await fetch(`${baseUrl}/api/v2/public/pr-packets/${VALID_TOKEN}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publishedUrl: url }),
      });
      const body = (await res.json()) as Envelope<null>;
      expect(res.status).toBe(400);
      expect(body.code).toBe(API_ERROR.BAD_REQUEST);
    }
    expect(createPublishRecordSpy).not.toHaveBeenCalled();

    // Valid public URL -> first submit creates GeoPublishRecord + T+7/14/30 schedules and marks task PUBLISHED
    const first = await fetch(`${baseUrl}/api/v2/public/pr-packets/${VALID_TOKEN}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishedUrl: 'https://media.public-press.example/acme-2026' }),
    });
    const firstBody = (await first.json()) as Envelope<PublicPrPacketSubmitResultDto>;
    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      accepted: true,
      publishedUrl: 'https://media.public-press.example/acme-2026',
      alreadyRecorded: false,
    });
    expect(createPublishRecordSpy).toHaveBeenCalledWith(
      'art_1',
      expect.objectContaining({
        publishedUrl: 'https://media.public-press.example/acme-2026',
        channel: 'Tech Review Media',
        distributionTaskId: 'task_valid',
        autoRetest: { enabled: true },
      }),
      { tenantId: 'tenant_a', userId: 'public-pr-submit' },
    );
    expect(tasks.get('task_valid')?.status).toBe('PUBLISHED');
    expect(tasks.get('task_valid')?.remotePublishedUrl).toBe(
      'https://media.public-press.example/acme-2026',
    );

    // Duplicate submit of same URL -> idempotent replay (alreadyRecorded: true, no duplicate record)
    const second = await fetch(`${baseUrl}/api/v2/public/pr-packets/${VALID_TOKEN}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishedUrl: 'https://media.public-press.example/acme-2026' }),
    });
    const secondBody = (await second.json()) as Envelope<PublicPrPacketSubmitResultDto>;
    expect(second.status).toBe(200);
    expect(secondBody.data.alreadyRecorded).toBe(true);
    expect(createPublishRecordSpy).toHaveBeenCalledTimes(1);
  });

  it('enforces per-IP 429 rate limiting with Retry-After on both GET and POST /submit and resets via resetRateLimits()', async () => {
    process.env.PUBLIC_PR_PACKET_GET_RATE_LIMIT_MAX = '2';
    process.env.PUBLIC_PR_PACKET_SUBMIT_RATE_LIMIT_MAX = '2';

    expect((await fetch(`${baseUrl}/api/v2/public/pr-packets/${UNKNOWN_TOKEN}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/v2/public/pr-packets/${UNKNOWN_TOKEN}`)).status).toBe(404);
    const limitedGet = await fetch(`${baseUrl}/api/v2/public/pr-packets/${UNKNOWN_TOKEN}`);
    const limitedGetBody = (await limitedGet.json()) as Envelope<null>;
    expect(limitedGet.status).toBe(429);
    expect(limitedGetBody.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(limitedGet.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 2; i += 1) {
      const r = await fetch(`${baseUrl}/api/v2/public/pr-packets/${UNKNOWN_TOKEN}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publishedUrl: 'https://media.public-press.example/test' }),
      });
      expect(r.status).toBe(404);
    }
    const limitedPost = await fetch(`${baseUrl}/api/v2/public/pr-packets/${UNKNOWN_TOKEN}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishedUrl: 'https://media.public-press.example/test' }),
    });
    const limitedPostBody = (await limitedPost.json()) as Envelope<null>;
    expect(limitedPost.status).toBe(429);
    expect(limitedPostBody.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(limitedPost.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Reset clears buckets cleanly
    publicPrService.resetRateLimits();
    expect((await fetch(`${baseUrl}/api/v2/public/pr-packets/${VALID_TOKEN}`)).status).toBe(200);
  });
});
