import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CRUD_EMPTY_TEXT,
  CrudQueryError,
  crudListQueryString,
  escapeLikeLiteral,
  parseCrudListQuery,
  priceButtonText,
  priceUnit,
  sampleBulkSchema,
  sampleExportTable,
  sampleInputSchema,
  toCsv,
  toXlsx,
} from './crud';

describe('crud list query', () => {
  it('uses the shared page sizes and rejects tenant or raw filters', () => {
    expect(CRUD_EMPTY_TEXT).toBe('没有找到匹配的记录');
    const query = parseCrudListQuery({
      page: '2',
      pageSize: '25',
      sort: 'name',
      order: 'asc',
      filter: JSON.stringify({ keyword: '示例', enabled: true }),
    });
    expect(query).toEqual({
      page: 2,
      pageSize: 25,
      sort: 'name',
      order: 'asc',
      keyword: '示例',
      enabled: true,
      export: undefined,
    });
    expect(
      parseCrudListQuery(Object.fromEntries(new URLSearchParams(crudListQueryString(query)))),
    ).toEqual(query);

    expect(() => parseCrudListQuery({ pageSize: '20' })).toThrow(CrudQueryError);
    expect(() => parseCrudListQuery({ sort: 'tenantId' })).toThrow('排序不正确');
    expect(() =>
      parseCrudListQuery({ filter: JSON.stringify({ tenantId: 'other', keyword: '甲' }) }),
    ).toThrow('筛选不正确');
    expect(() => parseCrudListQuery({ filter: '{"keyword":"甲" OR 1=1}' })).toThrow('筛选不正确');
    expect(parseCrudListQuery({ filter: JSON.stringify({ keyword: "甲' OR 1=1" }) }).keyword).toBe(
      "甲' OR 1=1",
    );
  });

  it('formats price buttons from the supplied amount', () => {
    expect(priceButtonText('AI写作', 10, priceUnit('ai_write'))).toBe('AI写作（10点数/篇）');
    expect(priceButtonText('AI蒸馏拓展', 10, priceUnit('distill'))).toBe('AI蒸馏拓展（10点数/次）');
    expect(priceButtonText('AI生图', 5, priceUnit('image_gen'))).toBe('AI生图（5点数/张）');
    expect(() => priceButtonText('AI写作', -1)).toThrow(CrudQueryError);
  });

  it('escapes like metacharacters so a keyword stays literal', () => {
    expect(escapeLikeLiteral('%')).toBe('\\%');
    expect(escapeLikeLiteral('_')).toBe('\\_');
    expect(escapeLikeLiteral('\\')).toBe('\\\\');
    expect(escapeLikeLiteral('%十')).toBe('\\%十');
    expect(escapeLikeLiteral('foo_bar')).toBe('foo\\_bar');
    expect(escapeLikeLiteral('50%_\\甲')).toBe('50\\%\\_\\\\甲');
    expect(escapeLikeLiteral('中文English')).toBe('中文English');
  });

  it('rejects unknown sample fields and exports the visible columns only', () => {
    expect(sampleInputSchema.parse({ name: ' 示例甲 ' })).toEqual({
      name: '示例甲',
      note: '',
      enabled: true,
    });
    expect(sampleInputSchema.safeParse({ name: '甲', tenantId: 'other' }).success).toBe(false);
    expect(sampleInputSchema.safeParse({ name: '' }).success).toBe(false);
    expect(sampleBulkSchema.safeParse({ action: 'delete', ids: ['c'.repeat(24)] }).success).toBe(
      true,
    );

    const table = sampleExportTable([
      {
        id: 'c'.repeat(24),
        name: '=示例',
        note: '备注,甲',
        enabled: true,
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T01:00:00.000Z',
      },
    ]);
    const csv = toCsv(table.headers, table.rows);
    expect(csv.startsWith('\uFEFF编号,名称')).toBe(true);
    expect(csv).toContain("'=示例");
    expect(csv).toContain('"备注,甲"');

    const bytes = toXlsx(table.headers, table.rows);
    const dir = mkdtempSync(join(tmpdir(), 'geomix-xlsx-'));
    writeFileSync(join(dir, 'samples.xlsx'), bytes);
    const opened = spawnSync(
      'python3',
      [
        '-c',
        'import zipfile; xml = zipfile.ZipFile("samples.xlsx").read("xl/worksheets/sheet1.xml").decode(); assert "备注,甲" in xml',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(opened.status, `${opened.stdout}\n${opened.stderr}`).toBe(0);
  });
});
