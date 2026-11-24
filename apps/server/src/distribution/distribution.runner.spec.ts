import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  L1_CHANNEL_PROVIDERS,
  type GeoPublishRecordDto,
  type L1ChannelProvider,
} from '@geomix/shared';
import { ApiModule } from '../api.module';
import type { QuotaService } from '../billing/quota.service';
import { SecretBox } from '../common/secret-box';
import type { OutboundHttpClient } from '../infra/outbound-http';
import { PrismaService } from '../prisma/prisma.service';
import type { MaintenanceRunner } from '../queue/maintenance.runner';
import { QueueProducer } from '../queue/queue.producer';
import { QueueRuntime } from '../queue/queue.runtime';
import type { WorkDriver } from '../queue/work-driver';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { currentTenantId } from '../tenant/tenant-context';
import { WorkerModule } from '../worker.module';
import type { WorkerRuntimeService } from '../worker/worker-runtime.service';
import { ConnectionsService } from './connections.service';
import {
  CmsConnectorRegistry,
  DevtoConnector,
  GhostConnector,
  GithubMdxConnector,
  HashnodeConnector,
  ShopifyConnector,
  WebflowConnector,
  WebhookConnector,
  WechatOfficialConnector,
  WordPressConnector,
} from './connectors';
import {
  ConnectorError,
  type CmsConnector,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
} from './connectors/types';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { CrawlProbeService } from './crawl-probe.service';
import {
  DISTRIBUTION_ENQUEUER,
  DISTRIBUTION_HANDLER,
  DistributionRunner,
} from './distribution.runner';
import { IndexNowService } from './indexnow.service';
import { RetestSchedulerService } from './retest-scheduler.service';

type TaskRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  connectionId: string | null;
  provider: string;
  mode: string;
  channelLabel: string;
  targetLocale?: string | null;
  variantTitle: string;
  variantSlug: string | null;
  variantMetaDesc: string | null;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: Record<string, unknown>;
  status: string;
  publishAsDraft: boolean;
  remotePostId: string | null;
  remoteAdminUrl: string | null;
  remotePublishedUrl: string | null;
  indexNowStatus: string | null;
  lastError: string | null;
  publishedAt: Date | null;
};

type ConnectionRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  credentialsCiphertext: string;
  credentialsIv: string;
  credentialsTag: string;
  keyVersion: number;
  configJson: Record<string, unknown>;
  status: string;
  authType: string;
  targetLocale?: string | null;
};

type PublishRecordRow = {
  id: string;
  tenantId: string;
  articleId: string;
  distributionTaskId: string | null;
  publishedUrl: string;
  channel: string;
  indexNowSubmitted: boolean;
};

