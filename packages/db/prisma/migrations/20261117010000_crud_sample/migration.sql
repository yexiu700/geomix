-- CreateTable
CREATE TABLE "CrudSample" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrudSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrudSample_tenantId_createdAt_idx" ON "CrudSample"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrudSample_tenantId_name_key" ON "CrudSample"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "CrudSample" ADD CONSTRAINT "CrudSample_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
