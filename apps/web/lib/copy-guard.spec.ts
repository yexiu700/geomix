import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CONTROL_LABEL_MAX_CHARS, EXPLAIN_INLINE_MAX_CHARS, copyLength } from './copy-length';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPONENTS_DIR = join(WEB_ROOT, 'components');

/**
 * 控制台受控目录（排除 (marketing)、reports、admin 等公开页与后台运营页）。
 */
const CONTROLLED_DIRS = [
  'home',
  'brands',
  'visibility',
  'studio',
  'publish',
  'account',
  'shell',
  'briefs',
  'geo',
  'distribution',
  'crud',
  'ui',
] as const;

/**
 * 极简交互规范（docs/极简交互规范.md）棘轮基线：
 * 只允许在 PR2–PR8 中单调递减，最终在 PR8 全部清零。
 */
export const COPY_DEBT_BASELINE = {
  over4Controls: 2,
  over8Alerts: 1,
  multiPrimaryFiles: 3,
} as const;

const CJK_RE = /[\u4e00-\u9fff]/;
const CONTROL_BUTTON_TAGS = new Set([
  'Button',
  'button',
  'GmButton',
  'PrimaryButton',
  'SecondaryButton',
  'QuietButton',
]);

function collectControlledTsxFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.tsx') && !entry.endsWith('.spec.tsx')) {
        files.push(full);
      }
    }
  };
  for (const sub of CONTROLLED_DIRS) {
    const dir = join(COMPONENTS_DIR, sub);
    if (existsSync(dir)) {
      walk(dir);
    }
  }
  return files.sort();
}

function getTagName(el: ts.JsxOpeningLikeElement): string {
  return el.tagName.getText();
}

function getStaticAttrString(el: ts.JsxOpeningLikeElement, name: string): string | null {
  for (const prop of el.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name || !prop.initializer) {
      continue;
    }
    if (
      ts.isStringLiteral(prop.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(prop.initializer)
    ) {
      return prop.initializer.text;
    }
    if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
      const expr = prop.initializer.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return expr.text;
      }
    }
  }
  return null;
}

function isSrOnlyElement(el: ts.JsxOpeningLikeElement): boolean {
  const cls = getStaticAttrString(el, 'className') ?? '';
  return cls.split(/\s+/).includes('gm-sr-only');
}

function collectStaticButtonText(el: ts.JsxElement): string {
  let out = '';
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      out += node.text;
    } else if (ts.isJsxExpression(node) && node.expression) {
      if (
        ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression)
      ) {
        out += node.expression.text;
      }
    } else if (ts.isJsxElement(node)) {
      if (isSrOnlyElement(node.openingElement)) {
        return;
      }
      node.children.forEach(visit);
    } else if (ts.isJsxFragment(node)) {
      node.children.forEach(visit);
    }
  };
  el.children.forEach(visit);
  return out.replace(/\s+/g, ' ').trim();
}

