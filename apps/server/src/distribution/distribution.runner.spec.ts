import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoPublishRecordDto } from '@geomix/shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducer } from '../queue/queue.producer';
import { QueueRuntime } from '../queue/queue.runtime';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { currentTenantId } from '../tenant/tenant-context';
import { WorkerModule } from '../worker.module';
import { ConnectionsService } from './connections.service';
import { CmsConnectorRegistry } from './connectors';
import {
  ConnectorError,
  type CmsConnector,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
} from './connectors/types';
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
}) {
  const tenantId = 'tenant_a';
  const connection: ConnectionRow | null =
    initial?.connection === null
      ? null
      : {
          id: 'conn_wp_1',
          tenantId,
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

  const runner = new DistributionRunner(prisma, connections, connectors, indexNow, geoDelivery);

  return {
    tenantId,
    task,
    records,
    seenTenantIds,
    runner,
    publishMock,
    connections,
    connectors,
    indexNow,
    geoDelivery,
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

  it('skips tasks not in PUBLISHING state and fails disabled/non-L1 tasks safely', async () => {
    const hSkipped = makeRunnerHarness({ task: { status: 'PUBLISHED' } });
    await hSkipped.runner.process({ tenantId: hSkipped.tenantId, taskId: 'task_1' });
    expect(hSkipped.publishMock).not.toHaveBeenCalled();

    const hDisabled = makeRunnerHarness({ connection: { status: 'DISABLED' } });
    await hDisabled.runner.process({ tenantId: hDisabled.tenantId, taskId: 'task_1' });
    expect(hDisabled.task.status).toBe('FAILED');
    expect(hDisabled.publishMock).not.toHaveBeenCalled();

    const hNonL1 = makeRunnerHarness({ task: { provider: 'PR_PACKET' } });
    await hNonL1.runner.process({ tenantId: hNonL1.tenantId, taskId: 'task_1' });
    expect(hNonL1.task.status).toBe('FAILED');
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

  it('boots WorkerModule offline with full DistributionRunner DI chain wired', async () => {
    const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
    const workerCtx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    try {
      const runner = workerCtx.get(DistributionRunner);
      expect(runner).toBeInstanceOf(DistributionRunner);
      expect(workerCtx.get(DISTRIBUTION_HANDLER)).toBe(runner);
      expect(workerCtx.get(DISTRIBUTION_ENQUEUER)).toBe(workerCtx.get(QueueProducer));
      expect(workerCtx.get(ConnectionsService)).toBeInstanceOf(ConnectionsService);
      expect(workerCtx.get(CmsConnectorRegistry)).toBeInstanceOf(CmsConnectorRegistry);
      expect(workerCtx.get(IndexNowService)).toBeInstanceOf(IndexNowService);
      expect(workerCtx.get(GeoDeliveryService)).toBeInstanceOf(GeoDeliveryService);
      expect(workerCtx.get(CrawlProbeService)).toBeInstanceOf(CrawlProbeService);
      expect(workerCtx.get(RetestSchedulerService)).toBeInstanceOf(RetestSchedulerService);
    } finally {
      await workerCtx.close();
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });
});
