-- GeoMix v2.2 provable ROI, L1 connectors, multi-locale & L2 extension bridge migration (Batch 0 / Issue #367).
-- Strictly forward-compatible and additive on both clean databases and existing GeoMix v2.1 databases.

-- ===================== 1. Extend existing enums =====================
ALTER TYPE "GeoBriefSource" ADD VALUE IF NOT EXISTS 'NEAR_MISS_BOOST';

ALTER TYPE "DistributionMode" ADD VALUE IF NOT EXISTS 'L2_EXTENSION';

ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'GHOST';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'DEVTO';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'HASHNODE';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'GITHUB_MDX';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'WECHAT_OFFICIAL';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'ZHIHU_EXT';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'TOUTIAO_EXT';
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'SMZDM_EXT';

-- ===================== 2. Backward-compatible column extensions =====================
ALTER TABLE "BrandMarket"
    ADD COLUMN IF NOT EXISTS "supportedLocales" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "controlPrompts" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "VisibilityObservation"
    ADD COLUMN IF NOT EXISTS "rawMetaJson" JSONB;

ALTER TABLE "GeoArticle"
    ADD COLUMN IF NOT EXISTS "targetLocale" TEXT;

ALTER TABLE "ChannelConnection"
    ADD COLUMN IF NOT EXISTS "targetLocale" TEXT,
    ADD COLUMN IF NOT EXISTS "externalShopDomain" TEXT;

ALTER TABLE "GeoDistributionTask"
    ADD COLUMN IF NOT EXISTS "targetLocale" TEXT;

ALTER TABLE "GeoRetestSchedule"
    ADD COLUMN IF NOT EXISTS "includeControlPrompts" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "controlMetricsJson" JSONB;

-- ===================== 3. Create new v2.2 tables =====================
CREATE TABLE IF NOT EXISTS "VisibilityRetrievedSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "sourceKind" "CitationSourceKind" NOT NULL DEFAULT 'OTHER',
    "wasOpened" BOOLEAN NOT NULL DEFAULT false,
    "wasCited" BOOLEAN NOT NULL DEFAULT false,
    "rank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisibilityRetrievedSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GeoRoiReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "whiteLabelOrg" TEXT,
    "summaryJson" JSONB NOT NULL,
    "shareTokenHash" TEXT,
    "shareExpiresAt" TIMESTAMP(3),
    "shareRevokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoRoiReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExtensionAccessToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['extension:distribution']::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionAccessToken_pkey" PRIMARY KEY ("id")
);

-- ===================== 4. Create indexes =====================
CREATE INDEX IF NOT EXISTS "ChannelConnection_provider_externalShopDomain_idx"
    ON "ChannelConnection"("provider", "externalShopDomain");

CREATE INDEX IF NOT EXISTS "VisibilityRetrievedSource_near_miss_lookup_idx"
    ON "VisibilityRetrievedSource"("tenantId", "brandMarketId", "wasCited", "wasOpened", "createdAt");

CREATE INDEX IF NOT EXISTS "VisibilityRetrievedSource_observationId_idx"
    ON "VisibilityRetrievedSource"("observationId");

CREATE INDEX IF NOT EXISTS "VisibilityRetrievedSource_tenantId_domain_idx"
    ON "VisibilityRetrievedSource"("tenantId", "domain");

CREATE UNIQUE INDEX IF NOT EXISTS "GeoRoiReport_shareTokenHash_key"
    ON "GeoRoiReport"("shareTokenHash");

CREATE INDEX IF NOT EXISTS "GeoRoiReport_tenantId_brandMarketId_createdAt_idx"
    ON "GeoRoiReport"("tenantId", "brandMarketId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionAccessToken_tokenHash_key"
    ON "ExtensionAccessToken"("tokenHash");

CREATE INDEX IF NOT EXISTS "ExtensionAccessToken_tenantId_revokedAt_idx"
    ON "ExtensionAccessToken"("tenantId", "revokedAt");

CREATE INDEX IF NOT EXISTS "ExtensionAccessToken_userId_createdAt_idx"
    ON "ExtensionAccessToken"("userId", "createdAt");

-- ===================== 5. Add foreign keys =====================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisibilityRetrievedSource_tenantId_fkey') THEN
        ALTER TABLE "VisibilityRetrievedSource" ADD CONSTRAINT "VisibilityRetrievedSource_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisibilityRetrievedSource_brandId_fkey') THEN
        ALTER TABLE "VisibilityRetrievedSource" ADD CONSTRAINT "VisibilityRetrievedSource_brandId_fkey"
            FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisibilityRetrievedSource_brandMarketId_fkey') THEN
        ALTER TABLE "VisibilityRetrievedSource" ADD CONSTRAINT "VisibilityRetrievedSource_brandMarketId_fkey"
            FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisibilityRetrievedSource_observationId_fkey') THEN
        ALTER TABLE "VisibilityRetrievedSource" ADD CONSTRAINT "VisibilityRetrievedSource_observationId_fkey"
            FOREIGN KEY ("observationId") REFERENCES "VisibilityObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoRoiReport_tenantId_fkey') THEN
        ALTER TABLE "GeoRoiReport" ADD CONSTRAINT "GeoRoiReport_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoRoiReport_brandId_fkey') THEN
        ALTER TABLE "GeoRoiReport" ADD CONSTRAINT "GeoRoiReport_brandId_fkey"
            FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoRoiReport_brandMarketId_fkey') THEN
        ALTER TABLE "GeoRoiReport" ADD CONSTRAINT "GeoRoiReport_brandMarketId_fkey"
            FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionAccessToken_tenantId_fkey') THEN
        ALTER TABLE "ExtensionAccessToken" ADD CONSTRAINT "ExtensionAccessToken_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
