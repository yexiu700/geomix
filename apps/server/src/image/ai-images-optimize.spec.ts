import 'reflect-metadata';
import { API_ERROR, FAKE_MARK } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import type { QuotaService } from '../billing/quota.service';
import { ComplianceService } from '../infra/compliance';
import type { LlmCallResult, LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import type { StorageService } from '../infra/storage';
import type { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { AiImagesService, formatAiImageOrderNo } from './ai-images.service';
import type { ImageJobEnqueuer } from './image-job.runner';
import {
  containsPromptLeakage,
  extractAndValidateOptimizedPrompt,
  trimPromptToMaxLength,
} from './prompt-optimizer';

function makeCost(scene: 'image_prompt' | 'distill' = 'image_prompt') {
  return {
    recordId: 'rec-1',
    tenantId: 'tenant_demo',
    idempotencyKey: 'img_opt_test',
    scene,
    provider: 'deepseek',
    model: 'deepseek-chat',
    fake: false,
    tokensIn: 80,
    tokensOut: 120,
    costMicro: 200,
    costBasis: 'placeholder' as const,
    latencyMs: 40,
    fingerprint: 'fp',
  };
}

function makeLlmResult(text: string, fake = false): LlmCallResult {
  return {
    provider: fake ? 'fake' : 'deepseek',
    model: fake ? 'fake-cheap' : 'deepseek-chat',
    fake,
    text,
    tokensIn: 80,
    tokensOut: 120,
    cost: makeCost(),
  };
}

function createService(completeMock: ReturnType<typeof vi.fn>) {
  const prisma = {
    scoped: {
      keyword: {
        findFirst: vi.fn().mockResolvedValue({ main: '便携屏' }),
      },
      knowledgeBase: {
        findFirst: vi.fn().mockResolvedValue({
          mode: 'SUMMARY',
          companyName: null,
          brandShort: null,
          fields: null,
          summaryText: '专注超薄便携显示器与移动双屏办公外设。',
        }),
      },
    },
  } as unknown as PrismaService;

  const billing = {} as unknown as BillingService;
  const quota = {} as unknown as QuotaService;
  const storage = {} as unknown as StorageService;
  const compliance = new ComplianceService();
  const llm = { complete: completeMock } as unknown as LlmService;
  const enqueuer = {} as unknown as ImageJobEnqueuer;

  return new AiImagesService(prisma, billing, quota, storage, compliance, llm, enqueuer);
}

describe('AiImagesService.optimizePrompt regression tests (#178)', () => {
  it('calls LLM with image_prompt scene, disableThinking=true, and sufficient maxTokens', async () => {
    const completeMock = vi.fn().mockResolvedValue(
      makeLlmResult(
        JSON.stringify({
          prompt:
            '写实商业摄影，咖啡厅深色木质桌面摆放一台超薄便携副屏与轻薄笔记本构成双屏移动办公场景，柔和自然窗光从侧前方照亮机身质感，浅景深虚化背景暖调灯饰，构图干净利落。',
        }),
      ),
    );
    const service = createService(completeMock);

    const res = await runInTenant('tenant_demo', () =>
      service.optimizePrompt({
        prompt: '便携屏咖啡厅双屏办公实拍',
        style: '写实摄影',
        keywordId: 'kw_1',
        kbId: 'kb_1',
      }),
    );

    expect(completeMock).toHaveBeenCalledTimes(1);
    const callArg = completeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.scene).toBe('image_prompt');
    expect(callArg.disableThinking).toBe(true);
    expect(Number(callArg.maxTokens)).toBeGreaterThanOrEqual(600);
    expect(res.optimizedPrompt).toContain('咖啡厅深色木质桌面');
  });

  it('strips closed <think> blocks and extracts clean prompt from JSON or trailing text', async () => {
    const completeMock = vi
      .fn()
      .mockResolvedValue(
        makeLlmResult(
          [
            '<think>',
            '用户需要把简短描述扩写成配图提示词，80-220字，注意硬性约束。',
            '</think>',
            '```json',
            '{"prompt":"写实摄影风格，安静的精品咖啡馆靠窗桌面，超薄便携副屏与银色笔记本电脑组成双屏办公工作区，屏幕展示简洁数据界面，左侧自然日光柔和照亮金属边框，背景咖啡吧台柔焦虚化，高清细腻质感。"}',
            '```',
          ].join('\n'),
        ),
      );
    const service = createService(completeMock);

    const res = await runInTenant('tenant_demo', () =>
      service.optimizePrompt({
        prompt: '便携屏咖啡厅出差双屏办公实拍',
        style: '写实摄影',
      }),
    );

    expect(res.optimizedPrompt).not.toContain('<think>');
    expect(res.optimizedPrompt).not.toContain('硬性约束');
    expect(res.optimizedPrompt).not.toContain('用户需要把');
    expect(res.optimizedPrompt).toContain('安静的精品咖啡馆靠窗桌面');
  });

  it('rejects unclosed <think> truncation and falls back cleanly without leaking reasoning', async () => {
    const unclosedThink =
      '<think>先分析用户的描述，需要扩写成80-220字写实摄影配图提示词，避免品牌名？硬性约束是不出现真人正脸...';
    const completeMock = vi.fn().mockResolvedValue(makeLlmResult(unclosedThink));
    const service = createService(completeMock);

    const res = await runInTenant('tenant_demo', () =>
      service.optimizePrompt({
        prompt: '氮化镓充电器桌面办公实拍',
        style: '写实摄影',
      }),
    );

    expect(res.optimizedPrompt).not.toContain('<think>');
    expect(res.optimizedPrompt).not.toContain('硬性约束');
    expect(res.optimizedPrompt).not.toContain('避免品牌名');
    expect(res.optimizedPrompt.length).toBeGreaterThanOrEqual(20);
    expect(res.optimizedPrompt).toContain('氮化镓充电器桌面办公实拍');
  });

  it('never leaks plain-text CoT reasoning monologue or truncated 490-char output (#178)', async () => {
    const leakedMonologue =
      '用户需要把简短描述扩写成配图提示词，80-220字，中文，写实摄影，不能出现真人正脸、公众人物、品牌Logo文字海报，不输出引号或多余解释。首先拆解核心主体与场景：咖啡厅出差双屏办公实拍，需要避免品牌名？硬性约束是不出现品牌商标Logo，还需要做好字数控制，确保画面层次清晰且光线具体。下面开始构思具体画面内容：一款超薄便携显示器放置在木质咖啡桌上，置于画面';
    const completeMock = vi.fn().mockResolvedValue(makeLlmResult(leakedMonologue));
    const service = createService(completeMock);

    const res = await runInTenant('tenant_demo', () =>
      service.optimizePrompt({
        prompt: '便携屏，咖啡厅出差双屏办公实拍',
        style: '写实摄影',
      }),
    );

    expect(res.optimizedPrompt).not.toContain('用户需要把');
    expect(res.optimizedPrompt).not.toContain('硬性约束');
    expect(res.optimizedPrompt).not.toContain('字数控制');
    expect(res.optimizedPrompt).not.toContain('避免品牌名');
    expect(res.optimizedPrompt).not.toContain('不输出引号');
    expect(res.optimizedPrompt).not.toMatch(/置于画面$/);
    expect(res.optimizedPrompt.length).toBeGreaterThanOrEqual(20);
  });

  it('never leaks system prompt instructions even if echoed verbatim by LLM', async () => {
    const leakedSystemPrompt =
      '你是专业的商业视觉配图提示词编辑。请将用户的简短描述扩写为一段画面层次清晰、光线构图具体的中文配图提示词（80-220字）。硬性约束：不出现真人正脸肖像、公众人物、任何品牌商标Logo或文字海报，不输出引号或多余解释。';
    const completeMock = vi.fn().mockResolvedValue(makeLlmResult(leakedSystemPrompt));
    const service = createService(completeMock);

    const res = await runInTenant('tenant_demo', () =>
      service.optimizePrompt({
        prompt: '桌面充电器实拍',
        style: '产品静物',
      }),
    );

    expect(res.optimizedPrompt).not.toContain('商业视觉配图提示词编辑');
    expect(res.optimizedPrompt).not.toContain('硬性约束');
    expect(res.optimizedPrompt).not.toContain('真人正脸');
    expect(res.optimizedPrompt).not.toContain('不输出引号');
    expect(res.optimizedPrompt.length).toBeGreaterThanOrEqual(20);
  });

  it('retries once with strict JSON prompt on contract/leak failure and succeeds if retry returns clean prompt', async () => {
    const completeMock = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema'),
      )
      .mockResolvedValueOnce(
        makeLlmResult(
          JSON.stringify({
            prompt:
              '产品静物商业摄影，深灰磨砂桌面摆放一台紧凑型氮化镓桌面充电器，侧面柔光勾勒金属散热倒角，一条编织快充线自然延伸连接笔记本电脑，背景简约虚化，整体质感锐利。',
          }),
        ),
      );
    const service = createService(completeMock);

    const res = await runInTenant('tenant_demo', () =>
      service.optimizePrompt({
        prompt: '140W 氮化镓充电器桌面办公实拍',
        style: '产品静物',
      }),
    );

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(res.optimizedPrompt).toContain('紧凑型氮化镓桌面充电器');
  });

  it('falls back safely when retry also throws contract error, and handles fake provider cleanly', async () => {
    const contractFailMock = vi
      .fn()
      .mockRejectedValue(
        new ProviderError(PROVIDER_KIND.CONTRACT, '外部服务返回了无法识别的结果', 'schema'),
      );
    const failService = createService(contractFailMock);

    const fallbackRes = await runInTenant('tenant_demo', () =>
      failService.optimizePrompt({
        prompt: '便携屏',
        style: '商务科技',
      }),
    );
    expect(contractFailMock).toHaveBeenCalledTimes(2);
    expect(fallbackRes.optimizedPrompt.length).toBeGreaterThanOrEqual(20);
    expect(fallbackRes.optimizedPrompt).toContain('便携屏');
    expect(fallbackRes.optimizedPrompt).not.toContain('真人正脸');

    const fakeMock = vi.fn().mockResolvedValue(makeLlmResult(`${FAKE_MARK}占位`, true));
    const fakeService = createService(fakeMock);
    const fakeRes = await runInTenant('tenant_demo', () =>
      fakeService.optimizePrompt({
        prompt: '现代产线光学检测工作站特写',
        style: '商务科技',
      }),
    );
    expect(fakeRes.optimizedPrompt.length).toBeGreaterThanOrEqual(20);
    expect(fakeRes.optimizedPrompt).not.toContain(FAKE_MARK);
  });

  it('still blocks forbidden industry inputs with 403', async () => {
    const completeMock = vi.fn();
    const service = createService(completeMock);

    await expect(
      runInTenant('tenant_demo', () =>
        service.optimizePrompt({
          prompt: '网络赌博博彩宣传图',
        }),
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe('prompt-optimizer extraction & validation helpers', () => {
  it('extracts JSON prompt even when preceded by CoT monologue and rejects leaked JSON values', () => {
    const withPreamble = [
      '用户需要把简短描述扩写成配图提示词，注意字数控制。',
      '{"prompt":"极简北欧风咖啡厅靠窗实木桌面，超薄便携副屏搭配轻薄笔记本展示清晰工作界面，温暖侧逆光勾勒铝合金边框，背景虚化柔和。"}',
    ].join('\n');
    expect(extractAndValidateOptimizedPrompt(withPreamble)).toBe(
      '极简北欧风咖啡厅靠窗实木桌面，超薄便携副屏搭配轻薄笔记本展示清晰工作界面，温暖侧逆光勾勒铝合金边框，背景虚化柔和。',
    );

    const leakedInsideJson = JSON.stringify({
      prompt: '用户需要把简短描述扩写成配图提示词，硬性约束是不出现真人正脸。',
    });
    expect(extractAndValidateOptimizedPrompt(leakedInsideJson)).toBeNull();

    const truncatedJson = '{"prompt":"写实摄影，咖啡厅木质桌面摆放便携屏幕，柔和日光';
    expect(extractAndValidateOptimizedPrompt(truncatedJson)).toBeNull();
  });

  it('extracts trailing labeled prompt after reasoning and trims overly long prompts at sentence boundary', () => {
    const labeled = [
      '思考过程：需要先分析主场景与光线构图，避免出现品牌Logo。',
      '最终提示词：商务科技感桌面实拍，哑光深灰金属氮化镓桌面充电器连接编织快充线为笔记本供电，冷暖对比桌面灯光勾勒散热纹理，微距浅景深质感。',
    ].join('\n');
    expect(extractAndValidateOptimizedPrompt(labeled)).toBe(
      '商务科技感桌面实拍，哑光深灰金属氮化镓桌面充电器连接编织快充线为笔记本供电，冷暖对比桌面灯光勾勒散热纹理，微距浅景深质感。',
    );

    const longSentence = `${'现代开放式办公空间桌面实拍，超薄便携显示器与轻薄笔记本并排摆放，柔和自然窗光映照金属机身质感，浅景深虚化背景绿植。'.repeat(6)}`;
    const trimmed = trimPromptToMaxLength(longSentence, 180);
    expect(trimmed.length).toBeLessThanOrEqual(180);
    expect(trimmed.endsWith('。')).toBe(true);
    expect(containsPromptLeakage(trimmed)).toBe(false);
  });
});

describe('AiImagesService.list keyword orderNo search', () => {
  it('matches full formatted orderNo like IMG20261117-001ABC against id suffix', async () => {
    const countMock = vi.fn().mockResolvedValue(0);
    const findManyMock = vi.fn().mockResolvedValue([]);
    const prisma = {
      base: {
        pricingItem: { findUnique: vi.fn().mockResolvedValue({ unitPoints: 5, enabled: true }) },
      },
      scoped: {
        aiImageJob: {
          count: countMock,
          findMany: findManyMock,
        },
      },
    } as unknown as PrismaService;

    const service = new AiImagesService(
      prisma,
      {} as BillingService,
      {} as QuotaService,
      {} as StorageService,
      new ComplianceService(),
      {} as LlmService,
      {} as ImageJobEnqueuer,
    );

    await runInTenant('tenant_demo', () =>
      service.list({
        page: 1,
        pageSize: 25,
        keyword: 'IMG20261117-001ABC',
      }),
    );

    expect(countMock).toHaveBeenCalledWith({
      where: {
        OR: [
          { prompt: { contains: 'IMG20261117-001ABC', mode: 'insensitive' } },
          { id: { contains: 'IMG20261117-001ABC', mode: 'insensitive' } },
          { id: { endsWith: '001ABC', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('formats orderNo date prefix in Asia/Shanghai (UTC+8) (#184)', () => {
    expect(formatAiImageOrderNo(new Date('2026-11-17T17:05:00.000Z'), 'img_abc123')).toBe(
      'IMG20261118-ABC123',
    );
  });
});
