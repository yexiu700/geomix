-- Add optional market-localized category label on BrandMarket (Issue #338)
ALTER TABLE "BrandMarket" ADD COLUMN IF NOT EXISTS "localCategory" TEXT;
