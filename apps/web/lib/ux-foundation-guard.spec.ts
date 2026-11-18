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
  '手动槽位·不入随机池',
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
});
