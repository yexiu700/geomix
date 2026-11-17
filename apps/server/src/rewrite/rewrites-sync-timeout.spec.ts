import { LLM_SCENES } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { PublicFetchService } from '../infra/adapters.module';
import { ComplianceService } from '../infra/compliance';
import type { HttpTransport } from '../infra/guarded-request';
import { LlmService } from '../infra/llm';
import type { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { RewritesService, readRewriteSyncTimeoutMs } from './rewrites.service';

const LONG_PASTED_SOURCE =
  '在工业自动化产线升级改造过程中，压力与温度传感器的选型直接决定了采集信号的长期稳定性与现场运维人员日常巡检的工作负荷。' +
  '第一步需要逐项核对被测介质的腐蚀特性、工作温度区间与瞬时冲击压力峰值，留出充足的安全裕量，避免探头长期处于极限工况。' +
  '第二步需要确认模拟量电流环或数字总线制式与现场PLC控制柜接口的兼容性，评估长距离电缆敷设时的电磁屏蔽接地规范。' +
  '第三步应当把季度标定周期、备件通用率以及故障快速替换耗时纳入综合评估体系，先用两周试运行验证波动曲线。';

describe('readRewriteSyncTimeoutMs (#96)', () => {
  it('defaults to 30000ms and clamps out-of-range values so upstream finishes before 60s gateway timeout', () => {
    expect(readRewriteSyncTimeoutMs({})).toBe(30_000);
    expect(readRewriteSyncTimeoutMs({ REWRITE_SYNC_TIMEOUT_MS: '18000' })).toBe(18_000);
    expect(readRewriteSyncTimeoutMs({ REWRITE_SYNC_TIMEOUT_MS: '90000' })).toBe(30_000);
    expect(readRewriteSyncTimeoutMs({ REWRITE_SYNC_TIMEOUT_MS: 'invalid' })).toBe(30_000);
  });
});

describe('RewritesService.createSingle sync timeout protection (#96)', () => {
  it('falls back from slow reasoner within REWRITE_SYNC_TIMEOUT_MS without hanging past gateway timeout', async () => {
    const prevTimeout = process.env.REWRITE_SYNC_TIMEOUT_MS;
    process.env.REWRITE_SYNC_TIMEOUT_MS = '250';

    try {
      const requestedModels: string[] = [];
      const transport: HttpTransport = async (req) => {
        const payload = JSON.parse(req.body ?? '{}') as { model: string; max_tokens: number };
        requestedModels.push(payload.model);
        if (payload.model === 'deepseek-reasoner') {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1_500);
            req.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
        }
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: [
                      '# 工业自动化产线传感器选型与抗干扰运维指南',
                      '',
                      '围绕工业现场工况评估，工程师在改造升级阶段应重点关注介质耐受等级、信号传输抗干扰方案以及周期性标定闭环管理。',
                      '',
                      '## 介质工况与安全裕量核查',
                      '',
                      '针对高温与强腐蚀场景，探头密封结构及护套材质需预留安全余量，防止零点漂移影响产线节拍。',
                      '',
                      '## 接口制式与日常巡检闭环',
                      '',
                      '结合控制柜端口规范选择电流信号或数字总线，并通过试运行建立标准化备件与标定台账。',
                    ].join('\n'),
                  },
                },
              ],
              usage: { prompt_tokens: 120, completion_tokens: 180 },
            }),
          ),
        };
      };

      const llm = LlmService.fromEnv(
        {
          DEEPSEEK_API_KEY: 'ds-test-key',
          LLM_PROVIDERS: JSON.stringify({
            providers: {
              deepseek: {
                kind: 'openai',
                baseUrl: 'https://192.0.2.10/v1',
                apiKeyEnv: 'DEEPSEEK_API_KEY',
                cheapModel: 'deepseek-chat',
                qualityModel: 'deepseek-reasoner',
              },
            },
            route: Object.fromEntries(
              LLM_SCENES.map((s) => [s, { primary: 'deepseek', backup: [] }]),
            ),
          }),
        },
        {
          transport,
          resolver: {
            async resolve() {
              return [{ address: '192.0.2.10', family: 4 }];
            },
          },
          timeoutMs: 25_000,
          retryDelayMs: 500,
        },
      );

      let storedRow: Record<string, unknown> = {};
      const prismaMock = {
        base: {
          promptTemplate: {
            count: vi.fn(async () => 4),
            findMany: vi.fn(async () => []),
            upsert: vi.fn(async () => ({})),
            findFirst: vi.fn(async () => ({
              id: 'tpl_rw_1',
              name: '系统·参考重写',
              kind: 'REWRITE',
              content: '请围绕核心观点进行结构化改写，输出 Markdown 标题与正文。',
            })),
          },
          pricingItem: {
            findUnique: vi.fn(async () => ({
              action: 'rewrite_single',
              unitPoints: 5,
              enabled: true,
            })),
          },
          mediaCategory: {
            findFirst: vi.fn(async () => ({ id: 'mcat_1', name: '默认图库' })),
          },
          mediaAsset: {
            count: vi.fn(async () => 1),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          articleCategory: {
            findFirst: vi.fn(async () => ({ id: 'acat_1', name: '默认分类' })),
          },
          rewriteRecord: {
            findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
              if (where && 'status' in where && where.status === 'SUCCESS') {
                return null;
              }
              return {
                id: 'rw_rec_96',
                tenantId: 'tenant_96',
                batchId: null,
                url: String(storedRow.url ?? 'paste://abc'),
                urlHash: String(storedRow.urlHash ?? 'hash_96'),
                pastedText: true,
                sourceTitle: '产线传感器选型原始笔记',
                newTitle: String(storedRow.newTitle ?? ''),
                categoryId: 'acat_1',
                category: { id: 'acat_1', name: '默认分类' },
                mediaCategoryId: 'mcat_1',
                mediaCategory: { id: 'mcat_1', name: '默认图库' },
                templateId: 'tpl_rw_1',
                template: { id: 'tpl_rw_1', name: '系统·参考重写' },
                status: 'SUCCESS',
                error: null,
                similarity: Number(storedRow.similarity ?? 0.08),
                articleId: 'art_96',
                article: { id: 'art_96', status: 'PENDING', complianceFlags: {} },
                rewrittenAt: new Date('2026-11-17T10:00:00.000Z'),
                createdAt: new Date('2026-11-17T10:00:00.000Z'),
              };
            }),
            findFirstOrThrow: vi.fn(async () => ({
              id: 'rw_rec_96',
              tenantId: 'tenant_96',
              batchId: null,
              url: String(storedRow.url ?? 'paste://abc'),
              urlHash: String(storedRow.urlHash ?? 'hash_96'),
              pastedText: true,
              sourceTitle: '产线传感器选型原始笔记',
              newTitle: String(storedRow.newTitle ?? ''),
              categoryId: 'acat_1',
              category: { id: 'acat_1', name: '默认分类' },
              mediaCategoryId: 'mcat_1',
              mediaCategory: { id: 'mcat_1', name: '默认图库' },
              templateId: 'tpl_rw_1',
              template: { id: 'tpl_rw_1', name: '系统·参考重写' },
              status: 'SUCCESS',
              error: null,
              similarity: Number(storedRow.similarity ?? 0.08),
              articleId: 'art_96',
              article: { id: 'art_96', status: 'PENDING', complianceFlags: {} },
              rewrittenAt: new Date('2026-11-17T10:00:00.000Z'),
              createdAt: new Date('2026-11-17T10:00:00.000Z'),
            })),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
              storedRow = { ...data };
              return { id: 'rw_rec_96', ...data };
            }),
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
              storedRow = { ...storedRow, ...data };
              return { id: 'rw_rec_96', ...storedRow };
            }),
          },
          article: {
            create: vi.fn(async () => ({ id: 'art_96' })),
          },
          $queryRaw: vi.fn(async () => [{ id: 'asset_1', url: '/uploads/demo.png' }]),
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prismaMock.base)),
        },
      } as unknown as PrismaService;

      const billingMock = {
        reserveSync: vi.fn(async () => ({ id: 'res_96' })),
        settle: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        releaseUnit: vi.fn(async () => undefined),
      } as unknown as BillingService;

      const compliance = new ComplianceService();
      const publicFetch = { fetch: vi.fn() } as unknown as PublicFetchService;

      const service = new RewritesService(prismaMock, billingMock, compliance, publicFetch, llm);

      const startedAt = Date.now();
      const res = await runInTenant('tenant_96', () =>
        service.createSingle(
          {
            url: '',
            pastedText: true,
            pastedTitle: '产线传感器选型原始笔记',
            pastedContent: LONG_PASTED_SOURCE,
            mediaCategoryId: 'mcat_1',
            imageCount: 1,
            templateId: 'tpl_rw_1',
            categoryId: 'acat_1',
            autoCategoryName: '',
            resultStatus: 'PENDING',
            brand: '',
          },
          'u_96',
        ),
      );
      const elapsed = Date.now() - startedAt;

      expect(requestedModels).toEqual(['deepseek-reasoner', 'deepseek-chat']);
      expect(res.record.status).toBe('SUCCESS');
      expect(res.record.newTitle).toContain('传感器选型');
      expect(elapsed).toBeLessThan(600);
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.REWRITE_SYNC_TIMEOUT_MS;
      } else {
        process.env.REWRITE_SYNC_TIMEOUT_MS = prevTimeout;
      }
    }
  });
});
