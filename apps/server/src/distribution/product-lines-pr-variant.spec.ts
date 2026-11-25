import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BillingService } from '../billing/billing.service';
import { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import type { OutboundHttpClient } from '../infra/outbound-http';
import type { PrismaService } from '../prisma/prisma.service';
import type { GeoDeliveryService } from '../studio/geo-delivery.service';
import { runInTenant } from '../tenant/tenant-context';
import { PublicPrPacketService } from './public-pr-packet.service';
import { VariantGeneratorService } from './variant-generator.service';

const EXPECTED_PUBLIC_PR_KEYS = [
  'brandName',
  'category',
  'channelLabel',
  'draftHtml',
  'draftMarkdown',
  'expiresAt',
  'keyAngles',
  'locale',
  'market',
  'status',
  'submittedUrl',
  'suggestedTitle',
  'targetFanOuts',
  'targetPrompt',
  'verifiedFacts',
];

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

describe('Product-Line Category Pass-Through & Zero Cross-Line Bleed (VariantGenerator + PublicPrPacket)', () => {
  it('applies resolveEffectiveCategory and isolates Line B facts in BOTH sync generateVariants and async processVariantJob', async () => {
    const createdTasks: Array<Record<string, unknown>> = [];
    const articleRow = {
      id: 'art_lineA',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      productLineId: 'pl_lineA',
      productLine: {
        id: 'pl_lineA',
        name: '星曜储能系列',
        localNamesJson: { GLOBAL: 'HeliosPower' },
        category: '便携储能电源',
        localCategoriesJson: { GLOBAL: 'Portable Power Station' },
        competitorsJson: {
          GLOBAL: [{ name: 'Jackery', aliases: [], domains: ['jackery.example'] }],
        },
      },
      title: 'HeliosPower 2048Wh Field Test',
      targetPrompt: 'Best portable power station for off-grid camping',
      targetLocale: 'en-US',
      contentMarkdown:
        '## Overview\n\nHeliosPower delivers 2048Wh LiFePO4 capacity with 2400W AC output.\n\n## FAQ\n**Q: Output?**\nA: 2400W continuous.',
      schemaJsonLd: {},
      llmsTxtSnippet: null,
      geoScore: 88,
      complianceFlags: [],
      brand: {
        id: 'brand_a',
        name: 'NovaTech',
        category: '智能硬件',
      },
      brandMarket: {
        id: 'bm_global',
        market: 'GLOBAL',
        locale: 'en-US',
        supportedLocales: ['en-US'],
        localBrandName: 'NovaTech',
        localCategory: 'Smart Hardware',
        aliases: ['Nova'],
        ownedDomains: ['novatech.example'],
        competitors: [{ name: 'GenericComp', aliases: [], domains: ['generic.example'] }],
      },
      brief: {
        id: 'brief_lineA',
        targetFanOuts: ['2048Wh runtime'],
        competitorFocus: [],
        matchedFactIds: ['fact_lineA', 'fact_general'],
        recommendedChannels: [],
      },
    };

    const allFacts = [
      {
        id: 'fact_general',
        slot: 'CREDENTIALS',
        title: 'Brand Cert',
        content: 'UL2743 and ISO9001 certified',
        productLineId: null,
      },
      {
        id: 'fact_lineA',
        slot: 'PRODUCT_SPECS',
        title: 'HeliosPower Specs',
        content: '2048Wh LiFePO4 battery with 2400W output',
        productLineId: 'pl_lineA',
      },
      {
        id: 'fact_lineB',
        slot: 'PRODUCT_SPECS',
        title: 'Home NAS Specs',
        content: 'LINEB_SECRET_HOME_NAS_4BAY_NEVER_LEAK',
        productLineId: 'pl_lineB',
      },
    ];

    const jobRow = {
      id: 'vj_1',
      tenantId: 'tenant_a',
      articleId: 'art_lineA',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      idempotencyKey: 'async_key_1',
      status: 'QUEUED',
      unitPrice: 0,
      reservationId: null,
      targetsJson: [
        {
          provider: 'PR_PACKET',
          channelLabel: 'Tech Press PR',
        },
      ],
      taskIds: [],
      failuresJson: [],
      doneCount: 0,
      failCount: 0,
      total: 1,
    };

    const scoped = {
      geoArticle: {
        findFirst: vi.fn(async () => articleRow),
      },
      brandFact: {
        findMany: vi.fn(async () => allFacts),
      },
      promptPreference: {
        findFirst: vi.fn(async () => null),
      },
      channelConnection: {
        findMany: vi.fn(async () => []),
      },
      geoDistributionTask: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const row = {
            ...args.data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          createdTasks.push(row);
          return row;
        }),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
          const row = {
            ...args.create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          createdTasks.push(row);
          return row;
        }),
      },
      geoVariantJob: {
        findFirst: vi.fn(async () => jobRow),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => jobRow),
      },
    };

    const prisma = { scoped, base: scoped } as unknown as PrismaService;
    const billing = {
      unitPrice: vi.fn(async () => 0),
    } as unknown as BillingService;
    const llm = LlmService.fromEnv({ LLM_PROVIDER: 'fake', ALLOW_FAKE_OUTPUT: 'true' });
    const compliance = new ComplianceService();
    const service = new VariantGeneratorService(prisma, billing, llm, compliance);

    // 1. Sync path: generateVariants
    const syncRes = await runInTenant('tenant_a', () =>
      service.generateVariants(
        'art_lineA',
        {
          targets: [{ provider: 'PR_PACKET', channelLabel: 'Tech Press PR' }],
        },
        { tenantId: 'tenant_a', userId: 'user_a' },
      ),
    );

    expect(syncRes.tasks).toHaveLength(1);
    const syncExtras = syncRes.tasks[0]!.variantExtrasJson as {
      factSheet?: { category?: string; verifiedFacts?: Array<{ title: string; summary: string }> };
    };
    expect(syncExtras.factSheet?.category).toBe('Portable Power Station');
    expect(JSON.stringify(syncExtras.factSheet)).not.toContain('Home NAS');
    expect(JSON.stringify(syncExtras.factSheet)).not.toContain('LINEB_SECRET');
    expect(syncExtras.factSheet?.verifiedFacts?.[0]?.title).toBe('HeliosPower Specs');

    // 2. Async path: processVariantJob
    createdTasks.length = 0;
    await service.processVariantJob('tenant_a', 'vj_1');
    expect(createdTasks).toHaveLength(1);
    const asyncExtras = createdTasks[0]!.variantExtrasJson as {
      factSheet?: { category?: string; verifiedFacts?: Array<{ title: string; summary: string }> };
    };
    expect(asyncExtras.factSheet?.category).toBe('Portable Power Station');
    expect(JSON.stringify(asyncExtras.factSheet)).not.toContain('Home NAS');
    expect(JSON.stringify(asyncExtras.factSheet)).not.toContain('LINEB_SECRET');
    expect(asyncExtras.factSheet?.verifiedFacts?.[0]?.title).toBe('HeliosPower Specs');
  });

  it('PublicPrPacketService uses resolveEffectiveCategory, isolates fallback facts, and enforces exact 15-key whitelist without productLineId', async () => {
    const rawToken = 'pr_token_line_isolation_test_1234567890abcdef';
    const tokenHash = sha256(rawToken);
    const future = new Date(Date.now() + 86_400_000 * 14);

    const taskRow = {
      id: 'task_pr_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_lineA',
      provider: 'PR_PACKET',
      channelLabel: 'Tech Review Press',
      variantTitle: 'HeliosPower 2048Wh Press Kit',
      variantMarkdown: '## Key Specs\n\n2048Wh LiFePO4 battery.',
      variantHtml: '<h2>Key Specs</h2><p>2048Wh LiFePO4 battery.</p>',
      variantExtrasJson: {
        // Deliberately omit verifiedFacts and set parent category to verify resolveEffectiveCategory + fallback isolation
        factSheet: {
          brandName: 'NovaTech',
          category: 'Smart Hardware',
          targetPrompt: 'Best portable power station 2026',
          targetFanOuts: ['2048Wh'],
          keyAngles: ['2400W output'],
          verifiedFacts: [],
        },
      },
      status: 'READY_TO_PUBLISH',
      remotePublishedUrl: null,
      shareTokenHash: tokenHash,
      shareExpiresAt: future,
      shareRevokedAt: null,
      brand: {
        name: 'NovaTech',
        category: '智能硬件',
        facts: [
          {
            title: 'Brand Cert',
            content: 'UL2743 certified',
            productLineId: null,
          },
          {
            title: 'Home NAS Secret',
            content: 'Home NAS LINEB_VECTOR_SECRET 4-bay',
            productLineId: 'pl_lineB',
          },
          {
            title: 'HeliosPower Specs',
            content: '2048Wh LiFePO4 battery rated 3000 cycles',
            productLineId: 'pl_lineA',
          },
        ],
      },
      brandMarket: {
        market: 'GLOBAL',
        locale: 'en-US',
        localBrandName: 'NovaTech',
        localCategory: 'Smart Hardware',
      },
      article: {
        targetPrompt: 'Best portable power station 2026',
        productLineId: 'pl_lineA',
        productLine: {
          category: '便携储能电源',
          localCategoriesJson: { GLOBAL: 'Portable Power Station' },
        },
        brief: {
          targetFanOuts: ['2048Wh'],
          outlineH2: [],
        },
      },
      publishRecords: [],
    };

    const prisma = {
      base: {
        geoDistributionTask: {
          findUnique: vi.fn(async () => ({
            id: taskRow.id,
            tenantId: taskRow.tenantId,
            shareTokenHash: tokenHash,
            shareExpiresAt: taskRow.shareExpiresAt,
            shareRevokedAt: null,
            status: taskRow.status,
          })),
        },
      },
      scoped: {
        geoDistributionTask: {
          findFirst: vi.fn(async () => taskRow),
        },
      },
    } as unknown as PrismaService;

    const service = new PublicPrPacketService(
      prisma,
      {} as unknown as OutboundHttpClient,
      {} as unknown as GeoDeliveryService,
    );
    const packet = await service.getPacket(rawToken, '127.0.0.1');

    expect(Object.keys(packet).sort()).toEqual(EXPECTED_PUBLIC_PR_KEYS);
    expect(Object.keys(packet)).toHaveLength(15);
    expect('productLineId' in packet).toBe(false);
    expect(packet.category).toBe('Portable Power Station');
    expect(packet.verifiedFacts.map((f) => f.title)).toEqual(['HeliosPower Specs', 'Brand Cert']);
    expect(JSON.stringify(packet)).not.toContain('Home NAS');
    expect(JSON.stringify(packet)).not.toContain('LINEB_VECTOR_SECRET');
  });

  it('never whitelists Chinese productLine.name or CJK localNamesJson.GLOBAL on GLOBAL variants (blocks CJK leakage)', async () => {
    const articleRow = {
      id: 'art_cjk_guard',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      productLineId: 'pl_nas',
      productLine: {
        id: 'pl_nas',
        name: '家用NAS线',
        localNamesJson: { GLOBAL: '中文海外名' },
        category: '家庭 NAS',
        localCategoriesJson: { GLOBAL: 'Home NAS' },
        competitorsJson: { GLOBAL: [] },
      },
      title: 'NovaNAS 4-Bay Review',
      targetPrompt: 'Best quiet home NAS 2026',
      targetLocale: 'en-US',
      contentMarkdown: '## Overview\n\nNovaNAS delivers 28dB acoustic performance.',
      schemaJsonLd: {},
      llmsTxtSnippet: null,
      geoScore: 86,
      complianceFlags: [],
      brand: {
        id: 'brand_a',
        name: 'NovaTech',
        category: 'Smart Hardware',
      },
      brandMarket: {
        id: 'bm_global',
        market: 'GLOBAL',
        locale: 'en-US',
        supportedLocales: ['en-US'],
        localBrandName: 'NovaTech',
        localCategory: 'Smart Hardware',
        aliases: ['Nova'],
        ownedDomains: ['novatech.example'],
        competitors: [],
      },
      brief: {
        id: 'brief_nas',
        targetFanOuts: ['28dB noise'],
        competitorFocus: [],
        matchedFactIds: [],
        recommendedChannels: [],
      },
    };

    const scoped = {
      geoArticle: { findFirst: vi.fn(async () => articleRow) },
      brandFact: { findMany: vi.fn(async () => []) },
      promptPreference: { findFirst: vi.fn(async () => null) },
      channelConnection: { findMany: vi.fn(async () => []) },
      geoDistributionTask: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => args.create),
      },
    };

    const prisma = { scoped, base: scoped } as unknown as PrismaService;
    const billing = { unitPrice: vi.fn(async () => 0) } as unknown as BillingService;
    const llm = {
      usesFakePrimary: () => false,
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          variantTitle: 'NovaTech 家用NAS线 Review',
          variantSlug: 'novatech-home-nas-review',
          variantMetaDesc: 'Quiet 4-bay NAS overview for home offices.',
          variantMarkdown:
            '## Overview\n\nNovaTech 家用NAS线 and 中文海外名 deliver 28dB acoustic performance.',
          tags: ['home-nas'],
        }),
        model: 'mock-live-model',
        tokensIn: 100,
        tokensOut: 100,
        fake: false,
      })),
    } as unknown as LlmService;
    const compliance = new ComplianceService();
    const service = new VariantGeneratorService(prisma, billing, llm, compliance);

    await expect(
      runInTenant('tenant_a', () =>
        service.generateVariants(
          'art_cjk_guard',
          { targets: [{ provider: 'WORDPRESS', channelLabel: 'Official Blog' }] },
          { tenantId: 'tenant_a', userId: 'user_a' },
        ),
      ),
    ).rejects.toThrow(/中文|CJK|语种|泄漏|语言/);
  });
});