function measureCopyDebt() {
  const files = collectControlledTsxFiles();
  const over4Controls: string[] = [];
  const over8Alerts: string[] = [];
  const multiPrimaryFiles: string[] = [];
  const uiViolations: string[] = [];

  for (const file of files) {
    const rel = relative(WEB_ROOT, file).replace(/\\/g, '/');
    const isUiPrimitive = rel.startsWith('components/ui/');
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let staticPrimaryCount = 0;

    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = getTagName(opening);

        if (CONTROL_BUTTON_TAGS.has(tag) && ts.isJsxElement(node)) {
          const text = collectStaticButtonText(node);
          if (CJK_RE.test(text) && copyLength(text) > CONTROL_LABEL_MAX_CHARS) {
            const msg = `${rel}: <${tag}> "${text}" (${copyLength(text)})`;
            over4Controls.push(msg);
            if (isUiPrimitive) uiViolations.push(msg);
          }
        }

        if (tag === 'Section' || tag === 'PageHeader') {
          const title = getStaticAttrString(opening, 'title');
          if (title && CJK_RE.test(title) && copyLength(title) > CONTROL_LABEL_MAX_CHARS) {
            const msg = `${rel}: <${tag} title="${title}"> (${copyLength(title)})`;
            over4Controls.push(msg);
            if (isUiPrimitive) uiViolations.push(msg);
          }
        }

        if (tag === 'Alert') {
          for (const attrName of ['message', 'description'] as const) {
            const val = getStaticAttrString(opening, attrName);
            if (val && CJK_RE.test(val) && copyLength(val) > EXPLAIN_INLINE_MAX_CHARS) {
              const msg = `${rel}: <Alert ${attrName}> (${copyLength(val)})`;
              over8Alerts.push(msg);
              if (isUiPrimitive) uiViolations.push(msg);
            }
          }
        }

        if (getStaticAttrString(opening, 'type') === 'primary') {
          staticPrimaryCount += 1;
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        const assigns = node.properties.filter(ts.isPropertyAssignment);
        const byName = new Map(assigns.map((p) => [p.name.getText(), p]));
        const readStr = (p: ts.PropertyAssignment | undefined) =>
          p &&
          (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))
            ? p.initializer.text
            : null;

        // Table column title
        if (
          byName.has('title') &&
          (byName.has('dataIndex') || byName.has('key') || byName.has('render'))
        ) {
          const colTitle = readStr(byName.get('title'));
          if (colTitle && CJK_RE.test(colTitle) && copyLength(colTitle) > CONTROL_LABEL_MAX_CHARS) {
            const msg = `${rel}: column "${colTitle}" (${copyLength(colTitle)})`;
            over4Controls.push(msg);
            if (isUiPrimitive) uiViolations.push(msg);
          }
        }

        // Tabs / Segmented option labels (explicit value+label or key+label objects)
        if (
          byName.has('label') &&
          (byName.has('value') || (byName.has('key') && byName.has('children')))
        ) {
          const optLabel = readStr(byName.get('label'));
          if (optLabel && CJK_RE.test(optLabel) && copyLength(optLabel) > CONTROL_LABEL_MAX_CHARS) {
            const msg = `${rel}: tab/option "${optLabel}" (${copyLength(optLabel)})`;
            over4Controls.push(msg);
            if (isUiPrimitive) uiViolations.push(msg);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);

    if (staticPrimaryCount > 1) {
      multiPrimaryFiles.push(`${rel}: ${staticPrimaryCount}`);
    }
  }

  return { over4Controls, over8Alerts, multiPrimaryFiles, uiViolations };
}

describe('UI Copy Simplification Ratchet Guard (PR1 Baseline)', () => {
  const result = measureCopyDebt();

  it('enforces zero control/alert copy debt inside components/ui/**', () => {
    expect(result.uiViolations).toEqual([]);
  });

  it('locks over-4-char control labels strictly <= COPY_DEBT_BASELINE.over4Controls', () => {
    expect(
      result.over4Controls.length,
      `Found ${result.over4Controls.length} controls >4 chars (baseline ${COPY_DEBT_BASELINE.over4Controls}):\n${result.over4Controls.slice(0, 10).join('\n')}`,
    ).toBeLessThanOrEqual(COPY_DEBT_BASELINE.over4Controls);
  });

  it('locks over-8-char always-visible Alert descriptions strictly <= COPY_DEBT_BASELINE.over8Alerts', () => {
    expect(
      result.over8Alerts.length,
      `Found ${result.over8Alerts.length} alerts >8 chars (baseline ${COPY_DEBT_BASELINE.over8Alerts})`,
    ).toBeLessThanOrEqual(COPY_DEBT_BASELINE.over8Alerts);
  });

  it('locks files with multiple static primary buttons strictly <= COPY_DEBT_BASELINE.multiPrimaryFiles', () => {
    expect(
      result.multiPrimaryFiles.length,
      `Found ${result.multiPrimaryFiles.length} multi-primary files (baseline ${COPY_DEBT_BASELINE.multiPrimaryFiles}):\n${result.multiPrimaryFiles.join('\n')}`,
    ).toBeLessThanOrEqual(COPY_DEBT_BASELINE.multiPrimaryFiles);
  });
});
