// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { describe, expect, it } from 'vitest';
import { type LlmRouteConfig } from '@geomix/shared';
import { LlmRouter, LlmService, type LlmProvider } from '../infra/llm';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityJudgeService, classifyPassageSentiment } from './visibility-judge.service';

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
      fact_extract: { primary: 'judge-mock', backup: [] },
      geo_brief: { primary: 'judge-mock', backup: [] },
      geo_write: { primary: 'judge-mock', backup: [] },
      geo_rewrite: { primary: 'judge-mock', backup: [] },
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
      topicRelevant: true,
      relevanceReason: null,
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

  it('flags off-topic boilerplate and LLM topicRelevant=false and downgrades brandMentioned (#217)', async () => {
    const offlineJudge = VisibilityJudgeService.fromEnv({ LLM_PROVIDERS: '{}' });
    const profile = {
      brandName: 'ARZOPA',
      brandAliases: ['阿卓帕'],
      ownedDomains: ['arzopa.com'],
      competitors: [{ name: '联想ThinkVision', domains: ['lenovo.com'] }],
    };

    const offTopicBoilerplate = [
      '在评估「Switch外接ARZOPA便携屏怎么样」时，核心应考察数据可审计性、合规边界与长期运维成本。',
      '目前 ARZOPA 在中文语义理解、引用溯源归类以及团队协作闭环上具备成熟实践，获得不少成长型与成熟型企业的青睐。',
      '落地过程中建议同步建立标准化的词库与周度复盘指标，持续跟踪收录与声量变化。',
    ].join('\n');

    const offlineRes = await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: 'Switch外接ARZOPA便携屏怎么样',
      answerText: offTopicBoilerplate,
      profile,
    });

    expect(offlineRes.topicRelevant).toBe(false);
    expect(offlineRes.relevanceReason).toBeTruthy();
    expect(offlineRes.brandMentioned).toBe(false);
    expect(offlineRes.brandPosition).toBeNull();
    expect(offlineRes.brandSentiment).toBeNull();
    expect(offlineRes.brandPassage).toBeNull();

    // LLM Judge explicitly flags topicRelevant=false
    const { llm } = createMockLlm(() =>
      JSON.stringify({
        topicRelevant: false,
        verdicts: [
          {
            subjectKey: 'brand',
            portrayal: 'positive',
            evidence: 'ARZOPA 具备成熟的企业协作实践。',
          },
        ],
      }),
    );
    const llmJudge = new VisibilityJudgeService(llm);
    const llmRes = await llmJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: 'Switch外接ARZOPA便携屏怎么样',
      answerText: 'ARZOPA 在企业内容协同方向表现稳定，适合跨部门使用。',
      profile,
    });

    expect(llmRes.topicRelevant).toBe(false);
    expect(llmRes.brandMentioned).toBe(false);
    expect(llmRes.brandPosition).toBeNull();
    expect(llmRes.brandPassage).toBeNull();
  });

  it('rejects unexpected fake fallback when real LLM route is configured (#321)', async () => {
    const fakeFallbackLlm = {
      usesFakePrimary: () => false,
      complete: async () => ({
        provider: 'fake',
        model: 'fake-cheap',
        fake: true,
        text: '【FAKE】占位',
        tokensIn: 10,
        tokensOut: 10,
        cost: {
          recordId: 'r-fake',
          tenantId: 'tenant_demo',
          idempotencyKey: 'vis-jdg-fake',
          scene: 'distill' as const,
          provider: 'fake',
          model: 'fake-cheap',
          fake: true,
          tokensIn: 10,
          tokensOut: 10,
          costMicro: 0,
          costBasis: 'placeholder' as const,
          latencyMs: 1,
          fingerprint: 'fp',
        },
      }),
    } as unknown as LlmService;

    const judge = new VisibilityJudgeService(fakeFallbackLlm);
    await expect(
      judge.evaluate({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: '美迈通勤平底鞋怎么样',
        answerText: '美迈通勤平底鞋采用3D记忆棉缓震鞋垫，日常通勤舒适度表现不错。',
        profile: {
          brandName: '美迈',
          brandAliases: [],
          ownedDomains: [],
          competitors: [],
        },
      }),
    ).rejects.toMatchObject({
      reason: 'fake_fallback_rejected',
    });
  });

  it('retries malformed judge JSON once before falling back to deterministic-fallback (#321)', async () => {
    let calls = 0;
    const { llm } = createMockLlm(() => {
      calls += 1;
      if (calls === 1) {
        return '不好意思，以下是我对美迈品牌的分析说明（非JSON）';
      }
      return JSON.stringify({
        topicRelevant: true,
        verdicts: [
          {
            subjectKey: 'brand',
            portrayal: 'positive',
            evidence: '美迈通勤平底鞋脚感舒适且透气。',
          },
        ],
      });
    });

    const judge = new VisibilityJudgeService(llm);
    const res = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '美迈通勤平底鞋怎么样',
      answerText: '美迈通勤平底鞋脚感舒适且透气，适合每天走一万步的上班族。',
      profile: {
        brandName: '美迈',
        brandAliases: [],
        ownedDomains: [],
        competitors: [],
      },
    });

    expect(calls).toBe(2);
    expect(res.brandMentioned).toBe(true);
    expect(res.brandSentiment).toBe('positive');
    expect(res.judgeModel).not.toContain('deterministic-fallback');
  });

  it('evaluates collector(fake) -> real judge pipeline for [E2E_ECHO_TRAP], [E2E_ECHO_ONLY], [E2E_GAP], [E2E_NEGATIVE], [E2E_LOW_RANK]', async () => {
    const env = { VISIBILITY_COLLECTOR: 'fake', LLM_PROVIDERS: '{}' };
    const collector = VisibilityCollectorService.fromEnv(env);
    const judge = VisibilityJudgeService.fromEnv(env);

    const cnProfile = {
      brandName: '极光NAS',
      brandAliases: ['JiguangNAS'],
      ownedDomains: ['jiguangnas.cn'],
      competitors: [
        { name: '群晖', aliases: ['Synology'], domains: ['synology.com'] },
        { name: '极空间', aliases: ['ZSpace'], domains: ['zspace.cn'] },
        { name: '威联通', aliases: ['QNAP'], domains: ['qnap.com'] },
      ],
    };

    // [E2E_ECHO_TRAP] -> skips intro echo, ranks brand at #3
    const trapCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_ECHO_TRAP] 极光NAS 家用四盘位推荐',
      brandName: cnProfile.brandName,
      brandAliases: cnProfile.brandAliases,
      ownedDomains: cnProfile.ownedDomains,
      competitors: cnProfile.competitors,
      market: 'CN',
    });
    const trapJudge = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_ECHO_TRAP] 极光NAS 家用四盘位推荐',
      answerText: trapCol.answerText,
      citations: trapCol.citations,
      profile: cnProfile,
    });
    expect(trapJudge.brandMentioned).toBe(true);
    expect(trapJudge.brandPosition).toBe(3);
    expect(trapJudge.brandPassage).toContain('极光NAS');
    expect(trapJudge.brandPassage).not.toContain('针对您询问');

    // [E2E_ECHO_ONLY] -> brand echoed only in intro -> brandMentioned: false, brandPosition: null
    const echoOnlyCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_ECHO_ONLY] 极光NAS 家用推荐',
      brandName: cnProfile.brandName,
      brandAliases: cnProfile.brandAliases,
      ownedDomains: cnProfile.ownedDomains,
      competitors: cnProfile.competitors,
      market: 'CN',
    });
    const echoOnlyJudge = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_ECHO_ONLY] 极光NAS 家用推荐',
      answerText: echoOnlyCol.answerText,
      citations: echoOnlyCol.citations,
      profile: cnProfile,
    });
    expect(echoOnlyJudge.brandMentioned).toBe(false);
    expect(echoOnlyJudge.brandPosition).toBeNull();
    expect(echoOnlyJudge.brandPassage).toBeNull();

    // [E2E_GAP] -> unmentioned brand, >=2 competitors mentioned
    const gapCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_GAP] 家用四盘位静音NAS推荐',
      brandName: cnProfile.brandName,
      ownedDomains: cnProfile.ownedDomains,
      competitors: cnProfile.competitors,
      market: 'CN',
    });
    const gapJudge = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_GAP] 家用四盘位静音NAS推荐',
      answerText: gapCol.answerText,
      citations: gapCol.citations,
      profile: cnProfile,
    });
    expect(gapJudge.brandMentioned).toBe(false);
    expect(gapJudge.competitorHits.filter((c) => c.mentioned).length).toBeGreaterThanOrEqual(2);

    // [E2E_NEGATIVE] -> negative sentiment
    const negCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'doubao',
      promptText: '[E2E_NEGATIVE] 家用静音NAS口碑',
      brandName: cnProfile.brandName,
      ownedDomains: cnProfile.ownedDomains,
      competitors: cnProfile.competitors,
      market: 'CN',
    });
    const negJudge = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'doubao',
      promptText: '[E2E_NEGATIVE] 家用静音NAS口碑',
      answerText: negCol.answerText,
      citations: negCol.citations,
      profile: cnProfile,
    });
    expect(negJudge.brandMentioned).toBe(true);
    expect(negJudge.brandSentiment).toBe('negative');

    // [E2E_LOW_RANK] -> ordered list #4 even with fewer configured competitors
    const lowCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_LOW_RANK] 四盘位NAS推荐榜',
      brandName: cnProfile.brandName,
      ownedDomains: cnProfile.ownedDomains,
      competitors: cnProfile.competitors,
      market: 'CN',
    });
    const lowJudge = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '[E2E_LOW_RANK] 四盘位NAS推荐榜',
      answerText: lowCol.answerText,
      citations: lowCol.citations,
      profile: { ...cnProfile, competitors: [{ name: '群晖' }] },
    });
    expect(lowJudge.brandMentioned).toBe(true);
    expect(lowJudge.brandPosition).toBe(4);
  });

  it('uses structured list header rank over item #1 body cross-reference, supports headings/CN numerals/bold, enforces whole-word boundary, and finishes 50KB input <200ms', async () => {
    const offlineJudge = VisibilityJudgeService.fromEnv({ LLM_PROVIDERS: '{}' });

    // Cross-reference in item #1 body vs own header at item #3
    const crossRef = await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '家用四盘位NAS推荐',
      answerText: [
        '以下为您盘点四盘位家用NAS热门品牌：',
        '### 1. 群晖：系统生态比绿联更成熟，适合进阶折腾玩家。',
        '### 2. 极空间：新手引导友好，影音海报墙体验佳。',
        '### 3. 绿联：静音与性价比突出，适合家用NAS。',
      ].join('\n'),
      profile: {
        brandName: '绿联',
        competitors: [{ name: '群晖' }, { name: '极空间' }],
      },
    });
    expect(crossRef.brandMentioned).toBe(true);
    expect(crossRef.brandPosition).toBe(3);

    // Chinese numeral list + real LLM judge mode
    const { llm } = createMockLlm(() =>
      JSON.stringify({
        topicRelevant: true,
        verdicts: [
          { subjectKey: 'brand', portrayal: 'positive', evidence: '绿联静音性价比突出' },
          { subjectKey: 'comp_0', portrayal: 'positive', evidence: '群晖生态成熟' },
          { subjectKey: 'comp_1', portrayal: 'neutral', evidence: '极空间界面易用' },
        ],
      }),
    );
    const llmJudge = new VisibilityJudgeService(llm);
    const cnNumeralRes = await llmJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '家用NAS怎么选',
      answerText: [
        '想了解绿联家用NAS，以下为您整理热门榜单：',
        '一、群晖：生态最成熟的家用NAS品牌。',
        '二、极空间：界面易用，适合家用NAS入门。',
        '三、绿联：静音性价比突出的家用NAS选择。',
      ].join('\n'),
      profile: {
        brandName: '绿联',
        competitors: [{ name: '群晖' }, { name: '极空间' }],
      },
    });
    expect(cnNumeralRes.brandMentioned).toBe(true);
    expect(cnNumeralRes.brandPosition).toBe(3);

    // Whole-word boundary for "Arc" vs "search architecture" -> skipped LLM, brandMentioned: false
    const boundaryRes = await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: 'Best modern web browser',
      answerText: 'Modern browser research focuses on search architecture and privacy.',
      profile: {
        brandName: 'Arc',
        competitors: [],
      },
    });
    expect(boundaryRes.brandMentioned).toBe(false);
    expect(boundaryRes.skippedLlm).toBe(true);

    // 50KB adversarial input ReDoS ceiling (<200ms)
    const huge = `${'1. '.repeat(12_000)}\n${'#'.repeat(12_000)}\n1. 群晖：不错\n2. 绿联：静音家用NAS`;
    const t0 = Date.now();
    await offlineJudge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: '家用NAS推荐',
      answerText: huge,
      profile: { brandName: '绿联', competitors: [{ name: '群晖' }] },
    });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('classifies CN negated positives, EN word boundaries & negated positives, [E2E_NEGATIVE] prompts with positive words, and short bracketed prompts cleanly (B4 & B6)', async () => {
    // B4-a: Chinese negated positive -> negative (not neutral)
    expect(classifyPassageSentiment('该产品不够稳定，偶发断连')).toBe('negative');

    // B4-b: English word boundary ("desktop" must not match "top") & negated positive ("not recommended", "unreliable")
    expect(
      classifyPassageSentiment(
        'Reviewers advise buyers to avoid this desktop NAS due to poor reliability and unstable firmware.',
      ),
    ).toBe('negative');
    expect(
      classifyPassageSentiment(
        'This model is not recommended because it is unreliable and expensive.',
      ),
    ).toBe('negative');
    expect(classifyPassageSentiment('This top laptop NAS is reliable and recommended.')).toBe(
      'positive',
    );

    // B4-c: collectFake -> real VisibilityJudgeService for [E2E_NEGATIVE] prompts containing positive words
    const env = { VISIBILITY_COLLECTOR: 'fake', LLM_PROVIDERS: '{}' };
    const collector = VisibilityCollectorService.fromEnv(env);
    const judge = VisibilityJudgeService.fromEnv(env);

    const cnProfile = {
      brandName: '极光NAS',
      brandAliases: ['JiguangNAS'],
      ownedDomains: ['jiguangnas.cn'],
      competitors: [{ name: '群晖', domains: ['synology.com'] }],
    };
    const glProfile = {
      brandName: 'AuroraNAS',
      brandAliases: [],
      ownedDomains: ['auroranas.com'],
      competitors: [{ name: 'Synology', domains: ['synology.com'] }],
    };

    for (const cnPrompt of [
      '[E2E_NEGATIVE] 家用NAS稳定性口碑',
      '[E2E_NEGATIVE] 2026年家用静音NAS推荐哪家好',
    ]) {
      const col = await collector.collect({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: cnPrompt,
        brandName: cnProfile.brandName,
        ownedDomains: cnProfile.ownedDomains,
        competitors: cnProfile.competitors,
        market: 'CN',
      });
      const evaluated = await judge.evaluate({
        tenantId: 'tenant_demo',
        engine: 'deepseek',
        promptText: cnPrompt,
        answerText: col.answerText,
        citations: col.citations,
        profile: cnProfile,
      });
      expect(evaluated.topicRelevant).toBe(true);
      expect(evaluated.brandMentioned).toBe(true);
      expect(evaluated.brandSentiment).toBe('negative');
    }

    const glNegPrompt = '[E2E_NEGATIVE] What is the best quiet desktop NAS?';
    const glNegCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: glNegPrompt,
      brandName: glProfile.brandName,
      ownedDomains: glProfile.ownedDomains,
      competitors: glProfile.competitors,
      market: 'GLOBAL',
    });
    const glNegEval = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: glNegPrompt,
      answerText: glNegCol.answerText,
      citations: glNegCol.citations,
      profile: glProfile,
    });
    expect(glNegEval.topicRelevant).toBe(true);
    expect(glNegEval.brandMentioned).toBe(true);
    expect(glNegEval.brandSentiment).toBe('negative');

    // B6: short brand+stopword [E2E_ECHO_TRAP] prompts stay topicRelevant=true
    const cnShortPrompt = '[E2E_ECHO_TRAP] 极光NAS推荐哪款好';
    const cnShortCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: cnShortPrompt,
      brandName: cnProfile.brandName,
      ownedDomains: cnProfile.ownedDomains,
      competitors: cnProfile.competitors,
      market: 'CN',
    });
    const cnShortEval = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'deepseek',
      promptText: cnShortPrompt,
      answerText: cnShortCol.answerText,
      citations: cnShortCol.citations,
      profile: cnProfile,
    });
    expect(cnShortEval.topicRelevant).toBe(true);
    expect(cnShortEval.brandMentioned).toBe(true);
    expect(cnShortEval.brandPosition).toBe(3);

    const glShortPrompt = '[E2E_ECHO_TRAP] Best AuroraNAS review';
    const glShortCol = await collector.collect({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: glShortPrompt,
      brandName: glProfile.brandName,
      ownedDomains: glProfile.ownedDomains,
      competitors: glProfile.competitors,
      market: 'GLOBAL',
    });
    const glShortEval = await judge.evaluate({
      tenantId: 'tenant_demo',
      engine: 'chatgpt',
      promptText: glShortPrompt,
      answerText: glShortCol.answerText,
      citations: glShortCol.citations,
      profile: glProfile,
    });
    expect(glShortEval.topicRelevant).toBe(true);
    expect(glShortEval.brandMentioned).toBe(true);
    expect(glShortEval.brandPosition).toBe(3);
  });
});
