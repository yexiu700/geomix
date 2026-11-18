import { AI_IMAGE_PROMPT_MAX, AI_IMAGE_PROMPT_MIN } from '@geomix/shared';
import type { LlmMessage } from '../infra/llm';

const PROMPT_MAX_LEN = AI_IMAGE_PROMPT_MAX - 10;

const JSON_PROMPT_KEYS = [
  'prompt',
  'optimizedPrompt',
  'optimized_prompt',
  'imagePrompt',
  'image_prompt',
  'description',
] as const;

/**
 * 识别大模型泄露的内部推理独白、System Prompt 约束原文或标签残留。
 */
const LEAK_PATTERNS: readonly RegExp[] = [
  /<\/?(?:think|thinking|thought|reasoning)\b[^>]*>/i,
  /商业视觉配图提示词编辑/,
  /配图提示词编辑/,
  /JSON\s*生成器/,
  /用户的简短描述/,
  /用户需要把/,
  /扩写成配图提示词/,
  /扩写为一段/,
  /硬性约束/,
  /核心约束/,
  /字数控制/,
  /字数要求/,
  /80\s*[-~到至]\s*220\s*字/,
  /不输出引号/,
  /多余解释/,
  /真人正脸(?:肖像)?/,
  /公众人物/,
  /(?:任何)?品牌商标\s*Logo/i,
  /(?:不出现|不能出现|禁止|避免|品牌\s*Logo).*文字海报/i,
  /(?:不出现|不能出现|避免出现).*(?:品牌|Logo|真人|正脸|商标)/i,
  /避免品牌名/,
  /思考过程/,
  /推理过程/,
  /内心独白/,
  /首先拆解/,
  /首先分析/,
  /下面开始构思/,
  /满足以下约束/,
  /遵守以下规则/,
  /检查是否符合/,
  /^(?:好的[，,]?|明白[，,]?|思考[:：]|分析[:：]|草稿[:：]|以下(?:是|为)(?:您)?(?:优化|生成|扩写))/,
  /(?:品牌名|字数|约束|规则|要求|硬性)[？?]/,
  /\b(?:let me|i need to|the user wants|system prompt|hard constraint|thinking process|step\s*\d+:)\b/i,
];

const LEADING_LABEL_PATTERN =
  /^(?:(?:最终|优化后(?:的)?|画面|配图|输出)?\s*(?:提示词|prompt)\s*[:：]\s*)+/i;

const FINAL_PROMPT_LINE_PATTERN =
  /(?:^|\n)\s*(?:最终|优化后(?:的)?|画面|配图)\s*提示词\s*[:：]\s*([^\n]+)\s*$/i;

export function buildImagePromptMessages(input: {
  contextSegments: readonly string[];
  strictRetry?: boolean;
}): LlmMessage[] {
  if (input.strictRetry) {
    return [
      {
        role: 'system',
        content:
          '你是严格的JSON视觉提示词生成器。根据用户输入生成一段80-200字中文商业配图画面描述（聚焦主体、材质、光线、构图与景深）。只允许输出单行合法JSON：{"prompt":"..."}，禁止输出思考过程、规则复述或JSON以外的任何字符。',
      },
      {
        role: 'user',
        content: [
          ...input.contextSegments,
          '示例格式：{"prompt":"写实商业摄影，浅色木质桌面摆放极简电子设备，侧前方柔和自然光勾勒金属纹理，浅景深虚化背景，构图均衡干净。"}',
          '请立即输出纯 JSON：',
        ].join('\n'),
      },
    ];
  }

  return [
    {
      role: 'system',
      content:
        '你是商业视觉配图提示词编辑。请将用户描述扩写为80-220字的中文画面提示词，突出主体细节、材质纹理、光线层次与空间构图，适合写实或商业生图使用。请直接输出唯一JSON对象：{"prompt":"你的画面描述"}，不要输出思考过程、解释或Markdown以外的额外文本。',
    },
    {
      role: 'user',
      content: [...input.contextSegments, '请直接输出 JSON 对象 {"prompt":"..."}：'].join('\n'),
    },
  ];
}

