// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  extractEvidencePassages,
  findSubjectMentionOffsets,
  isVisibilitySentiment,
  matchesDomain,
  rankTrackedSubjects,
  type CompetitorHit,
  type TrackedSubject,
  type VisibilitySentiment,
} from '@geomix/shared';
import { z } from 'zod';
import { LlmService } from '../infra/llm';

export const JUDGE_PORTRAYAL_VALUES = [
  'positive',
  'neutral',
  'mixed',
  'negative',
  'other_meaning',
  'other_company',
  'no_info',
] as const;

export type JudgePortrayal = (typeof JUDGE_PORTRAYAL_VALUES)[number];

const NON_MENTION_PORTRAYALS = new Set<JudgePortrayal>([
  'other_meaning',
  'other_company',
  'no_info',
]);

const POSITIVE_CUES = [
  '推荐',
  '首选',
  '出色',
  '优秀',
  '领先',
  '稳定',
  '高效',
  '优势',
  '好评',
  '青睐',
  '成熟',
  '值得',
  '性价比突出',
  '高性价比',
  '便捷',
  '突出',
  '标杆',
  '优先',
  '优异',
  'top',
  'best',
  'leading',
  'excellent',
  'recommended',
  'strong',
  'reliable',
] as const;

const NEGATIVE_CUES = [
  '不推荐',
  '慎选',
  '缺陷',
  '故障',
  '投诉',
  '昂贵',
  '不稳定',
  '较差',
  '落后',
  '短板',
  '不足',
  '繁琐',
  '门槛高',
  '受限',
  '较慢',
  '局限',
  '需结合业务规范配置',
  'poor',
  'bad',
  'avoid',
  'expensive',
  'unstable',
  'lacks',
  'weakness',
  'drawback',
] as const;

const CONTRAST_CUES = [
  '不过',
  '但是',
  '然而',
  '但部分',
  '只是',
  '缺点',
  'however',
  'although',
] as const;

const llmJudgeVerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        subjectKey: z.string().min(1).max(64),
        portrayal: z.enum(JUDGE_PORTRAYAL_VALUES),
        evidence: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export type VisibilityJudgeInput = {
  tenantId: string;
  promptText: string;
  engine: string;
  answerText: string;
  citations?: ReadonlyArray<{
    url: string;
    title?: string | null;
    snippet?: string | null;
  }>;
  profile: {
    brandName: string;
    brandAliases?: readonly string[];
    ownedDomains?: readonly string[];
    competitors?: ReadonlyArray<{
      name: string;
      aliases?: readonly string[];
      domains?: readonly string[];
    }>;
  };
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type VisibilityJudgeResult = {
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: VisibilitySentiment | null;
  brandPassage: string | null;
  competitorHits: CompetitorHit[];
  judgeModel: string;
  tokensIn: number;
  tokensOut: number;
  skippedLlm: boolean;
};

type CandidateScan = {
  subjectKey: string;
  isBrand: boolean;
  subject: TrackedSubject;
  offsets: number[];
  textOffsets: number[];
  domainCited: boolean;
  passages: string[];
};

@Injectable()
export class VisibilityJudgeService {
  constructor(@Inject(LlmService) private readonly llm: LlmService) {}

  static fromEnv(
    env: Record<string, string | undefined>,
    overrides?: { llm?: LlmService },
  ): VisibilityJudgeService {
    return new VisibilityJudgeService(overrides?.llm ?? LlmService.fromEnv(env));
  }

  async evaluate(input: VisibilityJudgeInput): Promise<VisibilityJudgeResult> {
    const answerText = input.answerText ?? '';
    const citedUrls = (input.citations ?? []).map((item) => item.url);

    const brandCandidate = scanCandidate(
      'brand',
      true,
      {
        name: input.profile.brandName,
        aliases: input.profile.brandAliases ?? [],
        domains: input.profile.ownedDomains ?? [],
      },
      answerText,
      citedUrls,
      input.promptText,
    );

    const competitorCandidates = (input.profile.competitors ?? []).map((comp, idx) =>
      scanCandidate(
        `comp_${idx}`,
        false,
        {
          name: comp.name,
          aliases: comp.aliases ?? [],
          domains: comp.domains ?? [],
        },
        answerText,
        citedUrls,
        input.promptText,
      ),
    );

    const allCandidates = [brandCandidate, ...competitorCandidates];
    const matchedCandidates = allCandidates.filter((item) => item.offsets.length > 0);

    // Stage 1: 零命中快速短路，不消耗任何 LLM Token
    if (matchedCandidates.length === 0) {
      return {
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: null,
        brandPassage: null,
        competitorHits: competitorCandidates.map((comp) => ({
          name: comp.subject.name,
          mentioned: false,
          position: null,
          sentiment: null,
        })),
        judgeModel: 'deterministic-skip',
        tokensIn: 0,
        tokensOut: 0,
        skippedLlm: true,
      };
    }

    const textMatchedCandidates = matchedCandidates.filter(
      (item) => item.textOffsets.length > 0 && item.passages.length > 0,
    );

    // 若全部命中仅来自引用域名（正文中无词面出现），直接确定性归因，无需调 LLM
    if (textMatchedCandidates.length === 0) {
      return finalizeVerdicts({
        brandCandidate,
        competitorCandidates,
        verdictMap: new Map(),
        useDeterministicFallback: true,
        judgeModel: 'deterministic-domain',
        tokensIn: 0,
        tokensOut: 0,
        skippedLlm: true,
      });
    }

    // Stage 2: 仅对初筛命中的候选实体抽取证据片段调用 LLM Judge 消歧与情感分类
    const idempotencyKey =
      input.idempotencyKey && /^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)
        ? input.idempotencyKey
        : buildJudgeIdempotencyKey(
            input.tenantId,
            input.engine,
            input.promptText,
            answerText,
            textMatchedCandidates.map((c) => c.subject.name),
          );

    const llmResult = await this.llm.complete({
      tenantId: input.tenantId,
      scene: 'distill',
      idempotencyKey,
      signal: input.signal,
      temperature: 0,
      maxTokens: 1024,
      messages: [
        {
          role: 'system',
          content: [
            '你是企业品牌可见性与声誉评测裁判（Mention & Sentiment Judge）。',
            '请根据用户问题与候选实体在 AI 回答中的原文片段，判断每个候选词是否确指该目标品牌/公司，并给出情感倾向：',
            '- positive：正面推荐、肯定优势或积极评价；',
            '- neutral：客观陈述、无明显褒贬；',
            '- mixed：同时指出优点与局限/缺点；',
            '- negative：负面批评、提示风险或不建议选择；',
            '- other_meaning：同名普通词汇歧义（如水果“苹果”而非品牌）；',
            '- other_company：同名但明显指代另一家无关主体；',
            '- no_info：未真正提及该实体，或仅在复述/转述用户提问词时顺带出现而正文未对该品牌进行推荐、评价或对比。',
            '仅输出严格 JSON：{"verdicts":[{"subjectKey":"brand","portrayal":"positive","evidence":"原文关键句"}]}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: buildJudgeUserPrompt(input.promptText, textMatchedCandidates),
        },
      ],
    });

    if (llmResult.fake) {
      return finalizeVerdicts({
        brandCandidate,
        competitorCandidates,
        verdictMap: new Map(),
        useDeterministicFallback: true,
        judgeModel: llmResult.model,
        tokensIn: llmResult.tokensIn,
        tokensOut: llmResult.tokensOut,
        skippedLlm: false,
      });
    }

    const parsedJson = extractJsonObject(llmResult.text);
    const parsedVerdicts = parsedJson ? llmJudgeVerdictSchema.safeParse(parsedJson) : null;

    if (!parsedVerdicts?.success) {
      return finalizeVerdicts({
        brandCandidate,
        competitorCandidates,
        verdictMap: new Map(),
        useDeterministicFallback: true,
        judgeModel: `${llmResult.model}:deterministic-fallback`,
        tokensIn: llmResult.tokensIn,
        tokensOut: llmResult.tokensOut,
        skippedLlm: false,
      });
    }

    const verdictMap = new Map<string, { portrayal: JudgePortrayal; evidence?: string }>();
    for (const row of parsedVerdicts.data.verdicts) {
      verdictMap.set(row.subjectKey, {
        portrayal: row.portrayal,
        evidence: row.evidence?.trim(),
      });
    }

    return finalizeVerdicts({
      brandCandidate,
      competitorCandidates,
      verdictMap,
      useDeterministicFallback: false,
      judgeModel: llmResult.model,
      tokensIn: llmResult.tokensIn,
      tokensOut: llmResult.tokensOut,
      skippedLlm: false,
    });
  }
}

function scanCandidate(
  subjectKey: string,
  isBrand: boolean,
  subject: TrackedSubject,
  answerText: string,
  citedUrls: readonly string[],
  promptText?: string,
): CandidateScan {
  const mentionOptions = { promptText };
  const textOffsets = findSubjectMentionOffsets(answerText, subject, undefined, mentionOptions);
  const offsets =
    textOffsets.length > 0
      ? textOffsets
      : findSubjectMentionOffsets(answerText, subject, citedUrls, mentionOptions);
  const domainCited =
    subject.domains.length > 0 &&
    citedUrls.some((url) => subject.domains.some((dom) => matchesDomain(url, dom)));
  const passages =
    textOffsets.length > 0 ? extractEvidencePassages(answerText, subject, 3, mentionOptions) : [];

  return {
    subjectKey,
    isBrand,
    subject,
    offsets,
    textOffsets,
    domainCited,
    passages,
  };
}

function finalizeVerdicts(input: {
  brandCandidate: CandidateScan;
  competitorCandidates: readonly CandidateScan[];
  verdictMap: ReadonlyMap<string, { portrayal: JudgePortrayal; evidence?: string }>;
  useDeterministicFallback: boolean;
  judgeModel: string;
  tokensIn: number;
  tokensOut: number;
  skippedLlm: boolean;
}): VisibilityJudgeResult {
  const all = [input.brandCandidate, ...input.competitorCandidates];

  const evaluated = all.map((cand) => {
    if (cand.offsets.length === 0) {
      return {
        subjectKey: cand.subjectKey,
        name: cand.subject.name,
        mentioned: false,
        firstMention: null as number | null,
        sentiment: null as VisibilitySentiment | null,
        passage: null as string | null,
      };
    }

    const llmVerdict = input.verdictMap.get(cand.subjectKey);
    if (!input.useDeterministicFallback && llmVerdict) {
      if (NON_MENTION_PORTRAYALS.has(llmVerdict.portrayal)) {
        if (cand.domainCited) {
          return {
            subjectKey: cand.subjectKey,
            name: cand.subject.name,
            mentioned: true,
            firstMention: cand.offsets[0] ?? null,
            sentiment: 'neutral' as VisibilitySentiment,
            passage: cand.passages[0] ?? null,
          };
        }
        return {
          subjectKey: cand.subjectKey,
          name: cand.subject.name,
          mentioned: false,
          firstMention: null,
          sentiment: null,
          passage: null,
        };
      }

      const sentiment: VisibilitySentiment = isVisibilitySentiment(llmVerdict.portrayal)
        ? llmVerdict.portrayal
        : 'neutral';
      const evidence =
        llmVerdict.evidence && llmVerdict.evidence.length > 0
          ? llmVerdict.evidence
          : (cand.passages[0] ?? null);

      return {
        subjectKey: cand.subjectKey,
        name: cand.subject.name,
        mentioned: true,
        firstMention: cand.offsets[0] ?? null,
        sentiment,
        passage: evidence,
      };
    }

    // 确定性情感与提及兜底（离线 fake 模式或 LLM 未返回对应项）
    const deterministicSentiment =
      cand.passages.length > 0 ? classifyPassageSentiment(cand.passages.join(' ')) : 'neutral';

    return {
      subjectKey: cand.subjectKey,
      name: cand.subject.name,
      mentioned: true,
      firstMention: cand.offsets[0] ?? null,
      sentiment: deterministicSentiment,
      passage: cand.passages[0] ?? null,
    };
  });

  const ranked = rankTrackedSubjects(evaluated);
  const brandRanked = ranked[0];
  const compRanked = ranked.slice(1);

  return {
    brandMentioned: brandRanked?.mentioned ?? false,
    brandPosition: brandRanked?.position ?? null,
    brandSentiment: brandRanked?.mentioned ? (brandRanked.sentiment ?? 'neutral') : null,
    brandPassage: brandRanked?.mentioned ? (brandRanked.passage ?? null) : null,
    competitorHits: compRanked.map((item) => ({
      name: item.name,
      mentioned: item.mentioned,
      position: item.position,
      sentiment: item.mentioned ? (item.sentiment ?? 'neutral') : null,
    })),
    judgeModel: input.judgeModel,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    skippedLlm: input.skippedLlm,
  };
}

export function classifyPassageSentiment(passageText: string): VisibilitySentiment {
  const lower = passageText.toLowerCase();
  const hasNeg = NEGATIVE_CUES.some((cue) => lower.includes(cue.toLowerCase()));
  // 排除“不推荐”对“推荐”的包含干扰
  const scrubbedForPos = lower.replace(/不推荐|不值得|不够稳定|不够出色/gu, '');
  const hasPos = POSITIVE_CUES.some((cue) => scrubbedForPos.includes(cue.toLowerCase()));
  const hasContrast = CONTRAST_CUES.some((cue) => lower.includes(cue.toLowerCase()));

  if (hasPos && (hasNeg || hasContrast)) return 'mixed';
  if (hasPos) return 'positive';
  if (hasNeg) return 'negative';
  return 'neutral';
}

function buildJudgeUserPrompt(promptText: string, candidates: readonly CandidateScan[]): string {
  const lines: string[] = [
    `【用户问题】\n${promptText.trim()}`,
    '',
    '【待判定候选实体与证据片段】',
  ];
  for (const cand of candidates) {
    const aliases =
      cand.subject.aliases.length > 0 ? `（别名：${cand.subject.aliases.join('、')}）` : '';
    const domains =
      cand.subject.domains.length > 0 ? `（域名：${cand.subject.domains.join(', ')}）` : '';
    lines.push(`- subjectKey="${cand.subjectKey}" 名称="${cand.subject.name}"${aliases}${domains}`);
    cand.passages.forEach((p, idx) => {
      lines.push(`  片段${idx + 1}：${p}`);
    });
  }
  return lines.join('\n');
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function buildJudgeIdempotencyKey(
  tenantId: string,
  engine: string,
  promptText: string,
  answerText: string,
  subjectNames: readonly string[],
): string {
  const hash = createHash('sha256')
    .update(`${tenantId}::${engine}::${promptText}::${subjectNames.join(',')}::${answerText}`)
    .digest('hex')
    .slice(0, 36);
  return `vis-jdg:${hash}`;
}
