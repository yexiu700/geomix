// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { describe, expect, it } from 'vitest';
import { type LlmRouteConfig } from '@geomix/shared';
import { LlmRouter, LlmService, type LlmProvider } from '../infra/llm';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityJudgeService } from './visibility-judge.service';

function createMockLlm(onCall: (prompt: string) => string): {
  llm: LlmService;
  getCallCount: () => number;
} {
  let calls = 0;
  const provider: LlmProvider = {
    name: 'judge-mock',
    async complete(call) {
      calls += 1;
      const userMsg = call.messages.find((m) => m.role === 'user')?.content ?? '';
      return {
        provider: 'judge-mock',
        model: call.model,
        fake: false,
        text: onCall(userMsg),
        tokensIn: 30,
        tokensOut: 20,
      };
    },
  };
  const route: LlmRouteConfig = {
    providers: {
      'judge-mock': {
        kind: 'openai',
        baseUrl: 'https://llm.example.com/v1',
        apiKeyEnv: 'JUDGE_KEY',
        cheapModel: 'judge-v1',
        qualityModel: 'judge-pro',
      },
    },
    route: {
      distill: { primary: 'judge-mock', backup: [] },
      title: { primary: 'judge-mock', backup: [] },
      body: { primary: 'judge-mock', backup: [] },
      rewrite: { primary: 'judge-mock', backup: [] },
      image_prompt: { primary: 'judge-mock', backup: [] },
    },
  };
  const llm = new LlmService(
    new LlmRouter(
      route,
      { 'judge-mock': provider },
      { maxRetries: 0, timeoutMs: 5_000, retryDelayMs: 0 },
    ),
  );
  return { llm, getCallCount: () => calls };
}