function makeRunnerHarness(initial?: {
  task?: Partial<TaskRow>;
  connection?: Partial<ConnectionRow> | null;
  existingRecords?: PublishRecordRow[];
  connectionsOverride?: ConnectionsService;
  connectorsOverride?: CmsConnectorRegistry;
}) {
  const tenantId = 'tenant_a';
  const connection: ConnectionRow | null =
    initial?.connection === null
      ? null
      : {
          id: 'conn_wp_1',
          tenantId,
          brandId: 'brand_1',
          brandMarketId: 'bm_1',
          provider: 'WORDPRESS',
          displayName: 'Global WP Blog',
          siteBaseUrl: 'https://blog.acme.example',
          credentialsCiphertext: 'enc_ct',
          credentialsIv: 'enc_iv',
          credentialsTag: 'enc_tag',
          keyVersion: 1,
          configJson: { indexNowKey: 'idx_key_secret_999' },
          status: 'ACTIVE',
          authType: 'API_KEY',
          ...initial?.connection,
        };

  const task: TaskRow = {
    id: 'task_1',
    tenantId,
    brandId: 'brand_1',
    brandMarketId: 'bm_1',
    articleId: 'art_1',
    connectionId: connection?.id ?? null,
    provider: 'WORDPRESS',
    mode: 'L1_API',
    channelLabel: 'Official Blog',
    variantTitle: 'Acme Battery Review',
    variantSlug: 'acme-battery-review',
    variantMetaDesc: 'Independent lab test of Acme Battery across 300 charge cycles.',
    variantMarkdown: '# Acme Battery Review\n\nVerified specs.',
    variantHtml: '<h1>Acme Battery Review</h1><p>Verified specs.</p>',
    variantExtrasJson: {
      templateKey: 'OWNED_BLOG_SEO_GEO',
      _publishIdempotencyKey: 'idem_secret_internal',
      _publishRequestFingerprint: 'fp_internal',
      targetId: 'cat_9',
    },
    status: 'PUBLISHING',
    publishAsDraft: false,
    remotePostId: null,
    remoteAdminUrl: null,
    remotePublishedUrl: null,
    indexNowStatus: null,
    lastError: null,
    publishedAt: null,
    ...initial?.task,
  };

  const article = {
    id: 'art_1',
    title: 'Master Article',
    targetPrompt: 'Best portable battery 2026',
    schemaJsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: 'Master' },
    llmsTxtSnippet: '- [Acme Battery](https://blog.acme.example): Verified review',
    tags: ['battery', 'review'],
    status: 'DRAFT',
  };

  const brandMarket = {
    id: 'bm_1',
    market: 'GLOBAL',
    locale: 'en-US',
    ownedDomains: ['blog.acme.example'],
  };

  const records: PublishRecordRow[] = [...(initial?.existingRecords ?? [])];
  const seenTenantIds: Array<string | undefined> = [];

  const prisma = {
    scoped: {
      geoDistributionTask: {
        findFirst: vi.fn(async (args: { where: { id: string } }) => {
          const tid = currentTenantId();
          seenTenantIds.push(tid);
          if (args.where.id !== task.id || task.tenantId !== tid) return null;
          return {
            ...task,
            article,
            brandMarket,
            connection:
              task.connectionId && connection?.id === task.connectionId ? connection : null,
          };
        }),
        update: vi.fn(async (args: { where: { id: string }; data: Partial<TaskRow> }) => {
          seenTenantIds.push(currentTenantId());
          Object.assign(task, args.data);
          return { ...task };
        }),
        updateMany: vi.fn(async (args: { where: { id: string }; data: Partial<TaskRow> }) => {
          seenTenantIds.push(currentTenantId());
          if (args.where.id !== task.id) return { count: 0 };
          Object.assign(task, args.data);
          return { count: 1 };
        }),
      },
      geoPublishRecord: {
        findFirst: vi.fn(
          async (args: {
            where: { articleId: string; distributionTaskId: string; publishedUrl: string };
          }) => {
            const tid = currentTenantId();
            return (
              records.find(
                (r) =>
                  r.tenantId === tid &&
                  r.articleId === args.where.articleId &&
                  r.distributionTaskId === args.where.distributionTaskId &&
                  r.publishedUrl === args.where.publishedUrl,
              ) ?? null
            );
          },
        ),
        update: vi.fn(async (args: { where: { id: string }; data: Partial<PublishRecordRow> }) => {
          const rec = records.find((r) => r.id === args.where.id);
          if (!rec) throw new Error('Not found');
          Object.assign(rec, args.data);
          return { ...rec };
        }),
      },
    },
  } as unknown as PrismaService;

  const decryptedSecret = {
    username: 'wp-editor',
    applicationPassword: 'shpat_super_secret_token_999',
  };

  const connections = {
    decryptCredentials: vi.fn(() => decryptedSecret),
    sanitizeConnectionError: vi.fn((raw: string, creds?: Record<string, string>) => {
      let cleaned = raw;
      if (creds) {
        for (const val of Object.values(creds)) {
          if (val && val.length >= 4) {
            cleaned = cleaned.split(val).join('[REDACTED]');
          }
        }
      }
      return cleaned;
    }),
  } as unknown as ConnectionsService;

  const publishMock = vi.fn<CmsConnector['publish']>(
    async (_conn, _secrets, payload: ConnectorPublishPayload): Promise<ConnectorPublishResult> => ({
      remotePostId: 'wp_post_101',
      remoteAdminUrl: 'https://blog.acme.example/wp-admin/post.php?post=101',
      remotePublishedUrl: payload.publishAsDraft
        ? undefined
        : 'https://blog.acme.example/acme-battery-review',
      publishedAsDraft: payload.publishAsDraft,
    }),
  );

  const connectors = {
    get: vi.fn(() => ({
      provider: 'WORDPRESS',
      testConnection: vi.fn(),
      listTargets: vi.fn(),
      publish: publishMock,
    })),
  } as unknown as CmsConnectorRegistry;

  const indexNow = {
    submit: vi.fn(async () => ({
      submitted: true,
      status: 'SUBMITTED' as const,
      reason: 'OK' as const,
      statusText: 'SUBMITTED',
      submittedUrls: ['https://blog.acme.example/acme-battery-review'],
    })),
  } as unknown as IndexNowService;

  const geoDelivery = {
    createPublishRecord: vi.fn(
      async (
        articleId: string,
        input: {
          publishedUrl: string;
          channel: string;
          publishedAt?: string;
          distributionTaskId?: string | null;
          indexNowSubmitted?: boolean;
          autoRetest?: { enabled?: boolean };
        },
        auth: { tenantId: string; userId: string },
      ): Promise<GeoPublishRecordDto> => {
        const created: PublishRecordRow = {
          id: `pr_${records.length + 1}`,
          tenantId: auth.tenantId,
          articleId,
          distributionTaskId: input.distributionTaskId ?? null,
          publishedUrl: input.publishedUrl,
          channel: input.channel,
          indexNowSubmitted: Boolean(input.indexNowSubmitted),
        };
        records.push(created);
        return {
          id: created.id,
          brandId: 'brand_1',
          brandMarketId: 'bm_1',
          articleId,
          publishedUrl: input.publishedUrl,
          channel: input.channel,
          publishedAt: input.publishedAt ?? new Date().toISOString(),
          baselineRunId: null,
          latestRetestRunId: null,
          beforeMetrics: null,
          afterMetrics: null,
          distributionTaskId: created.distributionTaskId,
          crawlStatus: 'PENDING',
          crawlCheckedAt: null,
          crawlReportJson: null,
          indexNowSubmitted: created.indexNowSubmitted,
          retestSchedules: [],
        };
      },
    ),
  } as unknown as GeoDeliveryService;

  const resolvedConnections = initial?.connectionsOverride ?? connections;
  const resolvedConnectors = initial?.connectorsOverride ?? connectors;
  const runner = new DistributionRunner(
    prisma,
    resolvedConnections,
    resolvedConnectors,
    indexNow,
    geoDelivery,
  );

  return {
    tenantId,
    task,
    records,
    seenTenantIds,
    runner,
    publishMock,
    connections: resolvedConnections,
    connectors,
    indexNow,
    geoDelivery,
    prisma,
  };
}

