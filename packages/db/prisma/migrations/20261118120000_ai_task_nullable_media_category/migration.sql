-- AlterTable
ALTER TABLE "AiTask" DROP CONSTRAINT "AiTask_mediaCategoryId_fkey";

ALTER TABLE "AiTask" ALTER COLUMN "mediaCategoryId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_mediaCategoryId_fkey" FOREIGN KEY ("mediaCategoryId") REFERENCES "MediaCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
