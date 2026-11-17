import 'reflect-metadata';
import { cleanDistilledQuestions, DISTILL_MIN_VALID_DEFAULT } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { QuotaService } from '../billing/quota.service';
import type { ComplianceService } from '../infra/compliance';
import type { LlmCallResult, LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import type { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { extractDistillCandidates } from './distill-parser';
import { KeywordsService } from './keywords.service';

describe('extractDistillCandidates', () => {
  it('strips <think> blocks and parses Markdown-fenced JSON arrays and trailing commas', () => {
    const raw = `
<think>
先围绕“工业注塑模具”构思推荐、价格、厂家类问题，同时避开品牌“华信精密模具”和“华信注塑”。
</think>
\`\`\`json
[
  "工业注塑模具哪家厂家技术稳定？",
  "定制一套工业注塑模具大概需要多少钱？",
  "东莞工业注塑模具加工周期一般要多久？",
]
\`\`\`
`;
    const candidates = extractDistillCandidates(raw);
    expect(candidates).toEqual([
      '工业注塑模具哪家厂家技术稳定？',
      '定制一套工业注塑模具大概需要多少钱？',
      '东莞工业注塑模具加工周期一般要多久？',
    ]);
  });

  it('extracts strings from object wrappers and object-array items', () => {
    const raw = JSON.stringify({
      data: [
        { question: '精密工业注塑模具选型要注意哪些细节？' },
        { text: '汽车配件工业注塑模具一般寿命是多少？' },
      ],
    });
    expect(extractDistillCandidates(raw)).toEqual([
      '精密工业注塑模具选型要注意哪些细节？',
      '汽车配件工业注塑模具一般寿命是多少？',
    ]);
  });

  it('falls back to numbered or bulleted plain-text lines when model omits JSON brackets', () => {
    const raw = [
      '以下是围绕主关键词生成的咨询问题：',
      '1. 工业注塑模具设计报价一般包含哪些项目？',
      '2、中小批量工业注塑模具怎么控制开模成本？',
      '- 医疗级工业注塑模具对钢材有什么要求？',
      '• 华东地区工业注塑模具源头工厂怎么考察？',
      '5) 复杂结构工业注塑模具试模流程是怎样的？',
    ].join('\n');
    const extracted = extractDistillCandidates(raw);
    const cleaned = cleanDistilledQuestions({
      rawCandidates: extracted,
      main: '工业注塑模具',
      brands: ['华信精密模具', '华信注塑'],
    });
    expect(cleaned).toHaveLength(5);
  });
});

describe('KeywordsService.distill format-anomaly retry', () => {
  it('retries once with a strict JSON prompt when upstream first returns a contract/format anomaly', async () => {
    const prisma = {
      scoped: {
        keyword: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
    } as unknown as PrismaService;

    const billing = {
      listPrices: vi.fn().mockResolvedValue([{ action: 'distill', unitPoints: 10, enabled: true }]),
      reserveSync: vi.fn().mockResolvedValue({ id: 'resv-1', shadow: true }),
      settle: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      releaseUnit: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingService;

    const quota = {} as unknown as QuotaService;
    const compliance = {
      assertAllowed: vi.fn().mockResolvedValue(undefined),
    } as unknown as ComplianceService;

    const validJsonQuestions = JSON.stringify([
      '工业注塑模具一般开模费用怎么算？',
      '选择工业注塑模具厂家要看哪些资质？',
      '精密工业注塑模具交货周期大概多久？',
      '小批量工业注塑模具定做需要注意什么？',
      '长寿命工业注塑模具常用哪些模具钢？',
      '本地工业注塑模具售后维护包含哪些服务？',
    ]);

    const completeMock = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema'),
      )
      .mockResolvedValueOnce({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: `\`\`\`json\n${validJsonQuestions}\n\`\`\``,
        tokensIn: 120,
        tokensOut: 180,
        cost: {
          recordId: 'rec-2',
          tenantId: 'tenant_demo',
          idempotencyKey: 'distill:idem-retry-test:retry1',
          scene: 'distill',
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          tokensIn: 120,
          tokensOut: 180,
          costMicro: 300,
          costBasis: 'placeholder',
          latencyMs: 50,
          fingerprint: 'fp',
        },
      } satisfies LlmCallResult);

    const llm = { complete: completeMock } as unknown as LlmService;
    const service = new KeywordsService(
      prisma,
      billing,
      quota,
      compliance,
      llm,
      () => DISTILL_MIN_VALID_DEFAULT,
    );

    const result = await runInTenant('tenant_demo', () =>
      service.distill({
        main: '工业注塑模具',
        brands: '华信精密模具,华信注塑',
        idempotencyKey: 'idem-retry-test',
      }),
    );

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.questions.length).toBe(6);
    expect(result.charged).toBe(10);
    expect(result.shadow).toBe(true);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.releaseUnit).not.toHaveBeenCalled();
  });
});
