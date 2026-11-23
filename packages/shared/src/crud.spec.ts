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

  it('formats price buttons from the supplied amount using v2 action units', () => {
    expect(priceButtonText('GEO写作', 10, priceUnit('geo_write'))).toBe('GEO写作（10点数/篇）');
    expect(priceButtonText('行内AI配图', 5, priceUnit('inline_image_gen'))).toBe(
      '行内AI配图（5点数/张）',
    );
    expect(priceButtonText('AI可见性监测', 2, priceUnit('visibility_check'))).toBe(
      'AI可见性监测（2点数/次）',
    );
    expect(priceButtonText('渠道变体改写', 2, priceUnit('geo_variant'))).toBe(
      '渠道变体改写（2点数/渠道）',
    );
    expect(priceButtonText('渠道变体改写', 0, priceUnit('geo_variant'))).toBe(
      '渠道变体改写（0点数/渠道）',
    );
    expect(() => priceButtonText('GEO写作', -1)).toThrow(CrudQueryError);
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

  it('exports safe CSV and XLSX tables escaping spreadsheet formulas', () => {
    const headers = ['编号', '名称', '备注'];
    const rows = [['c'.repeat(24), '=示例', '备注,甲']];
    const csv = toCsv(headers, rows);
    expect(csv.startsWith('\uFEFF编号,名称')).toBe(true);
    expect(csv).toContain("'=示例");
    expect(csv).toContain('"备注,甲"');

    const bytes = toXlsx(headers, rows);
    const dir = mkdtempSync(join(tmpdir(), 'geomix-xlsx-'));
    writeFileSync(join(dir, 'export.xlsx'), bytes);
    const opened = spawnSync(
      'python3',
      [
        '-c',
        'import zipfile; xml = zipfile.ZipFile("export.xlsx").read("xl/worksheets/sheet1.xml").decode(); assert "备注,甲" in xml',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(opened.status, `${opened.stdout}\n${opened.stderr}`).toBe(0);
  });
});
