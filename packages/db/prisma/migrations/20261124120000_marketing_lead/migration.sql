-- GeoMix brand website marketing lead table (Batch 0 / Issue #378).
-- Strictly forward-compatible and additive migration.

-- ===================== 1. Create new enums =====================
CREATE TYPE "MarketingLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'TRIAL_PROVISIONED', 'ARCHIVED');

CREATE TYPE "MarketingLeadMarket" AS ENUM ('GLOBAL', 'CN', 'BOTH');

-- ===================== 2. Create MarketingLead table =====================
CREATE TABLE IF NOT EXISTS "MarketingLead" (
    "id" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyBrand" TEXT NOT NULL,
    "websiteUrl" TEXT,
    "targetMarket" "MarketingLeadMarket" NOT NULL DEFAULT 'GLOBAL',
    "monthlyGoal" TEXT,
    "estimatedPts" INTEGER,
    "notes" TEXT,
    "sourcePage" TEXT,
    "status" "MarketingLeadStatus" NOT NULL DEFAULT 'NEW',
    "adminNote" TEXT,
    "sourceIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingLead_pkey" PRIMARY KEY ("id")
);

-- ===================== 3. Create indexes =====================
CREATE INDEX IF NOT EXISTS "MarketingLead_status_createdAt_idx"
    ON "MarketingLead"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "MarketingLead_email_createdAt_idx"
    ON "MarketingLead"("email", "createdAt");
