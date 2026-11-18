-- Add nullable originalName to MediaAsset so gallery UI and exports display safe user filenames instead of internal object keys.
ALTER TABLE "MediaAsset" ADD COLUMN "originalName" TEXT;
