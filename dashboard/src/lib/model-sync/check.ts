import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { fetchUpstreamModels } from "@/lib/providers/upstream-check";
import { decryptProviderKey } from "@/lib/providers/encrypt";
import type { CustomProviderApiType } from "@/lib/providers/api-types";

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const MODEL_SYNC_SETTING_KEYS = {
  ENABLED: "model_sync_enabled",
  INTERVAL_MINUTES: "model_sync_interval_minutes",
} as const;

const MODEL_SYNC_DEFAULTS = {
  enabled: false,
  intervalMinutes: 60,
} as const;

export interface ModelSyncSettings {
  enabled: boolean;
  intervalMinutes: number;
}

/**
 * Read model-sync settings from the DB (SystemSetting), falling back to
 * defaults when unset or invalid.
 */
export async function getModelSyncSettings(): Promise<ModelSyncSettings> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(MODEL_SYNC_SETTING_KEYS) } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const enabled = map.get(MODEL_SYNC_SETTING_KEYS.ENABLED) === "true";

  const intervalMinutesRaw = parseInt(
    map.get(MODEL_SYNC_SETTING_KEYS.INTERVAL_MINUTES) ?? "",
    10
  );
  const intervalMinutes =
    Number.isNaN(intervalMinutesRaw) || intervalMinutesRaw < 1
      ? MODEL_SYNC_DEFAULTS.intervalMinutes
      : intervalMinutesRaw;

  return { enabled, intervalMinutes };
}

/** Read the scheduler interval from DB (in milliseconds), min 1 minute. */
export async function getModelSyncIntervalMs(): Promise<number> {
  const settings = await getModelSyncSettings();
  return settings.intervalMinutes * 60_000;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export interface ModelSyncRunSummary {
  checked: boolean;
  providerResults: Array<{
    providerId: string;
    name: string;
    status: "ok" | "skipped" | "failed";
    reason?: string;
  }>;
  syncedCount: number;
  skippedCount: number;
  failedCount: number;
}

/**
 * Run a full model-sync pass over every CustomProvider with autoUpdateModels
 * enabled.
 *
 * Semantics:
 * - Append-only: only adds NEW upstream models that don't already have a
 *   CustomProviderModel mapping.
 * - Updates lastModelsSyncAt after each provider sync.
 *
 * @param options.force – run even when the feature is disabled (manual run).
 */
export async function runModelSync(
  options?: { force?: boolean }
): Promise<ModelSyncRunSummary> {
  const settings = await getModelSyncSettings();

  if (!options?.force && !settings.enabled) {
    return {
      checked: false,
      providerResults: [],
      syncedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  const providers = await prisma.customProvider.findMany({
    where: { autoUpdateModels: true },
    include: { keys: true },
  });

  const summary: ModelSyncRunSummary = {
    checked: true,
    providerResults: [],
    syncedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  for (const provider of providers) {
    try {
      const providerKeys = provider.keys ?? [];
      const enabledKey = providerKeys.find((k) => k.enabled && k.apiKeyEncrypted);
      const decryptedKey = enabledKey?.apiKeyEncrypted
        ? decryptProviderKey(enabledKey.apiKeyEncrypted) ?? undefined
        : undefined;

      const apiType = provider.apiType as CustomProviderApiType;
      const result = await fetchUpstreamModels(provider.baseUrl, decryptedKey, { apiType });

      if (result.status !== "success" || !result.models) {
        summary.providerResults.push({
          providerId: provider.providerId,
          name: provider.name,
          status: "skipped",
          reason: result.status === "success" ? "No models returned" : `Upstream fetch failed: ${result.status}`,
        });
        summary.skippedCount++;
        continue;
      }

      // Get current mappings
      const existingMappings = await prisma.customProviderModel.findMany({
        where: { customProviderId: provider.id },
      });
      const existingUpstreamNames = new Set(
        existingMappings.map((m) => m.upstreamName)
      );

      // Append-only: only add NEW models
      const newModels = result.models.filter(
        (m) => !existingUpstreamNames.has(m.id)
      );

      if (newModels.length > 0) {
        await prisma.customProviderModel.createMany({
          data: newModels.map((m) => ({
            customProviderId: provider.id,
            upstreamName: m.id,
            alias: m.name || m.id,
          })),
        });
      }

      // Update lastModelsSyncAt
      await prisma.customProvider.update({
        where: { id: provider.id },
        data: { lastModelsSyncAt: new Date() },
      });

      summary.providerResults.push({
        providerId: provider.providerId,
        name: provider.name,
        status: "ok",
      });
      summary.syncedCount++;
    } catch (error) {
      logger.error(
        { err: error, providerId: provider.providerId },
        "Model sync failed for provider"
      );
      summary.providerResults.push({
        providerId: provider.providerId,
        name: provider.name,
        status: "failed",
        reason: error instanceof Error ? error.message : "Unknown error",
      });
      summary.failedCount++;
    }
  }

  logger.info(
    {
      providers: providers.length,
      synced: summary.syncedCount,
      skipped: summary.skippedCount,
      failed: summary.failedCount,
    },
    "Model sync completed"
  );

  return summary;
}
