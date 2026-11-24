/**
 * 通用列表的查询、价格按钮文案和导出。
 * 筛选只接受关键字和启用状态，不接受租户、原始 SQL 或知识库切片条件。
 * 示例记录不参与计费。
 */

export const CRUD_PAGE_SIZES = [10, 25, 50] as const;
export const CRUD_EMPTY_TEXT = '没有找到匹配的记录';
export const CRUD_EXPORT_LIMIT = 1000;
const CRUD_KEYWORD_MAX = 40;

export const CRUD_SORTS = ['createdAt', 'name', 'updatedAt'] as const;
export const CRUD_ORDERS = ['asc', 'desc'] as const;

export type CrudPageSize = (typeof CRUD_PAGE_SIZES)[number];
export type CrudSort = (typeof CRUD_SORTS)[number];
export type CrudOrder = (typeof CRUD_ORDERS)[number];
export type CrudExportFormat = 'csv' | 'xlsx';

export type CrudListQuery = {
  page: number;
  pageSize: CrudPageSize;
  sort: CrudSort;
  order: CrudOrder;
  keyword: string;
  enabled: boolean | undefined;
  export: CrudExportFormat | undefined;
};

export class CrudQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrudQueryError';
  }
}

export function parseCrudListQuery(input: Record<string, unknown>): CrudListQuery {
  const filter = readFilter(input.filter);
  return {
    page: readPage(input.page),
    pageSize: readPageSize(input.pageSize),
    sort: readSort(input.sort),
    order: readOrder(input.order),
    keyword: filter.keyword,
    enabled: filter.enabled,
    export: readExport(input.export),
  };
}

export function crudListQueryString(query: CrudListQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('sort', query.sort);
  params.set('order', query.order);
  const filter: Record<string, string | boolean> = {};
  if (query.keyword) filter.keyword = query.keyword;
  if (query.enabled !== undefined) filter.enabled = query.enabled;
  if (Object.keys(filter).length > 0) params.set('filter', JSON.stringify(filter));
  if (query.export) params.set('export', query.export);
  return params.toString();
}

/**
 * PostgreSQL 的 LIKE / ILIKE 把反斜杠、百分号和下划线当模式符号。
 * Prisma 的 contains 会再包上一对百分号，所以这里只转义用户输入本身。
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function priceUnit(action: string): string {
  if (action === 'visibility_check') return '次';
  if (action === 'inline_image_gen') return '张';
  if (action === 'geo_variant') return '渠道';
  return '篇';
}

/** 约定文案：动作（X点数/篇）。可见性监测和行内配图换成次、张，数字仍来自价格表。 */
export function priceButtonText(label: string, points: number, unit = '篇'): string {
  const name = label.trim();
  if (!name || name.length > CRUD_KEYWORD_MAX || hasControl(name)) {
    throw new CrudQueryError('价格不正确');
  }
  if (!Number.isSafeInteger(points) || points < 0 || points > 1_000_000) {
    throw new CrudQueryError('价格不正确');
  }
  if (!unit || unit.length > 8 || hasControl(unit)) throw new CrudQueryError('价格不正确');
  return `${name}（${points}点数/${unit}）`;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((line) => line.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}

export function toXlsx(headers: string[], rows: string[][]): Uint8Array {
  const sheet = worksheetXml(headers, rows);
  return storeZip([
    { path: '[Content_Types].xml', data: text(CONTENT_TYPES) },
    { path: '_rels/.rels', data: text(ROOT_RELS) },
    { path: 'xl/workbook.xml', data: text(WORKBOOK) },
    { path: 'xl/_rels/workbook.xml.rels', data: text(WORKBOOK_RELS) },
    { path: 'xl/worksheets/sheet1.xml', data: text(sheet) },
  ]);
}

function readPage(value: unknown): number {
  const raw = one(value);
  if (raw === undefined || raw === '') return 1;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new CrudQueryError('分页不正确');
  return Number(raw);
}

function readPageSize(value: unknown): CrudPageSize {
  const raw = one(value);
  if (raw === undefined || raw === '') return 10;
  if (raw === '10' || raw === '25' || raw === '50') return Number(raw) as CrudPageSize;
  throw new CrudQueryError('分页不正确');
}

function readSort(value: unknown): CrudSort {
  const raw = one(value);
  if (raw === undefined || raw === '') return 'createdAt';
  if (raw === 'createdAt' || raw === 'name' || raw === 'updatedAt') return raw;
  throw new CrudQueryError('排序不正确');
}

function readOrder(value: unknown): CrudOrder {
  const raw = one(value);
  if (raw === undefined || raw === '') return 'desc';
  if (raw === 'asc' || raw === 'desc') return raw;
  throw new CrudQueryError('排序不正确');
}

function readExport(value: unknown): CrudExportFormat | undefined {
  const raw = one(value);
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'csv' || raw === 'xlsx') return raw;
  throw new CrudQueryError('导出格式不正确');
}

function readFilter(value: unknown): { keyword: string; enabled: boolean | undefined } {
  const raw = one(value);
  if (raw === undefined || raw === '') return { keyword: '', enabled: undefined };
  if (raw.length > 500) throw new CrudQueryError('筛选不正确');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CrudQueryError('筛选不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CrudQueryError('筛选不正确');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'keyword' && key !== 'enabled') throw new CrudQueryError('筛选不正确');
  }
  let keyword = '';
  if ('keyword' in record) {
    if (typeof record.keyword !== 'string') throw new CrudQueryError('筛选不正确');
    keyword = record.keyword.trim();
    if (keyword.length > CRUD_KEYWORD_MAX || hasControl(keyword)) {
      throw new CrudQueryError('筛选不正确');
    }
  }
  if (!('enabled' in record)) return { keyword, enabled: undefined };
  if (typeof record.enabled !== 'boolean') throw new CrudQueryError('筛选不正确');
  return { keyword, enabled: record.enabled };
}

function one(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CrudQueryError('参数不正确');
  return value;
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function worksheetXml(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const body = all
    .map((line, rowIndex) => {
      const cells = line
        .map((value, column) => {
          const ref = `${columnName(column)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function columnName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 25) {
    throw new CrudQueryError('导出列过多');
  }
  return String.fromCharCode(65 + index);
}

function xmlText(value: string): string {
  let next = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 && char !== '\t' && char !== '\n' && char !== '\r') continue;
    next += char;
  }
  return next
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="samples" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function storeZip(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = text(file.path);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length + file.data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
