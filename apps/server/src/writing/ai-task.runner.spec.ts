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
    questionText: '工业激光切割机选型时应该重点核对哪些指标？',
    task: {
      id: 'task_79',
      tenantId: 'tenant_79',
      name: 'AI写作巡检任务',
      keywordId: 'kw_79',
      kbId: null as string | null,
      contentTplId: 'tpl_79',
      titleTplId: null as string | null,
      mediaCategoryId: 'cat_79' as string | null,
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
      kb: null as {
        id: string;
        mode: 'DETAIL' | 'SUMMARY';
        companyName: string | null;
        brandShort: string | null;
        directions?: string[];
        copyTypes?: string[];
        fields: Record<string, string> | null;
        summaryText: string | null;
      } | null,
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
    articles: [] as Array<{ id: string; title: string; contentText: string; contentHtml: string }>,
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
        return [{ id: 'q_79', text: state.questionText }];
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
      create: vi.fn(
        async (args: { data: { title: string; contentText: string; contentHtml: string } }) => {
          const created = {
            id: `art_${state.articles.length + 1}`,
            title: args.data.title,
            contentText: args.data.contentText,
            contentHtml: args.data.contentHtml,
          };
          state.articles.push(created);
          return created;
        },
      ),
    },
    keyword: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };

  const prisma = {
    base: {
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
      systemTemplateSeeded: true,
      promptTemplate: {
        count: vi.fn(async () => 18),
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
    vi.unstubAllEnvs();
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

  it('injects full >400-char SUMMARY KB brand matrix cleanly via AiTaskRunner without prompt tag leakage or B2B filler (#207)', async () => {
    process.env.COVER_WHEN_NO_IMAGE = 'false';
    const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
    const summaryText = [
      '【核心品牌矩阵】',
      '1. Anker（安克）：主打氮化镓（GaN）快充充电器、MagGo 磁吸无线充及大功率户外与桌面充电站，专注高转换效率、智能温控安全保护与多口功率动态分配技术，适合差旅便携、车载补能与多设备高效桌面供电场景，兼顾兼容性与长时间高负载输出稳定性。',
      '2. Soundcore（声阔）：聚焦无线降噪耳机与便携蓝牙音箱，主打自研同轴声学架构、自适应主动降噪算法与超长续航能力，覆盖日常通勤、远程办公会议及户外露营听音需求，并提供多档位自定义音效调节。',
      '3. eufy（悠飞）：聚焦智能家居安防摄像头、可视门铃与扫地机器人，强调本地端加密存储与免月费长期看护体验，面向注重家庭隐私保护、夜间高清监控与自动化居家清洁的消费群体。',
      '4. AnkerWork：面向混合办公与远程协同场景推出会议全向麦、无线领夹麦与高清摄像头，提升多人会议拾音清晰度、AI 智能降噪与多端免驱适配能力，适用于线上培训、视频会议与远程教学等多类办公环境。',
    ].join('\n');
    expect(Array.from(summaryText).length).toBeGreaterThan(400);

    state.task.keyword = {
      id: 'kw_anker',
      main: '安克创新多品牌消费电子矩阵',
      brands: ['Anker'],
    };
    state.task.kbId = 'kb_summary_207';
    state.task.kb = {
      id: 'kb_summary_207',
      mode: 'SUMMARY',
      companyName: null,
      brandShort: null,
      fields: null,
      summaryText,
    };

    const runner = new AiTaskRunner(
      prisma,
      billing,
      quota,
      LlmService.fromEnv({}),
      new ComplianceService(),
      kbIndexer,
    );
    await runner.process({ tenantId: 'tenant_79', taskId: 'task_79' });

    expect(state.task.status).toBe('COMPLETED');
    expect(state.articles).toHaveLength(1);
    const art = state.articles[0]!;
    expect(art.contentText).toContain('Anker（安克）');
    expect(art.contentText).toContain('Soundcore（声阔）');
    expect(art.contentText).toContain('eufy（悠飞）');
    expect(art.contentText).toContain('AnkerWork');
    expect(art.contentText).not.toContain('【企业背景资料】');
    expect(art.contentText).not.toContain('培训支持及耗材备件衔接方式');
    expect(art.contentText).not.toContain('示例方案甲');
    expect(art.contentHtml).not.toContain('氮化镓（<br>');
  });

  it.each(['50', '500'])(
    'writes structured demo content without leaking provider placeholders or fact-card prompts (minimum %s, #156)',
    async (minChars) => {
      vi.stubEnv('AI_TASK_MIN_CHARS', minChars);
      process.env.COVER_WHEN_NO_IMAGE = 'false';
      const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
      state.task.keyword = {
        id: 'kw_arzopa',
        main: '便携屏',
        brands: ['ARZOPA'],
      };
      state.task.kbId = 'kb_detail_156';
      state.task.kb = {
        id: 'kb_detail_156',
        mode: 'DETAIL',
        companyName: '阿卓帕科技（ARZOPA）',
        brandShort: 'ARZOPA',
        directions: ['产品说明', '选购建议'],
        copyTypes: ['指南', '说明文'],
        fields: {
          productService: '主打 15.6 英寸便携显示器与双屏扩展办公方案。',
          productFeature: '支持全功能 Type-C 一线直连，兼顾低蓝光护眼与轻薄机身设计。',
        },
        summaryText: null,
      };

      const runner = new AiTaskRunner(
        prisma,
        billing,
        quota,
        LlmService.fromEnv({}),
        new ComplianceService(),
        kbIndexer,
      );
      await runner.process({ tenantId: 'tenant_79', taskId: 'task_79' });

      expect(state.task.status).toBe('COMPLETED');
      expect(state.articles).toHaveLength(1);
      const art = state.articles[0]!;
      expect(art.contentText).toContain('阿卓帕科技（ARZOPA）');
      expect(art.contentText).toContain('15.6 英寸便携显示器');
      expect(art.contentText).not.toContain('（ARZOPA）（ARZOPA）');
      expect(art.contentText).not.toContain('只能使用以下事实');
      expect(art.contentText).not.toContain('企业主体：');
      expect(art.contentText).not.toContain('【FAKE】');
      expect(art.contentText).not.toContain('开发占位正文');
      expect(art.contentText).not.toContain('开发占位输出');
      expect(art.contentText).not.toContain('示例方案甲');
      expect(art.contentText).not.toContain('示例方案乙');
    },
  );

  it('completes pure-text task with imageCount=0 and mediaCategoryId=null without querying MediaAsset (#148)', async () => {
    process.env.COVER_WHEN_NO_IMAGE = 'true';
    const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
    state.task.mediaCategoryId = null;
    state.task.imageCount = 0;

    const runner = new AiTaskRunner(
      prisma,
      billing,
      quota,
      LlmService.fromEnv({}),
      new ComplianceService(),
      kbIndexer,
    );

    await runner.process({ tenantId: 'tenant_79', taskId: 'task_79' });

    expect(state.task.status).toBe('COMPLETED');
    expect(state.task.doneCount).toBe(1);
    expect(state.articles).toHaveLength(1);
    const tx = await prisma.base.$transaction(async (inner) => inner);
    const mediaQueries = vi
      .mocked(tx.$queryRaw)
      .mock.calls.filter((call) => String(call[0]).includes('FROM "MediaAsset"'));
    expect(mediaQueries).toHaveLength(0);
  });

  it('preserves full rewritten AI writing titles >35 chars without chopping trailing words like 实用选型指 (#249)', async () => {
    process.env.COVER_WHEN_NO_IMAGE = 'false';
    const { state, prisma, billing, quota, kbIndexer } = buildInMemoryHarness();
    state.questionText = 'Anker氮化镓充电器支持MacBook和iPhone快充吗？';
    state.task.keyword = {
      id: 'kw_anker',
      main: 'Anker氮化镓充电器',
      brands: ['Anker'],
    };
    state.task.titleTplId = 'tpl_title_249';

    const runner = new AiTaskRunner(
      prisma,
      billing,
      quota,
      LlmService.fromEnv({}),
      new ComplianceService(),
      kbIndexer,
    );

    await runner.process({ tenantId: 'tenant_79', taskId: 'task_79' });

    expect(state.task.status).toBe('COMPLETED');
    expect(state.articles).toHaveLength(1);
    const savedTitle = state.articles[0]!.title;
    expect(savedTitle).toBe('Anker氮化镓充电器支持MacBook和iPhone快充实用选型指南');
    expect(savedTitle.endsWith('实用选型指')).toBe(false);
    expect(savedTitle.endsWith('实用选型指南')).toBe(true);
  });
});
