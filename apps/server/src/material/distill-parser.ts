import { extractJsonStringArray } from '@geomix/shared';

const WRAPPER_ARRAY_KEYS = [
  'questions',
  'items',
  'data',
  'list',
  'result',
  'results',
  'candidates',
  'queries',
  'keywords',
] as const;

const OBJECT_ITEM_KEYS = ['question', 'text', 'title', 'content', 'query', 'q', 'value'] as const;

/**
 * 从真实上游大模型返回内容中容错提取蒸馏候选问题：
 * 1) 剥离推理模型输出的 `<think>...</think>` 思考过程；
 * 2) 识别 Markdown 代码块、尾随逗号 JSON 数组、常见对象包裹字段以及对象数组元素；
 * 3) 当模型偶发忽略 JSON 约束直接输出有序/无序列表时，按行兜底提取候选条目。
 */
export function extractDistillCandidates(raw: string): string[] {
  const stripped = stripThinkBlocks(raw).trim();
  if (!stripped) return [];

  const direct = extractJsonStringArray(stripped);
  if (direct.length > 0) return direct;

  const jsonSnippets = collectJsonSnippets(stripped);
  for (const snippet of jsonSnippets) {
    const parsed = parseRelaxedJson(snippet);
    if (parsed === undefined) continue;
    const strings = extractStringsFromJsonValue(parsed);
    if (strings.length > 0) return strings;
  }

  return extractListLinesFallback(stripped);
}

function stripThinkBlocks(raw: string): string {
  const withoutClosed = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '\n');
  if (!/<think\b[^>]*>/i.test(withoutClosed)) {
    return withoutClosed;
  }
  const openMatch = /<think\b[^>]*>/i.exec(withoutClosed);
  if (!openMatch) return withoutClosed;
  const afterThink = withoutClosed.slice(openMatch.index + openMatch[0].length);
  const bracketIdx = afterThink.indexOf('[');
  if (bracketIdx >= 0) {
    return afterThink.slice(bracketIdx);
  }
  return afterThink;
}

function collectJsonSnippets(text: string): string[] {
  const snippets: string[] = [];
  const fenceRegex = /```(?:json|javascript|js|txt)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (inner) snippets.push(inner);
  }

  snippets.push(text);

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    snippets.push(text.slice(firstBracket, lastBracket + 1));
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    snippets.push(text.slice(firstBrace, lastBrace + 1));
  }

  return snippets;
}

function parseRelaxedJson(candidate: string): unknown {
  const normalized = candidate.trim();
  if (!normalized) return undefined;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    // 兼容部分模型在 JSON 数组或对象末尾多打逗号的情况
    const withoutTrailingCommas = normalized.replace(/,\s*([\]}])/g, '$1');
    try {
      return JSON.parse(withoutTrailingCommas) as unknown;
    } catch {
      return undefined;
    }
  }
}

function extractStringsFromJsonValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        out.push(item.trim());
        continue;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        for (const key of OBJECT_ITEM_KEYS) {
          const field = record[key];
          if (typeof field === 'string' && field.trim()) {
            out.push(field.trim());
            break;
          }
        }
      }
    }
    return out;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of WRAPPER_ARRAY_KEYS) {
      if (Array.isArray(record[key])) {
        const extracted = extractStringsFromJsonValue(record[key]);
        if (extracted.length > 0) return extracted;
      }
    }
    const arrayValues = Object.values(record).filter(Array.isArray);
    if (arrayValues.length === 1) {
      return extractStringsFromJsonValue(arrayValues[0]);
    }
  }

  return [];
}

function extractListLinesFallback(text: string): string[] {
  const withoutFences = text.replace(/```(?:json|javascript|js|txt)?/gi, '');
  const lines = withoutFences.split(/\r?\n/);
  const items: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^[[\]{},]+$/.test(line)) continue;
    if (/^(?:以下是|下面是|为您生成|根据您的|主关键词[:：]|输出[:：]|JSON)/i.test(line)) continue;

    const listMatch = /^(?:(?:\(\d+\)|（\d+）|第?\d+[条个项]?[.:：、)）]|[-*•·])\s*)(.+)$/.exec(
      line,
    );
    const quotedMatch = /^["'“”「」](.+)["'“”「」],?$/.exec(line);

    if (listMatch?.[1]) {
      line = listMatch[1].trim();
    } else if (quotedMatch?.[1]) {
      line = quotedMatch[1].trim();
    } else {
      continue;
    }

    line = line
      .replace(/^["'“”‘’「」]+/, '')
      .replace(/["'“”‘’「」]+,?$/, '')
      .trim();
    if (line) items.push(line);
  }

  return items;
}
