import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AUDIT_ACTION, logAuditAsync } from "@/lib/audit";
import { decryptProviderKey } from "@/lib/providers/encrypt";
import {
  fetchUpstreamModels,
  mapUpstreamResultToStatus,
  type UpstreamKeyStatusResult,
} from "@/lib/providers/upstream-check";
import {
  syncCustomProviderToProxy,
  type SyncProviderKeyEntry,
} from "@/lib/providers/custom-provider-sync";
import { invalidateProxyModelsCache } from "@/lib/cache";
import type { Prisma } from "@/generated/prisma/client";

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const KEY_HEALTH_SETTING_KEYS = {
  ENABLED: "key_health_enabled",
  INTERVAL_MINUTES: "key_health_interval_minutes",
  MAX_RETRIES: "key_health_max_retries",
} as const;

export const KEY_HEALTH_DEFAULTS = {
  enabled: false,
  intervalMinutes: 60,
  maxRetries: 3,
} as const;

/** Delay between retry probes of the same key. */
export const KEY_HEALTH_RETRY_DELAY_MS = 1_500;

export interface KeyHealthSettings {
  enabled: boolean;
  intervalMinutes: number;
  maxRetries: number;
}

/**
 * Read key-health settings from the DB (SystemSetting), falling back to
 * defaults when unset or invalid.
 */
export async function getKeyHealthSettings(): Promise<KeyHealthSettings> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(KEY_HEALTH_SETTING_KEYS) } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const enabled = map.get(KEY_HEALTH_SETTING_KEYS.ENABLED) === "true";

  const intervalMinutesRaw = parseInt(
    map.get(KEY_HEALTH_SETTING_KEYS.INTERVAL_MINUTES) ?? "",
    10
  );
  const intervalMinutes =
    Number.isNaN(intervalMinutesRaw) || intervalMinutesRaw < 1
      ? KEY_HEALTH_DEFAULTS.intervalMinutes
      : intervalMinutesRaw;

  const maxRetriesRaw = parseInt(
    map.get(KEY_HEALTH_SETTING_KEYS.MAX_RETRIES) ?? "",
    10
  );
  const maxRetries =
    Number.isNaN(maxRetriesRaw) || maxRetriesRaw < 0
      ? KEY_HEALTH_DEFAULTS.maxRetries
      : maxRetriesRaw;

  return { enabled, intervalMinutes, maxRetries };
}

/** Read the scheduler interval from DB (in milliseconds), min 1 minute. */
export async function getKeyHealthIntervalMs(): Promise<number> {
  const settings = await getKeyHealthSettings();
  return settings.intervalMinutes * 60_000;
}

/* ------------------------------------------------------------------ */
/* Probing                                                             */
/* ------------------------------------------------------------------ */

type CustomProviderWithRelations = Prisma.CustomProviderGetPayload<{
  include: { models: true; excludedModels: true; keys: true };
}>;

