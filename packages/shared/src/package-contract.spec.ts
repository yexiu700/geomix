import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as rootBarrel from './index';
import * as taskStatusModule from './task-status';
import * as uxFoundationModule from './ux-foundation';
import * as writingTasksModule from './writing-tasks';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(srcDir, '..');

interface ExportTarget {
  types: string;
  default: string;
}

interface PackageJsonShape {
  name: string;
  main: string;
  types: string;
  exports: Record<string, ExportTarget>;
}

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function collectProductionModules(dir: string, baseDir = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProductionModules(fullPath, baseDir));
      continue;
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.spec.ts') ||
      entry.name.endsWith('.d.ts')
    ) {
      continue;
    }
    results.push(relative(baseDir, fullPath).replace(/\\/g, '/'));
  }
  return results.sort();
}

function extractModuleSpecifiers(sourceText: string, fileName = 'module.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];
      if (firstArg && ts.isStringLiteralLike(firstArg)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          specifiers.push(firstArg.text);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          specifiers.push(firstArg.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveRelativeTarget(
  fromModule: string,
  specifier: string,
  knownModules: ReadonlySet<string>,
): { resolved: true; target: string } | { resolved: false; candidate: string } {
  const fromAbsDir = dirname(resolve(srcDir, fromModule));
  const rawTargetAbs = resolve(fromAbsDir, specifier);
  const strippedAbs = rawTargetAbs.replace(/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/, '');

  if (strippedAbs === srcDir && knownModules.has('index.ts')) {
    return { resolved: true, target: 'index.ts' };
  }

  const directCandidate = relative(srcDir, `${strippedAbs}.ts`).replace(/\\/g, '/');
  if (knownModules.has(directCandidate)) {
    return { resolved: true, target: directCandidate };
  }

  const indexCandidate = relative(srcDir, join(strippedAbs, 'index.ts')).replace(/\\/g, '/');
  if (knownModules.has(indexCandidate)) {
    return { resolved: true, target: indexCandidate };
  }

  return { resolved: false, candidate: directCandidate };
}

function canonicalizeCycle(loopNodes: readonly string[]): { key: string; display: string } {
  const first = loopNodes[0] ?? '';
  let minIdx = 0;
  let minVal = first;
  for (let i = 1; i < loopNodes.length; i += 1) {
    const candidate = loopNodes[i];
    if (candidate !== undefined && candidate < minVal) {
      minVal = candidate;
      minIdx = i;
    }
  }
  const rotated = [...loopNodes.slice(minIdx), ...loopNodes.slice(0, minIdx)];
  const head = rotated[0] ?? '';
  return {
    key: rotated.join(' -> '),
    display: [...rotated, head].join(' -> '),
  };
}

function findDirectedCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const seenKeys = new Set<string>();
  const cycles: string[] = [];

  const nodes = [...graph.keys()].sort();

  function dfs(node: string): void {
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const neighbors = [...(graph.get(node) ?? [])].sort();
    for (const next of neighbors) {
      if (!graph.has(next)) {
        continue;
      }
      if (inStack.has(next)) {
        const startIdx = stack.indexOf(next);
        if (startIdx >= 0) {
          const { key, display } = canonicalizeCycle(stack.slice(startIdx));
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            cycles.push(display);
          }
        }
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of nodes) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

describe('@geomix/shared package contract (#265)', () => {
  const productionModules = collectProductionModules(srcDir);
  const knownModuleSet = new Set(productionModules);

  it('captures every TypeScript import/export syntax while ignoring comments, strings, and URLs', () => {
    const syntheticSource = [
      '// import { ignoredLine } from "./comment-line";',
      '/* import { ignoredBlock } from "./comment-block";',
      '   export * from "./comment-reexport"; */',
      '/** @example import { ignoredDoc } from "./jsdoc-example"; */',
      'const literal = "import { ignoredStr } from \'./string-literal\'";',
      'const tpl = `export * from "./template-literal"`;',
      'const endpoint = "https://example.com//not-a-comment";',
      'import "./after-url-side-effect";',
      '/* inline block comment */ import { namedValue } from "./after-inline-comment";',
      'import type { TypeOnly } from "./type-import";',
      'import defaultExport, { type InlineType, runtimeVal } from "./mixed-import";',
      'import * as namespaceImport from "./namespace-import";',
      'import {',
      '  multilineA,',
      '  type MultilineB,',
      '} from "./multiline-import";',
      'export * from "./star-reexport";',
      'export * as nsReexport from "./ns-reexport";',
      'export { exportedA, type ExportedB } from "./named-reexport";',
      'export type { ReexportedType } from "./type-reexport";',
      'const lazyLoad = () => import("./dynamic-import");',
      'const lazyTemplate = () => import(`./dynamic-template`);',
      'const cjsLoad = () => require("./cjs-require");',
      'import eqRequire = require("./import-equals-require");',
      'type Referenced = import("./inline-import-type").SomeType;',
    ].join('\n');

    expect(extractModuleSpecifiers(syntheticSource, 'synthetic.ts')).toEqual([
      './after-url-side-effect',
      './after-inline-comment',
      './type-import',
      './mixed-import',
      './namespace-import',
      './multiline-import',
      './star-reexport',
      './ns-reexport',
      './named-reexport',
      './type-reexport',
      './dynamic-import',
      './dynamic-template',
      './cjs-require',
      './import-equals-require',
      './inline-import-type',
    ]);
  });

  it('detects self-loops, 2-cycles, and N-cycles while allowing diamond DAGs', () => {
    const selfLoopGraph = new Map<string, ReadonlySet<string>>([['self.ts', new Set(['self.ts'])]]);
    expect(findDirectedCycles(selfLoopGraph)).toEqual(['self.ts -> self.ts']);

    const twoCycleGraph = new Map<string, ReadonlySet<string>>([
      ['ux-foundation.ts', new Set(['writing-tasks.ts'])],
      ['writing-tasks.ts', new Set(['ux-foundation.ts'])],
    ]);
    expect(findDirectedCycles(twoCycleGraph)).toEqual([
      'ux-foundation.ts -> writing-tasks.ts -> ux-foundation.ts',
    ]);

    const nCycleGraph = new Map<string, ReadonlySet<string>>([
      ['entry.ts', new Set(['ux-foundation.ts'])],
      ['ux-foundation.ts', new Set(['writing-tasks.ts'])],
      ['writing-tasks.ts', new Set(['knowledge.ts'])],
      ['knowledge.ts', new Set(['ux-foundation.ts'])],
    ]);
    expect(findDirectedCycles(nCycleGraph)).toEqual([
      'knowledge.ts -> ux-foundation.ts -> writing-tasks.ts -> knowledge.ts',
    ]);

    const diamondDag = new Map<string, ReadonlySet<string>>([
      ['index.ts', new Set(['writing-tasks.ts', 'ux-foundation.ts'])],
      ['writing-tasks.ts', new Set(['task-status.ts'])],
      ['ux-foundation.ts', new Set(['task-status.ts'])],
      ['task-status.ts', new Set()],
    ]);
    expect(findDirectedCycles(diamondDag)).toEqual([]);
  });

  it('enforces zero circular dependencies across packages/shared/src/*.ts and keeps task-status.ts zero-import', () => {
    expect(knownModuleSet.has('task-status.ts')).toBe(true);

    const taskStatusSource = readFileSync(resolve(srcDir, 'task-status.ts'), 'utf8');
    expect(extractModuleSpecifiers(taskStatusSource, 'task-status.ts')).toEqual([]);

    const graph = new Map<string, ReadonlySet<string>>();
    const unresolvedRelativeImports: Array<{ from: string; specifier: string }> = [];
    const selfPackageImports: Array<{ from: string; specifier: string }> = [];

    for (const mod of productionModules) {
      const sourceText = readFileSync(resolve(srcDir, mod), 'utf8');
      const specifiers = extractModuleSpecifiers(sourceText, mod);
      const targets = new Set<string>();

      for (const specifier of specifiers) {
        if (specifier === '@geomix/shared' || specifier.startsWith('@geomix/shared/')) {
          selfPackageImports.push({ from: mod, specifier });
          continue;
        }
        if (!specifier.startsWith('.')) {
          continue;
        }
        const resolution = resolveRelativeTarget(mod, specifier, knownModuleSet);
        if (resolution.resolved) {
          targets.add(resolution.target);
        } else {
          unresolvedRelativeImports.push({ from: mod, specifier });
        }
      }

      graph.set(mod, targets);
    }

    expect(selfPackageImports).toEqual([]);
    expect(unresolvedRelativeImports).toEqual([]);
    expect(findDirectedCycles(graph)).toEqual([]);
  });

  it('maintains an exact 1-to-1 bijection between packages/shared/src/*.ts and package.json#exports', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as PackageJsonShape;

    expect(pkg.name).toBe('@geomix/shared');
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');

    const expectedExports: Record<string, ExportTarget> = {};
    for (const mod of productionModules) {
      const modBase = mod.replace(/\.ts$/, '');
      const exportKey = modBase === 'index' ? '.' : `./${modBase}`;
      expectedExports[exportKey] = {
        types: `./dist/${modBase}.d.ts`,
        default: `./dist/${modBase}.js`,
      };
    }

    expect(Object.keys(pkg.exports).sort()).toEqual(Object.keys(expectedExports).sort());
    expect(pkg.exports).toEqual(expectedExports);

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      expect(Object.keys(target), `exports[${subpath}] condition order`).toEqual([
        'types',
        'default',
      ]);
    }
  });

  it('preserves reference and type parity across ./task-status, ./writing-tasks, ./ux-foundation, and root ./index', () => {
    const taskStatusTypeParity: AssertEqual<
      taskStatusModule.TaskStatusName,
      writingTasksModule.TaskStatusName
    > = true;
    const rootTaskStatusTypeParity: AssertEqual<
      taskStatusModule.TaskStatusName,
      rootBarrel.TaskStatusName
    > = true;
    const itemStatusTypeParity: AssertEqual<
      taskStatusModule.ItemStatusName,
      writingTasksModule.ItemStatusName
    > = true;
    const rootItemStatusTypeParity: AssertEqual<
      taskStatusModule.ItemStatusName,
      rootBarrel.ItemStatusName
    > = true;
    expect(
      taskStatusTypeParity &&
        rootTaskStatusTypeParity &&
        itemStatusTypeParity &&
        rootItemStatusTypeParity,
    ).toBe(true);

    expect(taskStatusModule.TASK_STATUSES).toEqual([
      'QUEUED',
      'RUNNING',
      'PAUSED',
      'COMPLETED',
      'PARTIAL',
      'FAILED',
      'CANCELLED',
    ]);
    expect(taskStatusModule.ITEM_STATUSES).toEqual([
      'PENDING',
      'RUNNING',
      'SUCCESS',
      'FAILED',
      'SKIPPED',
    ]);

    expect(writingTasksModule.TASK_STATUSES).toBe(taskStatusModule.TASK_STATUSES);
    expect(rootBarrel.TASK_STATUSES).toBe(taskStatusModule.TASK_STATUSES);
    expect(writingTasksModule.ITEM_STATUSES).toBe(taskStatusModule.ITEM_STATUSES);
    expect(rootBarrel.ITEM_STATUSES).toBe(taskStatusModule.ITEM_STATUSES);
    expect(writingTasksModule.isTaskStatus).toBe(taskStatusModule.isTaskStatus);
    expect(rootBarrel.isTaskStatus).toBe(taskStatusModule.isTaskStatus);

    for (const status of taskStatusModule.TASK_STATUSES) {
      expect(taskStatusModule.isTaskStatus(status)).toBe(true);
    }
    expect(taskStatusModule.isTaskStatus(undefined)).toBe(false);
    expect(taskStatusModule.isTaskStatus(null)).toBe(false);
    expect(taskStatusModule.isTaskStatus(42)).toBe(false);
    expect(taskStatusModule.isTaskStatus('')).toBe(false);
    expect(taskStatusModule.isTaskStatus('PENDING')).toBe(false);
    expect(taskStatusModule.isTaskStatus('running')).toBe(false);

    expect(Object.keys(uxFoundationModule.VISIBILITY_TASK_STATUS_LABELS)).toEqual([
      ...taskStatusModule.TASK_STATUSES,
    ]);
  });
});