describe('VisibilityJudgeService', () => {
  it('skips LLM call completely at zero token cost when neither brand nor competitors match', async () => {
    const { llm, getCallCount } = createMockLlm(() => {
      throw new Error('LLM should not be called on zero pre-scan hits');
    });
    const judge = new VisibilityJudgeService(llm);

    const result = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '如何制定企业年度预算？',
      answerText: '制定年度预算应当结合历史营收增速、固定人力成本及现金流安全垫综合测算。',
      citations: [{ url: 'https://zhuanlan.zhihu.com/p/98765' }],
      profile: {
        brandName: 'GeoMix',
        brandAliases: ['吉奥米克斯'],
        ownedDomains: ['geomix.cn'],
        competitors: [{ name: '竞品甲', aliases: ['AlphaGEO'], domains: ['alphageo.com'] }],
      },
    });

    expect(getCallCount()).toBe(0);
    expect(result).toEqual({
      brandMentioned: false,
      brandPosition: null,
      brandSentiment: null,
      brandPassage: null,
      competitorHits: [{ name: '竞品甲', mentioned: false, position: null, sentiment: null }],
      judgeModel: 'deterministic-skip',
      tokensIn: 0,
      tokensOut: 0,
      skippedLlm: true,
    });
  });

  it('does not false-trigger on English inner-word substrings ("ace" in "place") while matching Chinese brand adjacency', async () => {
    const { llm, getCallCount } = createMockLlm(() =>
      JSON.stringify({
        verdicts: [
          {
            subjectKey: 'comp_0',
            portrayal: 'positive',
            evidence: '极米投影在家庭影院场景亮度出色。',
          },
        ],
      }),
    );
    const judge = new VisibilityJudgeService(llm);

    // Brand "Ace" appears ONLY inside "place" and "surface" -> should NOT match!
    const englishNoMatch = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: 'Best workspace setup tips',
      answerText: 'Put your monitor in a bright place on a clean surface.',
      profile: {
        brandName: 'Ace',
        ownedDomains: ['ace-tools.com'],
        competitors: [],
      },
    });
    expect(englishNoMatch.brandMentioned).toBe(false);
    expect(getCallCount()).toBe(0);

    // Chinese competitor "极米" adjacent to Chinese characters -> matches!
    const cjkMatch = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'doubao',
      promptText: '家用投影哪款好',
      answerText: 'Put your projector in a quiet place。极米投影在家庭影院场景亮度出色。',
      profile: {
        brandName: 'Ace',
        ownedDomains: ['ace-tools.com'],
        competitors: [{ name: '极米', aliases: [], domains: ['xgimi.com'] }],
      },
    });
    expect(getCallCount()).toBe(1);
    expect(cjkMatch.brandMentioned).toBe(false);
    expect(cjkMatch.competitorHits).toEqual([
      { name: '极米', mentioned: true, position: 1, sentiment: 'positive' },
    ]);
  });

  it('attributes domain-only citation mentions deterministically without calling LLM', async () => {
    const { llm, getCallCount } = createMockLlm(() => {
      throw new Error('LLM should not be called for pure citation-domain matches');
    });
    const judge = new VisibilityJudgeService(llm);

    const result = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'perplexity',
      promptText: '企业GEO白皮书参考资料',
      answerText: '详见下方参考技术白皮书与实施清单，建议按季度复盘核心指标。',
      citations: [
        { url: 'https://www.alphageo.com/report-2026', title: '行业报告' },
        { url: 'https://docs.geomix.cn/geo-playbook', title: '实施白皮书' },
      ],
      profile: {
        brandName: 'GeoMix',
        ownedDomains: ['geomix.cn'],
        competitors: [{ name: '竞品甲', domains: ['alphageo.com'] }],
      },
    });

    expect(getCallCount()).toBe(0);
    expect(result.skippedLlm).toBe(true);
    // alphageo.com is citation #1 -> position 1; geomix.cn is citation #2 -> position 2
    expect(result.brandMentioned).toBe(true);
    expect(result.brandPosition).toBe(2);
    expect(result.brandSentiment).toBe('neutral');
    expect(result.competitorHits).toEqual([
      { name: '竞品甲', mentioned: true, position: 1, sentiment: 'neutral' },
    ]);
  });

  it('rejects homonyms when LLM Judge classifies portrayal as other_meaning or other_company', async () => {
    const { llm, getCallCount } = createMockLlm(() =>
      JSON.stringify({
        verdicts: [
          {
            subjectKey: 'brand',
            portrayal: 'other_meaning',
          },
          {
            subjectKey: 'comp_0',
            portrayal: 'positive',
            evidence: '飞书文档支持多人实时协作，体验流畅。',
          },
        ],
      }),
    );
    const judge = new VisibilityJudgeService(llm);

    const result = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'wenxin',
      promptText: '健康饮食与团队办公建议',
      answerText: '建议下午茶准备新鲜苹果补充维生素；日常团队协作推荐使用飞书文档，体验流畅。',
      profile: {
        brandName: '苹果',
        ownedDomains: ['apple-enterprise.example.com'],
        competitors: [{ name: '飞书', domains: ['feishu.cn'] }],
      },
    });

    expect(getCallCount()).toBe(1);
    expect(result.brandMentioned).toBe(false);
    expect(result.brandPosition).toBeNull();
    expect(result.brandSentiment).toBeNull();
    expect(result.brandPassage).toBeNull();
    expect(result.competitorHits).toEqual([
      { name: '飞书', mentioned: true, position: 1, sentiment: 'positive' },
    ]);
  });

  it('computes 1-based multi-competitor ranking and deterministic sentiment when LLM_PROVIDERS={} (fake: true)', async () => {
    const offlineJudge = VisibilityJudgeService.fromEnv({ LLM_PROVIDERS: '{}' });

    const result = await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'kimi',
      promptText: '企业GEO监测平台横评',
      answerText: [
        '1. 竞品甲：起步较早，标准化报表模块丰富。',
        '2. GeoMix：在多引擎可见性诊断与内容闭环方面表现出色，值得优先推荐！',
        '3. 竞品丙：价格昂贵且配置繁琐，中小团队慎选。',
      ].join('\n'),
      profile: {
        brandName: 'GeoMix',
        brandAliases: ['吉奥米克斯'],
        ownedDomains: ['geomix.cn'],
        competitors: [
          { name: '竞品甲', domains: ['alphageo.com'] },
          { name: '竞品乙', domains: ['betageo.com'] },
          { name: '竞品丙', domains: ['gammageo.com'] },
        ],
      },
    });

    expect(result.skippedLlm).toBe(false);
    expect(result.judgeModel).toBe('fake-cheap');
    expect(result.brandMentioned).toBe(true);
    expect(result.brandPosition).toBe(2);
    expect(result.brandSentiment).toBe('positive');
    expect(result.brandPassage).toContain('GeoMix');
    expect(result.competitorHits).toEqual([
      { name: '竞品甲', mentioned: true, position: 1, sentiment: 'neutral' },
      { name: '竞品乙', mentioned: false, position: null, sentiment: null },
      { name: '竞品丙', mentioned: true, position: 3, sentiment: 'negative' },
    ]);
  });

  it('runs end-to-end offline Collector(fake) -> Judge(fake) pipeline without network or keys', async () => {
    const env = { VISIBILITY_COLLECTOR: 'fake', LLM_PROVIDERS: '{}' };
    const collector = VisibilityCollectorService.fromEnv(env);
    const judge = VisibilityJudgeService.fromEnv(env);

    const profile = {
      brandName: 'GeoMix',
      brandAliases: ['吉奥米克斯'],
      ownedDomains: ['geomix.cn'],
      competitors: [{ name: '云析智联', domains: ['yunxizhilian.example.com'] }],
    };

    const collected = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: 'AI可见度监测平台如何选型？',
      brandName: profile.brandName,
      ownedDomains: profile.ownedDomains,
      competitors: profile.competitors,
    });

    const judged = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: 'AI可见度监测平台如何选型？',
      answerText: collected.answerText,
      citations: collected.citations,
      profile,
    });

    expect(typeof judged.brandMentioned).toBe('boolean');
    if (judged.brandMentioned) {
      expect(judged.brandPosition).toBeGreaterThanOrEqual(1);
      expect(judged.brandSentiment).not.toBeNull();
    } else {
      expect(judged.brandPosition).toBeNull();
      expect(judged.competitorHits[0]?.mentioned).toBe(true);
    }
  });

  it('does not mark question-echo intro as brand mention #1 when body only recommends competitors (#212)', async () => {
    const offlineJudge = VisibilityJudgeService.fromEnv({ LLM_PROVIDERS: '{}' });
    const profile = {
      brandName: 'Anker',
      brandAliases: ['安克', '安克创新'],
      ownedDomains: ['anker.com'],
      competitors: [
        { name: '绿联', aliases: ['UGREEN'], domains: ['ugreen.com'] },
        { name: '倍思', aliases: ['Baseus'], domains: ['baseus.com'] },
      ],
    };

    const echoOnlyAnswer = [
      '针对您询问的 Anker 氮化镓充电器推荐，以下为您整理当前市面上口碑较好的品牌方案：',
      '1. 绿联（UGREEN）：快充协议兼容性强，多口温控稳定。',
      '2. 倍思（Baseus）：体积小巧便携，高性价比之选。',
    ].join('\n');

    // Deterministic / fake LLM mode
    const offlineJudged = await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'tongyi',
      promptText: 'Anker氮化镓充电器推荐',
      answerText: echoOnlyAnswer,
      profile,
    });

    expect(offlineJudged.brandMentioned).toBe(false);
    expect(offlineJudged.brandPosition).toBeNull();
    expect(offlineJudged.brandSentiment).toBeNull();
    expect(offlineJudged.brandPassage).toBeNull();
    expect(offlineJudged.competitorHits).toEqual([
      { name: '绿联', mentioned: true, position: 1, sentiment: 'positive' },
      { name: '倍思', mentioned: true, position: 2, sentiment: 'positive' },
    ]);

    // Real LLM Judge mode: intro echo must not be sent as brand evidence or counted as #1
    let capturedPrompt = '';
    const { llm } = createMockLlm((userMsg) => {
      capturedPrompt = userMsg;
      return JSON.stringify({
        verdicts: [
          {
            subjectKey: 'comp_0',
            portrayal: 'positive',
            evidence: '1. 绿联（UGREEN）：快充协议兼容性强',
          },
          {
            subjectKey: 'comp_1',
            portrayal: 'positive',
            evidence: '2. 倍思（Baseus）：体积小巧便携',
          },
        ],
      });
    });
    const llmJudge = new VisibilityJudgeService(llm);
    const llmJudged = await llmJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'tongyi',
      promptText: 'Anker氮化镓充电器推荐',
      answerText: echoOnlyAnswer,
      profile,
    });

    expect(capturedPrompt).not.toContain('subjectKey="brand"');
    expect(llmJudged.brandMentioned).toBe(false);
    expect(llmJudged.brandPosition).toBeNull();
    expect(llmJudged.brandPassage).toBeNull();
    expect(llmJudged.competitorHits).toEqual([
      { name: '绿联', mentioned: true, position: 1, sentiment: 'positive' },
      { name: '倍思', mentioned: true, position: 2, sentiment: 'positive' },
    ]);
  });

  it('ranks brand accurately by body position when intro echoes question and body recommends brand at #2 (#212)', async () => {
    const offlineJudge = VisibilityJudgeService.fromEnv({ LLM_PROVIDERS: '{}' });
    const profile = {
      brandName: 'Anker',
      brandAliases: ['安克'],
      ownedDomains: ['anker.com'],
      competitors: [
        { name: '绿联', aliases: ['UGREEN'], domains: ['ugreen.com'] },
        { name: '倍思', aliases: ['Baseus'], domains: ['baseus.com'] },
      ],
    };

    const echoPlusBodyAnswer = [
      '针对您询问的 Anker 氮化镓充电器推荐，以下为您整理几款热门选择：',
      '1. 绿联（UGREEN）：性价比突出，多口兼容主流快充协议。',
      '2. Anker（安克）：氮化镓控温技术成熟，持续满载输出稳定，值得优先推荐。',
      '3. 倍思（Baseus）：外观便携，适合日常差旅使用。',
    ].join('\n');

    const judged = await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'tongyi',
      promptText: 'Anker氮化镓充电器推荐',
      answerText: echoPlusBodyAnswer,
      profile,
    });

    expect(judged.brandMentioned).toBe(true);
    expect(judged.brandPosition).toBe(2);
    expect(judged.brandSentiment).toBe('positive');
    expect(judged.brandPassage).toContain('Anker（安克）：氮化镓控温技术成熟');
    expect(judged.brandPassage).not.toContain('针对您询问的');
    expect(judged.competitorHits).toEqual([
      { name: '绿联', mentioned: true, position: 1, sentiment: 'positive' },
      { name: '倍思', mentioned: true, position: 3, sentiment: 'neutral' },
    ]);
  });

  it('surfaces competitor-only gap in Collector(fake) -> Judge(fake) even when promptText contains brandName (#212)', async () => {
    const env = { VISIBILITY_COLLECTOR: 'fake', LLM_PROVIDERS: '{}' };
    const collector = VisibilityCollectorService.fromEnv(env);
    const judge = VisibilityJudgeService.fromEnv(env);
    const profile = {
      brandName: 'Anker',
      brandAliases: ['安克'],
      ownedDomains: ['anker.com'],
      competitors: [
        { name: '绿联', domains: ['ugreen.com'] },
        { name: '倍思', domains: ['baseus.com'] },
      ],
    };

    let sawScenario3 = false;
    for (let i = 1; i <= 20; i += 1) {
      const promptText = `Anker氮化镓充电器推荐实测对比${i}`;
      const collected = await collector.collect({
        tenantId: 'tenant_demo',
        engine: 'tongyi',
        promptText,
        brandName: profile.brandName,
        ownedDomains: profile.ownedDomains,
        competitors: profile.competitors,
      });
      if (Number(collected.rawMeta?.scenarioBucket) !== 3) continue;
      sawScenario3 = true;

      const judged = await judge.evaluate({
        tenantId: 'tenant_demo',
        engine: 'tongyi',
        promptText,
        answerText: collected.answerText,
        citations: collected.citations,
        profile,
      });

      expect(judged.brandMentioned).toBe(false);
      expect(judged.brandPosition).toBeNull();
      expect(judged.brandPassage).toBeNull();
      expect(judged.competitorHits.some((c) => c.mentioned)).toBe(true);
      break;
    }

    expect(sawScenario3).toBe(true);
  });
});