export function stripReasoningMarkup(raw: string): string {
  const withoutClosed = raw
    .replace(/<(think|thinking|thought|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .trim();
  return withoutClosed.replace(/<(think|thinking|thought|reasoning)\b[^>]*>[\s\S]*$/gi, '').trim();
}

export function containsPromptLeakage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  return LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeCandidateText(raw: string): string {
  return raw
    .replace(/^```(?:json|text|txt|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(LEADING_LABEL_PATTERN, '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trimPromptToMaxLength(text: string, maxLen = PROMPT_MAX_LEN): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxLen) return cleaned;

  const sliced = cleaned.slice(0, maxLen);
  const minCut = Math.floor(maxLen * 0.55);
  const sentenceStop = Math.max(
    sliced.lastIndexOf('。'),
    sliced.lastIndexOf('！'),
    sliced.lastIndexOf('；'),
    sliced.lastIndexOf('.'),
  );
  if (sentenceStop >= minCut) {
    return sliced.slice(0, sentenceStop + 1).trim();
  }

  const clauseStop = Math.max(sliced.lastIndexOf('，'), sliced.lastIndexOf(','));
  if (clauseStop >= minCut) {
    return `${sliced.slice(0, clauseStop).trim()}。`;
  }

  return sliced.trim();
}

function parseRelaxedObject(candidate: string): Record<string, unknown> | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  for (const attempt of [trimmed, trimmed.replace(/,\s*}/g, '}')]) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractPromptFromJson(text: string): string | null {
  const snippets: string[] = [];
  const fenceRegex = /```(?:json|javascript|js|txt)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (inner) snippets.push(inner);
  }
  snippets.push(text);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    snippets.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const snippet of snippets) {
    const obj = parseRelaxedObject(snippet);
    if (!obj) continue;
    for (const key of JSON_PROMPT_KEYS) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val;
      }
    }
  }
  return null;
}

export function extractAndValidateOptimizedPrompt(raw: string): string | null {
  const stripped = stripReasoningMarkup(raw);
  if (!stripped) return null;

  const jsonPrompt = extractPromptFromJson(stripped);
  if (jsonPrompt !== null) {
    const cleanJsonPrompt = normalizeCandidateText(stripReasoningMarkup(jsonPrompt));
    if (!cleanJsonPrompt || containsPromptLeakage(cleanJsonPrompt)) {
      return null;
    }
    const bounded = trimPromptToMaxLength(cleanJsonPrompt);
    return bounded.length >= AI_IMAGE_PROMPT_MIN ? bounded : null;
  }

  // If the model ignored JSON format and emitted truncated JSON syntax, reject cleanly.
  if (stripped.startsWith('{') && !stripped.includes('}')) {
    return null;
  }

  const finalLineMatch = FINAL_PROMPT_LINE_PATTERN.exec(stripped);
  const plainSource = finalLineMatch?.[1] ? finalLineMatch[1] : stripped;
  const cleanPlain = normalizeCandidateText(plainSource);
  if (!cleanPlain || containsPromptLeakage(cleanPlain)) {
    return null;
  }

  // Reject dangling unfinished reasoning/ellipsis fragments.
  if (/(?:\.\.\.|……)$/.test(cleanPlain) && cleanPlain.length < 25) {
    return null;
  }

  const bounded = trimPromptToMaxLength(cleanPlain);
  return bounded.length >= AI_IMAGE_PROMPT_MIN ? bounded : null;
}

export function buildFallbackVisualPrompt(input: {
  prompt: string;
  styleLabel: string;
  keywordText?: string;
  kbContext?: string;
}): string {
  const extraTopic = [
    input.keywordText ? `围绕${input.keywordText}应用场景` : '',
    input.kbContext ? `呈现${input.kbContext}` : '',
  ]
    .filter(Boolean)
    .join('，');

  const base = `${input.styleLabel}风格，${input.prompt.trim()}${extraTopic ? `，${extraTopic}` : ''}。采用柔和自然主光与细腻环境反射，主体层次突出、景深干净利落，色调克制协调，现代商业空间构图，高清质感细节。`;
  return trimPromptToMaxLength(base.replace(/\s+/g, ' ').trim());
}
