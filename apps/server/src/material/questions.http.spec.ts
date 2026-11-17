import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  AUTH_ERROR,
  QUESTION_EMPTY_KEYWORD_MSG,
  QUESTION_EMPTY_LINES_MSG,
  type QuestionBatchResult,
  type QuestionRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';

describe('questions routes without a database', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    app = await createApiApp();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects anonymous list and batch create calls', async () => {
    const listRes = await httpCall(base, 'GET', '/api/v1/questions');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const postRes = await httpCall(base, 'POST', '/api/v1/questions', {
      body: { keywordId: 'kw_1', questionsText: '测试问题' },
    });
    expect(postRes.status).toBe(401);
    expect(postRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'questions CRUD, deduplication, and QUESTION stock quota against isolated Postgres',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('qst');
    }, 120_000);

    afterAll(async () => {
      if (ctx) await ctx.close();
    }, 60_000);

    it('filters by keywordId, deduplicates batch lines, edits text, and releases QUESTION quota matching /me/rights on delete', async () => {
      const tenantA = await ctx.createTenantUser({ prefix: 'qa' });
      const tenantB = await ctx.createTenantUser({ prefix: 'qb' });

      const kw1Res = await httpCall(ctx.base, 'POST', '/api/v1/keywords', {
        token: tenantA.token,
        body: {
          main: '工业机器人',
          brands: ['智造星'],
          questionsText: '工业机器人哪家靠谱？',
        },
      });
      expect(kw1Res.status).toBe(200);
      const kw1Id = (kw1Res.data as { keyword: { id: string } }).keyword.id;

      const kw2Res = await httpCall(ctx.base, 'POST', '/api/v1/keywords', {
        token: tenantA.token,
        body: {
          main: '激光切割机',
          brands: ['智造星'],
          questionsText: '光纤激光切割机报价',
        },
      });
      expect(kw2Res.status).toBe(200);
      const kw2Id = (kw2Res.data as { keyword: { id: string } }).keyword.id;

      // Empty keywordId rejected
      const noKw = await httpCall(ctx.base, 'POST', '/api/v1/questions', {
        token: tenantA.token,
        body: { keywordId: '', questionsText: '工业机器人选型指南' },
      });
      expect(noKw.status).toBe(400);
      expect(noKw.msg).toContain(QUESTION_EMPTY_KEYWORD_MSG);

      // Empty lines rejected
      const emptyLines = await httpCall(ctx.base, 'POST', '/api/v1/questions', {
        token: tenantA.token,
        body: { keywordId: kw1Id, questionsText: '   \n  \n ' },
      });
      expect(emptyLines.status).toBe(400);
      expect(emptyLines.msg).toBe(QUESTION_EMPTY_LINES_MSG);

      // Batch create under kw1 with 1 existing duplicate + 1 batch duplicate + 2 new items
      const batchRes = await httpCall(ctx.base, 'POST', '/api/v1/questions', {
        token: tenantA.token,
        body: {
          keywordId: kw1Id,
          questionsText: [
            '工业机器人哪家靠谱?', // duplicate of existing
            '六轴工业机器人厂家推荐',
            '六轴 工业机器人 厂家推荐', // duplicate in input
            '深圳工业机器人日常维护指南',
          ].join('\n'),
        },
      });
      expect(batchRes.status).toBe(200);
      const batchData = batchRes.data as QuestionBatchResult;
      expect(batchData.createdCount).toBe(2);
      expect(batchData.skippedCount).toBe(2);
      expect(batchData.items.every((item) => item.included === false)).toBe(true);

      // Filter by keywordId=kw1Id -> 3 items (1 initial + 2 batch)
      const filteredRes = await httpCall(
        ctx.base,
        'GET',
        `/api/v1/questions?keywordId=${encodeURIComponent(kw1Id)}&included=false`,
        { token: tenantA.token },
      );
      expect(filteredRes.status).toBe(200);
      const filtered = filteredRes.data as { items: QuestionRecord[]; total: number };
      expect(filtered.total).toBe(3);
      expect(filtered.items.every((item) => item.keywordId === kw1Id)).toBe(true);

      // Check /me/rights QUESTION used = 4 (3 under kw1 + 1 under kw2)
      const rightsBefore = await httpCall(ctx.base, 'GET', '/api/v1/me/rights', {
        token: tenantA.token,
      });
      expect(rightsBefore.status).toBe(200);
      const cardsBefore = (
        rightsBefore.data as { cards: Array<{ key: string; text: string; used?: string }> }
      ).cards;
      const questionCardBefore = cardsBefore.find((c) => c.key === 'QUESTION');
      expect(questionCardBefore?.used).toBe('4');

      // Edit 1 item
      const targetId = batchData.items[0]!.id;
      const patchRes = await httpCall(ctx.base, 'PATCH', `/api/v1/questions/${targetId}`, {
        token: tenantA.token,
        body: { text: '六轴工业机器人源头厂家选型对比' },
      });
      expect(patchRes.status).toBe(200);
      expect((patchRes.data as QuestionRecord).text).toBe('六轴工业机器人源头厂家选型对比');

      // Cross-tenant isolation: tenantB gets 404 on tenantA's keywordId & questionId
      const crossPost = await httpCall(ctx.base, 'POST', '/api/v1/questions', {
        token: tenantB.token,
        body: { keywordId: kw2Id, questionsText: '激光切割机参数' },
      });
      expect(crossPost.status).toBe(404);

      const crossDel = await httpCall(ctx.base, 'DELETE', `/api/v1/questions/${targetId}`, {
        token: tenantB.token,
      });
      expect(crossDel.status).toBe(404);

      // Delete 1 item -> QUESTION quota decreases from 4 to 3 in /me/rights!
      const delRes = await httpCall(ctx.base, 'DELETE', `/api/v1/questions/${targetId}`, {
        token: tenantA.token,
      });
      expect(delRes.status).toBe(200);
      expect((delRes.data as { affected: number }).affected).toBe(1);

      const rightsAfter = await httpCall(ctx.base, 'GET', '/api/v1/me/rights', {
        token: tenantA.token,
      });
      const cardsAfter = (
        rightsAfter.data as { cards: Array<{ key: string; text: string; used?: string }> }
      ).cards;
      const questionCardAfter = cardsAfter.find((c) => c.key === 'QUESTION');
      expect(questionCardAfter?.used).toBe('3');
    });
  },
);
