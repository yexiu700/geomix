-- GeoMix v2.1 distribution & retest scheduling schema migration (Batch 0 / Issue #349).
-- Strictly forward-compatible on both clean databases and existing GeoMix 2.0 databases.

-- ===================== 1. Create new enums =====================
CREATE TYPE "ChannelProvider" AS ENUM (
    'SHOPIFY',
    'WORDPRESS',
    'WEBFLOW',
    'WEBHOOK',
    'REDDIT_ASSIST',
    'QUORA_ASSIST',
    'SOCIAL_THREAD_ASSIST',
    'PR_PACKET',
    'CN_COMMUNITY_ASSIST'
);

CREATE TYPE "ChannelConnectionStatus" AS ENUM ('ACTIVE', 'INVALID', 'DISABLED');

CREATE TYPE "DistributionMode" AS ENUM ('L1_API', 'L3_COMMUNITY_ASSIST', 'L3_PR_PACKET');

CREATE TYPE "DistributionTaskStatus" AS ENUM (
    'DRAFT_VARIANT',
    'READY_TO_PUBLISH',
    'PUBLISHING',
    'DRAFT_PUSHED',
    'PUBLISHED',
    'FAILED',
    'ARCHIVED'
);

CREATE TYPE "CrawlProbeStatus" AS ENUM ('PENDING', 'OK', 'WARNING', 'BLOCKED', 'FAILED');

CREATE TYPE "RetestScheduleStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'SKIPPED_INSUFFICIENT_POINTS',
    'SKIPPED_NO_ENGINE',
    'FAILED',
    'CANCELLED'
);

-- ===================== 2. Create new v2.1 tables =====================
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "provider" "ChannelProvider" NOT NULL,
    "displayName" TEXT NOT NULL,
    "siteBaseUrl" TEXT NOT NULL,
    "credentialsCiphertext" TEXT NOT NULL,
    "credentialsIv" TEXT NOT NULL,
    "credentialsTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "credentialHint" TEXT NOT NULL,
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastTestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'API_KEY',
    "oauthAccessTokenCiphertext" TEXT,
    "oauthExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GeoDistributionTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" "ChannelProvider" NOT NULL,
    "mode" "DistributionMode" NOT NULL,
    "channelLabel" TEXT NOT NULL,
    "targetUrlHint" TEXT,
    "variantTitle" TEXT NOT NULL,
    "variantSlug" TEXT,
    "variantMetaDesc" TEXT,
    "variantMarkdown" TEXT NOT NULL,
    "variantHtml" TEXT NOT NULL,
    "variantExtrasJson" JSONB NOT NULL DEFAULT '{}',
    "preflightJson" JSONB,
    "status" "DistributionTaskStatus" NOT NULL DEFAULT 'DRAFT_VARIANT',
    "publishAsDraft" BOOLEAN NOT NULL DEFAULT true,
    "remotePostId" TEXT,
    "remoteAdminUrl" TEXT,
    "remotePublishedUrl" TEXT,
    "indexNowStatus" TEXT,
    "lastError" TEXT,
    "shareTokenHash" TEXT,
    "shareExpiresAt" TIMESTAMP(3),
    "shareRevokedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoDistributionTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GeoRetestSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "publishRecordId" TEXT NOT NULL,
    "milestoneDay" INTEGER NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 1,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "RetestScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "visibilityRunId" TEXT,
    "metricsSnapshotJson" JSONB,
    "skipReason" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoRetestSchedule_pkey" PRIMARY KEY ("id")
);

-- ===================== 3. Backward-compatible column extensions =====================
ALTER TABLE "GeoPublishRecord"
    ADD COLUMN IF NOT EXISTS "distributionTaskId" TEXT,
    ADD COLUMN IF NOT EXISTS "crawlStatus" "CrawlProbeStatus" NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS "crawlCheckedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "crawlReportJson" JSONB,
    ADD COLUMN IF NOT EXISTS "indexNowSubmitted" BOOLEAN NOT NULL DEFAULT false;

