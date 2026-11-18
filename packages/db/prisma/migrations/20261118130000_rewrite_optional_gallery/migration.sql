-- DropForeignKey
ALTER TABLE "RewriteBatch" DROP CONSTRAINT "RewriteBatch_mediaCategoryId_fkey";

-- DropForeignKey
ALTER TABLE "RewriteRecord" DROP CONSTRAINT "RewriteRecord_mediaCategoryId_fkey";

-- AlterTable
ALTER TABLE "RewriteBatch" ALTER COLUMN "mediaCategoryId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RewriteRecord" ALTER COLUMN "mediaCategoryId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "RewriteBatch" ADD CONSTRAINT "RewriteBatch_mediaCategoryId_fkey" FOREIGN KEY ("mediaCategoryId") REFERENCES "MediaCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewriteRecord" ADD CONSTRAINT "RewriteRecord_mediaCategoryId_fkey" FOREIGN KEY ("mediaCategoryId") REFERENCES "MediaCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
