-- Add independent brand and resultStatus columns to RewriteBatch so brand hints do not overwrite keyword/note (#209)
ALTER TABLE "RewriteBatch" ADD COLUMN IF NOT EXISTS "brand" TEXT;
ALTER TABLE "RewriteBatch" ADD COLUMN IF NOT EXISTS "resultStatus" "ArticleStatus" NOT NULL DEFAULT 'PENDING';
