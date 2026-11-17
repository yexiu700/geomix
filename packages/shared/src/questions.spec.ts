import { describe, expect, it } from 'vitest';
import {
  QUESTION_EMPTY_KEYWORD_MSG,
  parseBatchQuestionLines,
  parseQuestionListQuery,
  questionBatchCreateSchema,
  questionExportTable,
} from './questions';

describe('questions shared helpers', () => {
  it('deduplicates batch question lines across whitespace and trailing question marks', () => {
    const parsed = parseBatchQuestionLines(
      [
        '  1. 工业机器人哪家好？ ',
        '工业机器人哪家好?',
        '',
        '2、深圳工业机器人厂家推荐',
        '深圳 工业机器人 厂家推荐',
      ].join('\n'),
    );
    expect(parsed.items).toEqual(['工业机器人哪家好？', '深圳工业机器人厂家推荐']);
    expect(parsed.duplicateInInputCount).toBe(2);
  });

  it('requires selecting a keyword before submitting batch questions', () => {
    const emptyRes = questionBatchCreateSchema.safeParse({
      keywordId: '',
      questionsText: '工业机器人报价',
    });
    expect(emptyRes.success).toBe(false);
    if (!emptyRes.success) {
      expect(emptyRes.error.issues[0]?.message).toBe(QUESTION_EMPTY_KEYWORD_MSG);
    }
  });

  it('parses keywordId, included, and date range query parameters cleanly', () => {
    const query = parseQuestionListQuery({
      page: '2',
      pageSize: '25',
      keywordId: 'kw_demo_1',
      included: 'false',
      createdAtFrom: '2026-11-01',
      createdAtTo: '2026-11-17',
      sort: 'usedCount',
      order: 'asc',
    });
    expect(query.page).toBe(2);
    expect(query.pageSize).toBe(25);
    expect(query.keywordId).toBe('kw_demo_1');
    expect(query.included).toBe(false);
    expect(query.createdAtFrom).toBe('2026-11-01T00:00:00.000Z');
    expect(query.createdAtTo).toBe('2026-11-17T23:59:59.999Z');
    expect(query.sort).toBe('usedCount');
    expect(query.order).toBe('asc');
  });

  it('formats export rows with default 未收录 label', () => {
    const table = questionExportTable([
      {
        id: 'q_1',
        keywordId: 'kw_1',
        keywordMain: '工业机器人',
        text: '工业机器人选型指南',
        source: 'MANUAL',
        usedCount: 0,
        included: false,
        createdAt: '2026-11-17T04:00:00.000Z',
      },
    ]);
    expect(table.headers).toContain('收录状态');
    expect(table.rows[0]).toEqual([
      '1',
      '工业机器人',
      '工业机器人选型指南',
      '未收录',
      '手动添加',
      '0',
      '2026-11-17T04:00:00.000Z',
    ]);
  });
});
