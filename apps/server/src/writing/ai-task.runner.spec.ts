import { LLM_SCENES } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { QuotaService } from '../billing/quota.service';
import { ComplianceService } from '../infra/compliance';
import type { HttpTransport } from '../infra/guarded-request';
import { LlmService } from '../infra/llm';
import type { KnowledgeIndexRunner } from '../material/knowledge-index.runner';
import type { PrismaService } from '../prisma/prisma.service';
import { MaintenanceRunner } from '../queue/maintenance.runner';
import type { WorkDriver } from '../queue/work-driver';
import {
  AiTaskRunner,
  readStaleRunningMs,
  readTaskLlmTimeoutMs,
  type AiTaskEnqueuer,
} from './ai-task.runner';

function buildInMemoryHarness() {
  const state = {
    task: {
      id: 'task_79',
      tenantId: 'tenant_79',
      name: 'AI写作巡检任务',
      keywordId: 'kw_79',
      kbId: null as string | null,
      contentTplId: 'tpl_79',
      titleTplId: null as string | null,
      mediaCategoryId: 'cat_79',
      categoryId: 'artcat_79',
      imageCount: 0,
      resultStatus: 'NORMAL' as const,
      target: 1,
      doneCount: 0,
      failCount: 0,
      unitPrice: 10,
      seed: 42,
      status: 'QUEUED' as
        'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'PAUSED' | 'CANCELLED',
      lastError: null as string | null,
      lastWrittenAt: null as Date | null,
      createdAt: new Date(Date.now() - 20_000),
      keyword: {
        id: 'kw_79',
        main: '工业激光切割机',
        brands: ['智造星'],
      },
      kb: null,
    },
    items: [
      {
        id: 'item_79_1',
        taskId: 'task_79',
        seq: 1,
        attempts: 0,
        status: 'PENDING' as 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED',
        startedAt: null as Date | null,
        finishedAt: null as Date | null,
        error: null as string | null,
        articleId: null as string | null,
      },
    ],
    reservation: {
      id: 'res_79',
      tenantId: 'tenant_79',
      refType: 'ai_task',
      refId: 'task_79',
      status: 'OPEN' as 'OPEN' | 'CLOSED',
    },
    articles: [] as Array<{ id: string; title: string; contentText: string }>,
  };

  const txMock = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM "AiTask"')) {
        return [
          {
            id: state.task.id,
            tenantId: state.task.tenantId,
            status: state.task.status,
            target: state.task.target,
            doneCount: state.task.doneCount,
            failCount: state.task.failCount,
          },
        ];
      }
      if (sql.includes('SELECT COUNT(*)::int AS cnt')) {
        return [{ cnt: state.items.filter((i) => i.status === 'RUNNING').length }];
      }
      if (sql.includes('FROM "AiTaskItem"')) {
        return state.items
          .filter((i) => i.status === 'PENDING')
          .map((i) => ({ id: i.id, seq: i.seq, attempts: i.attempts }));
      }
      if (sql.includes('FROM "Question"')) {
        return [{ id: 'q_79', text: '工业激光切割机选型时应该重点核对哪些指标？' }];
      }
      if (sql.includes('FROM "MediaAsset"')) {
        return [];
      }
      return [];
    }),
    aiTaskItem: {
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const item of state.items) {
            if (args.where.status === 'RUNNING' && item.status === 'RUNNING') {
              const lt = (args.where.startedAt as { lt?: Date } | undefined)?.lt;
              if (!lt || (item.startedAt && item.startedAt < lt)) {
                Object.assign(item, args.data);
                count += 1;
              }
            } else if (args.where.status === 'PENDING' && item.status === 'PENDING') {
              Object.assign(item, args.data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      count: vi.fn(async (args: { where: { status?: string } }) => {
        return state.items.filter((i) => !args.where.status || i.status === args.where.status)
          .length;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = state.items.find((i) => i.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return found;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return state.items.find((i) => i.id === args.where.id) ?? null;
      }),
      findMany: vi.fn(async () => {
        return state.items
          .filter((i) => i.status === 'SUCCESS' || i.status === 'FAILED')
          .map((i) => ({ status: i.status }));
      }),
    },
    aiTask: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        for (const [k, v] of Object.entries(args.data)) {
          if (
            (k === 'doneCount' || k === 'failCount') &&
            v &&
            typeof v === 'object' &&
            'increment' in v
          ) {
            state.task[k] += Number((v as { increment: number }).increment);
          } else {
            (state.task as Record<string, unknown>)[k] = v;
          }
        }
        return state.task;
      }),
    },
    question: {
      update: vi.fn(async () => ({})),
    },
    mediaAsset: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    article: {
      create: vi.fn(async (args: { data: { title: string; contentText: string } }) => {
        const created = {
          id: `art_${state.articles.length + 1}`,
          title: args.data.title,
          contentText: args.data.contentText,
        };
        state.articles.push(created);
        return created;
      }),
    },
  };

  const prisma = {
    base: {
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
      systemTemplateSeeded: true,
      promptTemplate: {
        count: vi.fn(async () => 4),
        findFirst: vi.fn(async () => ({
          id: 'tpl_79',
          content: '请围绕 {{question}} 撰写一篇专业选型指南，自然提及 {{brand}}。',
        })),
        findMany: vi.fn(async () => []),
      },
      aiTask: {
        findFirst: vi.fn(async () => state.task),
        findMany: vi.fn(async () => [
          {
            id: state.task.id,
            tenantId: state.task.tenantId,
            status: state.task.status,
            items: state.items.map((i) => ({ status: i.status, startedAt: i.startedAt })),
          },
        ]),
      },
      pointReservation: {
        findFirst: vi.fn(async () => state.reservation),
      },
    },
  } as unknown as PrismaService;

  const billing = {
    settleAiWriteUnit: vi.fn(async () => undefined),
    releaseUnit: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      state.reservation.status = 'CLOSED';
    }),
    listPrices: vi.fn(async () => [{ action: 'ai_write', unitPoints: 10 }]),
    reconcileOrphans: vi.fn(async () => ({ ledgerIssues: [] })),
  } as unknown as BillingService;

  const quota = {
    applyArticleEvent: vi.fn(async () => undefined),
  } as unknown as QuotaService;

  const kbIndexer = {
    searchTopChunks: vi.fn(async () => []),
  } as unknown as KnowledgeIndexRunner;

  return { state, prisma, billing, quota, kbIndexer };
}

