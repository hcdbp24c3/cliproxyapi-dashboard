-- CreateTable: custom_provider_keys (one row per API key entry for a custom provider)
CREATE TABLE "custom_provider_keys" (
    "id" TEXT NOT NULL,
    "customProviderId" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT,
    "weight" INTEGER,
    "proxyUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_provider_keys_pkey" PRIMARY KEY ("id")
);

-- Backfill: migrate existing single keys on custom_providers into the new pool table.
-- Rows that carry a key hash are migrated, including legacy hash-only rows whose
-- apiKeyEncrypted is NULL (e.g. the auto-provisioned perplexity-pro provider).
-- Keyless providers (e.g. Ollama) are left with an empty pool.
INSERT INTO "custom_provider_keys" ("id", "customProviderId", "apiKeyHash", "apiKeyEncrypted", "weight", "proxyUrl", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "id", "apiKeyHash", "apiKeyEncrypted", NULL, "proxyUrl", true, 0, "createdAt", "updatedAt"
FROM "custom_providers"
WHERE "apiKeyHash" IS NOT NULL;

-- Drop legacy single-key columns from custom_providers
ALTER TABLE "custom_providers" DROP COLUMN "apiKeyHash";
ALTER TABLE "custom_providers" DROP COLUMN "apiKeyEncrypted";

-- CreateIndex
CREATE INDEX "custom_provider_keys_customProviderId_idx" ON "custom_provider_keys"("customProviderId");

-- AddForeignKey
ALTER TABLE "custom_provider_keys" ADD CONSTRAINT "custom_provider_keys_customProviderId_fkey" FOREIGN KEY ("customProviderId") REFERENCES "custom_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