export interface KeyHealthRunSummary {
  checked: boolean;
  skippedReason?: string;
  settings: KeyHealthSettings;
  probedCount: number;
  okCount: number;
  invalidCount: number;
  unreachableCount: number;
  disabledKeys: Array<{
    keyId: string;
    providerId: string;
    reason: string;
  }>;
  resyncStatus: "ok" | "failed";
  resyncMessage?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe a single key once and map the upstream result to a key status.
 * Never throws: fetchUpstreamModels returns a discriminated union.
 */
async function probeKeyOnce(
  baseUrl: string,
  apiKey: string
): Promise<UpstreamKeyStatusResult> {
  const result = await fetchUpstreamModels(baseUrl, apiKey);
  return mapUpstreamResultToStatus(result);
}

/**
 * Disable a key after repeated invalid (401/403) results and record an
 * audit entry attributed to the provider owner (the scheduler has no user
 * session, matching the manual toggle route which audits as the owner).
 */
async function disableKey(params: {
  keyId: string;
  providerId: string;
  ownerUserId: string;
  reason: string;
  failureCount: number;
  now: Date;
}): Promise<void> {
  const { keyId, providerId, ownerUserId, reason, failureCount, now } = params;

  await prisma.customProviderKey.update({
    where: { id: keyId },
    data: {
      enabled: false,
      autoDisabledAt: now,
      autoDisableReason: reason,
      probeFailureCount: failureCount,
      lastProbedAt: now,
    },
  });

  logAuditAsync({
    userId: ownerUserId,
    action: AUDIT_ACTION.KEY_AUTO_DISABLED,
    target: keyId,
    metadata: {
      providerId,
      reason,
      failureCount,
      trigger: "scheduler",
    },
  });
}

/**
 * Re-sync a provider to the proxy after one or more of its keys were
 * auto-disabled, so the proxy pool no longer contains the disabled keys.
 * Mirrors resync.ts payload construction but filters out disabled keys.
 */
async function resyncProviderAfterDisable(
  provider: CustomProviderWithRelations,
  disabledKeyIds: Set<string>
): Promise<{ status: "ok" | "failed"; message?: string }> {
  const apiKeyEntries: SyncProviderKeyEntry[] = [];

  for (const key of provider.keys) {
    if (!key.enabled || disabledKeyIds.has(key.id)) continue;
    if (!key.apiKeyEncrypted) continue;

    const decrypted = decryptProviderKey(key.apiKeyEncrypted);
    if (!decrypted) {
      logger.error(
        { providerId: provider.providerId, keyId: key.id },
        "Key health: failed to decrypt API key during resync"
      );
      continue;
    }
    apiKeyEntries.push({ apiKey: decrypted, weight: key.weight, proxyUrl: key.proxyUrl });
  }

  try {
    const { syncStatus, syncMessage } = await syncCustomProviderToProxy(
      {
        providerId: provider.providerId,
        prefix: provider.prefix,
        baseUrl: provider.baseUrl,
        apiKeyEntries,
        proxyUrl: provider.proxyUrl,
        headers: provider.headers as Record<string, string> | null,
        models: provider.models,
        excludedModels: provider.excludedModels,
      },
      "update"
    );
    return { status: syncStatus, message: syncMessage };
  } catch (err) {
    logger.error(
      { err, providerId: provider.providerId },
      "Key health: resync after auto-disable threw"
    );
    return { status: "failed", message: "sync_threw" };
  }
}

/* ------------------------------------------------------------------ */
/* Main check                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run a full key-health pass over every enabled CustomProviderKey.
 *
 * Semantics per key:
 * - "ok"            → update lastProbedAt, reset probeFailureCount to 0.
 * - "unreachable"   → update lastProbedAt only; never counts as failure.
 * - "invalid"       → retry up to `maxRetries` more times (delay
 *                     KEY_HEALTH_RETRY_DELAY_MS between probes); if still
 *                     invalid, auto-disable the key and resync the provider.
 *
 * @param options.force – run even when the feature is disabled (manual run).
 */
export async function runKeyHealthCheck(
  options: { force?: boolean } = {}
): Promise<KeyHealthRunSummary> {
  const settings = await getKeyHealthSettings();

  const summary: KeyHealthRunSummary = {
    checked: false,
    settings,
    probedCount: 0,
    okCount: 0,
    invalidCount: 0,
    unreachableCount: 0,
    disabledKeys: [],
    resyncStatus: "ok",
  };

  if (!settings.enabled && !options.force) {
    summary.skippedReason = "key_health_disabled";
    return summary;
  }

  const providers = await prisma.customProvider.findMany({
    include: { models: true, excludedModels: true, keys: true },
    orderBy: { sortOrder: "asc" },
  });

  // Track keys disabled during this pass, per provider, for the follow-up resync.
  const disabledByProvider = new Map<string, Set<string>>();

  for (const provider of providers) {
    for (const key of provider.keys) {
      if (!key.enabled) continue;
      if (!key.apiKeyEncrypted) continue; // legacy row without encrypted copy

      const decrypted = decryptProviderKey(key.apiKeyEncrypted);
      if (!decrypted) {
        logger.error(
          { providerId: provider.providerId, keyId: key.id },
          "Key health: failed to decrypt API key"
        );
        continue;
      }

      summary.probedCount++;

      let probe = await probeKeyOnce(provider.baseUrl, decrypted);
      let failures = probe.status === "invalid" ? 1 : 0;

      // Retry only on invalid (401/403); unreachable is not a key failure.
      let attempts = 1;
      while (probe.status === "invalid" && attempts <= settings.maxRetries) {
        await sleep(KEY_HEALTH_RETRY_DELAY_MS);
        probe = await probeKeyOnce(provider.baseUrl, decrypted);
        attempts++;
        if (probe.status === "invalid") failures++;
      }

      const now = new Date();

      if (probe.status === "ok") {
        summary.okCount++;
        await prisma.customProviderKey.update({
          where: { id: key.id },
          data: { lastProbedAt: now, probeFailureCount: 0 },
        });
        continue;
      }

      if (probe.status === "invalid") {
        summary.invalidCount++;
        const reason =
          probe.message ??
          `Invalid API key after ${failures} probe(s) (HTTP 401/403)`;

        await disableKey({
          keyId: key.id,
          providerId: provider.id,
          ownerUserId: provider.userId,
          reason,
          failureCount: failures,
          now,
        });

        summary.disabledKeys.push({
          keyId: key.id,
          providerId: provider.id,
          reason,
        });

        const set = disabledByProvider.get(provider.id) ?? new Set<string>();
        set.add(key.id);
        disabledByProvider.set(provider.id, set);
        continue;
      }

      // unreachable
      summary.unreachableCount++;
      await prisma.customProviderKey.update({
        where: { id: key.id },
        data: { lastProbedAt: now },
      });
    }
  }

  // Re-sync every affected provider once (disabled keys removed from pool).
  if (disabledByProvider.size > 0) {
    const results: Array<{ status: "ok" | "failed"; message?: string }> = [];
    for (const [providerId, disabledKeyIds] of disabledByProvider) {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) continue;
      results.push(await resyncProviderAfterDisable(provider, disabledKeyIds));
    }

    const anyFailed = results.some((r) => r.status === "failed");
    summary.resyncStatus = anyFailed ? "failed" : "ok";
    if (anyFailed) {
      summary.resyncMessage = "One or more providers failed to resync after auto-disable";
      logger.error(
        { results },
        "Key health: resync after auto-disable had failures"
      );
    } else {
      invalidateProxyModelsCache();
    }
  }

  summary.checked = true;

  logger.info(
    {
      probed: summary.probedCount,
      ok: summary.okCount,
      invalid: summary.invalidCount,
      unreachable: summary.unreachableCount,
      disabled: summary.disabledKeys.length,
      resync: summary.resyncStatus,
    },
    "Key health check completed"
  );

  return summary;
}
