import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATEGORY_REMAINING_EXPR } from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import { categoryPageSql } from './categories.sql';

const here = resolve(process.cwd(), 'src/writing');

describe('category stats sql', () => {
  it('aggregates remaining in sql and keeps the tenant on both sides of the join', () => {
    const sql = categoryPageSql({
      tenantId: 'tenant-a',
      keyword: `100%_'; DROP`,
      sort: 'remaining',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    const text = sql.strings.join(' ');
    expect(text).toContain(CATEGORY_REMAINING_EXPR);
    expect(text).toContain('c."tenantId"');
    expect(text).toContain('a."tenantId" = c."tenantId"');
    expect(text).not.toContain('100%');
    expect(text).not.toContain('DROP');
    expect(sql.values).toContain('tenant-a');
    expect(sql.values).toContain(`%100\\%\\_'; DROP%`);
    expect(sql.values).toContain('\\');
    expect(sql.values).not.toContain(`100%_'; DROP`);
  });

  it('does not cache counts, charge points, or start a writing task', () => {
    const service = readFileSync(resolve(here, 'categories.service.ts'), 'utf8');
    const controller = readFileSync(resolve(here, 'categories.controller.ts'), 'utf8');
    const combined = `${service}\n${controller}`;
    expect(service).toContain('categoryPageSql');
    expect(service).not.toMatch(/total:\s*0|remaining:\s*0/);
    expect(combined).not.toMatch(
      /BillingService|LlmService|reserve\(|KnowledgeChunk|knowledgeChunk|AiTaskItem|contentHtml/,
    );
  });
});
