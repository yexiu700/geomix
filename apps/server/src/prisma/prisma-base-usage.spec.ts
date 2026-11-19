import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PRISMA_BASE_ALLOWLIST, type PrismaBaseAllowance } from './prisma-base-allowlist';

/**
 * 守卫：收紧 `prisma.base`（无租户自动过滤）的使用面。
 * 规则与类别说明见 `prisma-base-allowlist.ts`。
 */

const SRC_ROOT = join(__dirname, '..');
const RAW_OR_TX = /^\$(transaction|queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/;

type Usage = { direct: number; txOrRaw: number; bypass: string[] };

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** `prisma` / `this.prisma` / `deps.prisma` 等以 prisma 结尾的接收者。 */
function isPrismaReceiver(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'prisma';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'prisma';
  return false;
}

function scan(file: string, source: string): Usage {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const usage: Usage = { direct: 0, txOrRaw: 0, bypass: [] };
  const where = (node: ts.Node) => `${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'base' &&
      isPrismaReceiver(node.expression)
    ) {
      const parent = node.parent;
      const member =
        ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? parent.name.text
          : null;
      if (member && RAW_OR_TX.test(member)) usage.txOrRaw += 1;
      else usage.direct += 1;
    }
    if (
      ts.isElementAccessExpression(node) &&
      isPrismaReceiver(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'base'
    ) {
      usage.bypass.push(`L${where(node)}: prisma['base']`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      (isPrismaReceiver(node.initializer) ||
        (ts.isIdentifier(node.initializer) && node.initializer.text === 'PrismaService')) &&
      node.name.elements.some(
        (el) =>
          (el.propertyName &&
            ts.isIdentifier(el.propertyName) &&
            el.propertyName.text === 'base') ||
          (!el.propertyName && ts.isIdentifier(el.name) && el.name.text === 'base'),
      )
    ) {
      usage.bypass.push(`L${where(node)}: const { base } = prisma`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return usage;
}

function collectUsages(): Map<string, Usage> {
  const result = new Map<string, Usage>();
  for (const full of listSourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, full).split(sep).join('/');
    const source = readFileSync(full, 'utf8');
    if (!source.includes('base')) continue;
    const usage = scan(rel, source);
    if (usage.direct + usage.txOrRaw + usage.bypass.length > 0) result.set(rel, usage);
  }
  return result;
}

describe('prisma.base usage guard', () => {
  const usages = collectUsages();

  it('only allowlisted files touch prisma.base (new code must use prisma.scoped)', () => {
    const unlisted = [...usages.keys()].filter((file) => !(file in PRISMA_BASE_ALLOWLIST));
    expect(
      unlisted,
      '以下文件新增了 prisma.base：商户业务请改用 this.prisma.scoped；确属认证/管理/Worker/计费/全局数据，' +
        '请在 src/prisma/prisma-base-allowlist.ts 登记类别并在 PR 描述说明理由',
    ).toEqual([]);
  });

  it('allowlist counts match exactly (ratchet: lower the baseline after migrating)', () => {
    const drift: string[] = [];
    for (const [file, allowed] of Object.entries(PRISMA_BASE_ALLOWLIST)) {
      const actual = usages.get(file) ?? { direct: 0, txOrRaw: 0, bypass: [] };
      if (actual.direct !== allowed.direct || actual.txOrRaw !== allowed.txOrRaw) {
        drift.push(
          `${file}: 登记 direct=${allowed.direct}, txOrRaw=${allowed.txOrRaw}；` +
            `实际 direct=${actual.direct}, txOrRaw=${actual.txOrRaw}`,
        );
      }
    }
    expect(
      drift,
      '次数增加：请改用 prisma.scoped；次数减少：请同步下调 prisma-base-allowlist.ts 基线（棘轮只降不升）',
    ).toEqual([]);
  });

  it('allowlist has no stale entries and no controllers', () => {
    const entries = Object.entries(PRISMA_BASE_ALLOWLIST) as Array<[string, PrismaBaseAllowance]>;
    const stale = entries
      .filter(([file, allowed]) => allowed.direct + allowed.txOrRaw === 0 || !usages.has(file))
      .map(([file]) => file);
    expect(stale, '已不再使用 prisma.base 的文件请从白名单删除').toEqual([]);
    expect(entries.filter(([file]) => file.endsWith('.controller.ts')).map(([f]) => f)).toEqual([]);
    const sorted = entries.map(([file]) => file);
    expect(sorted).toEqual([...sorted].sort());
  });

  it('forbids indirect access that would evade the guard', () => {
    const bypass = [...usages.entries()].flatMap(([file, usage]) =>
      usage.bypass.map((hit) => `${file} ${hit}`),
    );
    expect(bypass, '禁止用下标或解构绕开 prisma.base 守卫').toEqual([]);
  });

  it('scanner classifies direct, tx/raw and bypass access', () => {
    const sample = [
      'this.prisma.base.article.findMany({ where: { tenantId } });',
      'await prisma.base.$transaction(async (tx) => tx);',
      'this.prisma.base.$queryRaw`SELECT 1`;',
      'const alias = this.prisma.base as unknown;',
      "const x = this.prisma['base'];",
      'const { base } = this.prisma;',
      'this.prisma.scoped.article.findMany();',
      'other.base.article.findMany();',
    ].join('\n');
    const usage = scan('sample.ts', sample);
    expect(usage.direct).toBe(2);
    expect(usage.txOrRaw).toBe(2);
    expect(usage.bypass).toHaveLength(2);
  });
});
