import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CITATION_SOURCE_KINDS,
  FAKE_MARK,
  VISIBILITY_ID_PATTERN,
  VISIBILITY_MAX_COMPETITORS,
  type ProfileForMetrics,
} from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  buildDailyTrend,
  buildEngineBreakdown,
  computeOverviewMetricsAndGroups,
  dedupeStringsCaseInsensitive,
  deriveVisibilityRunId,
  evaluateObservationRelevance,
  higherPrioritySourceKind,
  isEffectiveBrandMention,
  normalizeCompetitorsList,
  normalizeOwnedDomainsList,
  parseProfileCompetitors,
  parseStoredCompetitorHits,
  presentCitationRecord,
  presentObservationRecord,
  presentRunRecord,
  shanghaiWindowFromQuery,
  type ObservationRowForMapper,
  type OverviewObservationRow,
  type OverviewProfileContext,
  type RunRowForMapper,
} from './visibility.mapper';
import { deriveVisibilityRunId as reExportedDeriveVisibilityRunId } from './visibility.service';

const CURRENT_DIR = __dirname;

describe('visibility.mapper', () => {
  describe('deriveVisibilityRunId', () => {
    it('derives deterministic vrun_ IDs matching VISIBILITY_ID_PATTERN and facade re-export', () => {
      const first = deriveVisibilityRunId('tenant_1', 'idem_key_abc12345');
      const second = deriveVisibilityRunId('tenant_1', 'idem_key_abc12345');

      expect(first).toBe(second);
      expect(first).toMatch(/^vrun_[0-9a-f]{28}$/);
      expect(first).toHaveLength(33);
      expect(VISIBILITY_ID_PATTERN.test(first)).toBe(true);
      expect(reExportedDeriveVisibilityRunId('tenant_1', 'idem_key_abc12345')).toBe(first);
    });

    it('isolates run IDs across tenants, idempotency keys, and boundary concatenations', () => {
      const tenantA = deriveVisibilityRunId('tenant_a', 'same_key_12345');
      const tenantB = deriveVisibilityRunId('tenant_b', 'same_key_12345');
      const diffKey = deriveVisibilityRunId('tenant_a', 'other_key_12345');

      expect(tenantA).not.toBe(tenantB);
      expect(tenantA).not.toBe(diffKey);
      expect(deriveVisibilityRunId('ab', 'c')).not.toBe(deriveVisibilityRunId('a', 'bc'));
    });
  });

  describe('competitor, alias, and domain normalization', () => {
    it('dedupeStringsCaseInsensitive collapses whitespace, preserves first casing, and excludes brand self-matches', () => {
      const result = dedupeStringsCaseInsensitive(
        ['  Geo   Mix \n ', '', '   ', 'geomix', 'GeoMix Pro', 'GEOMIX PRO', '吉奥米克斯'],
        'Geo Mix',
      );
      expect(result).toEqual(['geomix', 'GeoMix Pro', '吉奥米克斯']);
    });

    it('normalizeOwnedDomainsList normalizes URLs, strips invalid hosts, deduplicates, and enforces limits', () => {
      const raw = [
        'https://WWW.GeoMix.cn:443/docs?x=1#top',
        'http://geomix.cn/',
        'DOCS.geomix.cn.',
        '',
        '   ',
        'localhost',
        'javascript:alert(1)',
        'mailto:ops@geomix.cn',
        ...Array.from({ length: 25 }, (_, idx) => `https://sub${idx}.example.com/path`),
      ];
      const normalized = normalizeOwnedDomainsList(raw);
      expect(normalized).toHaveLength(20);
      expect(normalized[0]).toBe('geomix.cn');
      expect(normalized[1]).toBe('docs.geomix.cn');
      expect(normalizeOwnedDomainsList(raw, 3)).toEqual([
        'geomix.cn',
        'docs.geomix.cn',
        'sub0.example.com',
      ]);
    });

    it('normalizeCompetitorsList caps at VISIBILITY_MAX_COMPETITORS, skips blanks, strips self-aliases, and caps aliases/domains at 20', () => {
      const manyAliases = [
        'CompZero',
        ' compzero ',
        ...Array.from({ length: 25 }, (_, i) => `Alias ${i}`),
      ];
      const manyDomains = [
        'https://www.Comp0.com/home',
        'http://comp0.com:8080',
        'invalid-host',
        ...Array.from({ length: 25 }, (_, i) => `https://mirror${i}.comp0.com`),
      ];

      const input = [
        { name: '   ' },
        { name: '  Comp   Zero ', aliases: manyAliases, domains: manyDomains },
        { name: 'comp zero', aliases: ['ShouldSkipDuplicate'] },
        ...Array.from({ length: 15 }, (_, idx) => ({
          name: `Competitor ${idx + 1}`,
          aliases: [`Competitor ${idx + 1}`, `Alt ${idx + 1}`],
          domains: [`https://www.comp-${idx + 1}.cn/products`],
        })),
      ];

      const normalized = normalizeCompetitorsList(input);
      expect(normalized).toHaveLength(VISIBILITY_MAX_COMPETITORS);
      expect(normalized[0]?.name).toBe('Comp Zero');
      expect(normalized[0]?.aliases).toHaveLength(20);
      expect(normalized[0]?.aliases).toContain('CompZero');
      expect(normalized[0]?.domains).toHaveLength(20);
      expect(normalized[0]?.domains[0]).toBe('comp0.com');

      expect(normalized[1]).toEqual({
        name: 'Competitor 1',
        aliases: ['Alt 1'],
        domains: ['comp-1.cn'],
      });
    });

    it('parseProfileCompetitors safely handles malformed JSON and normalizes domains', () => {
      expect(parseProfileCompetitors(null)).toEqual([]);
      expect(parseProfileCompetitors(undefined)).toEqual([]);
      expect(parseProfileCompetitors('not-an-array')).toEqual([]);
      expect(parseProfileCompetitors({ name: 'X' })).toEqual([]);

      const parsed = parseProfileCompetitors([
        null,
        123,
        { name: '   ' },
        {
          name: ' 竞品A ',
          aliases: [' 别名1 ', '', 42, null],
          domains: ['https://WWW.RivalA.com/docs', 'not_a_domain', 99],
        },
      ]);
      expect(parsed).toEqual([
        {
          name: '竞品A',
          aliases: ['别名1'],
          domains: ['rivala.com'],
        },
      ]);
    });
  });

  describe('parseStoredCompetitorHits', () => {
    it('normalizes boundary positions and sentiments while rejecting malformed entries', () => {
      expect(parseStoredCompetitorHits(null)).toEqual([]);
      expect(parseStoredCompetitorHits(undefined)).toEqual([]);
      expect(parseStoredCompetitorHits({})).toEqual([]);
      expect(parseStoredCompetitorHits('raw')).toEqual([]);

      const hits = parseStoredCompetitorHits([
        null,
        'bad',
        { mentioned: true },
        { name: 'ValidFirst', mentioned: 1, position: 1, sentiment: 'positive' },
        { name: 'ValidThird', mentioned: true, position: 3, sentiment: 'mixed' },
        { name: 'ZeroPos', mentioned: true, position: 0, sentiment: 'neutral' },
        { name: 'NegPos', mentioned: false, position: -2, sentiment: 'negative' },
        { name: 'NaNPos', mentioned: true, position: Number.NaN, sentiment: 'other_meaning' },
        {
          name: 'InfPos',
          mentioned: true,
          position: Number.POSITIVE_INFINITY,
          sentiment: 'unknown',
        },
        { name: 'StringPos', mentioned: 0, position: '1', sentiment: 123 },
      ]);

      expect(hits).toEqual([
        { name: 'ValidFirst', mentioned: true, position: 1, sentiment: 'positive' },
        { name: 'ValidThird', mentioned: true, position: 3, sentiment: 'mixed' },
        { name: 'ZeroPos', mentioned: true, position: null, sentiment: 'neutral' },
        { name: 'NegPos', mentioned: false, position: null, sentiment: 'negative' },
        { name: 'NaNPos', mentioned: true, position: null, sentiment: null },
        { name: 'InfPos', mentioned: true, position: null, sentiment: null },
        { name: 'StringPos', mentioned: false, position: null, sentiment: null },
      ]);
    });
  });

  describe('off-topic relevance projection & presenters', () => {
    const brandCtx = {
      brandName: 'GeoMix',
      brandAliases: ['吉奥米克斯'],
      competitorNames: ['竞品椅A'],
    };

    const baseTimestamp = new Date('2026-11-18T10:00:00.000Z');

    function makeObservation(
      overrides: Partial<ObservationRowForMapper> = {},
    ): ObservationRowForMapper {
      return {
        id: 'obs_1',
        runId: 'vrun_1',
        brandId: 'brand_1',
        brandMarketId: 'prof_1',
        promptText: '人体工学椅护腰推荐哪家？',
        engine: 'deepseek',
        status: 'SUCCESS',
        collectorKind: 'llm_api',
        answerText: '在人体工学椅护腰实测对比中，GeoMix 腰靠动态追腰支撑出色，优于竞品椅A。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        brandPassage: 'GeoMix 腰靠动态追腰支撑出色',
        competitorHits: [{ name: '竞品椅A', mentioned: true, position: 2, sentiment: 'neutral' }],
        fanOutQueries: ['人体工学椅腰靠评测'],
        judgeModel: 'deepseek-chat',
        tokensIn: 120,
        tokensOut: 260,
        error: null,
        checkedAt: baseTimestamp,
        createdAt: baseTimestamp,
        citations: [
          {
            id: 'cit_1',
            url: 'https://geomix.cn/chairs',
            domain: 'geomix.cn',
            title: 'GeoMix 人体工学椅',
            snippet: '护腰实测',
            sourceKind: 'OWNED',
            position: 1,
            createdAt: baseTimestamp,
          },
          {
            id: 'cit_2',
            url: 'https://unknown.example.org/post',
            domain: 'unknown.example.org',
            title: null,
            snippet: null,
            sourceKind: 'UNKNOWN_KIND',
            position: 2,
            createdAt: baseTimestamp,
          },
        ],
        ...overrides,
      };
    }

    it('preserves brand mention fields on on-topic SUCCESS observations and normalizes unknown citation sourceKind', () => {
      const obs = makeObservation();
      const projected = presentObservationRecord(obs, brandCtx);

      expect(projected.topicRelevant).toBe(true);
      expect(projected.relevanceReason).toBeNull();
      expect(projected.brandMentioned).toBe(true);
      expect(projected.brandPosition).toBe(1);
      expect(projected.brandSentiment).toBe('positive');
      expect(projected.brandPassage).toBe('GeoMix 腰靠动态追腰支撑出色');
      expect(projected.citations[0]?.sourceKind).toBe('OWNED');
      expect(projected.citations[1]?.sourceKind).toBe('OTHER');
      expect(presentCitationRecord(obs.citations[1]!).sourceKind).toBe('OTHER');
      expect(isEffectiveBrandMention(obs, brandCtx)).toBe(true);
    });

    it('downgrades off-topic FAKE and generic boilerplate SUCCESS observations while preserving citations and competitorHits', () => {
      const fakeObs = makeObservation({
        answerText: `${FAKE_MARK}GeoMix 占位模拟输出`,
      });
      const fakeProjected = presentObservationRecord(fakeObs, brandCtx);
      expect(fakeProjected.topicRelevant).toBe(false);
      expect(fakeProjected.relevanceReason).toBeTruthy();
      expect(fakeProjected.brandMentioned).toBe(false);
      expect(fakeProjected.brandPosition).toBeNull();
      expect(fakeProjected.brandSentiment).toBeNull();
      expect(fakeProjected.brandPassage).toBeNull();
      expect(fakeProjected.competitorHits).toHaveLength(1);
      expect(fakeProjected.citations).toHaveLength(2);
      expect(isEffectiveBrandMention(fakeObs, brandCtx)).toBe(false);

      const boilerplateObs = makeObservation({
        answerText:
          '针对企业长期运维成本与数据可审计性，GeoMix 提供多维度看板、引用溯源归类与标准化报表模板，全面优化团队协作闭环与合规边界。',
      });
      const boilerplateProjected = presentObservationRecord(boilerplateObs, brandCtx);
      expect(boilerplateProjected.topicRelevant).toBe(false);
      expect(boilerplateProjected.brandMentioned).toBe(false);
      expect(boilerplateProjected.brandPosition).toBeNull();
      expect(boilerplateProjected.brandSentiment).toBeNull();
      expect(boilerplateProjected.brandPassage).toBeNull();
    });

    it('does not flag non-SUCCESS or empty-answer observations as off-topic', () => {
      for (const status of ['PENDING', 'RUNNING', 'FAILED', 'SKIPPED'] as const) {
        const nonSuccess = makeObservation({
          status,
          answerText: `${FAKE_MARK}未完成或失败样本`,
          brandMentioned: false,
        });
        expect(evaluateObservationRelevance(nonSuccess, brandCtx)).toEqual({
          relevant: true,
          reason: null,
        });
        const projected = presentObservationRecord(nonSuccess, brandCtx);
        expect(projected.topicRelevant).toBe(true);
        expect(projected.relevanceReason).toBeNull();
        expect(isEffectiveBrandMention({ ...nonSuccess, brandMentioned: true }, brandCtx)).toBe(
          false,
        );
      }

      const nullAnswer = makeObservation({ answerText: null });
      expect(presentObservationRecord(nullAnswer, brandCtx).topicRelevant).toBe(true);
    });

    it('presentRunRecord excludes off-topic mentions from visibilityPct, counts SKIPPED, and falls back frozenPoints', () => {
      const runRow: RunRowForMapper = {
        id: 'vrun_abc',
        brandId: 'brand_1',
        brandMarketId: 'prof_1',
        name: '椅类可见度诊断',
        engines: ['deepseek', 'unknown_engine', 'doubao'],
        prompts: ['人体工学椅护腰推荐哪家？'],
        totalChecks: 4,
        doneCount: 2,
        failCount: 1,
        unitPrice: 2,
        reservationId: 'resv_1',
        status: 'PARTIAL',
        lastError: null,
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp,
        finishedAt: baseTimestamp,
        brandMarket: {
          id: 'prof_1',
          market: 'CN',
          localBrandName: 'GeoMix',
          aliases: ['吉奥米克斯'],
          competitors: [{ name: '竞品椅A', aliases: [], domains: [] }],
          brand: { name: '默认档案' },
        },
        observations: [
          {
            status: 'SUCCESS',
            brandMentioned: true,
            promptText: '人体工学椅护腰推荐哪家？',
            answerText: '在人体工学椅护腰评测中，GeoMix 支撑表现优秀。',
          },
          {
            status: 'SUCCESS',
            brandMentioned: true,
            promptText: '人体工学椅护腰推荐哪家？',
            answerText: `${FAKE_MARK}GeoMix 跑题占位回答`,
          },
          {
            status: 'SKIPPED',
            brandMentioned: false,
            promptText: '人体工学椅护腰推荐哪家？',
            answerText: null,
          },
          {
            status: 'FAILED',
            brandMentioned: false,
            promptText: '人体工学椅护腰推荐哪家？',
            answerText: null,
          },
        ],
      };

      const withoutReservation = presentRunRecord(runRow);
      expect(withoutReservation.engines).toEqual(['deepseek', 'doubao']);
      expect(withoutReservation.skipCount).toBe(1);
      expect(withoutReservation.visibilityPct).toBe(50);
      expect(withoutReservation.frozenPoints).toBe(8);
      expect(withoutReservation.settledPoints).toBe(0);
      expect(withoutReservation.releasedPoints).toBe(0);

      const withReservation = presentRunRecord(runRow, {
        frozen: 8,
        settled: 4,
        released: 4,
      });
      expect(withReservation.settledPoints).toBe(4);
      expect(withReservation.releasedPoints).toBe(4);
    });
  });

  describe('shanghaiWindowFromQuery', () => {
    it('aligns exact UTC+8 midnight boundaries (15:59:59.999Z vs 16:00:00.000Z)', () => {
      const justBeforeMidnight = shanghaiWindowFromQuery({
        days: 1,
        now: new Date('2026-11-18T15:59:59.999Z'),
      });
      expect(justBeforeMidnight.keys).toEqual(['2026-11-18']);
      expect(justBeforeMidnight.startUtc.toISOString()).toBe('2026-11-17T16:00:00.000Z');
      expect(justBeforeMidnight.endUtc.toISOString()).toBe('2026-11-18T15:59:59.999Z');

      const exactMidnightRollover = shanghaiWindowFromQuery({
        days: 1,
        now: new Date('2026-11-18T16:00:00.000Z'),
      });
      expect(exactMidnightRollover.keys).toEqual(['2026-11-19']);
      expect(exactMidnightRollover.startUtc.toISOString()).toBe('2026-11-18T16:00:00.000Z');
      expect(exactMidnightRollover.endUtc.toISOString()).toBe('2026-11-19T15:59:59.999Z');
    });

    it('builds ascending multi-day rolling windows and clamps out-of-range or fractional days', () => {
      const sevenDays = shanghaiWindowFromQuery({
        days: 7,
        now: new Date('2026-11-18T04:00:00.000Z'),
      });
      expect(sevenDays.keys).toEqual([
        '2026-11-12',
        '2026-11-13',
        '2026-11-14',
        '2026-11-15',
        '2026-11-16',
        '2026-11-17',
        '2026-11-18',
      ]);
      expect(sevenDays.endUtc.getTime() - sevenDays.startUtc.getTime()).toBe(7 * DAY_MS - 1);

      expect(
        shanghaiWindowFromQuery({ days: 0, now: new Date('2026-11-18T04:00:00.000Z') }).keys,
      ).toHaveLength(1);
      expect(
        shanghaiWindowFromQuery({ days: -10, now: new Date('2026-11-18T04:00:00.000Z') }).keys,
      ).toHaveLength(1);
      expect(
        shanghaiWindowFromQuery({ days: 999, now: new Date('2026-11-18T04:00:00.000Z') }).keys,
      ).toHaveLength(365);
      expect(
        shanghaiWindowFromQuery({ days: 3.8, now: new Date('2026-11-18T04:00:00.000Z') }).keys,
      ).toHaveLength(3);
    });

    it('handles explicit from/to ranges, inverted bounds, 366-key cap, and invalid dates safely', () => {
      const explicit = shanghaiWindowFromQuery({
        days: 14,
        from: '2026-11-17T16:00:00.000Z',
        to: '2026-11-19T15:59:59.999Z',
      });
      expect(explicit.keys).toEqual(['2026-11-18', '2026-11-19']);
      expect(explicit.startUtc.toISOString()).toBe('2026-11-17T16:00:00.000Z');
      expect(explicit.endUtc.toISOString()).toBe('2026-11-19T15:59:59.999Z');

      const inverted = shanghaiWindowFromQuery({
        days: 14,
        from: '2026-11-20T00:00:00.000Z',
        to: '2026-11-18T00:00:00.000Z',
      });
      expect(inverted.startUtc.toISOString()).toBe('2026-11-18T00:00:00.000Z');
      expect(inverted.endUtc.toISOString()).toBe('2026-11-20T00:00:00.000Z');
      expect(inverted.keys).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);

      const capped = shanghaiWindowFromQuery({
        days: 14,
        from: '2025-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      });
      expect(capped.keys).toHaveLength(366);

      const invalid = shanghaiWindowFromQuery({
        days: 14,
        from: 'not-a-date',
        to: '2026-11-18T00:00:00.000Z',
      });
      expect(invalid.keys).toEqual([]);
    });
  });

  describe('overview, SoV, source priority, engine breakdown, and daily trend math', () => {
    it('higherPrioritySourceKind enforces OWNED > COMPETITOR > ECOMMERCE > SOCIAL > AUTHORITY > OTHER and presentObservationRecord normalizes fanOut + reclassifies citations', () => {
      expect(CITATION_SOURCE_KINDS).toEqual([
        'OWNED',
        'COMPETITOR',
        'SOCIAL',
        'AUTHORITY',
        'ECOMMERCE',
        'OTHER',
      ]);
      expect(higherPrioritySourceKind('AUTHORITY', 'SOCIAL')).toBe('SOCIAL');
      expect(higherPrioritySourceKind('SOCIAL', 'AUTHORITY')).toBe('SOCIAL');
      expect(higherPrioritySourceKind('OTHER', 'OWNED')).toBe('OWNED');
      expect(higherPrioritySourceKind('COMPETITOR', 'SOCIAL')).toBe('COMPETITOR');
      expect(higherPrioritySourceKind('ECOMMERCE', 'AUTHORITY')).toBe('ECOMMERCE');
      expect(higherPrioritySourceKind('ECOMMERCE', 'SOCIAL')).toBe('ECOMMERCE');

      const now = new Date('2026-11-18T08:00:00.000Z');
      const presented = presentObservationRecord(
        {
          id: 'obs_norm',
          runId: 'run_1',
          brandId: 'brand_1',
          brandMarketId: 'bm_1',
          promptText: '静音家用NAS推荐',
          engine: 'deepseek',
          status: 'SUCCESS',
          collectorKind: 'fake',
          answerText: '静音家用NAS推荐绿联。',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          brandPassage: '静音家用NAS推荐绿联。',
          competitorHits: [],
          fanOutQueries: ['安静NAS; 家用NAS功耗；安静NAS\n四盘位NAS'],
          judgeModel: 'fake',
          tokensIn: 10,
          tokensOut: 10,
          error: null,
          checkedAt: now,
          createdAt: now,
          citations: [
            {
              id: 'cite_1',
              url: 'https://newrival.example.com/review',
              domain: 'newrival.example.com',
              title: 'Rival Review',
              snippet: null,
              sourceKind: 'OTHER',
              position: 1,
              createdAt: now,
            },
          ],
        },
        { brandName: '绿联' },
        {
          market: 'CN',
          citationContext: {
            ownedDomains: ['ugreen.com'],
            competitorDomains: ['newrival.example.com'],
          },
        },
      );
      expect(presented.market).toBe('CN');
      expect(presented.fanOutQueries).toEqual(['安静NAS', '家用NAS功耗', '四盘位NAS']);
      expect(presented.citations[0]?.sourceKind).toBe('COMPETITOR');
    });

    it('computeOverviewMetricsAndGroups supports 0-brand, 1-brand, and >=2-brand isolated SoV tracks with domain priority merge', () => {
      const emptyFallback: ProfileForMetrics = {
        brandName: '本品牌',
        brandAliases: [],
        ownedDomains: [],
        competitors: [],
      };

      const obsA: OverviewObservationRow = {
        id: 'obs_a',
        brandMarketId: 'prof_a',
        engine: 'deepseek',
        status: 'SUCCESS',
        promptText: '便携显示器推荐哪家？',
        answerText: '便携显示器推荐阿卓帕，色彩表现优于竞品屏X。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        competitorHits: [{ name: '竞品屏X', mentioned: true, position: 2, sentiment: 'neutral' }],
        checkedAt: new Date('2026-11-18T15:59:59.000Z'),
        createdAt: new Date('2026-11-18T15:59:59.000Z'),
        citations: [
          { url: 'https://arzopa.com/monitor', domain: 'arzopa.com', sourceKind: 'OWNED' },
        ],
      };

      const obsB1: OverviewObservationRow = {
        id: 'obs_b1',
        brandMarketId: 'prof_b',
        engine: 'doubao',
        status: 'SUCCESS',
        promptText: '氮化镓充电器哪款好？',
        answerText: '氮化镓充电器首选安克创新，温控稳定。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        competitorHits: [{ name: '竞品充Y', mentioned: false, position: null, sentiment: null }],
        checkedAt: new Date('2026-11-18T16:00:00.000Z'),
        createdAt: new Date('2026-11-18T16:00:00.000Z'),
        citations: [
          { url: 'https://arzopa.com/cross-ref', domain: 'arzopa.com', sourceKind: 'OTHER' },
        ],
      };

      const obsB2: OverviewObservationRow = {
        id: 'obs_b2',
        brandMarketId: 'prof_b',
        engine: 'deepseek',
        status: 'SUCCESS',
        promptText: '氮化镓充电器横评推荐？',
        answerText: '在氮化镓充电器横评中，安克创新体积小巧，发热控制优秀。',
        brandMentioned: true,
        brandPosition: 2,
        brandSentiment: 'neutral',
        competitorHits: [{ name: '竞品充Y', mentioned: true, position: 1, sentiment: 'positive' }],
        checkedAt: null,
        createdAt: new Date('2026-11-18T16:30:00.000Z'),
        citations: [],
      };

      const orphanObs: OverviewObservationRow = {
        id: 'obs_orphan',
        brandMarketId: 'prof_deleted',
        engine: 'deepseek',
        status: 'SUCCESS',
        promptText: '便携显示器选购技巧？',
        answerText: '选购便携显示器可关注刷新率与色域表现。',
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: null,
        competitorHits: [],
        checkedAt: new Date('2026-11-18T10:00:00.000Z'),
        createdAt: new Date('2026-11-18T10:00:00.000Z'),
        citations: [],
      };

      const zeroBrandCtx: OverviewProfileContext = {
        resolvedProfileId: null,
        profilesById: new Map(),
        brandEntries: [],
        fallbackProfileForMetrics: emptyFallback,
      };
      const zeroResult = computeOverviewMetricsAndGroups([obsA], zeroBrandCtx);
      expect(zeroResult.brandGroups).toEqual([]);
      expect(zeroResult.metrics.completedChecks).toBe(1);

      const profileA: ProfileForMetrics = {
        brandName: '阿卓帕',
        brandAliases: ['Arzopa'],
        ownedDomains: ['arzopa.com'],
        competitors: [{ name: '竞品屏X', aliases: [], domains: [] }],
      };
      const oneBrandCtx: OverviewProfileContext = {
        resolvedProfileId: 'prof_a',
        profilesById: new Map([['prof_a', profileA]]),
        brandEntries: [
          { brandName: '阿卓帕', profileIds: ['prof_a'], profileForMetrics: profileA },
        ],
        fallbackProfileForMetrics: profileA,
      };
      const oneResult = computeOverviewMetricsAndGroups([obsA], oneBrandCtx);
      expect(oneResult.brandGroups).toHaveLength(1);
      expect(oneResult.brandGroups[0]?.shareOfVoice).toEqual(oneResult.metrics.shareOfVoice);

      const profileB: ProfileForMetrics = {
        brandName: '安克创新',
        brandAliases: ['Anker'],
        ownedDomains: ['anker.com'],
        competitors: [{ name: '竞品充Y', aliases: [], domains: [] }],
      };
      const multiBrandCtx: OverviewProfileContext = {
        resolvedProfileId: null,
        profilesById: new Map([
          ['prof_a', profileA],
          ['prof_b', profileB],
        ]),
        brandEntries: [
          { brandName: '阿卓帕', profileIds: ['prof_a'], profileForMetrics: profileA },
          { brandName: '安克创新', profileIds: ['prof_b'], profileForMetrics: profileB },
        ],
        fallbackProfileForMetrics: profileA,
      };
      const multiResult = computeOverviewMetricsAndGroups(
        [obsA, obsB1, obsB2, orphanObs],
        multiBrandCtx,
      );

      expect(multiResult.brandGroups.map((g) => g.brandName)).toEqual(['安克创新', '阿卓帕']);
      expect(multiResult.brandGroups[0]?.shareOfVoice.entries.map((e) => e.name)).toEqual([
        '安克创新',
        '竞品充Y',
      ]);
      expect(multiResult.brandGroups[1]?.shareOfVoice.entries.map((e) => e.name)).toEqual([
        '阿卓帕',
        '竞品屏X',
      ]);
      expect(multiResult.metrics.completedChecks).toBe(4);
      expect(multiResult.metrics.mentionedChecks).toBe(3);

      const offTopicMulti = computeOverviewMetricsAndGroups(
        [
          {
            ...obsA,
            brandMentioned: true,
            brandPosition: 1,
            brandSentiment: 'POSITIVE',
            answerText: `${FAKE_MARK}阿卓帕 跑题占位回答`,
          },
          {
            ...obsB1,
            brandMentioned: true,
            brandPosition: 1,
            brandSentiment: 'POSITIVE',
            answerText: `${FAKE_MARK}安克创新 跑题占位回答`,
          },
        ],
        multiBrandCtx,
      );
      expect(offTopicMulti.metrics.mentionedChecks).toBe(0);
      expect(offTopicMulti.metrics.visibilityPct).toBe(0);
      expect(offTopicMulti.metrics.avgPosition).toBeNull();
      expect(offTopicMulti.metrics.sentimentSummary.total).toBe(0);

      const arzopaDomain = multiResult.metrics.topDomains.find((d) => d.domain === 'arzopa.com');
      expect(arzopaDomain).toEqual({
        domain: 'arzopa.com',
        sourceKind: 'OWNED',
        count: 2,
        observationCount: 2,
      });

      const dateKeys = ['2026-11-17', '2026-11-18', '2026-11-19'];
      const allTrend = buildDailyTrend([obsA, obsB1, obsB2], dateKeys, multiBrandCtx);
      const emptyDay = allTrend.find((p) => p.engine === 'all' && p.date === '2026-11-17');
      const day18 = allTrend.find((p) => p.engine === 'all' && p.date === '2026-11-18');
      const day19 = allTrend.find((p) => p.engine === 'all' && p.date === '2026-11-19');

      expect(emptyDay).toEqual({
        date: '2026-11-17',
        engine: 'all',
        completedChecks: 0,
        mentionedChecks: 0,
        visibilityPct: 0,
        shareOfVoicePct: null,
      });
      expect(day18?.completedChecks).toBe(1);
      expect(day19?.completedChecks).toBe(2);

      const filteredTrend = buildDailyTrend(
        [obsA, obsB1, obsB2],
        dateKeys,
        multiBrandCtx,
        'doubao',
      );
      expect(filteredTrend).toHaveLength(3);
      expect(filteredTrend.every((p) => p.engine === 'doubao')).toBe(true);
      expect(filteredTrend[0]?.shareOfVoicePct).toBeNull();
      expect(filteredTrend[2]?.completedChecks).toBe(1);

      const offTopicEngineObs: OverviewObservationRow = {
        ...obsA,
        id: 'obs_fake',
        answerText: `${FAKE_MARK}阿卓帕 跑题占位`,
        brandMentioned: true,
        brandPosition: 1,
      };
      const breakdown = buildEngineBreakdown(
        [obsA, obsB1, offTopicEngineObs, { ...obsA, id: 'obs_unknown', engine: 'custom_bot' }],
        multiBrandCtx,
      );
      expect(breakdown).toEqual([
        {
          engine: 'doubao',
          completedChecks: 1,
          mentionedChecks: 1,
          visibilityPct: 100,
          avgPosition: 1,
        },
        {
          engine: 'deepseek',
          completedChecks: 2,
          mentionedChecks: 1,
          visibilityPct: 50,
          avgPosition: 1,
        },
      ]);
    });
  });

  describe('module purity and acyclic dependency contract', () => {
    it('keeps visibility.mapper.ts pure (only node:crypto and @geomix/shared) and visibility/*.ts acyclic', () => {
      const mapperSource = readFileSync(join(CURRENT_DIR, 'visibility.mapper.ts'), 'utf8');
      const importSpecifiers = [
        ...mapperSource.matchAll(/^\s*import\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]);

      expect(importSpecifiers.length).toBeGreaterThan(0);
      for (const spec of importSpecifiers) {
        expect(['node:crypto', '@geomix/shared']).toContain(spec);
      }

      const sourceFiles = readdirSync(CURRENT_DIR).filter(
        (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
      );
      const graph = new Map<string, string[]>();
      for (const file of sourceFiles) {
        const content = readFileSync(join(CURRENT_DIR, file), 'utf8');
        const edges: string[] = [];
        for (const match of content.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
          const target = `${match[1]?.slice(2)}.ts`;
          if (sourceFiles.includes(target)) {
            edges.push(target);
          }
        }
        graph.set(file, edges);
      }

      const state = new Map<string, 'visiting' | 'visited'>();
      const visit = (node: string, stack: string[]) => {
        const cur = state.get(node);
        if (cur === 'visiting') {
          throw new Error(`Circular dependency detected: ${[...stack, node].join(' -> ')}`);
        }
        if (cur === 'visited') return;
        state.set(node, 'visiting');
        for (const dep of graph.get(node) ?? []) {
          visit(dep, [...stack, node]);
        }
        state.set(node, 'visited');
      };

      for (const file of sourceFiles) {
        visit(file, []);
      }
    });
  });
});
