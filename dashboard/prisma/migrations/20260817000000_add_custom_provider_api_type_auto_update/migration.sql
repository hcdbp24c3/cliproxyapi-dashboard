-- AlterTable
ALTER TABLE "custom_providers" ADD COLUMN "apiType" TEXT NOT NULL DEFAULT 'openai-compatible',
ADD COLUMN "cloak" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autoUpdateModels" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastModelsSyncAt" TIMESTAMPTZ(3);
