import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = resolve(process.cwd(), 'src/billing');

function rawStatements(source: string): string[] {
  const statements: string[] = [];
  const pattern = /\$queryRaw(?:<[^>]+>)?`([\s\S]*?)`|\$executeRaw`([\s\S]*?)`/g;
  for (const match of source.matchAll(pattern)) {
    statements.push(match[1] ?? match[2] ?? '');
  }
  return statements;
}

describe('billing SQL tenancy', () => {
  it('keeps every raw statement filtered by tenantId', () => {
    const files = ['billing.sql.ts', 'billing.service.ts', 'quota.service.ts'];
    const statements = files.flatMap((file) =>
      rawStatements(readFileSync(resolve(here, file), 'utf8')),
    );
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toContain('tenantId');
    }
  });
});
