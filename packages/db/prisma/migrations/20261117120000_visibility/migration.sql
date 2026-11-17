-- CreateTable
CREATE TABLE "VisibilityProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandAliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisibilityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisibilityRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "keywordId" TEXT,
    "name" TEXT NOT NULL,
    "engines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "questionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
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

-- CreateTable
CREATE TABLE "VisibilityObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "questionId" TEXT,
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

-- CreateTable
CREATE TABLE "VisibilityCitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "sourceKind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisibilityCitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisibilityProfile_tenantId_createdAt_idx" ON "VisibilityProfile"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VisibilityProfile_tenantId_name_key" ON "VisibilityProfile"("tenantId", "name");

-- CreateIndex
CREATE INDEX "VisibilityRun_tenantId_status_createdAt_idx" ON "VisibilityRun"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "VisibilityRun_tenantId_profileId_createdAt_idx" ON "VisibilityRun"("tenantId", "profileId", "createdAt");

-- CreateIndex
CREATE INDEX "VisibilityObservation_tenantId_profileId_checkedAt_idx" ON "VisibilityObservation"("tenantId", "profileId", "checkedAt");

-- CreateIndex
CREATE INDEX "VisibilityObservation_tenantId_engine_brandMentioned_idx" ON "VisibilityObservation"("tenantId", "engine", "brandMentioned");

-- CreateIndex
CREATE INDEX "VisibilityObservation_tenantId_questionId_brandMentioned_idx" ON "VisibilityObservation"("tenantId", "questionId", "brandMentioned");

-- CreateIndex
CREATE UNIQUE INDEX "VisibilityObservation_runId_promptText_engine_key" ON "VisibilityObservation"("runId", "promptText", "engine");

-- CreateIndex
CREATE INDEX "VisibilityCitation_tenantId_domain_sourceKind_idx" ON "VisibilityCitation"("tenantId", "domain", "sourceKind");

-- CreateIndex
CREATE INDEX "VisibilityCitation_observationId_position_idx" ON "VisibilityCitation"("observationId", "position");

-- AddForeignKey
ALTER TABLE "VisibilityProfile" ADD CONSTRAINT "VisibilityProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "VisibilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityRun" ADD CONSTRAINT "VisibilityRun_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VisibilityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "VisibilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityObservation" ADD CONSTRAINT "VisibilityObservation_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityCitation" ADD CONSTRAINT "VisibilityCitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilityCitation" ADD CONSTRAINT "VisibilityCitation_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "VisibilityObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
