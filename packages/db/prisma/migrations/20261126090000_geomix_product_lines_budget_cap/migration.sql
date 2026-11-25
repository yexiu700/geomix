-- GeoMix optional multi-product-line & monthly auto-retest budget soft cap migration (Batch 2 / Issue #386).
-- Strictly forward-compatible and additive on both clean databases and existing GeoMix v2.2 databases.

-- ===================== 1. Extend existing enums =====================
ALTER TYPE "RetestScheduleStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_BUDGET_CAP';

-- ===================== 2. Create BrandProductLine table =====================
CREATE TABLE IF NOT EXISTS "BrandProductLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "localNamesJson" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT NOT NULL,
    "localCategoriesJson" JSONB NOT NULL DEFAULT '{}',
    "seedPromptsJson" JSONB NOT NULL DEFAULT '{}',
    "competitorsJson" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandProductLine_pkey" PRIMARY KEY ("id")
);

-- ===================== 3. Backward-compatible column extensions =====================
ALTER TABLE "BrandMarket"
    ADD COLUMN IF NOT EXISTS "monthlyRetestPointCap" INTEGER;

ALTER TABLE "BrandFact"
    ADD COLUMN IF NOT EXISTS "productLineId" TEXT;

ALTER TABLE "VisibilityRun"
    ADD COLUMN IF NOT EXISTS "productLineId" TEXT;

ALTER TABLE "GeoBrief"
    ADD COLUMN IF NOT EXISTS "productLineId" TEXT;

ALTER TABLE "GeoArticle"
    ADD COLUMN IF NOT EXISTS "productLineId" TEXT;

-- ===================== 4. Create indexes =====================
CREATE UNIQUE INDEX IF NOT EXISTS "BrandProductLine_brandId_name_key"
    ON "BrandProductLine"("brandId", "name");

CREATE INDEX IF NOT EXISTS "BrandProductLine_tenantId_brandId_sortOrder_idx"
    ON "BrandProductLine"("tenantId", "brandId", "sortOrder");

CREATE INDEX IF NOT EXISTS "BrandFact_tenantId_brandId_productLineId_idx"
    ON "BrandFact"("tenantId", "brandId", "productLineId");

CREATE INDEX IF NOT EXISTS "VisibilityRun_tenantId_brandMarketId_productLineId_createdAt_idx"
    ON "VisibilityRun"("tenantId", "brandMarketId", "productLineId", "createdAt");

CREATE INDEX IF NOT EXISTS "GeoBrief_tenantId_brandMarketId_productLineId_status_idx"
    ON "GeoBrief"("tenantId", "brandMarketId", "productLineId", "status");

CREATE INDEX IF NOT EXISTS "GeoArticle_tenantId_brandMarketId_productLineId_status_idx"
    ON "GeoArticle"("tenantId", "brandMarketId", "productLineId", "status");

-- ===================== 5. Add foreign keys =====================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BrandProductLine_tenantId_fkey') THEN
        ALTER TABLE "BrandProductLine" ADD CONSTRAINT "BrandProductLine_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BrandProductLine_brandId_fkey') THEN
        ALTER TABLE "BrandProductLine" ADD CONSTRAINT "BrandProductLine_brandId_fkey"
            FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BrandFact_productLineId_fkey') THEN
        ALTER TABLE "BrandFact" ADD CONSTRAINT "BrandFact_productLineId_fkey"
            FOREIGN KEY ("productLineId") REFERENCES "BrandProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisibilityRun_productLineId_fkey') THEN
        ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_productLineId_fkey"
            FOREIGN KEY ("productLineId") REFERENCES "BrandProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoBrief_productLineId_fkey') THEN
        ALTER TABLE "GeoBrief" ADD CONSTRAINT "GeoBrief_productLineId_fkey"
            FOREIGN KEY ("productLineId") REFERENCES "BrandProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoArticle_productLineId_fkey') THEN
        ALTER TABLE "GeoArticle" ADD CONSTRAINT "GeoArticle_productLineId_fkey"
            FOREIGN KEY ("productLineId") REFERENCES "BrandProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
