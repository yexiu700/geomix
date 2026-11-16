-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- Same statement without quotes. Safe to repeat after docker init.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MERCHANT', 'ADMIN');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('SHADOW', 'STRICT');

-- CreateEnum
CREATE TYPE "LedgerStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "QuotaKey" AS ENUM ('MAIN_KEYWORD', 'QUESTION', 'AI_WRITE', 'STORAGE_BYTES', 'PUBLISH', 'SOCIAL_AUTH');

-- CreateEnum
CREATE TYPE "KeywordOptStatus" AS ENUM ('NONE', 'OPTIMIZING', 'INCLUDED');

-- CreateEnum
CREATE TYPE "QuestionSource" AS ENUM ('AI', 'MANUAL', 'COMBO');

-- CreateEnum
CREATE TYPE "KbMode" AS ENUM ('DETAIL', 'SUMMARY');

-- CreateEnum
CREATE TYPE "KbIndexStatus" AS ENUM ('NONE', 'INDEXING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "PromptKind" AS ENUM ('ARTICLE', 'TITLE', 'REWRITE');

-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('PENDING', 'NORMAL', 'DISABLED');

-- CreateEnum
CREATE TYPE "ArticleSource" AS ENUM ('AI_TASK', 'MANUAL', 'REWRITE_SINGLE', 'REWRITE_BATCH');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "MediaOrigin" AS ENUM ('UPLOAD', 'AI_IMAGE', 'EDITOR');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billingMode" "BillingMode",
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "nickname" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'MERCHANT',
    "uiPrefs" JSONB,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "tenantId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "pointsReserved" INTEGER NOT NULL DEFAULT 0,
    "money" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Quota" (
    "tenantId" TEXT NOT NULL,
    "key" "QuotaKey" NOT NULL,
    "limit" BIGINT NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Quota_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateTable
CREATE TABLE "PricingItem" (
    "action" TEXT NOT NULL,
    "unitPoints" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingItem_pkey" PRIMARY KEY ("action")
);

-- CreateTable
CREATE TABLE "PointReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "shadow" BOOLEAN NOT NULL DEFAULT false,
    "frozen" INTEGER NOT NULL,
    "settled" INTEGER NOT NULL DEFAULT 0,
    "released" INTEGER NOT NULL DEFAULT 0,
    "status" "ReservationStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PointReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reservationId" TEXT,
    "action" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "unitKey" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "listPrice" INTEGER NOT NULL,
    "detail" JSONB,
    "balanceAfter" INTEGER,
    "status" "LedgerStatus" NOT NULL DEFAULT 'SETTLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "tenantId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "creditCode" TEXT NOT NULL,
    "contact" TEXT,
    "phone" TEXT,
    "licenseUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "AgreementSignature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'kb_truthfulness',
    "version" TEXT NOT NULL,
    "ip" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgreementSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "main" TEXT NOT NULL,
    "brands" TEXT[],
    "optStatus" "KeywordOptStatus" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" "QuestionSource" NOT NULL DEFAULT 'MANUAL',
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "included" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "origin" "MediaOrigin" NOT NULL DEFAULT 'UPLOAD',
    "aiImageId" TEXT,
    "objectKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbUrl" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "KbMode" NOT NULL DEFAULT 'DETAIL',
    "companyName" TEXT,
    "brandShort" TEXT,
    "directions" TEXT[],
    "copyTypes" TEXT[],
    "fields" JSONB,
    "summaryText" TEXT,
    "indexStatus" "KbIndexStatus" NOT NULL DEFAULT 'NONE',
    "signatureId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" "PromptKind" NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "randomPool" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "clonedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "mediaCategoryId" TEXT NOT NULL,
    "imageCount" INTEGER NOT NULL DEFAULT 1,
    "kbId" TEXT,
    "contentTplId" TEXT,
    "titleTplId" TEXT,
    "resultStatus" "ArticleStatus" NOT NULL DEFAULT 'PENDING',
    "target" INTEGER NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "lastError" TEXT,
    "lastWrittenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTaskItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "questionId" TEXT,
    "templateId" TEXT,
    "direction" TEXT,
    "copyType" TEXT,
    "brand" TEXT,
    "title" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "error" TEXT,
    "articleId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "title" TEXT NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "contentText" TEXT NOT NULL,
    "coverUrl" TEXT,
    "status" "ArticleStatus" NOT NULL DEFAULT 'NORMAL',
    "source" "ArticleSource" NOT NULL,
    "aiTaskId" TEXT,
    "sourceUrl" TEXT,
    "complianceFlags" JSONB,
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "firstPublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewriteBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "maxCount" INTEGER NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL DEFAULT 'link_list',
    "linkList" TEXT[],
    "categoryId" TEXT NOT NULL,
    "mediaCategoryId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewriteBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewriteRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "pastedText" BOOLEAN NOT NULL DEFAULT false,
    "sourceTitle" TEXT,
    "newTitle" TEXT,
    "categoryId" TEXT,
    "mediaCategoryId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "similarity" DOUBLE PRECISION,
    "articleId" TEXT,
    "rewrittenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewriteRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImageJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "style" TEXT,
    "ratio" TEXT NOT NULL DEFAULT '1:1',
    "count" INTEGER NOT NULL DEFAULT 1,
    "refAssetId" TEXT,
    "saveCategoryId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImageJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "PointReservation_status_createdAt_idx" ON "PointReservation"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointReservation_refType_refId_key" ON "PointReservation"("refType", "refId");

-- CreateIndex
CREATE INDEX "PointLog_tenantId_createdAt_idx" ON "PointLog"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointLog_unitKey_action_key" ON "PointLog"("unitKey", "action");

-- CreateIndex
CREATE INDEX "MoneyLog_tenantId_createdAt_idx" ON "MoneyLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgreementSignature_tenantId_kind_version_idx" ON "AgreementSignature"("tenantId", "kind", "version");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_tenantId_main_key" ON "Keyword"("tenantId", "main");

-- CreateIndex
CREATE INDEX "Question_tenantId_keywordId_usedCount_idx" ON "Question"("tenantId", "keywordId", "usedCount");

-- CreateIndex
CREATE UNIQUE INDEX "Question_keywordId_text_key" ON "Question"("keywordId", "text");

-- CreateIndex
CREATE UNIQUE INDEX "MediaCategory_tenantId_type_name_key" ON "MediaCategory"("tenantId", "type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_objectKey_key" ON "MediaAsset"("objectKey");

-- CreateIndex
CREATE INDEX "MediaAsset_tenantId_categoryId_usedCount_idx" ON "MediaAsset"("tenantId", "categoryId", "usedCount");

-- CreateIndex
CREATE INDEX "KnowledgeBase_tenantId_idx" ON "KnowledgeBase"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_kbId_idx_key" ON "KnowledgeChunk"("kbId", "idx");

-- CreateIndex
CREATE INDEX "PromptTemplate_tenantId_kind_idx" ON "PromptTemplate"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleCategory_tenantId_name_key" ON "ArticleCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AiTask_tenantId_createdAt_idx" ON "AiTask"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiTaskItem_articleId_key" ON "AiTaskItem"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "AiTaskItem_taskId_seq_key" ON "AiTaskItem"("taskId", "seq");

-- CreateIndex
CREATE INDEX "Article_tenantId_categoryId_status_sendCount_idx" ON "Article"("tenantId", "categoryId", "status", "sendCount");

-- CreateIndex
CREATE INDEX "Article_tenantId_aiTaskId_idx" ON "Article"("tenantId", "aiTaskId");

-- CreateIndex
CREATE INDEX "RewriteBatch_tenantId_createdAt_idx" ON "RewriteBatch"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewriteRecord_articleId_key" ON "RewriteRecord"("articleId");

-- CreateIndex
CREATE INDEX "RewriteRecord_tenantId_urlHash_idx" ON "RewriteRecord"("tenantId", "urlHash");

-- CreateIndex
CREATE INDEX "RewriteRecord_tenantId_batchId_createdAt_idx" ON "RewriteRecord"("tenantId", "batchId", "createdAt");

-- CreateIndex
CREATE INDEX "AiImageJob_tenantId_createdAt_idx" ON "AiImageJob"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quota" ADD CONSTRAINT "Quota_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointReservation" ADD CONSTRAINT "PointReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLog" ADD CONSTRAINT "PointLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLog" ADD CONSTRAINT "PointLog_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "PointReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoneyLog" ADD CONSTRAINT "MoneyLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementSignature" ADD CONSTRAINT "AgreementSignature_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaCategory" ADD CONSTRAINT "MediaCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MediaCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_aiImageId_fkey" FOREIGN KEY ("aiImageId") REFERENCES "AiImageJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptTemplate" ADD CONSTRAINT "PromptTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCategory" ADD CONSTRAINT "ArticleCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ArticleCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_mediaCategoryId_fkey" FOREIGN KEY ("mediaCategoryId") REFERENCES "MediaCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_contentTplId_fkey" FOREIGN KEY ("contentTplId") REFERENCES "PromptTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_titleTplId_fkey" FOREIGN KEY ("titleTplId") REFERENCES "PromptTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTaskItem" ADD CONSTRAINT "AiTaskItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AiTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTaskItem" ADD CONSTRAINT "AiTaskItem_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ArticleCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_aiTaskId_fkey" FOREIGN KEY ("aiTaskId") REFERENCES "AiTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteBatch" ADD CONSTRAINT "RewriteBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteBatch" ADD CONSTRAINT "RewriteBatch_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ArticleCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteBatch" ADD CONSTRAINT "RewriteBatch_mediaCategoryId_fkey" FOREIGN KEY ("mediaCategoryId") REFERENCES "MediaCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteBatch" ADD CONSTRAINT "RewriteBatch_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RewriteBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ArticleCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_mediaCategoryId_fkey" FOREIGN KEY ("mediaCategoryId") REFERENCES "MediaCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImageJob" ADD CONSTRAINT "AiImageJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GeoMix ledger guards and the knowledge-chunk HNSW index.
-- Prisma cannot model these. They stay idempotent: docker init may already
-- have created the vector extension, and a repeated local apply must not fail.

DO $$
BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT chk_wallet_nonneg
    CHECK (points >= 0 AND "pointsReserved" >= 0 AND points >= "pointsReserved");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "Quota" ADD CONSTRAINT chk_quota_nonneg CHECK (used >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "PointReservation" ADD CONSTRAINT chk_resv
    CHECK (settled >= 0 AND released >= 0 AND settled + released <= frozen);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_chunk_embedding ON "KnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops);
