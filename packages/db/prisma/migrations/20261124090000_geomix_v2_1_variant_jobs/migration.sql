-- GeoMix v2.1 async variant generation job table (Issue #363).
-- Strictly forward-compatible and additive migration.

CREATE TABLE IF NOT EXISTS "GeoVariantJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandMarketId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "targetsJson" JSONB NOT NULL DEFAULT '[]',
    "total" INTEGER NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL,
    "totalChargedPoints" INTEGER NOT NULL DEFAULT 0,
    "refundedCount" INTEGER NOT NULL DEFAULT 0,
    "refundedPoints" INTEGER NOT NULL DEFAULT 0,
    "billingMode" TEXT NOT NULL DEFAULT 'SHADOW',
    "reservationId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "taskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failuresJson" JSONB NOT NULL DEFAULT '[]',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GeoVariantJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GeoVariantJob_tenantId_articleId_createdAt_idx"
    ON "GeoVariantJob"("tenantId", "articleId", "createdAt");

CREATE INDEX IF NOT EXISTS "GeoVariantJob_tenantId_articleId_status_idx"
    ON "GeoVariantJob"("tenantId", "articleId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "GeoVariantJob_tenantId_articleId_idempotencyKey_key"
    ON "GeoVariantJob"("tenantId", "articleId", "idempotencyKey");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoVariantJob_tenantId_fkey') THEN
        ALTER TABLE "GeoVariantJob" ADD CONSTRAINT "GeoVariantJob_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoVariantJob_brandId_fkey') THEN
        ALTER TABLE "GeoVariantJob" ADD CONSTRAINT "GeoVariantJob_brandId_fkey"
            FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoVariantJob_brandMarketId_fkey') THEN
        ALTER TABLE "GeoVariantJob" ADD CONSTRAINT "GeoVariantJob_brandMarketId_fkey"
            FOREIGN KEY ("brandMarketId") REFERENCES "BrandMarket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeoVariantJob_articleId_fkey') THEN
        ALTER TABLE "GeoVariantJob" ADD CONSTRAINT "GeoVariantJob_articleId_fkey"
            FOREIGN KEY ("articleId") REFERENCES "GeoArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
