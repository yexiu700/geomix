-- GeoMix 2.0 domain schema migration (Batch 0 / Issue #326).
-- Drops 17 obsolete v1 tables + 8 obsolete enums, recreates Visibility tables
-- bound to Brand + BrandMarket, and creates the 10 new v2 domain models with
-- pgvector(1024) HNSW index (pgvector extension is already installed in init).

-- ===================== 1. Drop obsolete tables & recreate Visibility =====================
DROP TABLE IF EXISTS "VisibilityCitation" CASCADE;
DROP TABLE IF EXISTS "VisibilityObservation" CASCADE;
DROP TABLE IF EXISTS "VisibilityRun" CASCADE;
DROP TABLE IF EXISTS "VisibilityProfile" CASCADE;
DROP TABLE IF EXISTS "AiTaskItem" CASCADE;
DROP TABLE IF EXISTS "RewriteRecord" CASCADE;
DROP TABLE IF EXISTS "RewriteBatch" CASCADE;
DROP TABLE IF EXISTS "Article" CASCADE;
DROP TABLE IF EXISTS "AiTask" CASCADE;
DROP TABLE IF EXISTS "ArticleCategory" CASCADE;
DROP TABLE IF EXISTS "PromptTemplate" CASCADE;
DROP TABLE IF EXISTS "KnowledgeChunk" CASCADE;
DROP TABLE IF EXISTS "KnowledgeBase" CASCADE;
DROP TABLE IF EXISTS "MediaAsset" CASCADE;
DROP TABLE IF EXISTS "AiImageJob" CASCADE;
DROP TABLE IF EXISTS "MediaCategory" CASCADE;
DROP TABLE IF EXISTS "Question" CASCADE;
DROP TABLE IF EXISTS "Keyword" CASCADE;
DROP TABLE IF EXISTS "AgreementSignature" CASCADE;
DROP TABLE IF EXISTS "CrudSample" CASCADE;

-- ===================== 2. Drop obsolete enums =====================
DROP TYPE IF EXISTS "KeywordOptStatus";
DROP TYPE IF EXISTS "QuestionSource";
DROP TYPE IF EXISTS "KbMode";
DROP TYPE IF EXISTS "KbIndexStatus";
DROP TYPE IF EXISTS "PromptKind";
DROP TYPE IF EXISTS "ArticleStatus";
DROP TYPE IF EXISTS "ArticleSource";
DROP TYPE IF EXISTS "MediaOrigin";

-- ===================== 3. Create new enums =====================
CREATE TYPE "GeoMarket" AS ENUM ('CN', 'GLOBAL');

CREATE TYPE "BrandFactSlot" AS ENUM ('PRODUCT_SPECS', 'DIFFERENTIATORS', 'CREDENTIALS', 'CASE_STUDIES', 'EXTRA_DOC');

CREATE TYPE "FactSourceType" AS ENUM ('MANUAL', 'URL_EXTRACT', 'DOC_UPLOAD', 'STUDIO_FEEDBACK');

CREATE TYPE "FactIndexStatus" AS ENUM ('NONE', 'INDEXING', 'READY', 'FAILED');

CREATE TYPE "BrandMediaOrigin" AS ENUM ('PRODUCT_UPLOAD', 'AI_INLINE_GEN');

CREATE TYPE "VisibilityTriggerType" AS ENUM ('MANUAL', 'RETEST');

CREATE TYPE "GeoBriefSource" AS ENUM ('AUTO_GAP', 'LOW_RANK', 'SENTIMENT_RISK', 'FANOUT_CLUSTER', 'CITATION_COUNTER', 'MANUAL');

CREATE TYPE "GeoRecipe" AS ENUM ('AUTHORITY_GUIDE', 'COMPARISON_MATRIX', 'OBJECTION_FAQ', 'CITATION_COUNTER');

CREATE TYPE "GeoTargetFormat" AS ENUM ('CN_DEEP_REVIEW', 'CN_COMMUNITY_QA', 'GLOBAL_AUTHORITY_GUIDE', 'GLOBAL_COMMUNITY_DISCUSSION');

CREATE TYPE "GeoBriefStatus" AS ENUM ('OPEN', 'WRITING', 'DONE', 'DISMISSED');

CREATE TYPE "GeoArticleStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHED');

CREATE TYPE "CitationSourceKind" AS ENUM ('OWNED', 'COMPETITOR', 'SOCIAL', 'AUTHORITY', 'ECOMMERCE', 'OTHER');

-- ===================== 4. Create new & refactored tables =====================
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "truthAgreementSignedAt" TIMESTAMP(3),
    "truthAgreementIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandMarket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "market" "GeoMarket" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "region" TEXT NOT NULL DEFAULT 'CN',
    "localBrandName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitors" JSONB NOT NULL DEFAULT '[]',
    "seedPrompts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandMarket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandFact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "slot" "BrandFactSlot" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceType" "FactSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "indexStatus" "FactIndexStatus" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandFact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandFactChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),

    CONSTRAINT "BrandFactChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandMediaAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "origin" "BrandMediaOrigin" NOT NULL DEFAULT 'PRODUCT_UPLOAD',
    "title" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "thumbKey" TEXT,
    "url" TEXT NOT NULL,
    "thumbUrl" TEXT,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "aiPrompt" TEXT,
    "aiModel" TEXT,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandMediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VisibilityRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prompts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerType" "VisibilityTriggerType" NOT NULL DEFAULT 'MANUAL',
    "retestArticleId" TEXT,
    "briefsGeneratedAt" TIMESTAMP(3),
    "totalChecks" INTEGER NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL,
    "reservationId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "VisibilityRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VisibilityObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "collectorKind" TEXT NOT NULL DEFAULT 'fake',
    "answerText" TEXT,
    "brandMentioned" BOOLEAN NOT NULL DEFAULT false,
    "brandPosition" INTEGER,
    "brandSentiment" TEXT,
    "brandPassage" TEXT,
    "competitorHits" JSONB,
    "fanOutQueries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "judgeModel" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisibilityObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VisibilityCitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "sourceKind" "CitationSourceKind" NOT NULL DEFAULT 'OTHER',
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisibilityCitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GeoBrief" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "sourceType" "GeoBriefSource" NOT NULL,
    "sourceRunId" TEXT,
    "sourceObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceCitationUrl" TEXT,
    "targetPrompt" TEXT NOT NULL,
    "priorityScore" INTEGER NOT NULL DEFAULT 50,
    "diagnosisSummary" TEXT NOT NULL,
    "recommendedRecipe" "GeoRecipe" NOT NULL,
    "targetFormat" "GeoTargetFormat" NOT NULL,
    "suggestedTitle" TEXT NOT NULL,
    "outlineH2" JSONB NOT NULL DEFAULT '[]',
    "targetFanOuts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitorFocus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedFactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingFactHints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendedChannels" JSONB NOT NULL DEFAULT '[]',
    "status" "GeoBriefStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoBrief_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GeoArticle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "briefId" TEXT,
    "batchJobId" TEXT,
    "recipe" "GeoRecipe" NOT NULL,
    "targetFormat" "GeoTargetFormat" NOT NULL,
    "title" TEXT NOT NULL,
    "targetPrompt" TEXT NOT NULL,
    "outlineJson" JSONB NOT NULL DEFAULT '[]',
    "contentMarkdown" TEXT NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "schemaJsonLd" JSONB NOT NULL DEFAULT '{}',
    "llmsTxtSnippet" TEXT,
    "geoScore" INTEGER NOT NULL DEFAULT 0,
    "geoScoreDetail" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "GeoArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "complianceFlags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoArticle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GeoPublishRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "publishedUrl" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "baselineRunId" TEXT,
    "latestRetestRunId" TEXT,
    "beforeMetrics" JSONB,
    "afterMetrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoPublishRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GeoBatchJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "briefIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total" INTEGER NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL,
    "reservationId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GeoBatchJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PromptPreference" (
    "tenantId" TEXT NOT NULL,
    "customToneNote" TEXT,
    "customForbiddenWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipeOverrides" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptPreference_pkey" PRIMARY KEY ("tenantId")
);

-- ===================== 5. Create indexes =====================
CREATE UNIQUE INDEX "Brand_tenantId_name_key" ON "Brand"("tenantId", "name");
CREATE INDEX "Brand_tenantId_createdAt_idx" ON "Brand"("tenantId", "createdAt");

CREATE UNIQUE INDEX "BrandMarket_brandId_market_key" ON "BrandMarket"("brandId", "market");
CREATE INDEX "BrandMarket_tenantId_brandId_idx" ON "BrandMarket"("tenantId", "brandId");
CREATE INDEX "BrandMarket_tenantId_market_idx" ON "BrandMarket"("tenantId", "market");

CREATE INDEX "BrandFact_tenantId_brandId_slot_idx" ON "BrandFact"("tenantId", "brandId", "slot");
CREATE INDEX "BrandFact_brandId_indexStatus_idx" ON "BrandFact"("brandId", "indexStatus");

CREATE UNIQUE INDEX "BrandFactChunk_factId_seq_key" ON "BrandFactChunk"("factId", "seq");
CREATE INDEX "BrandFactChunk_tenantId_brandId_idx" ON "BrandFactChunk"("tenantId", "brandId");
CREATE INDEX IF NOT EXISTS idx_brand_fact_chunk_embedding ON "BrandFactChunk"
    USING hnsw (embedding vector_cosine_ops);

CREATE UNIQUE INDEX "BrandMediaAsset_objectKey_key" ON "BrandMediaAsset"("objectKey");
CREATE INDEX "BrandMediaAsset_tenantId_brandId_createdAt_idx" ON "BrandMediaAsset"("tenantId", "brandId", "createdAt");
CREATE INDEX "BrandMediaAsset_tenantId_brandId_origin_idx" ON "BrandMediaAsset"("tenantId", "brandId", "origin");

CREATE INDEX "VisibilityRun_tenantId_status_createdAt_idx" ON "VisibilityRun"("tenantId", "status", "createdAt");
CREATE INDEX "VisibilityRun_tenantId_brandMarketId_createdAt_idx" ON "VisibilityRun"("tenantId", "brandMarketId", "createdAt");
CREATE INDEX "VisibilityRun_tenantId_brandId_createdAt_idx" ON "VisibilityRun"("tenantId", "brandId", "createdAt");
CREATE INDEX "VisibilityRun_retestArticleId_idx" ON "VisibilityRun"("retestArticleId");

CREATE UNIQUE INDEX "VisibilityObservation_runId_promptText_engine_key" ON "VisibilityObservation"("runId", "promptText", "engine");
CREATE INDEX "VisibilityObservation_tenantId_brandMarketId_checkedAt_idx" ON "VisibilityObservation"("tenantId", "brandMarketId", "checkedAt");
CREATE INDEX "VisibilityObservation_tenantId_brandId_checkedAt_idx" ON "VisibilityObservation"("tenantId", "brandId", "checkedAt");
CREATE INDEX "VisibilityObservation_tenantId_engine_brandMentioned_idx" ON "VisibilityObservation"("tenantId", "engine", "brandMentioned");

CREATE INDEX "VisibilityCitation_tenantId_domain_sourceKind_idx" ON "VisibilityCitation"("tenantId", "domain", "sourceKind");
CREATE INDEX "VisibilityCitation_observationId_position_idx" ON "VisibilityCitation"("observationId", "position");

CREATE INDEX "GeoBrief_tenantId_brandMarketId_status_priorityScore_idx" ON "GeoBrief"("tenantId", "brandMarketId", "status", "priorityScore");
CREATE INDEX "GeoBrief_tenantId_brandId_createdAt_idx" ON "GeoBrief"("tenantId", "brandId", "createdAt");
CREATE INDEX "GeoBrief_sourceRunId_idx" ON "GeoBrief"("sourceRunId");

CREATE INDEX "GeoArticle_tenantId_brandMarketId_status_createdAt_idx" ON "GeoArticle"("tenantId", "brandMarketId", "status", "createdAt");
CREATE INDEX "GeoArticle_tenantId_brandId_createdAt_idx" ON "GeoArticle"("tenantId", "brandId", "createdAt");
CREATE INDEX "GeoArticle_tenantId_createdAt_idx" ON "GeoArticle"("tenantId", "createdAt");
CREATE INDEX "GeoArticle_briefId_idx" ON "GeoArticle"("briefId");
CREATE INDEX "GeoArticle_batchJobId_idx" ON "GeoArticle"("batchJobId");

CREATE INDEX "GeoPublishRecord_tenantId_brandMarketId_publishedAt_idx" ON "GeoPublishRecord"("tenantId", "brandMarketId", "publishedAt");
CREATE INDEX "GeoPublishRecord_tenantId_articleId_createdAt_idx" ON "GeoPublishRecord"("tenantId", "articleId", "createdAt");
CREATE INDEX "GeoPublishRecord_latestRetestRunId_idx" ON "GeoPublishRecord"("latestRetestRunId");

CREATE INDEX "GeoBatchJob_tenantId_brandMarketId_createdAt_idx" ON "GeoBatchJob"("tenantId", "brandMarketId", "createdAt");
CREATE INDEX "GeoBatchJob_tenantId_status_createdAt_idx" ON "GeoBatchJob"("tenantId", "status", "createdAt");

-- ===================== 6. Add foreign keys =====================
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandMarket" ADD CONSTRAINT "BrandMarket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandMarket" ADD CONSTRAINT "BrandMarket_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandFact" ADD CONSTRAINT "BrandFact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandFact" ADD CONSTRAINT "BrandFact_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandFactChunk" ADD CONSTRAINT "BrandFactChunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandFactChunk" ADD CONSTRAINT "BrandFactChunk_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandFactChunk" ADD CONSTRAINT "BrandFactChunk_factId_fkey" FOREIGN KEY ("factId") REFERENCES "BrandFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandMediaAsset" ADD CONSTRAINT "BrandMediaAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandMediaAsset" ADD CONSTRAINT "BrandMediaAsset_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VisibilityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisibilityCitation" ADD CONSTRAINT "VisibilityCitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityCitation" ADD CONSTRAINT "VisibilityCitation_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "VisibilityObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeoBrief" ADD CONSTRAINT "GeoBrief_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBrief" ADD CONSTRAINT "GeoBrief_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBrief" ADD CONSTRAINT "GeoBrief_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBrief" ADD CONSTRAINT "GeoBrief_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "VisibilityRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GeoArticle" ADD CONSTRAINT "GeoArticle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoArticle" ADD CONSTRAINT "GeoArticle_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoArticle" ADD CONSTRAINT "GeoArticle_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoArticle" ADD CONSTRAINT "GeoArticle_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "GeoBrief"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeoArticle" ADD CONSTRAINT "GeoArticle_batchJobId_fkey" FOREIGN KEY ("batchJobId") REFERENCES "GeoBatchJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GeoPublishRecord" ADD CONSTRAINT "GeoPublishRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoPublishRecord" ADD CONSTRAINT "GeoPublishRecord_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoPublishRecord" ADD CONSTRAINT "GeoPublishRecord_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoPublishRecord" ADD CONSTRAINT "GeoPublishRecord_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "GeoArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeoBatchJob" ADD CONSTRAINT "GeoBatchJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBatchJob" ADD CONSTRAINT "GeoBatchJob_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBatchJob" ADD CONSTRAINT "GeoBatchJob_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromptPreference" ADD CONSTRAINT "PromptPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===================== 7. Sync v2 PricingItem rows =====================
-- Production CD (`docker-compose.prod.yml:94`) runs `prisma:migrate` without `db:seed`.
-- Delete obsolete v1 actions and seed v2 defaults idempotently (preserving admin overrides).
DELETE FROM "PricingItem"
WHERE "action" IN ('distill', 'ai_write', 'kb_addon', 'rewrite_single', 'rewrite_batch', 'image_gen');

INSERT INTO "PricingItem" ("action", "unitPoints", "enabled", "updatedAt")
VALUES
  ('geo_write', 10, true, CURRENT_TIMESTAMP),
  ('visibility_check', 2, true, CURRENT_TIMESTAMP),
  ('inline_image_gen', 5, true, CURRENT_TIMESTAMP)
ON CONFLICT ("action") DO NOTHING;
