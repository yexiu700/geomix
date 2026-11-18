import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

    const requiredToolbarListScreens = new Set([
      'components/material/keyword-screen.tsx',
      'components/material/question-screen.tsx',
      'components/material/gallery-screen.tsx',
      'components/material/knowledge-screen.tsx',
      'components/writing/prompt-screen.tsx',
      'components/writing/category-screen.tsx',
      'components/writing/ai-task-screen.tsx',
      'components/writing/article-manage-screen.tsx',
      'components/rewrite/rewrite-single-screen.tsx',
      'components/rewrite/rewrite-batch-screen.tsx',
      'components/image/ai-image-screen.tsx',
    ]);

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
});