describe('DistributionRunner, QueueProducer & WorkerModule wiring', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
  });

  it('pushes draft to DRAFT_PUSHED without creating GeoPublishRecord or calling IndexNow', async () => {
    const h = makeRunnerHarness({ task: { publishAsDraft: true } });

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.seenTenantIds.every((id) => id === 'tenant_a')).toBe(true);
    expect(h.task.status).toBe('DRAFT_PUSHED');
    expect(h.task.remotePostId).toBe('wp_post_101');
    expect(h.task.remoteAdminUrl).toContain('/wp-admin/post.php');
    expect(h.task.remotePublishedUrl).toBeNull();
    expect(h.task.lastError).toBeNull();
    expect(h.indexNow.submit).not.toHaveBeenCalled();
    expect(h.geoDelivery.createPublishRecord).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(0);
  });

  it('pushes live to PUBLISHED, submits IndexNow, auto-creates GeoPublishRecord with autoRetest, strips internal _* extras, and falls back to article JSON-LD', async () => {
    const h = makeRunnerHarness({ task: { publishAsDraft: false } });

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.publishMock).toHaveBeenCalledTimes(1);
    const payload = h.publishMock.mock.calls[0]?.[2];
    expect(payload?.schemaJsonLd).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Master',
    });
    expect(payload?.llmsTxtSnippet).toContain('Acme Battery');
    expect(payload?.extras).toEqual({ templateKey: 'OWNED_BLOG_SEO_GEO', targetId: 'cat_9' });
    expect(payload?.extras).not.toHaveProperty('_publishIdempotencyKey');

    expect(h.indexNow.submit).toHaveBeenCalledWith({
      urls: ['https://blog.acme.example/acme-battery-review'],
      indexNowKey: 'idx_key_secret_999',
      keyLocation: undefined,
    });
    expect(h.geoDelivery.createPublishRecord).toHaveBeenCalledWith(
      'art_1',
      expect.objectContaining({
        publishedUrl: 'https://blog.acme.example/acme-battery-review',
        channel: 'Official Blog',
        distributionTaskId: 'task_1',
        indexNowSubmitted: true,
        autoRetest: { enabled: true },
      }),
      { tenantId: 'tenant_a', userId: 'system-distribution-runner' },
    );

    expect(h.task.status).toBe('PUBLISHED');
    expect(h.task.remotePublishedUrl).toBe('https://blog.acme.example/acme-battery-review');
    expect(h.task.indexNowStatus).toBe('SUBMITTED');
    expect(h.task.publishedAt).toBeInstanceOf(Date);
    expect(h.task.lastError).toBeNull();
  });

  it('treats IndexNow errors or exceptions as strictly non-blocking during live publish', async () => {
    const h = makeRunnerHarness({ task: { publishAsDraft: false } });
    vi.mocked(h.indexNow.submit).mockRejectedValueOnce(new Error('IndexNow 500 timeout'));

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.task.status).toBe('PUBLISHED');
    expect(h.task.indexNowStatus).toBe('FAILED:ERROR');
    expect(h.geoDelivery.createPublishRecord).toHaveBeenCalledWith(
      'art_1',
      expect.objectContaining({
        indexNowSubmitted: false,
        autoRetest: { enabled: true },
      }),
      expect.anything(),
    );
  });

  it('avoids creating duplicate GeoPublishRecord when record already exists for the task & URL', async () => {
    const h = makeRunnerHarness({
      task: { publishAsDraft: false },
      existingRecords: [
        {
          id: 'pr_existing',
          tenantId: 'tenant_a',
          articleId: 'art_1',
          distributionTaskId: 'task_1',
          publishedUrl: 'https://blog.acme.example/acme-battery-review',
          channel: 'Official Blog',
          indexNowSubmitted: false,
        },
      ],
    });

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.geoDelivery.createPublishRecord).not.toHaveBeenCalled();
    expect(h.records[0]?.indexNowSubmitted).toBe(true);
    expect(h.task.status).toBe('PUBLISHED');
  });

  it('catches connector failure, transitions to FAILED, and redacts credentials from lastError', async () => {
    const h = makeRunnerHarness({ task: { publishAsDraft: false } });
    h.publishMock.mockRejectedValueOnce(
      new ConnectorError(
        'WORDPRESS',
        'AUTH_FAILED',
        'Upstream 401 rejected token shpat_super_secret_token_999',
        401,
      ),
    );

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.task.status).toBe('FAILED');
    expect(h.task.lastError).toBeTruthy();
    expect(h.task.lastError).not.toContain('shpat_super_secret_token_999');
    expect(h.task.lastError).toContain('[REDACTED]');
    expect(h.geoDelivery.createPublishRecord).not.toHaveBeenCalled();
  });

  it('skips tasks not in PUBLISHING state and fails disabled/invalid/mismatched/non-L1 tasks safely without decrypting or publishing', async () => {
    const hSkipped = makeRunnerHarness({ task: { status: 'PUBLISHED' } });
    await hSkipped.runner.process({ tenantId: hSkipped.tenantId, taskId: 'task_1' });
    expect(hSkipped.publishMock).not.toHaveBeenCalled();

    const hDisabled = makeRunnerHarness({ connection: { status: 'DISABLED' } });
    await hDisabled.runner.process({ tenantId: hDisabled.tenantId, taskId: 'task_1' });
    expect(hDisabled.task.status).toBe('FAILED');
    expect(hDisabled.connections.decryptCredentials).not.toHaveBeenCalled();
    expect(hDisabled.publishMock).not.toHaveBeenCalled();

    const hInvalid = makeRunnerHarness({ connection: { status: 'INVALID' } });
    await hInvalid.runner.process({ tenantId: hInvalid.tenantId, taskId: 'task_1' });
    expect(hInvalid.task.status).toBe('FAILED');
    expect(hInvalid.connections.decryptCredentials).not.toHaveBeenCalled();
    expect(hInvalid.publishMock).not.toHaveBeenCalled();

    const hWrongBrand = makeRunnerHarness({ connection: { brandId: 'brand_other' } });
    await hWrongBrand.runner.process({ tenantId: hWrongBrand.tenantId, taskId: 'task_1' });
    expect(hWrongBrand.task.status).toBe('FAILED');
    expect(hWrongBrand.connections.decryptCredentials).not.toHaveBeenCalled();
    expect(hWrongBrand.publishMock).not.toHaveBeenCalled();

    const hWrongMarket = makeRunnerHarness({ connection: { brandMarketId: 'bm_other' } });
    await hWrongMarket.runner.process({ tenantId: hWrongMarket.tenantId, taskId: 'task_1' });
    expect(hWrongMarket.task.status).toBe('FAILED');
    expect(hWrongMarket.connections.decryptCredentials).not.toHaveBeenCalled();
    expect(hWrongMarket.publishMock).not.toHaveBeenCalled();

    const hNonL1 = makeRunnerHarness({ task: { provider: 'PR_PACKET' } });
    await hNonL1.runner.process({ tenantId: hNonL1.tenantId, taskId: 'task_1' });
    expect(hNonL1.task.status).toBe('FAILED');
  });

  it('redacts Shopify, WP Basic Base64, Webflow Bearer, Webhook HMAC, upper/lower/mixed URL-encoded, form-urlencoded +, and connConfig.indexNowKey/Location via real ConnectionsService + SecretBox', async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 0x37).toString('base64');
    const secretBox = new SecretBox();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const shopifyToken = 'shpat_live_secret_987654321';
    const webflowToken = 'wf_secret_tok_999';
    const webhookSecret = 'whsec_very_secret_hmac_key';
    const hmacSig = 'sha256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const encodedToken = 'tok+live/987=abc';
    const wpUser = 'wp-admin';
    const wpAppPassword = 'abcd efgh ijkl mnop';
    const wpBase64 = Buffer.from(`${wpUser}:${wpAppPassword}`, 'utf8').toString('base64');
    const wpBase64LowerEncoded = encodeURIComponent(wpBase64).replace(/%[0-9A-F]{2}/g, (m) =>
      m.toLowerCase(),
    );
    const indexNowKey = 'my_indexnow_secret_key_998877';
    const indexNowKeyLocation = `https://blog.acme.example/${indexNowKey}.txt`;
    const indexNowKeyLocationLowerEncoded = encodeURIComponent(indexNowKeyLocation).replace(
      /%[0-9A-F]{2}/g,
      (m) => m.toLowerCase(),
    );

    const encrypted = secretBox.encryptJson({
      accessToken: shopifyToken,
      apiToken: webflowToken,
      signingSecret: webhookSecret,
      extraToken: encodedToken,
      username: wpUser,
      appPassword: wpAppPassword,
    });

    const realConnections = new ConnectionsService(
      {} as PrismaService,
      {} as QuotaService,
      secretBox,
      {} as OutboundHttpClient,
      {} as CmsConnectorRegistry,
    );

    const vectors: Array<{
      label: string;
      message: string;
      sentinel: string;
      forbidden: string[];
    }> = [
      {
        label: 'shopify-and-webflow-bearer',
        message: `Shopify X-Shopify-Access-Token: ${shopifyToken} | Authorization: Bearer ${webflowToken} | END_V1`,
        sentinel: 'END_V1',
        forbidden: [shopifyToken, webflowToken],
      },
      {
        label: 'webhook-hmac',
        message: `Webhook secret=${webhookSecret} X-GeoMix-Signature: ${hmacSig} | END_V2`,
        sentinel: 'END_V2',
        forbidden: [webhookSecret, hmacSig],
      },
      {
        label: 'wp-basic-base64-and-form-plus',
        message: `Authorization: Basic ${wpBase64} bare=${wpBase64} enc=${wpBase64LowerEncoded} app_password=abcd+efgh+ijkl+mnop | END_V3`,
        sentinel: 'END_V3',
        forbidden: [wpAppPassword, 'abcd+efgh+ijkl+mnop', wpBase64, wpBase64LowerEncoded],
      },
      {
        label: 'url-encoded-upper-lower-mixed',
        message: `upper=tok%2Blive%2F987%3Dabc lower=tok%2blive%2f987%3dabc mixed=tok%2Blive%2f987%3Dabc | END_V4`,
        sentinel: 'END_V4',
        forbidden: [
          encodedToken,
          'tok%2Blive%2F987%3Dabc',
          'tok%2blive%2f987%3dabc',
          'tok%2Blive%2f987%3Dabc',
        ],
      },
      {
        label: 'indexnow-key-and-location',
        message: `key=${indexNowKey} loc=${indexNowKeyLocation} enc=${indexNowKeyLocationLowerEncoded} | END_V5`,
        sentinel: 'END_V5',
        forbidden: [indexNowKey, indexNowKeyLocation, indexNowKeyLocationLowerEncoded],
      },
      {
        label: 'json-escaped-slash-and-whitespace-collapsed-wp',
        message: `PHP error: {"err":"bad ${encodedToken.replace(/\//g, '\\/')}" basic=${wpBase64.replace(/\//g, '\\/')} pass=abcd\nefgh\tijkl  mnop | END_V6`,
        sentinel: 'END_V6',
        forbidden: [
          encodedToken,
          encodedToken.replace(/\//g, '\\/'),
          wpBase64,
          wpBase64.replace(/\//g, '\\/'),
          wpAppPassword,
        ],
      },
    ];

    for (const vec of vectors) {
      warnSpy.mockClear();
      const h = makeRunnerHarness({
        task: { publishAsDraft: false },
        connection: {
          credentialsCiphertext: encrypted.ciphertext,
          credentialsIv: encrypted.iv,
          credentialsTag: encrypted.tag,
          keyVersion: encrypted.keyVersion,
          configJson: {
            indexNowKey,
            indexNowKeyLocation,
          },
        },
        connectionsOverride: realConnections,
      });

      h.publishMock.mockRejectedValueOnce(new Error(vec.message));
      await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

      expect(h.task.status, vec.label).toBe('FAILED');
      const persisted = h.task.lastError ?? '';
      const logged = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

      for (const output of [persisted, logged]) {
        expect(output, `${vec.label} must retain sentinel (no truncation)`).toContain(vec.sentinel);
        expect(output, `${vec.label} must contain [REDACTED]`).toContain('[REDACTED]');
        for (const secret of vec.forbidden) {
          expect(output, `${vec.label} leaked ${secret}`).not.toContain(secret);
        }
      }
    }
  });

  it('R2-S-01: redacts Webhook configJson extraHeaders secret straddling mapHttpStatusError 220-char boundary in GeoDistributionTask.lastError and warn logs', async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 0x39).toString('base64');
    const secretBox = new SecretBox();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const signingSecret = 'whsec_runner_boundary_123456';
    const headerSecret = 'wh_live_secret_header_998877665544';
    const encrypted = secretBox.encryptJson({ signingSecret });

    const fakeHttp = {
      request: vi.fn(async () => ({
        status: 400,
        headers: { 'content-type': 'text/plain' },
        body: `Validation failed on custom payload field: ${'a'.repeat(160)} key=${headerSecret}`,
        finalUrl: 'https://hooks.acme.example/publish',
      })),
      assertAllowedUrl: vi.fn(async (url: string) => new URL(url)),
    } as unknown as OutboundHttpClient;

    const realWebhook = new WebhookConnector(fakeHttp);
    const realConnections = new ConnectionsService(
      {} as PrismaService,
      {} as QuotaService,
      secretBox,
      fakeHttp,
      {} as CmsConnectorRegistry,
    );
    const registry = {
      get: vi.fn(() => realWebhook),
    } as unknown as CmsConnectorRegistry;

    const h = makeRunnerHarness({
      task: { provider: 'WEBHOOK', publishAsDraft: false },
      connection: {
        id: 'conn_wh_1',
        provider: 'WEBHOOK',
        displayName: 'Webhook Boundary',
        siteBaseUrl: 'https://hooks.acme.example/publish',
        credentialsCiphertext: encrypted.ciphertext,
        credentialsIv: encrypted.iv,
        credentialsTag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
        configJson: {
          extraHeaders: { 'X-Api-Key': headerSecret },
        },
      },
      connectionsOverride: realConnections,
      connectorsOverride: registry,
    });
    h.task.connectionId = 'conn_wh_1';

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.task.status).toBe('FAILED');
    const persisted = h.task.lastError ?? '';
    const logged = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    for (const out of [persisted, logged]) {
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain(headerSecret);
      expect(out).not.toContain('wh_live_secr');
      expect(out).not.toContain(signingSecret);
    }
  });

  it('isolates QueueRuntime distribution queue so wrong job.name never falls through to WorkDriver.handle()', async () => {
    const producer = {} as QueueProducer;
    const driver = {
      handle: vi.fn(async () => undefined),
    } as unknown as WorkDriver;
    const maintenance = {
      run: vi.fn(async () => undefined),
    } as unknown as MaintenanceRunner;
    const runtimeState = {
      markConnected: vi.fn(),
    } as unknown as WorkerRuntimeService;
    const distributionHandler = {
      process: vi.fn(async () => undefined),
    };

    const queueRuntime = new QueueRuntime(
      producer,
      driver,
      maintenance,
      runtimeState,
      undefined,
      undefined,
      undefined,
      distributionHandler,
    );

    // Wrong job.name carrying a legacy WorkDriver payload MUST NOT fall through to driver.handle()
    await queueRuntime.dispatchJob('distribution', {
      name: 'unexpected-job-name',
      data: { tenantId: 'tenant_a', runId: 'run_1' },
    });
    expect(driver.handle).not.toHaveBeenCalled();
    expect(distributionHandler.process).not.toHaveBeenCalled();

    // Reserved 'system' tenantId on valid job.name MUST be ignored without fallthrough
    await queueRuntime.dispatchJob('distribution', {
      name: 'distribution',
      data: { tenantId: 'system', taskId: 'task_99' },
    });
    expect(driver.handle).not.toHaveBeenCalled();
    expect(distributionHandler.process).not.toHaveBeenCalled();

    // Valid job.name + valid payload dispatches strictly to distributionHandler
    await queueRuntime.dispatchJob('distribution', {
      name: 'distribution',
      data: { tenantId: 'tenant_a', taskId: 'task_99' },
    });
    expect(distributionHandler.process).toHaveBeenCalledTimes(1);
    expect(distributionHandler.process).toHaveBeenCalledWith({
      tenantId: 'tenant_a',
      taskId: 'task_99',
    });
    expect(driver.handle).not.toHaveBeenCalled();
  });

  it('enqueues distribution jobs with attempts=1 and no fixed jobId via QueueProducer', async () => {
    const producer = new QueueProducer();
    const addMock = vi.fn().mockResolvedValue({ id: 'job_1' });
    vi.spyOn(producer, 'connect').mockResolvedValue(undefined);
    vi.spyOn(
      producer as unknown as { queue: (name: string) => Promise<{ add: typeof addMock }> },
      'queue',
    ).mockResolvedValue({ add: addMock });

    await producer.enqueueDistribution({ tenantId: 'tenant_a', taskId: 'task_99' });

    expect(addMock).toHaveBeenCalledWith(
      'distribution',
      { tenantId: 'tenant_a', taskId: 'task_99' },
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 200 },
      },
    );
    const opts = addMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('jobId');
  });

  it('boots both ApiModule (DistributionModule) and WorkerModule (QueueModule.forWorker) offline and resolves all 9 L1 connectors', async () => {
    const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
    const workerCtx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    const apiCtx = await NestFactory.createApplicationContext(ApiModule, { logger: false });
    try {
      const expectedClasses: Record<L1ChannelProvider, new (...args: never[]) => CmsConnector> = {
        SHOPIFY: ShopifyConnector,
        WORDPRESS: WordPressConnector,
        WEBFLOW: WebflowConnector,
        WEBHOOK: WebhookConnector,
        GHOST: GhostConnector,
        DEVTO: DevtoConnector,
        HASHNODE: HashnodeConnector,
        GITHUB_MDX: GithubMdxConnector,
        WECHAT_OFFICIAL: WechatOfficialConnector,
      };

      expect(L1_CHANNEL_PROVIDERS).toHaveLength(9);

      for (const ctx of [apiCtx, workerCtx]) {
        const registry = ctx.get(CmsConnectorRegistry);
        expect(registry).toBeInstanceOf(CmsConnectorRegistry);
        for (const provider of L1_CHANNEL_PROVIDERS) {
          const connector = registry.get(provider);
          expect(connector).toBeInstanceOf(expectedClasses[provider]);
          expect(connector.provider).toBe(provider);
        }
        expect(ctx.get(DistributionRunner)).toBeInstanceOf(DistributionRunner);
        expect(ctx.get(ConnectionsService)).toBeInstanceOf(ConnectionsService);
        expect(ctx.get(IndexNowService)).toBeInstanceOf(IndexNowService);
        expect(ctx.get(GeoDeliveryService)).toBeInstanceOf(GeoDeliveryService);
        expect(ctx.get(CrawlProbeService)).toBeInstanceOf(CrawlProbeService);
        expect(ctx.get(RetestSchedulerService)).toBeInstanceOf(RetestSchedulerService);
      }

      const workerRunner = workerCtx.get(DistributionRunner);
      expect(workerCtx.get(DISTRIBUTION_HANDLER)).toBe(workerRunner);
      expect(workerCtx.get(DISTRIBUTION_ENQUEUER)).toBe(workerCtx.get(QueueProducer));
      expect(apiCtx.get(ShopifyOAuthService)).toBeInstanceOf(ShopifyOAuthService);
    } finally {
      await apiCtx.close();
      await workerCtx.close();
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('merges variantExtrasJson.tags ahead of article.tags (deduped) and forwards targetLocale in ConnectorPublishPayload (#370)', async () => {
    const h = makeRunnerHarness({
      task: {
        provider: 'DEVTO',
        publishAsDraft: true,
        targetLocale: 'de-DE',
        variantExtrasJson: {
          templateKey: 'DEVELOPER_TECH_POST',
          tags: ['architecture', 'benchmarks', 'battery'],
        },
      },
      connection: {
        provider: 'DEVTO',
        targetLocale: 'de-DE',
      },
    });
    h.publishMock.mockResolvedValueOnce({
      remotePostId: 'devto_123',
      remoteAdminUrl: 'https://dev.to/dashboard/123',
      publishedAsDraft: true,
    });

    await h.runner.process({ tenantId: h.tenantId, taskId: 'task_1' });

    expect(h.task.status).toBe('DRAFT_PUSHED');
    const payload = h.publishMock.mock.calls[0]?.[2] as {
      tags?: string[];
      targetLocale?: string | null;
    };
    expect(payload.targetLocale).toBe('de-DE');
    expect(payload.tags).toEqual(['architecture', 'benchmarks', 'battery', 'review']);
  });

  it('Iter 2 Fix 3: strips private/loopback/metadata SSRF canonicalUrl candidates in DistributionRunner', async () => {
    // All candidates unsafe -> canonicalUrl resolves to null
    const hBlocked = makeRunnerHarness({
      task: {
        provider: 'DEVTO',
        publishAsDraft: true,
        variantExtrasJson: {
          templateKey: 'DEVELOPER_TECH_POST',
          canonicalUrl: 'http://127.0.0.1/admin',
          canonicalGuideHint: 'http://[::1]/secret',
        },
      },
      connection: {
        provider: 'DEVTO',
      },
    });
    (hBlocked.task as { targetUrlHint?: string | null }).targetUrlHint =
      'http://169.254.169.254/latest/meta-data/';
    hBlocked.publishMock.mockResolvedValueOnce({
      remotePostId: 'devto_ssrf_1',
      publishedAsDraft: true,
    });

    await hBlocked.runner.process({ tenantId: hBlocked.tenantId, taskId: 'task_1' });
    const blockedPayload = hBlocked.publishMock.mock.calls[0]?.[2] as ConnectorPublishPayload;
    expect(blockedPayload.canonicalUrl).toBeNull();

    // Unsafe primary canonicalUrl falls back to safe public canonicalGuideHint
    const hFallback = makeRunnerHarness({
      task: {
        provider: 'DEVTO',
        publishAsDraft: true,
        variantExtrasJson: {
          templateKey: 'DEVELOPER_TECH_POST',
          canonicalUrl: 'http://localhost:3000/internal',
          canonicalGuideHint: 'https://blog.acme.example/guides/battery-benchmarks',
        },
      },
      connection: {
        provider: 'DEVTO',
      },
    });
    hFallback.publishMock.mockResolvedValueOnce({
      remotePostId: 'devto_ssrf_2',
      publishedAsDraft: true,
    });

    await hFallback.runner.process({ tenantId: hFallback.tenantId, taskId: 'task_1' });
    const fallbackPayload = hFallback.publishMock.mock.calls[0]?.[2] as ConnectorPublishPayload;
    expect(fallbackPayload.canonicalUrl).toBe(
      'https://blog.acme.example/guides/battery-benchmarks',
    );
    expect(fallbackPayload.extras).not.toHaveProperty('canonicalUrl');
    expect(fallbackPayload.extras?.canonicalGuideHint).toBe(
      'https://blog.acme.example/guides/battery-benchmarks',
    );
  });

  it('Iter 3 Fix 2: scrubs unsafe SSRF URL fields from publishPayload.extras before connector.publish', async () => {
    const hBlocked = makeRunnerHarness({
      task: {
        provider: 'DEVTO',
        publishAsDraft: true,
        variantExtrasJson: {
          templateKey: 'DEVELOPER_TECH_POST',
          canonicalUrl: 'http://127.0.0.1/admin',
          contentSourceUrl: 'http://169.254.169.254/latest/meta-data/',
          canonicalGuideHint: 'See http://10.0.0.1/internal',
          coverImageUrl: 'http://127.0.0.1:8080/cover.png',
          targetThreadUrls: ['http://[::1]/x', 'https://docs.example.com/thread'],
        },
      },
      connection: {
        provider: 'DEVTO',
      },
    });
    hBlocked.publishMock.mockResolvedValueOnce({
      remotePostId: 'devto_ssrf_extras_1',
      publishedAsDraft: true,
    });

    await hBlocked.runner.process({ tenantId: hBlocked.tenantId, taskId: 'task_1' });

    const blockedPayload = hBlocked.publishMock.mock.calls[0]?.[2] as ConnectorPublishPayload;
    expect(blockedPayload.canonicalUrl).toBeNull();
    expect(blockedPayload.extras).not.toHaveProperty('canonicalUrl');
    expect(blockedPayload.extras).not.toHaveProperty('contentSourceUrl');
    expect(blockedPayload.extras).not.toHaveProperty('canonicalGuideHint');
    expect(blockedPayload.extras).not.toHaveProperty('coverImageUrl');
    expect(blockedPayload.extras?.targetThreadUrls).toEqual(['https://docs.example.com/thread']);

    // Safe public URLs and safe prose hints pass through cleanly
    const hSafe = makeRunnerHarness({
      task: {
        provider: 'WECHAT_OFFICIAL',
        publishAsDraft: true,
        variantExtrasJson: {
          templateKey: 'WECHAT_OFFICIAL_ARTICLE',
          contentSourceUrl: 'https://docs.example.com/original-guide',
          canonicalGuideHint: 'Read full guide at https://docs.example.com/original-guide.',
          coverImageUrl: 'https://cdn.example.com/cover.png',
          targetThreadUrls: ['https://docs.example.com/thread-1'],
        },
      },
      connection: {
        provider: 'WECHAT_OFFICIAL',
      },
    });
    hSafe.publishMock.mockResolvedValueOnce({
      remotePostId: 'wx_safe_1',
      publishedAsDraft: true,
    });

    await hSafe.runner.process({ tenantId: hSafe.tenantId, taskId: 'task_1' });

    const safePayload = hSafe.publishMock.mock.calls[0]?.[2] as ConnectorPublishPayload;
    expect(safePayload.canonicalUrl).toBe('https://docs.example.com/original-guide');
    expect(safePayload.extras?.contentSourceUrl).toBe('https://docs.example.com/original-guide');
    expect(safePayload.extras?.canonicalGuideHint).toBe(
      'Read full guide at https://docs.example.com/original-guide.',
    );
    expect(safePayload.extras?.coverImageUrl).toBe('https://cdn.example.com/cover.png');
    expect(safePayload.extras?.targetThreadUrls).toEqual(['https://docs.example.com/thread-1']);
  });
});
