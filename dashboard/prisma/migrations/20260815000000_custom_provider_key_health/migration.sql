-- AlterTable: add key health auto-check fields to custom_provider_keys
ALTER TABLE "custom_provider_keys" ADD COLUMN "lastProbedAt" TIMESTAMP(3);
ALTER TABLE "custom_provider_keys" ADD COLUMN "probeFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "custom_provider_keys" ADD COLUMN "autoDisabledAt" TIMESTAMP(3);
ALTER TABLE "custom_provider_keys" ADD COLUMN "autoDisableReason" TEXT;
