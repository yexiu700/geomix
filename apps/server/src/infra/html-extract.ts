/**
 * 零依赖 HTML 正文提取工具（供品牌官网事实提炼与竞品高引用页解析复用）。
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
};

const RAW_TEXT_NOISE_TAGS = ['script', 'style', 'noscript', 'template'] as const;

const STRUCTURAL_NOISE_TAGS = [
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe',
  'form',
  'button',
  'nav',
  'footer',
  'aside',
] as const;

const MAX_NOISE_STRIP_PASSES = 8;

const RAW_TEXT_NOISE_PATTERNS = RAW_TEXT_NOISE_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'),
);

const STRUCTURAL_INNERMOST_PATTERNS = STRUCTURAL_NOISE_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>(?:(?!<${tag}\\b)[\\s\\S])*?<\\/${tag}\\s*>`, 'gi'),
);

const STRUCTURAL_FALLBACK_PATTERNS = STRUCTURAL_NOISE_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'),
);

const BOILERPLATE_LINE_RE =
  /^(?:首页|返回顶部|关于我们|联系我们|隐私政策|服务协议|版权所有|Copyright\b|All rights reserved|Cookie\s+Policy|Privacy\s+Policy|Terms\s+of\s+Service|Sign\s+in|Log\s+in|Menu|Navigation)$/i;

export function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (match, hex, dec, named) => {
    if (hex) {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (dec) {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (named) {
      const found = NAMED_ENTITIES[named.toLowerCase()];
      return found ?? match;
    }
    return match;
  });
}

function stripNoiseBlocks(html: string): string {
  let out = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  for (const re of RAW_TEXT_NOISE_PATTERNS) {
    out = out.replace(re, '\n');
  }
  for (let pass = 0; pass < MAX_NOISE_STRIP_PASSES; pass += 1) {
    const prev = out;
    for (const re of STRUCTURAL_INNERMOST_PATTERNS) {
      out = out.replace(re, '\n');
    }
    if (out === prev) break;
  }
  for (const re of STRUCTURAL_FALLBACK_PATTERNS) {
    out = out.replace(re, '\n');
  }
  return out;
}

function extractTagContent(html: string, tagName: 'article' | 'main' | 'body'): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'gi');
  let best = '';
  let match: RegExpExecArray | null = re.exec(html);
  while (match !== null) {
    const candidate = match[1] ?? '';
    if (candidate.length > best.length) {
      best = candidate;
    }
    match = re.exec(html);
  }
  return best || null;
}

function extractTitle(rawHtml: string): string {
  const ogMatch =
    /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(rawHtml) ??
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i.exec(rawHtml);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml);
  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(rawHtml);

  const raw = ogMatch?.[1] ?? titleMatch?.[1] ?? h1Match?.[1] ?? '';
  const cleaned = decodeHtmlEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.replace(/\s*[-|—–·_]\s*[^-|—–·_]{2,30}$/, '').trim() || cleaned;
}

function htmlFragmentToLines(fragment: string): string[] {
  const withStructure = fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:t[dh])>\s*<(?:t[dh])\b[^>]*>/gi, ' | ')
    .replace(/<\/(?:h[1-6]|p|li|tr|div|section|header|blockquote|dd|dt|pre)>/gi, '\n')
    .replace(/<(?:h[1-6]|p|li|tr|div|section|blockquote|dt|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(withStructure).replace(/\r\n/g, '\n');
  const lines: string[] = [];
  for (const rawLine of decoded.split('\n')) {
    const line = rawLine
      .replace(/\s*\|\s*/g, ' | ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/^\|\s*|\s*\|$/g, '')
      .trim();
    if (!line) continue;
    if (BOILERPLATE_LINE_RE.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

export function extractPlainTextFromHtml(rawHtml: string): { title: string; text: string } {
  const html = typeof rawHtml === 'string' ? rawHtml : '';
  const title = extractTitle(html);
  const cleaned = stripNoiseBlocks(html);

  const article = extractTagContent(cleaned, 'article');
  const main = extractTagContent(cleaned, 'main');
  const body = extractTagContent(cleaned, 'body');

  let chosen = cleaned;
  for (const candidate of [article, main, body]) {
    if (!candidate) continue;
    const candidateText = htmlFragmentToLines(candidate).join('\n');
    if (nonWhitespaceLength(candidateText) >= 80) {
      chosen = candidate;
      break;
    }
  }

  const lines = htmlFragmentToLines(chosen);
  const text = lines.join('\n').trim();
  return { title, text };
}
