import { prisma } from "@/lib/db";
import { decryptProviderKey } from "@/lib/providers/encrypt";
import { syncCustomProviderToProxy, type SyncProviderKeyEntry } from "@/lib/providers/custom-provider-sync";
import { type CustomProviderApiType } from "@/lib/providers/api-types";
import { invalidateProxyModelsCache } from "@/lib/cache";
import { logger } from "@/lib/logger";

export interface ResyncResult {
  providerId: string;
  name: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
}

export async function resyncCustomProviders(userId?: string): Promise<ResyncResult[]> {
  const providers = await prisma.customProvider.findMany({
    where: userId ? { userId } : undefined,
    include: { models: true, excludedModels: true, keys: true },
    orderBy: { sortOrder: "asc" },
  });

  if (providers.length === 0) return [];

  const results: ResyncResult[] = [];

  for (const provider of providers) {
    // Keyless providers (e.g. local Ollama): no enabled keys in the pool.
    // Sync them with an empty key — Management API payload shape stays stable
    // and downstream consumers see a consistent "api-key-entries": [{ "api-key": "" }].
    const enabledKeys = provider.keys.filter(k => k.enabled);
    const apiKeyEntries: SyncProviderKeyEntry[] = [];

    let skipReason: string | null = null;
    let failReason: string | null = null;

    for (const key of enabledKeys) {
      if (!key.apiKeyEncrypted) {
        // Legacy row: hash was stored before encryption landed. Operator must
        // re-enter the key once so we can encrypt it; skip for now.
        skipReason = "no_encrypted_key";
        break;
      }

      const decrypted = decryptProviderKey(key.apiKeyEncrypted);
      if (!decrypted) {
        failReason = "decrypt_failed";
        logger.error({ providerId: provider.providerId, keyId: key.id }, "Resync: failed to decrypt API key");
        break;
      }
      apiKeyEntries.push({ apiKey: decrypted, weight: key.weight, proxyUrl: key.proxyUrl });
    }

    if (skipReason) {
      results.push({ providerId: provider.providerId, name: provider.name, status: "skipped", reason: skipReason });
      continue;
    }
    if (failReason) {
      results.push({ providerId: provider.providerId, name: provider.name, status: "failed", reason: failReason });
      continue;
    }

    try {
      const { syncStatus, syncMessage } = await syncCustomProviderToProxy({
        providerId: provider.providerId,
        prefix: provider.prefix,
        baseUrl: provider.baseUrl,
        apiKeyEntries,
        proxyUrl: provider.proxyUrl,
        headers: provider.headers as Record<string, string> | null,
        models: provider.models,
        excludedModels: provider.excludedModels,
        apiType: provider.apiType as CustomProviderApiType,
        cloak: provider.cloak,
      }, "update");

      results.push({ providerId: provider.providerId, name: provider.name, status: syncStatus, reason: syncMessage });
    } catch (err) {
      logger.error({ err, providerId: provider.providerId }, "Resync: sync threw");
      results.push({ providerId: provider.providerId, name: provider.name, status: "failed", reason: "sync_threw" });
    }
  }

  invalidateProxyModelsCache();

  const synced = results.filter(r => r.status === "ok").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const failed = results.filter(r => r.status === "failed").length;
  logger.info({ synced, skipped, failed }, "Custom provider resync completed");

  return results;
}