-- Support sampleCount = 1 | 3 per retest run without losing existing v2.0 rows (default 1).
ALTER TABLE "VisibilityObservation"
    ADD COLUMN IF NOT EXISTS "sampleIndex" INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS "VisibilityObservation_runId_promptText_engine_key";
CREATE UNIQUE INDEX "VisibilityObservation_runId_promptText_engine_sampleIndex_key"
    ON "VisibilityObservation"("runId", "promptText", "engine", "sampleIndex");

-- ===================== 4. Create indexes =====================
CREATE INDEX "ChannelConnection_tenantId_brandMarketId_provider_idx" ON "ChannelConnection"("tenantId", "brandMarketId", "provider");
CREATE INDEX "ChannelConnection_tenantId_brandId_idx" ON "ChannelConnection"("tenantId", "brandId");

CREATE UNIQUE INDEX "GeoDistributionTask_shareTokenHash_key" ON "GeoDistributionTask"("shareTokenHash");
CREATE INDEX "GeoDistributionTask_tenantId_articleId_createdAt_idx" ON "GeoDistributionTask"("tenantId", "articleId", "createdAt");
CREATE INDEX "GeoDistributionTask_tenantId_brandMarketId_status_idx" ON "GeoDistributionTask"("tenantId", "brandMarketId", "status");
CREATE INDEX "GeoDistributionTask_connectionId_idx" ON "GeoDistributionTask"("connectionId");

CREATE UNIQUE INDEX "GeoRetestSchedule_publishRecordId_milestoneDay_key" ON "GeoRetestSchedule"("publishRecordId", "milestoneDay");
CREATE INDEX "GeoRetestSchedule_status_dueAt_idx" ON "GeoRetestSchedule"("status", "dueAt");
CREATE INDEX "GeoRetestSchedule_tenantId_brandMarketId_status_idx" ON "GeoRetestSchedule"("tenantId", "brandMarketId", "status");
CREATE INDEX "GeoRetestSchedule_visibilityRunId_idx" ON "GeoRetestSchedule"("visibilityRunId");

CREATE INDEX "GeoPublishRecord_distributionTaskId_idx" ON "GeoPublishRecord"("distributionTaskId");
CREATE INDEX "GeoPublishRecord_crawlStatus_publishedAt_idx" ON "GeoPublishRecord"("crawlStatus", "publishedAt");

-- ===================== 5. Add foreign keys =====================
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeoDistributionTask" ADD CONSTRAINT "GeoDistributionTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoDistributionTask" ADD CONSTRAINT "GeoDistributionTask_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoDistributionTask" ADD CONSTRAINT "GeoDistributionTask_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoDistributionTask" ADD CONSTRAINT "GeoDistributionTask_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "GeoArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoDistributionTask" ADD CONSTRAINT "GeoDistributionTask_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GeoRetestSchedule" ADD CONSTRAINT "GeoRetestSchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoRetestSchedule" ADD CONSTRAINT "GeoRetestSchedule_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoRetestSchedule" ADD CONSTRAINT "GeoRetestSchedule_brandMarketId_fkey" FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoRetestSchedule" ADD CONSTRAINT "GeoRetestSchedule_publishRecordId_fkey" FOREIGN KEY ("publishRecordId") REFERENCES "GeoPublishRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GeoPublishRecord" ADD CONSTRAINT "GeoPublishRecord_distributionTaskId_fkey" FOREIGN KEY ("distributionTaskId") REFERENCES "GeoDistributionTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===================== 6. Sync v2.1 PricingItem default =====================
-- Production CD runs `prisma:migrate` without `db:seed`; insert idempotently (preserving admin overrides).
INSERT INTO "PricingItem" ("action", "unitPoints", "enabled", "updatedAt")
VALUES ('geo_variant', 2, true, CURRENT_TIMESTAMP)
ON CONFLICT ("action") DO NOTHING;