describe('AiTaskRunner timeout bounding & orphan recovery (#79)', () => {
  const prevTimeout = process.env.AI_TASK_LLM_TIMEOUT_MS;
  const prevCover = process.env.COVER_WHEN_NO_IMAGE;

  afterEach(() => {
    if (prevTimeout === undefined) delete process.env.AI_TASK_LLM_TIMEOUT_MS;
    else process.env.AI_TASK_LLM_TIMEOUT_MS = prevTimeout;
    if (prevCover === undefined) delete process.env.COVER_WHEN_NO_IMAGE;
    else process.env.COVER_WHEN_NO_IMAGE = prevCover;
  });

  it('parses AI_TASK_LLM_TIMEOUT_MS and AI_TASK_STALE_RUNNING_MS with safe defaults', () => {
    expect(readTaskLlmTimeoutMs({})).toBe(20_000);
    expect(readTaskLlmTimeoutMs({ AI_TASK_LLM_TIMEOUT_MS: '15000' })).toBe(15_000);
    expect(readTaskLlmTimeoutMs({ AI_TASK_LLM_TIMEOUT_MS: '999999' })).toBe(20_000);

    expect(readStaleRunningMs({})).toBe(60_000);
    expect(readStaleRunningMs({ AI_TASK_STALE_RUNNING_MS: '30000' })).toBe(30_000);
  });

  it('bounds hung upstream LLM calls without 3x3 retry storm and completes via fake fallback when LLM_FALLBACK_FAKE=true', async () => {
    process.env.AI_TASK_LLM_TIMEOUT_MS = '120';
    process.env.COVER_WHEN_NO_IMAGE = 'false';

    let upstreamAttempts = 0;
    const hungTransport: HttpTransport = async (req) => {
      upstreamAttempts += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        req.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      throw new Error('unreachable');
    };

    const llm = LlmService.fromEnv(
      {
        DEEPSEEK_API_KEY: 'test-key',
        LLM_FALLBACK_FAKE: 'true',
        LLM_PROVIDERS: JSON.stringify({
          providers: {
            deepseek: {
              kind: 'openai',
              baseUrl: 'https://192.0.2.10/v1',
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              cheapModel: 'deepseek-chat',
              qualityModel: 'deepseek-chat',
            },
          },
          route: Object.fromEntries(
            LLM_SCENES.map((s) => [s, { primary: 'deepseek', backup: [] }]),
          ),
        }),
      },
      {
        transport: hungTransport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
        timeoutMs: 90_000,
        retryDelayMs: 0,
      },
    );

    const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
    const runner = new AiTaskRunner(
      prisma,
      billing,
      quota,
      llm,
      new ComplianceService(),
      kbIndexer,
    );

    const startedAt = Date.now();
    await runner.process({ tenantId: 'tenant_79', taskId: 'task_79' });
    const elapsed = Date.now() - startedAt;

    expect(upstreamAttempts).toBe(1);
    expect(elapsed).toBeLessThan(600);
    expect(state.task.status).toBe('COMPLETED');
    expect(state.task.doneCount).toBe(1);
    expect(state.articles).toHaveLength(1);
    expect(billing.settleAiWriteUnit).toHaveBeenCalledTimes(1);
    expect(state.reservation.status).toBe('CLOSED');
  });

  it('promptly marks task FAILED and refunds frozen points without retrying timeouts when LLM_FALLBACK_FAKE=false', async () => {
    process.env.AI_TASK_LLM_TIMEOUT_MS = '120';
    process.env.COVER_WHEN_NO_IMAGE = 'false';

    let upstreamAttempts = 0;
    const hungTransport: HttpTransport = async (req) => {
      upstreamAttempts += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        req.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      throw new Error('unreachable');
    };

    const llm = LlmService.fromEnv(
      {
        DEEPSEEK_API_KEY: 'test-key',
        LLM_FALLBACK_FAKE: 'false',
        LLM_PROVIDERS: JSON.stringify({
          providers: {
            deepseek: {
              kind: 'openai',
              baseUrl: 'https://192.0.2.10/v1',
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              cheapModel: 'deepseek-chat',
              qualityModel: 'deepseek-chat',
            },
          },
          route: Object.fromEntries(
            LLM_SCENES.map((s) => [s, { primary: 'deepseek', backup: [] }]),
          ),
        }),
      },
      {
        transport: hungTransport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
        timeoutMs: 90_000,
        retryDelayMs: 0,
      },
    );

    const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
    const runner = new AiTaskRunner(
      prisma,
      billing,
      quota,
      llm,
      new ComplianceService(),
      kbIndexer,
    );

    const startedAt = Date.now();
    await runner.process({ tenantId: 'tenant_79', taskId: 'task_79' });
    const elapsed = Date.now() - startedAt;

    expect(upstreamAttempts).toBe(1);
    expect(elapsed).toBeLessThan(600);
    expect(state.task.status).toBe('FAILED');
    expect(state.task.failCount).toBe(1);
    expect(state.task.lastError).toContain('超时');
    expect(billing.releaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_79',
        reservationId: 'res_79',
        amount: 10,
      }),
    );
    expect(state.reservation.status).toBe('CLOSED');
  });

  it('recovers orphaned QUEUED and stale RUNNING tasks via MaintenanceRunner.run("recover")', async () => {
    const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
    const enqueued: Array<{ tenantId: string; taskId: string }> = [];
    const enqueuer: AiTaskEnqueuer = {
      async enqueueAiTask(job) {
        enqueued.push(job);
      },
    };
    const runner = new AiTaskRunner(
      prisma,
      billing,
      quota,
      LlmService.fromEnv({}),
      new ComplianceService(),
      kbIndexer,
      enqueuer,
    );
    const driver = { recover: vi.fn(async () => 0) } as unknown as WorkDriver;
    const maintenance = new MaintenanceRunner(billing, driver, runner);

    // 1) Orphaned QUEUED task (>10s old) is re-enqueued
    expect(await maintenance.run('recover')).toBe('recover:1');
    expect(enqueued).toEqual([{ tenantId: 'tenant_79', taskId: 'task_79' }]);

    // 2) Freshly RUNNING item is NOT redundantly re-enqueued
    enqueued.length = 0;
    state.task.status = 'RUNNING';
    state.items[0]!.status = 'RUNNING';
    state.items[0]!.startedAt = new Date();
    expect(await maintenance.run('recover')).toBe('recover:0');
    expect(enqueued).toEqual([]);

    // 3) Stale RUNNING item (>60s old) IS re-enqueued for recovery
    state.items[0]!.startedAt = new Date(Date.now() - 65_000);
    expect(await maintenance.run('recover')).toBe('recover:1');
    expect(enqueued).toEqual([{ tenantId: 'tenant_79', taskId: 'task_79' }]);
  });
});
