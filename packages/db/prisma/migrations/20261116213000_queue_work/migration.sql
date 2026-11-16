-- CreateTable
CREATE TABLE "WorkRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "taskName" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "unitAiWrite" INTEGER NOT NULL,
    "unitKbAddon" INTEGER NOT NULL DEFAULT 0,
    "withKnowledgeBase" BOOLEAN NOT NULL DEFAULT false,
    "quotaKey" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkUnit" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "steps" INTEGER NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failuresRemaining" INTEGER NOT NULL DEFAULT 0,
    "outputReady" BOOLEAN NOT NULL DEFAULT false,
    "quotaApplied" BOOLEAN NOT NULL DEFAULT false,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "released" BOOLEAN NOT NULL DEFAULT false,
    "executionToken" TEXT,
    "error" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveWork" (
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL,
    "workerId" TEXT,

    CONSTRAINT "ActiveWork_pkey" PRIMARY KEY ("refType","refId")
);

-- CreateIndex
CREATE INDEX "WorkRun_tenantId_createdAt_idx" ON "WorkRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkRun_status_updatedAt_idx" ON "WorkRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "WorkUnit_tenantId_status_idx" ON "WorkUnit"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WorkUnit_status_leaseUntil_idx" ON "WorkUnit"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "WorkUnit_runId_seq_key" ON "WorkUnit"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ActiveWork_runId_key" ON "ActiveWork"("runId");

-- CreateIndex
CREATE INDEX "ActiveWork_tenantId_beatAt_idx" ON "ActiveWork"("tenantId", "beatAt");

-- AddForeignKey
ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkUnit" ADD CONSTRAINT "WorkUnit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkUnit" ADD CONSTRAINT "WorkUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveWork" ADD CONSTRAINT "ActiveWork_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveWork" ADD CONSTRAINT "ActiveWork_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
