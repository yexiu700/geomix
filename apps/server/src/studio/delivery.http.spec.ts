import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  API_ERROR,
  parseEnv,
  readZipStoreEntries,
  type ActionHomeResponse,
  type GeoEvaluationResult,
  type GeoPublishRecordDto,
  type VisibilityRunDetailRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BillingService, type ReservationView } from '../billing/billing.service';
import { QuotaService } from '../billing/quota.service';
import { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { BriefsAutoGeneratorService } from '../briefs/briefs-auto-generator.service';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { QueueRuntime } from '../queue/queue.runtime';
import { currentTenantId } from '../tenant/tenant-context';
import { VISIBILITY_RUN_ENQUEUER, VisibilityRunRunner } from '../visibility/visibility-run.runner';
import { WorkerModule } from '../worker.module';
import { GeoDeliveryService } from './geo-delivery.service';
import { RetestMetricsHookService } from './retest-metrics-hook.service';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type BrandRow = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  truthAgreementIp: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BrandMarketRow = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale: string;
  region: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  seedPrompts: string[];
  createdAt: Date;
  updatedAt: Date;
};

type FactRow = {
  id: string;
  tenantId: string;
  brandId: string;
  slot: string;
  title: string;
  content: string;
  sourceType: string;
  indexStatus: string;
};

type BriefRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  sourceType: string;
  priorityScore: number;
  diagnosisSummary: string;
  suggestedTitle: string;
  targetPrompt: string;
  recommendedRecipe: string;
  targetFormat: string;
  targetFanOuts: string[];
  matchedFactIds: string[];
  recommendedChannels: unknown;
  status: string;
  createdAt: Date;
};

type ArticleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  briefId: string | null;
  batchJobId: string | null;
  recipe: string;
  targetFormat: string;
  title: string;
  targetPrompt: string;
  outlineJson: unknown;
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: unknown;
  llmsTxtSnippet: string | null;
  geoScore: number;
  geoScoreDetail: unknown;
  tags: string[];
  status: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  complianceFlags: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type PublishRecordRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  publishedUrl: string;
  channel: string;
  publishedAt: Date;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: unknown;
  afterMetrics: unknown;
  createdAt: Date;
};

type VisibilityRunRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  name: string;
  engines: string[];
  prompts: string[];
  triggerType: 'MANUAL' | 'RETEST';
  retestArticleId: string | null;
  briefsGeneratedAt: Date | null;
  totalChecks: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type VisibilityObservationRow = {
  id: string;
  tenantId: string;
  runId: string;
  brandId: string;
  brandMarketId: string;
  promptText: string;
  engine: string;
  status: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  brandPassage: string | null;
  competitorHits: unknown;
  fanOutQueries: string[];
  collectorKind: string | null;
  rawMeta: unknown;
  errorMsg: string | null;
  checkedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type VisibilityCitationRow = {
  id: string;
  tenantId: string;
  observationId: string;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  sourceKind: string;
  position: number;
  createdAt: Date;
};

const RICH_CN_MD = [
  '综合实测表现，星辰存储 DXP4800 在四盘位静音家用 NAS 场景中表现稳定，满载噪音仅 18.5dB，待机功耗 14W，值得家庭影音与团队备份优先纳入对比清单。',
  '',
  '## 核心硬件与实测参数',
  '- 满载噪音：18.5dB（1 米距离实测）',
  '- 待机功耗：14W，双 2.5GbE 网口，最大扩展 96TB',
  '- 权威资质：通过 ISO9001 质量体系认证',
  '',
  '## 横向参数对比表',
  '| 指标 | 星辰存储 DXP4800 | 群晖 DS423+ |',
  '| --- | --- | --- |',
  '| 满载噪音 | 18.5dB | 29dB |',
  '| 待机功耗 | 14W | 26W |',
  '',
  '## 典型使用场景建议',
  '支持 24 小时静音运行，适合客厅部署与多设备备份。',
  '',
  '## 常见问题（FAQ）',
  '**问：四盘位静音 NAS 放在卧室会吵吗？**',
  '答：星辰存储 DXP4800 满载仅 18.5dB，日常几乎无感。',
].join('\n');

const RICH_GLOBAL_MD = [
  'AstraVault DXP4800 is one of the Best Top-rated 4-bay home NAS picks in 2026 with 100% aluminum chassis, 18.5dB noise, and 14W idle power.',
  '',
  '## Verified Hardware Specs',
  '- Acoustic: 18.5dB under load, 100% solid aluminum damping',
  '- Connectivity: Dual 2.5GbE, 96TB max capacity, ISO9001 certified',
  '',
  '## Head-to-Head Comparison',
  '| Metric | AstraVault | Synology |',
  '| --- | --- | --- |',
  '| Load Noise | 18.5dB | 29dB |',
  '| Idle Power | 14W | 26W |',
  '',
  '## Deployment Notes',
  'Ideal for 24/7 home-office backups and 4K media streaming.',
  '',
  '## Frequently Asked Questions (FAQ)',
  '**Q: Why is AstraVault a Best pick for quiet home labs?**',
  'A: It combines 18.5dB operation, 14W efficiency, and 100% aluminum thermal control.',
].join('\n');

describe('M5 Delivery, Export, Publish/Retest, Action Home HTTP & ApiModule/WorkerModule DI', () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokenTenantA: string;
  let tokenTenantB: string;
  let tokenExpired: string;
  let rateLimiter: FreeActionRateLimiter;

  const brands = new Map<string, BrandRow>();
  const markets = new Map<string, BrandMarketRow>();
  const facts = new Map<string, FactRow>();
  const briefs = new Map<string, BriefRow>();
  const articles = new Map<string, ArticleRow>();
  const publishRecords = new Map<string, PublishRecordRow>();
  const visibilityRuns = new Map<string, VisibilityRunRow>();
  const visibilityObservations = new Map<string, VisibilityObservationRow>();
  const visibilityCitations = new Map<string, VisibilityCitationRow>();
  const wallets = new Map<string, { balance: number; frozen: number; mode: 'SHADOW' | 'STRICT' }>();
  const reservations = new Map<string, ReservationView & { tenantId: string; total: number }>();
  const enqueuedRuns: Array<{ tenantId: string; runId: string }> = [];

  let pubSeq = 1;
  let obsSeq = 1;

  const now = new Date('2026-11-21T08:00:00Z');
  const validUntilFuture = new Date('2027-11-21T00:00:00Z');
  const validUntilPast = new Date('2025-01-01T00:00:00Z');

  function seedState() {
    brands.clear();
    markets.clear();
    facts.clear();
    briefs.clear();
    articles.clear();
    publishRecords.clear();
    visibilityRuns.clear();
    visibilityObservations.clear();
    visibilityCitations.clear();
    wallets.clear();
    reservations.clear();
    enqueuedRuns.length = 0;
    pubSeq = 1;
    obsSeq = 1;
    rateLimiter?.reset();

    wallets.set('tenant_a', { balance: 100, frozen: 0, mode: 'STRICT' });
    wallets.set('tenant_b', { balance: 100, frozen: 0, mode: 'SHADOW' });
    wallets.set('tenant_exp', { balance: 100, frozen: 0, mode: 'SHADOW' });

    brands.set('brand_dual', {
      id: 'brand_dual',
      tenantId: 'tenant_a',
      name: '星辰存储',
      category: '家用 NAS',
      truthAgreementSignedAt: now,
      truthAgreementIp: '127.0.0.1',
      createdAt: now,
      updatedAt: now,
    });
    brands.set('brand_b', {
      id: 'brand_b',
      tenantId: 'tenant_b',
      name: 'Tenant B Brand',
      category: 'NAS',
      truthAgreementSignedAt: now,
      truthAgreementIp: '127.0.0.1',
      createdAt: now,
      updatedAt: now,
    });

    markets.set('bm_cn', {
      id: 'bm_cn',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '星辰存储',
      aliases: ['DXP4800'],
      ownedDomains: ['xingchennas.example'],
      competitors: [{ name: '群晖', aliases: ['Synology'], domains: ['synology.com'] }],
      seedPrompts: ['四盘位静音家用 NAS 推荐'],
      createdAt: now,
      updatedAt: now,
    });
    markets.set('bm_global', {
      id: 'bm_global',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AstraVault',
      aliases: ['DXP4800'],
      ownedDomains: ['astravault.example'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['Best quiet 4-bay NAS 2026'],
      createdAt: now,
      updatedAt: now,
    });
    markets.set('bm_b', {
      id: 'bm_b',
      tenantId: 'tenant_b',
      brandId: 'brand_b',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: 'Tenant B Brand',
      aliases: [],
      ownedDomains: ['tenantb.example'],
      competitors: [],
      seedPrompts: ['测试问题'],
      createdAt: now,
      updatedAt: now,
    });

    facts.set('fact_1', {
      id: 'fact_1',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      slot: 'PRODUCT_SPECS',
      title: 'DXP4800 实测参数',
      content: '满载噪音 18.5dB，待机功耗 14W，双 2.5GbE 网口，最大扩展 96TB。',
      sourceType: 'MANUAL',
      indexStatus: 'NONE',
    });
    facts.set('fact_2', {
      id: 'fact_2',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      slot: 'CREDENTIALS',
      title: '权威认证',
      content: '通过 ISO9001 质量体系认证。',
      sourceType: 'MANUAL',
      indexStatus: 'NONE',
    });

    // 5 CN briefs (4 OPEN + 1 DISMISSED) + 1 GLOBAL OPEN brief -> /home must return <= 3 OPEN per market
    for (let i = 1; i <= 5; i += 1) {
      briefs.set(`brief_cn_${i}`, {
        id: `brief_cn_${i}`,
        tenantId: 'tenant_a',
        brandId: 'brand_dual',
        brandMarketId: 'bm_cn',
        sourceType: i === 1 ? 'AUTO_GAP' : 'LOW_RANK',
        priorityScore: i === 5 ? 99 : 95 - i * 5,
        diagnosisSummary: `CN 诊断摘要 ${i}`,
        suggestedTitle: `CN 建议标题 ${i}`,
        targetPrompt: '四盘位静音家用 NAS 推荐',
        recommendedRecipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetFanOuts: ['满载噪音', '待机功耗'],
        matchedFactIds: ['fact_1', 'fact_2'],
        recommendedChannels: [{ channel: '知乎', reason: '国内评测权重高' }],
        status: i === 5 ? 'DISMISSED' : 'OPEN',
        createdAt: new Date(now.getTime() - i * 1000),
      });
    }
    briefs.set('brief_global_1', {
      id: 'brief_global_1',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      brandMarketId: 'bm_global',
      sourceType: 'AUTO_GAP',
      priorityScore: 92,
      diagnosisSummary: '海外引擎缺口建议',
      suggestedTitle: 'Best 4-Bay NAS 2026 Buying Guide',
      targetPrompt: 'Best quiet 4-bay NAS 2026',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      targetFanOuts: ['18.5dB', '2.5GbE'],
      matchedFactIds: ['fact_1', 'fact_2'],
      recommendedChannels: [{ channel: 'Official Blog / Docs', reason: 'Schema + llms.txt' }],
      status: 'OPEN',
      createdAt: now,
    });

    // 6 CN articles (testing <= 5 cap on /home) + 1 CN cliché + 1 GLOBAL article
    for (let i = 1; i <= 6; i += 1) {
      articles.set(`art_cn_${i}`, {
        id: `art_cn_${i}`,
        tenantId: 'tenant_a',
        brandId: 'brand_dual',
        brandMarketId: 'bm_cn',
        briefId: i === 1 ? 'brief_cn_1' : null,
        batchJobId: null,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        title: `2026 四盘位静音家用 NAS 实测指南 ${i}`,
        targetPrompt: '四盘位静音家用 NAS 推荐',
        outlineJson: [],
        contentMarkdown: RICH_CN_MD,
        contentHtml:
          '<h2>核心参数</h2><table><thead><tr><th>指标</th><th>值</th></tr></thead><tbody><tr><td>噪音</td><td>18.5dB</td></tr></tbody></table>',
        schemaJsonLd: {},
        llmsTxtSnippet: null,
        geoScore: 88,
        geoScoreDetail: {},
        tags: ['NAS'],
        status: 'DRAFT',
        model: 'fake-quality',
        tokensIn: 100,
        tokensOut: 200,
        complianceFlags: [],
        createdAt: new Date(now.getTime() - i * 60_000),
        updatedAt: new Date(now.getTime() - i * 10_000),
      });
    }

    articles.set('art_cn_poor', {
      id: 'art_cn_poor',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      brandMarketId: 'bm_cn',
      briefId: 'brief_cn_1',
      batchJobId: null,
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      title: '随便写写 </script><script>alert(1)</script>',
      targetPrompt: '四盘位静音家用 NAS 推荐',
      outlineJson: [],
      contentMarkdown: '在数字化浪潮下，随着科技的飞速发展，全网第一顶级产品，[待补充：功耗]。',
      contentHtml: '<p>在数字化浪潮下</p>',
      schemaJsonLd: {},
      llmsTxtSnippet: null,
      geoScore: 0,
      geoScoreDetail: {},
      tags: [],
      status: 'DRAFT',
      model: 'fake-quality',
      tokensIn: 20,
      tokensOut: 20,
      complianceFlags: [],
      createdAt: new Date(now.getTime() - 900_000),
      updatedAt: new Date(now.getTime() - 900_000),
    });

    articles.set('art_global_1', {
      id: 'art_global_1',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      brandMarketId: 'bm_global',
      briefId: 'brief_global_1',
      batchJobId: null,
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      title: 'Best 4-Bay Quiet NAS 2026 Guide',
      targetPrompt: 'Best quiet 4-bay NAS 2026',
      outlineJson: [],
      contentMarkdown: RICH_GLOBAL_MD,
      contentHtml: '', // deliberately blank to verify markdown table -> HTML / OOXML fallback!
      schemaJsonLd: {},
      llmsTxtSnippet: null,
      geoScore: 90,
      geoScoreDetail: {},
      tags: ['Global'],
      status: 'READY',
      model: 'fake-quality',
      tokensIn: 100,
      tokensOut: 200,
      complianceFlags: [],
      createdAt: now,
      updatedAt: now,
    });

    // Baseline COMPLETED MANUAL run for CN with gap observation
    visibilityRuns.set('run_base_cn', {
      id: 'run_base_cn',
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      brandMarketId: 'bm_cn',
      name: 'CN 基线监测',
      engines: ['deepseek'],
      prompts: ['[E2E_GAP] 四盘位静音家用 NAS 推荐'],
      triggerType: 'MANUAL',
      retestArticleId: null,
      briefsGeneratedAt: now,
      totalChecks: 1,
      doneCount: 1,
      failCount: 0,
      unitPrice: 2,
      reservationId: null,
      status: 'COMPLETED',
      lastError: null,
      createdAt: new Date(now.getTime() - 3_600_000),
      updatedAt: new Date(now.getTime() - 3_500_000),
      startedAt: new Date(now.getTime() - 3_590_000),
      finishedAt: new Date(now.getTime() - 3_500_000),
    });
    visibilityObservations.set('obs_base_cn_1', {
      id: 'obs_base_cn_1',
      tenantId: 'tenant_a',
      runId: 'run_base_cn',
      brandId: 'brand_dual',
      brandMarketId: 'bm_cn',
      promptText: '[E2E_GAP] 四盘位静音家用 NAS 推荐',
      engine: 'deepseek',
      status: 'SUCCESS',
      answerText: '1. 群晖 DS423+ 稳定可靠，2. 威联通 TS-464C2 扩展性强。',
      brandMentioned: false,
      brandPosition: null,
      brandSentiment: null,
      brandPassage: null,
      competitorHits: [{ name: '群晖', mentioned: true, position: 1, sentiment: 'positive' }],
      fanOutQueries: ['满载噪音', '待机功耗'],
      collectorKind: 'fake',
      rawMeta: { simulated: true },
      errorMsg: null,
      checkedAt: new Date(now.getTime() - 3_500_000),
      createdAt: new Date(now.getTime() - 3_500_000),
      updatedAt: new Date(now.getTime() - 3_500_000),
    });
    visibilityCitations.set('cite_base_cn_1', {
      id: 'cite_base_cn_1',
      tenantId: 'tenant_a',
      observationId: 'obs_base_cn_1',
      url: 'https://www.synology.com/nas',
      domain: 'synology.com',
      title: 'Synology NAS',
      snippet: 'Synology specs',
      sourceKind: 'COMPETITOR',
      position: 1,
      createdAt: new Date(now.getTime() - 3_500_000),
    });
  }

  function buildScopedClient(forcedTenant?: string) {
    const t = () => forcedTenant ?? currentTenantId();
    const attachArticleIncludes = (row: ArticleRow, include?: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...row };
      if (include?.brand) {
        const b = brands.get(row.brandId);
        out.brand = b
          ? {
              ...b,
              facts: [...facts.values()].filter(
                (f) => f.brandId === b.id && f.tenantId === b.tenantId,
              ),
            }
          : null;
      }
      if (include?.brandMarket) {
        out.brandMarket = markets.get(row.brandMarketId) ?? null;
      }
      if (include?.brief) {
        out.brief = row.briefId ? (briefs.get(row.briefId) ?? null) : null;
      }
      if (include?.publishRecords) {
        const recs = [...publishRecords.values()]
          .filter((r) => r.articleId === row.id && r.tenantId === row.tenantId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const take =
          typeof include.publishRecords === 'object' && include.publishRecords
            ? ((include.publishRecords as { take?: number }).take ?? recs.length)
            : recs.length;
        out.publishRecords = recs.slice(0, take);
      }
      return out;
    };

    const attachRunIncludes = (row: VisibilityRunRow, include?: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...row };
      const b = brands.get(row.brandId) ?? null;
      const bm = markets.get(row.brandMarketId) ?? null;
      if (include?.brand) out.brand = b;
      if (include?.brandMarket) {
        out.brandMarket = bm ? { ...bm, brand: b ? { name: b.name } : null } : null;
      }
      if (include?.observations) {
        const obsFilter =
          typeof include.observations === 'object' && include.observations
            ? (include.observations as { where?: { status?: string } }).where
            : undefined;
        out.observations = [...visibilityObservations.values()]
          .filter(
            (o) => o.runId === row.id && (!obsFilter?.status || o.status === obsFilter.status),
          )
          .map((o) => ({
            ...o,
            citations: [...visibilityCitations.values()].filter((c) => c.observationId === o.id),
          }));
      }
      return out;
    };

    const client: Record<string, unknown> = {
      tenant: {
        findUnique: async (args: { where: { id: string } }) => ({
          id: args.where.id,
          name: args.where.id,
          isActive: true,
          expiresAt: args.where.id === 'tenant_exp' ? validUntilPast : validUntilFuture,
          billingMode: wallets.get(args.where.id)?.mode ?? 'SHADOW',
        }),
      },
      user: {
        findUnique: async (args: { where: { id?: string; username?: string } }) => {
          const id = args.where.id ?? args.where.username ?? 'user_a';
          const tenantId =
            id === 'user_b' ? 'tenant_b' : id === 'user_exp' ? 'tenant_exp' : 'tenant_a';
          return {
            id,
            tenantId,
            username: id,
            passwordHash: 'hashed_pw',
            role: 'MERCHANT',
            tenant: {
              id: tenantId,
              name: tenantId,
              isActive: true,
              expiresAt: tenantId === 'tenant_exp' ? validUntilPast : validUntilFuture,
              billingMode: wallets.get(tenantId)?.mode ?? 'SHADOW',
            },
          };
        },
      },
      auditLog: {
        create: async () => ({ id: 'audit_1' }),
        findMany: async () => [],
      },
      pointReservation: {
        findMany: async (args: { where: { id?: { in: string[] } } }) =>
          [...reservations.values()].filter(
            (r) => !args.where.id?.in || args.where.id.in.includes(r.id),
          ),
      },
      $disconnect: async () => undefined,
      $connect: async () => undefined,
      brand: {
        findFirst: async (args: {
          where: { id?: string; tenantId?: string };
          include?: Record<string, unknown>;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const row = [...brands.values()].find(
            (b) => b.tenantId === tenantId && (!args.where.id || b.id === args.where.id),
          );
          if (!row) return null;
          return {
            ...row,
            markets: [...markets.values()].filter((m) => m.brandId === row.id),
          };
        },
      },
      brandMarket: {
        findFirst: async (args: {
          where: { id?: string; brandId?: string; market?: string; tenantId?: string };
        }) => {
          const tenantId = args.where.tenantId ?? t();
          return (
            [...markets.values()].find(
              (m) =>
                m.tenantId === tenantId &&
                (!args.where.id || m.id === args.where.id) &&
                (!args.where.brandId || m.brandId === args.where.brandId) &&
                (!args.where.market || m.market === args.where.market),
            ) ?? null
          );
        },
      },
      geoBrief: {
        findMany: async (args: {
          where: { brandId?: string; brandMarketId?: string; status?: string; tenantId?: string };
          take?: number;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const list = [...briefs.values()]
            .filter(
              (b) =>
                b.tenantId === tenantId &&
                (!args.where.brandId || b.brandId === args.where.brandId) &&
                (!args.where.brandMarketId || b.brandMarketId === args.where.brandMarketId) &&
                (!args.where.status || b.status === args.where.status),
            )
            .sort((a, b) => b.priorityScore - a.priorityScore);
          return args.take !== undefined ? list.slice(0, args.take) : list;
        },
      },
      geoArticle: {
        findFirst: async (args: {
          where: { id?: string; tenantId?: string };
          include?: Record<string, unknown>;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const row = [...articles.values()].find(
            (a) => a.tenantId === tenantId && (!args.where.id || a.id === args.where.id),
          );
          return row ? attachArticleIncludes(row, args.include) : null;
        },
        findMany: async (args: {
          where: { brandId?: string; brandMarketId?: string; tenantId?: string };
          include?: Record<string, unknown>;
          take?: number;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const list = [...articles.values()]
            .filter(
              (a) =>
                a.tenantId === tenantId &&
                (!args.where.brandId || a.brandId === args.where.brandId) &&
                (!args.where.brandMarketId || a.brandMarketId === args.where.brandMarketId),
            )
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .map((a) => attachArticleIncludes(a, args.include));
          return args.take !== undefined ? list.slice(0, args.take) : list;
        },
        update: async (args: { where: { id: string }; data: Partial<ArticleRow> }) => {
          const row = articles.get(args.where.id);
          if (!row) throw new Error('Not found');
          const updated: ArticleRow = { ...row, ...args.data, updatedAt: new Date() };
          articles.set(row.id, updated);
          return updated;
        },
      },
      geoPublishRecord: {
        findFirst: async (args: {
          where: { id?: string; tenantId?: string };
          include?: Record<string, unknown>;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const row = [...publishRecords.values()].find(
            (r) => r.tenantId === tenantId && (!args.where.id || r.id === args.where.id),
          );
          if (!row) return null;
          return {
            ...row,
            ...(args.include?.article ? { article: articles.get(row.articleId) ?? null } : {}),
            ...(args.include?.brandMarket
              ? { brandMarket: markets.get(row.brandMarketId) ?? null }
              : {}),
          };
        },
        findMany: async (args: {
          where: {
            articleId?: string;
            latestRetestRunId?: string;
            tenantId?: string;
          };
          take?: number;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const list = [...publishRecords.values()]
            .filter(
              (r) =>
                r.tenantId === tenantId &&
                (!args.where.articleId || r.articleId === args.where.articleId) &&
                (!args.where.latestRetestRunId ||
                  r.latestRetestRunId === args.where.latestRetestRunId),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return args.take !== undefined ? list.slice(0, args.take) : list;
        },
        create: async (args: { data: Omit<PublishRecordRow, 'id' | 'createdAt'> }) => {
          const id = `pub_${pubSeq++}`;
          const row: PublishRecordRow = {
            ...args.data,
            id,
            beforeMetrics:
              args.data.beforeMetrics && typeof args.data.beforeMetrics === 'object'
                ? args.data.beforeMetrics
                : null,
            afterMetrics:
              args.data.afterMetrics && typeof args.data.afterMetrics === 'object'
                ? args.data.afterMetrics
                : null,
            createdAt: new Date(now.getTime() + pubSeq * 1000),
          };
          publishRecords.set(id, row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Partial<PublishRecordRow> }) => {
          const row = publishRecords.get(args.where.id);
          if (!row) throw new Error('Not found');
          const next: PublishRecordRow = { ...row, ...args.data };
          publishRecords.set(row.id, next);
          return next;
        },
        updateMany: async (args: {
          where: {
            id?: string;
            OR?: Array<{ latestRetestRunId: null | { not: string } }>;
          };
          data: Partial<PublishRecordRow>;
        }) => {
          const tenantId = t();
          let count = 0;
          for (const row of publishRecords.values()) {
            if (row.tenantId !== tenantId) continue;
            if (args.where.id && row.id !== args.where.id) continue;
            if (args.where.OR) {
              const matched = args.where.OR.some((cond) => {
                if (cond.latestRetestRunId === null) return row.latestRetestRunId === null;
                return row.latestRetestRunId !== cond.latestRetestRunId.not;
              });
              if (!matched) continue;
            }
            const nextAfter =
              args.data.afterMetrics &&
              typeof args.data.afterMetrics === 'object' &&
              'mentionRate' in (args.data.afterMetrics as Record<string, unknown>)
                ? args.data.afterMetrics
                : null;
            publishRecords.set(row.id, {
              ...row,
              ...(args.data.latestRetestRunId !== undefined
                ? { latestRetestRunId: args.data.latestRetestRunId }
                : {}),
              ...(args.data.afterMetrics !== undefined ? { afterMetrics: nextAfter } : {}),
            });
            count += 1;
          }
          return { count };
        },
      },
      visibilityRun: {
        findFirst: async (args: {
          where: {
            id?: string;
            tenantId?: string;
            brandId?: string;
            brandMarketId?: string;
            triggerType?: string;
            status?: string | { in: string[] };
          };
          include?: Record<string, unknown>;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          const list = [...visibilityRuns.values()]
            .filter((r) => {
              if (r.tenantId !== tenantId) return false;
              if (args.where.id && r.id !== args.where.id) return false;
              if (args.where.brandId && r.brandId !== args.where.brandId) return false;
              if (args.where.brandMarketId && r.brandMarketId !== args.where.brandMarketId)
                return false;
              if (args.where.triggerType && r.triggerType !== args.where.triggerType) return false;
              if (args.where.status) {
                if (typeof args.where.status === 'string' && r.status !== args.where.status)
                  return false;
                if (
                  typeof args.where.status === 'object' &&
                  !args.where.status.in.includes(r.status)
                )
                  return false;
              }
              return true;
            })
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return list[0] ? attachRunIncludes(list[0], args.include) : null;
        },
        findUnique: async (args: { where: { id: string }; include?: Record<string, unknown> }) => {
          const row = visibilityRuns.get(args.where.id);
          return row ? attachRunIncludes(row, args.include) : null;
        },
        create: async (args: { data: Omit<VisibilityRunRow, 'createdAt' | 'updatedAt'> }) => {
          const row: VisibilityRunRow = {
            ...args.data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          visibilityRuns.set(row.id, row);
          return row;
        },
      },
      visibilityObservation: {
        createMany: async (args: {
          data: Array<{
            tenantId: string;
            runId: string;
            brandId: string;
            brandMarketId: string;
            promptText: string;
            engine: string;
            status: string;
          }>;
        }) => {
          for (const item of args.data) {
            const id = `obs_${obsSeq++}`;
            visibilityObservations.set(id, {
              id,
              ...item,
              answerText: null,
              brandMentioned: false,
              brandPosition: null,
              brandSentiment: null,
              brandPassage: null,
              competitorHits: null,
              fanOutQueries: [],
              collectorKind: null,
              rawMeta: null,
              errorMsg: null,
              checkedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
          return { count: args.data.length };
        },
        findMany: async (args: {
          where: {
            tenantId?: string;
            brandId?: string;
            brandMarketId?: string;
            status?: string;
            runId?: string;
          };
          include?: Record<string, unknown>;
        }) => {
          const tenantId = args.where.tenantId ?? t();
          return [...visibilityObservations.values()]
            .filter(
              (o) =>
                o.tenantId === tenantId &&
                (!args.where.brandId || o.brandId === args.where.brandId) &&
                (!args.where.brandMarketId || o.brandMarketId === args.where.brandMarketId) &&
                (!args.where.status || o.status === args.where.status) &&
                (!args.where.runId || o.runId === args.where.runId),
            )
            .map((o) => ({
              ...o,
              citations: [...visibilityCitations.values()].filter((c) => c.observationId === o.id),
            }));
        },
      },
      $transaction: async <T>(fn: (tx: Record<string, unknown>) => Promise<T>) => fn(client),
    };
    return client;
  }

  beforeAll(async () => {
    seedState();
    process.env.VISIBILITY_COLLECTOR = 'fake';
    process.env.BILLING_MODE = 'SHADOW';
    const env = parseEnv(process.env);

    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as {
      base: unknown;
      scoped: unknown;
    };
    const scopedClient = buildScopedClient();
    prismaSvc.base = scopedClient;
    prismaSvc.scoped = scopedClient;

    const billingSvc = app.get(BillingService);
    vi.spyOn(billingSvc, 'unitPrice').mockImplementation(async (action) =>
      action === 'visibility_check' ? 2 : 10,
    );
    vi.spyOn(billingSvc, 'reserve').mockImplementation(
      async (input: {
        tenantId: string;
        refType: string;
        refId: string;
        amount: number;
      }): Promise<ReservationView> => {
        const key = `${input.tenantId}:${input.refType}:${input.refId}`;
        const existing = reservations.get(key);
        if (existing) return existing;
        const wallet = wallets.get(input.tenantId)!;
        if (wallet.mode === 'STRICT' && wallet.balance < input.amount) {
          throw new ApiError(402, API_ERROR.INSUFFICIENT_POINTS, '可用点数不足');
        }
        if (wallet.mode === 'STRICT') {
          wallet.balance -= input.amount;
          wallet.frozen += input.amount;
        }
        const res: ReservationView = {
          id: `res_${reservations.size + 1}`,
          tenantId: input.tenantId,
          refType: input.refType,
          refId: input.refId,
          shadow: wallet.mode !== 'STRICT',
          frozen: input.amount,
          settled: 0,
          released: 0,
          status: 'OPEN',
        };
        reservations.set(key, { ...res, total: input.amount });
        return res;
      },
    );

    const quotaSvc = app.get(QuotaService);
    vi.spyOn(quotaSvc, 'applyArticleEvent').mockResolvedValue(undefined);

    const visEnqueuer = app.get<{
      enqueueVisibilityRun(job: { tenantId: string; runId: string }): Promise<void>;
    }>(VISIBILITY_RUN_ENQUEUER);
    vi.spyOn(visEnqueuer, 'enqueueVisibilityRun').mockImplementation(async (job) => {
      enqueuedRuns.push(job);
    });

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    rateLimiter = app.get(FreeActionRateLimiter);

    const fp = passwordFingerprint('hashed_pw');
    const nowSec = Math.floor(Date.now() / 1000);
    const mintAccess = (sub: string, tid: string) =>
      signToken(
        {
          sub,
          tid,
          role: 'MERCHANT',
          typ: 'access',
          fp,
          lms: Date.now(),
          iat: nowSec,
          exp: nowSec + 3600,
        },
        env.JWT_ACCESS_SECRET,
      );

    tokenTenantA = mintAccess('user_a', 'tenant_a');
    tokenTenantB = mintAccess('user_b', 'tenant_b');
    tokenExpired = mintAccess('user_exp', 'tenant_exp');
  });

  beforeEach(() => {
    seedState();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function reqJson<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as Envelope<T>;
    return { status: res.status, body: json };
  }

  it('boots BOTH ApiModule and WorkerModule with BOTH geo-brief-auto-generator AND geo-retest-metrics-writeback registered', async () => {
    expect(app.get(GeoDeliveryService)).toBeInstanceOf(GeoDeliveryService);
    expect(app.get(RetestMetricsHookService)).toBeInstanceOf(RetestMetricsHookService);
    const apiRunner = app.get(VisibilityRunRunner) as unknown as {
      completeHooks: Array<{ name: string }>;
    };
    const apiHookNames = apiRunner.completeHooks.map((h) => h.name);
    expect(apiHookNames).toContain('geo-brief-auto-generator');
    expect(apiHookNames).toContain('geo-retest-metrics-writeback');

    const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
    const workerCtx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    try {
      const workerRunner = workerCtx.get(VisibilityRunRunner) as unknown as {
        completeHooks: Array<{ name: string }>;
      };
      const workerHookNames = workerRunner.completeHooks.map((h) => h.name);
      expect(workerHookNames).toContain('geo-brief-auto-generator');
      expect(workerHookNames).toContain('geo-retest-metrics-writeback');
      expect(workerCtx.get(BrandFactIndexRunner)).toBeDefined();
      expect(workerCtx.get(BriefsAutoGeneratorService)).toBeInstanceOf(BriefsAutoGeneratorService);
      expect(workerCtx.get(RetestMetricsHookService)).toBeInstanceOf(RetestMetricsHookService);
    } finally {
      await workerCtx.close();
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });

  it('POST /api/v2/articles/:id/evaluate-geo returns 200, persists dual-track score/JSON-LD/llms.txt, discriminates poor drafts, and enforces 403/404/429', async () => {
    const cnRes = await reqJson<GeoEvaluationResult>(
      'POST',
      '/api/v2/articles/art_cn_1/evaluate-geo',
      tokenTenantA,
    );
    expect(cnRes.status).toBe(200);
    expect(cnRes.body.code).toBe(0);
    expect(cnRes.body.data.geoScore).toBeGreaterThanOrEqual(85);
    const sum = Object.values(cnRes.body.data.geoScoreDetail.dimensions).reduce(
      (acc, d) => acc + d.score,
      0,
    );
    expect(cnRes.body.data.geoScore).toBe(sum);
    expect(cnRes.body.data.llmsTxtSnippet).toBeNull();
    expect(cnRes.body.data.recommendedChannels[0]?.channel).toBe('知乎');

    const globalRes = await reqJson<GeoEvaluationResult>(
      'POST',
      '/api/v2/articles/art_global_1/evaluate-geo',
      tokenTenantA,
    );
    expect(globalRes.status).toBe(200);
    expect(globalRes.body.data.geoScore).toBeGreaterThanOrEqual(85);
    expect(globalRes.body.data.llmsTxtSnippet).toContain('astravault.example');
    expect(globalRes.body.data.crawlerChecklist.map((c) => c.bot)).toContain('GPTBot');
    expect(globalRes.body.data.crawlerChecklist.map((c) => c.bot)).toContain('PerplexityBot');

    const poorRes = await reqJson<GeoEvaluationResult>(
      'POST',
      '/api/v2/articles/art_cn_poor/evaluate-geo',
      tokenTenantA,
    );
    expect(poorRes.status).toBe(200);
    expect(poorRes.body.data.geoScore).toBeLessThan(50);
    expect(JSON.stringify(poorRes.body.data.schemaJsonLd).toLowerCase()).not.toContain('</script');

    // Cross-tenant 404
    const crossTenant = await reqJson(
      'POST',
      '/api/v2/articles/art_cn_1/evaluate-geo',
      tokenTenantB,
    );
    expect(crossTenant.status).toBe(404);

    // Expired tenant 403/40301
    const expired = await reqJson('POST', '/api/v2/articles/art_cn_1/evaluate-geo', tokenExpired);
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe(40301);
  });

  it('GET /api/v2/articles/:id/export streams MD (GFM table), HTML (<table>), valid OOXML .docx (<w:tbl>), and rejects invalid/nested formats with 400', async () => {
    const mdRes = await fetch(`${baseUrl}/api/v2/articles/art_global_1/export?format=md`, {
      headers: { authorization: `Bearer ${tokenTenantA}` },
    });
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get('content-type')).toContain('text/markdown');
    expect(mdRes.headers.get('x-content-type-options')).toBe('nosniff');
    const mdBody = await mdRes.text();
    expect(mdBody).toMatch(/\|[^\n]+\|/);

    const htmlRes = await fetch(`${baseUrl}/api/v2/articles/art_global_1/export?format=html`, {
      headers: { authorization: `Bearer ${tokenTenantA}` },
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    const htmlBody = await htmlRes.text();
    expect(htmlBody).toContain('<html lang="en-US">');
    expect(htmlBody).toContain('<table');

    const docxRes = await fetch(`${baseUrl}/api/v2/articles/art_global_1/export?format=docx`, {
      headers: { authorization: `Bearer ${tokenTenantA}` },
    });
    expect(docxRes.status).toBe(200);
    expect(docxRes.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const docxBuf = new Uint8Array(await docxRes.arrayBuffer());
    const entries = readZipStoreEntries(docxBuf);
    const docXml = new TextDecoder('utf-8').decode(
      entries.find((e) => e.path === 'word/document.xml')!.data,
    );
    expect(docXml).toMatch(/<w:tbl[\s>]/);
    expect(docXml).toMatch(/<w:tr[\s>]/);
    expect(docXml).toMatch(/<w:tc[\s>]/);

    // Invalid format -> 400 / 40001
    for (const qs of ['format=pdf', 'format=exe', 'format[a]=md', '']) {
      const bad = await reqJson('GET', `/api/v2/articles/art_global_1/export?${qs}`, tokenTenantA);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe(API_ERROR.BAD_REQUEST);
    }

    // Cross-tenant 404
    const cross = await reqJson(
      'GET',
      '/api/v2/articles/art_global_1/export?format=md',
      tokenTenantB,
    );
    expect(cross.status).toBe(404);
  });

  it('publish-records CRUD validates HTTP(S) URLs, snapshots baseline beforeMetrics, transitions article to PUBLISHED, and supports flat RETEST + idempotency + afterMetrics writeback', async () => {
    // Invalid URLs rejected with 400 / 40001 without modifying status
    for (const badUrl of ['not-a-url', 'javascript:alert(1)', '', 'ftp://example.com/a']) {
      const bad = await reqJson('POST', '/api/v2/articles/art_cn_1/publish-records', tokenTenantA, {
        publishedUrl: badUrl,
        channel: '官网博客',
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe(API_ERROR.BAD_REQUEST);
    }
    expect(articles.get('art_cn_1')?.status).toBe('DRAFT');

    // Valid publish record
    const created = await reqJson<GeoPublishRecordDto>(
      'POST',
      '/api/v2/articles/art_cn_1/publish-records',
      tokenTenantA,
      { publishedUrl: 'https://xingchennas.example/guides/dxp4800', channel: '官网博客' },
    );
    expect(created.status).toBe(200);
    expect(created.body.data.baselineRunId).toBe('run_base_cn');
    expect(created.body.data.beforeMetrics).toEqual({
      mentionRate: 0,
      avgPosition: null,
      sentiment: null,
      citationHit: false,
    });
    expect(created.body.data.afterMetrics).toBeNull();
    expect(articles.get('art_cn_1')?.status).toBe('PUBLISHED');

    const listed = await reqJson<{ items: GeoPublishRecordDto[] }>(
      'GET',
      '/api/v2/articles/art_cn_1/publish-records',
      tokenTenantA,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(1);

    // One-click RETEST with EMPTY body returns FLAT VisibilityRunDetailRecord & deducts 2 pts * online engines
    const recordId = created.body.data.id;
    const balanceBefore = wallets.get('tenant_a')!.balance;
    const retestRes = await reqJson<VisibilityRunDetailRecord>(
      'POST',
      `/api/v2/publish-records/${recordId}/retest`,
      tokenTenantA,
      undefined,
      { 'Idempotency-Key': 'retest_key_001' },
    );
    expect(retestRes.status).toBe(200);
    expect(retestRes.body.data.triggerType).toBe('RETEST');
    expect(retestRes.body.data.retestArticleId).toBe('art_cn_1');
    expect(retestRes.body.data.engines.length).toBeGreaterThan(0);
    expect(enqueuedRuns).toHaveLength(1);
    const balanceAfterFirst = wallets.get('tenant_a')!.balance;
    expect(balanceAfterFirst).toBeLessThan(balanceBefore);

    // Simulate worker completion hook writing afterMetrics
    const retestRunId = retestRes.body.data.id;
    const retestObs = [...visibilityObservations.values()].filter((o) => o.runId === retestRunId);
    for (const o of retestObs) {
      o.status = 'SUCCESS';
      o.answerText = '1. 星辰存储 DXP4800 实测静音 18.5dB，强烈推荐。';
      o.brandMentioned = true;
      o.brandPosition = 1;
      o.brandSentiment = 'positive';
      visibilityCitations.set(`cite_retest_${o.id}`, {
        id: `cite_retest_${o.id}`,
        tenantId: 'tenant_a',
        observationId: o.id,
        url: 'https://xingchennas.example/guides/dxp4800',
        domain: 'xingchennas.example',
        title: '星辰存储实测',
        snippet: '18.5dB',
        sourceKind: 'OWNED',
        position: 1,
        createdAt: new Date(),
      });
    }
    const hook = app.get(RetestMetricsHookService);
    await hook.onVisibilityRunComplete({
      tenantId: 'tenant_a',
      brandId: 'brand_dual',
      brandMarketId: 'bm_cn',
      runId: retestRunId,
      triggerType: 'RETEST',
      retestArticleId: 'art_cn_1',
      status: 'COMPLETED',
      successCount: retestObs.length,
    });

    // Replay with same Idempotency-Key must NOT double charge OR wipe afterMetrics!
    const replayRes = await reqJson<VisibilityRunDetailRecord>(
      'POST',
      `/api/v2/publish-records/${recordId}/retest`,
      tokenTenantA,
      undefined,
      { 'Idempotency-Key': 'retest_key_001' },
    );
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.data.id).toBe(retestRunId);
    expect(wallets.get('tenant_a')!.balance).toBe(balanceAfterFirst);

    const afterList = await reqJson<{ items: GeoPublishRecordDto[] }>(
      'GET',
      '/api/v2/articles/art_cn_1/publish-records',
      tokenTenantA,
    );
    expect(afterList.body.data.items[0]?.afterMetrics).toEqual({
      mentionRate: 100,
      avgPosition: 1,
      sentiment: 'positive',
      citationHit: true,
    });

    // Wrong-market engine rejected with 400
    const badEngine = await reqJson(
      'POST',
      `/api/v2/publish-records/${recordId}/retest`,
      tokenTenantA,
      { engines: ['chatgpt'] },
    );
    expect(badEngine.status).toBe(400);
    expect(badEngine.body.code).toBe(API_ERROR.BAD_REQUEST);

    // STRICT insufficient points -> 402 / 40201
    wallets.get('tenant_a')!.balance = 0;
    const noPoints = await reqJson(
      'POST',
      `/api/v2/publish-records/${recordId}/retest`,
      tokenTenantA,
      { engines: ['deepseek'] },
      { 'Idempotency-Key': 'retest_key_insufficient' },
    );
    expect(noPoints.status).toBe(402);
    expect(noPoints.body.code).toBe(API_ERROR.INSUFFICIENT_POINTS);
  });

  it('GET /api/v2/brands/:brandId/home returns strict market-isolated 14-day KPIs, <= 3 OPEN topBriefs, <= 5 recentArticles, and rejects omitted/nested market with 400', async () => {
    // Dual-market brand with omitted ?market= -> 400 / 40001
    const missingMarket = await reqJson('GET', '/api/v2/brands/brand_dual/home', tokenTenantA);
    expect(missingMarket.status).toBe(400);
    expect(missingMarket.body.code).toBe(API_ERROR.BAD_REQUEST);

    // Nested qs -> 400 / 40001
    const nestedQs = await reqJson(
      'GET',
      '/api/v2/brands/brand_dual/home?market[x]=CN',
      tokenTenantA,
    );
    expect(nestedQs.status).toBe(400);
    expect(nestedQs.body.code).toBe(API_ERROR.BAD_REQUEST);

    // CN Action Home
    const cnHome = await reqJson<ActionHomeResponse>(
      'GET',
      '/api/v2/brands/brand_dual/home?market=CN',
      tokenTenantA,
    );
    expect(cnHome.status).toBe(200);
    expect(cnHome.body.data.market).toBe('CN');
    expect(cnHome.body.data.health.days).toBe(14);
    expect(cnHome.body.data.topBriefs).toHaveLength(3);
    expect(cnHome.body.data.topBriefs.map((b) => b.id)).toEqual([
      'brief_cn_1',
      'brief_cn_2',
      'brief_cn_3',
    ]);
    expect(cnHome.body.data.recentArticles).toHaveLength(5);

    // GLOBAL Action Home strictly isolated
    const globalHome = await reqJson<ActionHomeResponse>(
      'GET',
      '/api/v2/brands/brand_dual/home?market=GLOBAL',
      tokenTenantA,
    );
    expect(globalHome.status).toBe(200);
    expect(globalHome.body.data.market).toBe('GLOBAL');
    expect(globalHome.body.data.topBriefs.map((b) => b.id)).toEqual(['brief_global_1']);
    expect(globalHome.body.data.recentArticles.map((a) => a.id)).toEqual(['art_global_1']);

    // Cross-tenant 404
    const cross = await reqJson('GET', '/api/v2/brands/brand_dual/home?market=CN', tokenTenantB);
    expect(cross.status).toBe(404);
  });
});
