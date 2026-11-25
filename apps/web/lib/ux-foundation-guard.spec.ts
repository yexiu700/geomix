import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GM_ANTD_THEME } from './design-tokens';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPONENTS_DIR = join(WEB_ROOT, 'components');

function collectProductionSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectProductionSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.spec\.(ts|tsx)$/.test(entry)) {
      continue;
    }
    results.push(full);
  }
  return results.sort();
}

const BANNED_JARGON_TERMS = [
  '影子计费',
  '零拷贝',
  '检索适配器',
  '复刻落库状态',
  '已落库查看',
  '切分向量索引',
  '整段注入',
  '切片向量化',
  '含手工槽位·不入随机池',
  '模型收录计数留到后续模块',
] as const;

describe('UX Foundation static guardrails', () => {
  const files = collectProductionSourceFiles(COMPONENTS_DIR);

  it('forbids raw UTC ISO string slicing timestamps in UI components', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (
        content.includes(".replace('T', ' ').slice(0, 16)") ||
        content.includes(".slice(0, 16).replace('T', ' ')") ||
        content.includes('.expiresAt.slice(0, 10)')
      ) {
        violations.push(relative(WEB_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids static light-themed Modal.confirm and synchronous URL.revokeObjectURL in UI components', () => {
    const modalViolations: string[] = [];
    const revokeViolations: string[] = [];

    for (const file of files) {
      const rel = relative(WEB_ROOT, file);
      const content = readFileSync(file, 'utf8');
      if (rel !== 'components/crud/ux-feedback.tsx' && /\bModal\.confirm\s*\(/.test(content)) {
        modalViolations.push(rel);
      }
      if (/\bURL\.revokeObjectURL\s*\(/.test(content)) {
        revokeViolations.push(rel);
      }
    }

    expect(modalViolations).toEqual([]);
    expect(revokeViolations).toEqual([]);
  });

  it('forbids generic misleading placeholder="名称或备注" and internal R&D jargon in UI components', () => {
    const placeholderViolations: string[] = [];
    const jargonViolations: Array<{ file: string; term: string }> = [];

    for (const file of files) {
      const rel = relative(WEB_ROOT, file);
      const content = readFileSync(file, 'utf8');
      if (content.includes('placeholder="名称或备注"')) {
        placeholderViolations.push(rel);
      }
      for (const term of BANNED_JARGON_TERMS) {
        if (content.includes(term)) {
          jargonViolations.push({ file: rel, term });
        }
      }
    }

    expect(placeholderViolations).toEqual([]);
    expect(jargonViolations).toEqual([]);
  });

  it('enforces shared CrudToolbar / CrudTable create-first toolbar contract across list screens (#260)', () => {
    const rawToolbarClassViolations: string[] = [];
    const legacyDefaultOrderViolations: string[] = [];
    const unstandardizedListScreens: string[] = [];

    // M2–M5 v2 list screens will be registered here as they land.
    const requiredToolbarListScreens = new Set<string>();

    for (const file of files) {
      const rel = relative(WEB_ROOT, file);
      const content = readFileSync(file, 'utf8');
      if (rel !== 'components/crud/crud-toolbar.tsx' && content.includes('gm-crud-toolbar')) {
        rawToolbarClassViolations.push(rel);
      }
      if (
        content.includes('toolbarOrder="default"') ||
        content.includes("toolbarOrder = 'default'")
      ) {
        legacyDefaultOrderViolations.push(rel);
      }
      if (
        requiredToolbarListScreens.has(rel) &&
        !content.includes('<CrudTable') &&
        !content.includes('<CrudToolbar')
      ) {
        unstandardizedListScreens.push(rel);
      }
    }

    expect(rawToolbarClassViolations).toEqual([]);
    expect(legacyDefaultOrderViolations).toEqual([]);
    expect(unstandardizedListScreens).toEqual([]);
  });

  it('forbids duplicated private async function unwrap blocks across apps/web/lib gateways (#264)', () => {
    const libDir = join(WEB_ROOT, 'lib');
    const libFiles = collectProductionSourceFiles(libDir);
    const duplicateUnwrapFiles: string[] = [];

    for (const file of libFiles) {
      const rel = relative(WEB_ROOT, file);
      if (rel === 'lib/envelope.ts') {
        continue;
      }
      const content = readFileSync(file, 'utf8');
      if (/\bfunction\s+unwrap\b/.test(content)) {
        duplicateUnwrapFiles.push(rel);
      }
    }

    expect(duplicateUnwrapFiles).toEqual([]);
  });
});

// === Sonar Ink 2.0 Visual-Debt Ratchet (#390) ===

const VISUAL_DEBT_BASELINE = {
  inlineStyleBlocks: 44,
  inlineFontSize: 1,
  globalsCssSolidBorders: 54,
  globalsCssInsetBorderRings: 45,
} as const;

const SUB_12PX_FONT_SIZE_ALLOWLIST: Readonly<Record<string, number>> = {};

const PRESET_TAG_COLOR_ALLOWLIST: Readonly<Record<string, number>> = {};

const ANTD_PRESET_TAG_COLORS = [
  'geekblue',
  'gold',
  'purple',
  'magenta',
  'volcano',
  'orange',
  'lime',
  'cyan',
  'blue',
  'green',
  'red',
] as const;

const ANTD_PRESET_COLOR_LITERAL_RE = new RegExp(
  `(['"\`])(?:${ANTD_PRESET_TAG_COLORS.join('|')})\\1`,
);
const FORBIDDEN_VIOLET_INDIGO_HEX_RE = /#(5E6AD2|8B5CF6|6366F1)\b/gi;
const FONT_SIZE_PX_OR_NUM_RE =
  /\bfontSize\s*:\s*(?:(['"])(\d+(?:\.\d+)?)px\1|(\d+(?:\.\d+)?)(?![\d.a-zA-Z%]))/g;
const FONT_SIZE_REM_RE = /\bfontSize\s*:\s*(['"])(\d+(?:\.\d+)?)rem\1/g;
const FONT_SIZE_JSX_ATTR_RE =
  /\bfontSize\s*=\s*(?:(['"])(\d+(?:\.\d+)?)(px|rem)?\1|\{\s*(\d+(?:\.\d+)?)\s*\}|\{\s*(['"])(\d+(?:\.\d+)?)(px|rem)?\5\s*\})/g;

function toPosixRel(file: string): string {
  return relative(WEB_ROOT, file).replace(/\\/g, '/');
}

function countInlineStyleBlocks(content: string): number {
  return (content.match(/style=\{\{/g) ?? []).length;
}

function countInlineFontSizes(content: string): number {
  return (content.match(/\bfontSize\s*:/g) ?? []).length;
}

function countSub12FontSizes(content: string): number {
  let count = 0;
  for (const match of content.matchAll(FONT_SIZE_PX_OR_NUM_RE)) {
    const num = Number(match[2] ?? match[3]);
    if (Number.isFinite(num) && num < 12) {
      count += 1;
    }
  }
  for (const match of content.matchAll(FONT_SIZE_REM_RE)) {
    const rem = Number(match[2]);
    if (Number.isFinite(rem) && rem < 0.75) {
      count += 1;
    }
  }
  for (const match of content.matchAll(FONT_SIZE_JSX_ATTR_RE)) {
    const num = Number(match[2] ?? match[4] ?? match[6]);
    const unit = match[3] ?? match[7];
    if (!Number.isFinite(num)) {
      continue;
    }
    if (unit === 'rem' ? num < 0.75 : num < 12) {
      count += 1;
    }
  }
  return count;
}

/**
 * Balanced brace/quote-aware JSX opening-tag scanner for `<Tag ...>`.
 * Handles expressions containing `>` (e.g. `color={score > 80 ? 'green' : 'red'}`).
 */
function findTagOpenings(content: string): string[] {
  const openings: string[] = [];
  const startRe = /<Tag(?=\s|>|\/)/g;
  let match: RegExpExecArray | null;

  while ((match = startRe.exec(content)) !== null) {
    let i = match.index + 4;
    let braceDepth = 0;
    let quote: "'" | '"' | '`' | null = null;

    while (i < content.length) {
      const ch = content[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) {
          quote = null;
        }
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '{') {
        braceDepth += 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        i += 1;
        continue;
      }
      if (ch === '>' && braceDepth === 0) {
        openings.push(content.slice(match.index, i + 1));
        break;
      }
      i += 1;
    }
  }

  return openings;
}

function extractColorPropValue(tagOpening: string): string | null {
  const colorAttrMatch = /(?<![-\w])color\s*=\s*/.exec(tagOpening);
  if (!colorAttrMatch) {
    return null;
  }
  let i = colorAttrMatch.index + colorAttrMatch[0].length;
  const first = tagOpening[i];
  if (first === '"' || first === "'") {
    const end = tagOpening.indexOf(first, i + 1);
    return end === -1 ? null : tagOpening.slice(i, end + 1);
  }
  if (first !== '{') {
    return null;
  }
  const start = i;
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  while (i < tagOpening.length) {
    const ch = tagOpening[i];
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return tagOpening.slice(start, i + 1);
      }
    }
    i += 1;
  }
  return null;
}

function countPresetTagColors(content: string): number {
  let count = 0;
  for (const opening of findTagOpenings(content)) {
    const colorExpr = extractColorPropValue(opening);
    if (colorExpr && ANTD_PRESET_COLOR_LITERAL_RE.test(colorExpr)) {
      count += 1;
    }
  }
  return count;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const v = Number.parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (bright + 0.05) / (dark + 0.05);
}

describe('Sonar Ink 2.0 visual-debt ratchet (#390)', () => {
  const files = collectProductionSourceFiles(COMPONENTS_DIR);
  const uiDir = join(COMPONENTS_DIR, 'ui');

  it('visual debt only ratchets down (inline style={{}} and inline fontSize:)', () => {
    let totalStyleBlocks = 0;
    let totalFontSize = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      totalStyleBlocks += countInlineStyleBlocks(content);
      totalFontSize += countInlineFontSizes(content);
    }

    expect(totalStyleBlocks).toBeLessThanOrEqual(VISUAL_DEBT_BASELINE.inlineStyleBlocks);
    expect(totalFontSize).toBeLessThanOrEqual(VISUAL_DEBT_BASELINE.inlineFontSize);
  });

  it('forbids new font sizes below 12px in UI components (ratchet allowlist)', () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = toPosixRel(file);
      const count = countSub12FontSizes(readFileSync(file, 'utf8'));
      const allowed = SUB_12PX_FONT_SIZE_ALLOWLIST[rel] ?? 0;
      if (count > allowed) {
        violations.push(`${rel}: ${count} > allowed ${allowed}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('forbids new AntD preset color <Tag> usage in UI components (ratchet allowlist)', () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = toPosixRel(file);
      const count = countPresetTagColors(readFileSync(file, 'utf8'));
      const allowed = PRESET_TAG_COLOR_ALLOWLIST[rel] ?? 0;
      if (count > allowed) {
        violations.push(`${rel}: ${count} > allowed ${allowed}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('forbids violet/indigo hexes (#5E6AD2, #8B5CF6, #6366F1) in tokens, globals.css, and UI primitives', () => {
    const targetFiles = [
      join(WEB_ROOT, 'lib/design-tokens.ts'),
      join(WEB_ROOT, 'app/globals.css'),
      ...(existsSync(uiDir) ? collectProductionSourceFiles(uiDir) : []),
    ];
    const violations: string[] = [];

    for (const file of targetFiles) {
      const content = readFileSync(file, 'utf8');
      const matches = content.match(FORBIDDEN_VIOLET_INDIGO_HEX_RE);
      if (matches && matches.length > 0) {
        violations.push(`${toPosixRel(file)}: ${matches.join(', ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('enforces zero visual debt inside apps/web/components/ui/**, components/shell/**, and components/brands/**', () => {
    expect(existsSync(uiDir)).toBe(true);
    const shellDir = join(COMPONENTS_DIR, 'shell');
    const brandsDir = join(COMPONENTS_DIR, 'brands');
    expect(existsSync(shellDir)).toBe(true);
    expect(existsSync(brandsDir)).toBe(true);
    const uiFiles = collectProductionSourceFiles(uiDir);
    const shellFiles = collectProductionSourceFiles(shellDir);
    const brandsFiles = collectProductionSourceFiles(brandsDir);
    expect(uiFiles.length).toBeGreaterThanOrEqual(8);
    expect(shellFiles.length).toBeGreaterThanOrEqual(7);
    expect(brandsFiles.length).toBeGreaterThanOrEqual(8);

    const violations: string[] = [];
    for (const file of [...uiFiles, ...shellFiles, ...brandsFiles]) {
      const rel = toPosixRel(file);
      const content = readFileSync(file, 'utf8');
      const styleBlocks = countInlineStyleBlocks(content);
      const fontSizes = countInlineFontSizes(content);
      const sub12 = countSub12FontSizes(content);
      const presetTags = countPresetTagColors(content);
      if (styleBlocks > 0 || fontSizes > 0 || sub12 > 0 || presetTags > 0) {
        violations.push(
          `${rel}: style={{}}=${styleBlocks}, fontSize=${fontSizes}, sub12=${sub12}, presetTags=${presetTags}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('verifies self-hosted WOFF2 fonts and Sonar Ink 2.0 AntD theme calibration', () => {
    const fontsDir = join(WEB_ROOT, 'public/fonts');
    for (const fontFile of [
      'inter-latin-wght-normal.woff2',
      'jetbrains-mono-latin-wght-normal.woff2',
    ]) {
      const fullPath = join(fontsDir, fontFile);
      expect(existsSync(fullPath)).toBe(true);
      const bytes = readFileSync(fullPath);
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
      expect(bytes.length).toBeGreaterThan(20_000);
    }

    const globalsCss = readFileSync(join(WEB_ROOT, 'app/globals.css'), 'utf8');
    const layoutTsx = readFileSync(join(WEB_ROOT, 'app/layout.tsx'), 'utf8');
    for (const source of [globalsCss, layoutTsx]) {
      expect(source).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
    }
    expect(globalsCss).toContain("url('/fonts/inter-latin-wght-normal.woff2')");
    expect(globalsCss).toContain("url('/fonts/jetbrains-mono-latin-wght-normal.woff2')");

    expect(GM_ANTD_THEME.token.fontSize).toBe(13);
    expect(GM_ANTD_THEME.token.colorBgBase).toBe('#090B0A');
    expect(GM_ANTD_THEME.token.colorBgContainer).toBe('#111513');
    expect(GM_ANTD_THEME.token.colorBgElevated).toBe('#181D1B');
    expect(GM_ANTD_THEME.token.colorText).toBe('#EEF2F0');
    expect(GM_ANTD_THEME.token.colorTextSecondary).toBe('#ADB6B2');
    expect(GM_ANTD_THEME.token.colorTextTertiary).toBe('#838D89');
    expect(GM_ANTD_THEME.token.colorTextQuaternary).toBe('#5E6864');
    expect(GM_ANTD_THEME.token.borderRadius).toBe(6);
    expect(GM_ANTD_THEME.components.Table.cellFontSize).toBe(13);
    expect(GM_ANTD_THEME.components.Segmented.itemSelectedBg).toBe('rgba(255, 255, 255, 0.08)');
    expect(GM_ANTD_THEME.components.Segmented.itemSelectedColor).toBe('#EEF2F0');
    expect(GM_ANTD_THEME.components.Tag.defaultBg).toBe('transparent');
    expect(GM_ANTD_THEME.components.Tag.defaultColor).toBe('#ADB6B2');

    // WCAG AA check: --gm-fg-3 (#838D89) on --gm-surface-1 (#111513) >= 5.2:1
    expect(contrastRatio('#838D89', '#111513')).toBeGreaterThanOrEqual(5.2);
  });

  it('locks console globals.css 1px solid borders and inset 1px rings <= 60 (Sonar Ink 2.0 closure #394)', () => {
    const globalsCss = readFileSync(join(WEB_ROOT, 'app/globals.css'), 'utf8');
    const stripped = globalsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const solidBorderCount = (stripped.match(/1px\s+solid/g) ?? []).length;
    const insetBorderRingCount = (stripped.match(/inset\s+0\s+0\s+0\s+1px/g) ?? []).length;

    expect(VISUAL_DEBT_BASELINE.globalsCssSolidBorders).toBeLessThanOrEqual(60);
    expect(solidBorderCount).toBeLessThanOrEqual(VISUAL_DEBT_BASELINE.globalsCssSolidBorders);
    expect(solidBorderCount).toBeLessThanOrEqual(60);

    expect(VISUAL_DEBT_BASELINE.globalsCssInsetBorderRings).toBeLessThanOrEqual(60);
    expect(insetBorderRingCount).toBeLessThanOrEqual(
      VISUAL_DEBT_BASELINE.globalsCssInsetBorderRings,
    );
    expect(insetBorderRingCount).toBeLessThanOrEqual(60);
  });
});
