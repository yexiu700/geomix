import { describe, expect, it, vi } from 'vitest';
import { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import { runInTenant } from '../tenant/tenant-context';
import { AiTaskRunner, type AiTaskEnqueuer } from './ai-task.runner';
import { AiTasksService } from './ai-tasks.service';

describe('Issue #70: Keyword.optStatus sync on AI writing task creation & completion', () => {
  it('promotes Keyword.optStatus from NONE to OPTIMIZING on AiTasksService.create() without downgrading INCLUDED', async () => {
    const keywordState = { id: 'kw_01', tenantId: 'tenant_01', optStatus: 'NONE' };
    const keywordUpdateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; tenantId: string; optStatus: string };
        data: { optStatus: string };
      }) => {
        if (
          keywordState.id === where.id &&
          keywordState.tenantId === where.tenantId &&
          keywordState.optStatus === where.optStatus
        ) {
          keywordState.optStatus = data.optStatus;
          return { count: 1 };
        }
        return { count: 0 };
      },
    );

    const fakeTaskRow = {
      id: 'task_01',
      name: '工业除尘方案创作',
      categoryId: 'cat_01',
      category: { id: 'cat_01', name: '工业除尘方案创作' },
      keywordId: 'kw_01',
      keyword: { id: 'kw_01', main: '工业除尘器' },
      mediaCategoryId: 'mcat_01',
      mediaCategory: { id: 'mcat_01', name: '车间图库' },
      imageCount: 1,
      kbId: null,
      kb: null,
      contentTplId: null,
      contentTpl: null,
      titleTplId: null,
      titleTpl: null,
      resultStatus: 'PENDING' as const,
      target: 1,
      doneCount: 0,
      failCount: 0,
      unitPrice: 10,
      status: 'QUEUED' as const,
      lastError: null,
      lastWrittenAt: null,
      createdAt: new Date('2026-11-17T00:00:00Z'),
      items: [
        {
          id: 'item_01',
          seq: 1,
          questionId: null,
          question: null,
          templateId: null,
          direction: null,
          copyType: null,
          brand: null,
          title: null,
          status: 'PENDING' as const,
          attempts: 0,
          model: null,
          tokensIn: null,
          tokensOut: null,
          error: null,
          articleId: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    };

    const prismaStub = {
      base: {
        promptTemplate: {
          count: vi.fn().mockResolvedValue(18),
        },
        keyword: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'kw_01',
            main: '工业除尘器',
            brands: ['蓝天环保'],
            _count: { questions: 3 },
          }),
          updateMany: keywordUpdateMany,
        },
        mediaCategory: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'mcat_01',
            _count: { assets: 2 },
          }),
        },
        articleCategory: {
          findUnique: vi.fn().mockResolvedValue({ id: 'cat_01' }),
        },
        aiTask: {
          create: vi.fn().mockResolvedValue({ id: 'task_01' }),
          findFirst: vi.fn().mockResolvedValue(fakeTaskRow),
        },
        pointReservation: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ refId: 'task_01', frozen: 10, settled: 0, released: 0 }]),
        },
        aiTaskItem: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
      },
    };

    const enqueuer: AiTaskEnqueuer = {
      enqueueAiTask: vi.fn().mockResolvedValue(undefined),
    };

    const service = new AiTasksService(
      prismaStub as never,
      {
        quoteAiWrite: vi.fn().mockResolvedValue({ total: 10, unitTotal: 10 }),
        wallet: vi.fn().mockResolvedValue({ billingMode: 'SHADOW', available: 1000 }),
        reserve: vi.fn().mockResolvedValue({ id: 'resv_01' }),
        close: vi.fn().mockResolvedValue(undefined),
      } as never,
      { assertAvailable: vi.fn().mockResolvedValue(undefined) } as never,
      new ComplianceService({ write: async () => undefined }),
      enqueuer,
    );

    const payload = {
      name: '工业除尘方案创作',
      categoryId: null,
      keywordId: 'kw_01',
      mediaCategoryId: 'mcat_01',
      imageCount: 1,
      kbId: null,
      contentTplId: null,
      titleTplId: null,
      resultStatus: 'PENDING' as const,
      target: 1,
    };

    await runInTenant('tenant_01', () => service.create(payload, 'user_01'));
    expect(keywordState.optStatus).toBe('OPTIMIZING');

    // Does not downgrade INCLUDED keywords
    keywordState.optStatus = 'INCLUDED';
    await runInTenant('tenant_01', () => service.create(payload, 'user_01'));
    expect(keywordState.optStatus).toBe('INCLUDED');
  });

  it('promotes Keyword.optStatus from NONE to OPTIMIZING when AiTaskRunner persists an article', async () => {
    const keywordUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    let claimStep = 0;

    const txStub = {
      $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('FROM "AiTask"')) {
          return Promise.resolve([
            {
              id: 'task_ok',
              tenantId: 'tenant_01',
              status: 'RUNNING',
              target: 1,
              doneCount: 1,
              failCount: 0,
            },
          ]);
        }
        if (sql.includes('COUNT(*)::int AS cnt')) {
          return Promise.resolve([{ cnt: 0 }]);
        }
        if (sql.includes('FROM "AiTaskItem"')) {
          claimStep += 1;
          if (claimStep === 1) {
            return Promise.resolve([{ id: 'item_ok1', seq: 1, attempts: 0 }]);
          }
          return Promise.resolve([]);
        }
        if (sql.includes('FROM "Question"')) {
          return Promise.resolve([{ id: 'q_ok', text: '工业除尘器日常维护要注意什么？' }]);
        }
        if (sql.includes('FROM "MediaAsset"')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
      aiTaskItem: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi
          .fn()
          .mockImplementation(({ where }: { where: { status: string } }) =>
            Promise.resolve(where.status === 'SUCCESS' ? 1 : 0),
          ),
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ articleId: null, status: 'RUNNING' }),
        findMany: vi.fn().mockResolvedValue([{ status: 'SUCCESS' }]),
      },
      aiTask: { update: vi.fn().mockResolvedValue({}) },
      question: { update: vi.fn().mockResolvedValue({}) },
      mediaAsset: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      article: { create: vi.fn().mockResolvedValue({ id: 'art_ok1' }) },
      keyword: { updateMany: keywordUpdateMany },
    };

    const runner = new AiTaskRunner(
      {
        base: {
          $transaction: vi
            .fn()
            .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txStub)),
          promptTemplate: {
            count: vi.fn().mockResolvedValue(18),
            findFirst: vi.fn().mockResolvedValue({
              id: 'sys_article_01',
              content: '围绕{训练词占位符}与{转化词占位符}解答{问题}',
            }),
            findMany: vi.fn().mockResolvedValue([]),
          },
          aiTask: {
            findFirst: vi.fn().mockResolvedValue({
              id: 'task_ok',
              tenantId: 'tenant_01',
              name: '正常成文验证',
              categoryId: 'cat_01',
              keywordId: 'kw_ok',
              mediaCategoryId: 'mcat_01',
              imageCount: 0,
              kbId: null,
              kb: null,
              contentTplId: 'sys_article_01',
              titleTplId: null,
              resultStatus: 'PENDING',
              target: 1,
              unitPrice: 10,
              seed: 7,
              keyword: { id: 'kw_ok', main: '工业除尘器', brands: ['蓝天环保'] },
            }),
          },
          pointReservation: {
            findFirst: vi.fn().mockResolvedValue({ id: 'resv_ok', status: 'OPEN' }),
          },
        },
      } as never,
      {
        settleAiWriteUnit: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as never,
      { applyArticleEvent: vi.fn().mockResolvedValue(undefined) } as never,
      LlmService.fromEnv({}),
      new ComplianceService({ write: async () => undefined }),
      {} as never,
      { enqueueAiTask: vi.fn().mockResolvedValue(undefined) },
    );

    await runner.process({ tenantId: 'tenant_01', taskId: 'task_ok' });
    expect(keywordUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'kw_ok',
        tenantId: 'tenant_01',
        optStatus: 'NONE',
      },
      data: { optStatus: 'OPTIMIZING' },
    });
  });
});
