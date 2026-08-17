import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { invalidateProxyModelsCache } from "@/lib/cache";
import {
  type CustomProviderApiType,
  API_TYPE_MANAGEMENT_PATH,
  isFlatListType,
} from "./api-types";

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface SyncProviderKeyEntry {
  apiKey: string;
  weight?: number | null;
  proxyUrl?: string | null;
}

export interface SyncProviderData {
  providerId: string;
  prefix?: string | null;
  baseUrl: string;
  apiKeyEntries: SyncProviderKeyEntry[];
  proxyUrl?: string | null;
  headers?: Record<string, string> | null;
  models: Array<{ upstreamName: string; alias: string }>;
  excludedModels: Array<{ pattern: string }>;
  apiType?: CustomProviderApiType;
  cloak?: boolean;
}

export interface SyncResult {
  syncStatus: "ok" | "failed";
  syncMessage?: string;
}

export function mergeProviderKeyEntries(
  existing: SyncProviderKeyEntry[],
  incoming: SyncProviderKeyEntry[]
): SyncProviderKeyEntry[] {
  const seen = new Set<string>();
  return [...existing, ...incoming].filter((entry) => {
    const normalized = entry.apiKey.trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

interface ManagementProviderEntry {
  name?: string;
  [key: string]: unknown;
}

function isManagementProviderEntry(value: unknown): value is ManagementProviderEntry {
  return typeof value === "object" && value !== null;
}

/**
 * Syncs a custom provider to CLIProxyAPI Management API.
 * openai-compatible → named-list; all other apiTypes → flat-list.
 */
export async function syncCustomProviderToProxy(
  providerData: SyncProviderData,
  operation: "create" | "update",
  prefetchedConfig?: ManagementProviderEntry[]
): Promise<SyncResult> {
  const managementUrl = env.CLIPROXYAPI_MANAGEMENT_URL;
  const secretKey = env.MANAGEMENT_API_KEY;
  const apiType: CustomProviderApiType = providerData.apiType ?? "openai-compatible";
  const managementPath = API_TYPE_MANAGEMENT_PATH[apiType];

  if (!secretKey) {
    return {
      syncStatus: "failed",
      syncMessage: "Backend sync unavailable - management API key not configured"
    };
  }

  try {
    const result = isFlatListType(apiType)
      ? await syncFlatList({ managementUrl, secretKey, managementPath, providerData, operation, prefetchedConfig })
      : await syncNamedList({ managementUrl, secretKey, managementPath, providerData, operation, prefetchedConfig });

    invalidateProxyModelsCache();
    return result;

  } catch (syncError) {
    logger.error({ err: syncError }, `Failed to sync custom provider to Management API (${operation})`);
    return {
      syncStatus: "failed",
      syncMessage: `Backend sync failed - provider ${operation === "create" ? "created" : "updated"} but may not work immediately`
    };
  }
}

interface NamedListSyncArgs {
  managementUrl: string;
  secretKey: string;
  managementPath: string;
  providerData: SyncProviderData;
  operation: "create" | "update";
  prefetchedConfig?: ManagementProviderEntry[];
}

async function syncNamedList({
  managementUrl, secretKey, managementPath, providerData, operation, prefetchedConfig,
}: NamedListSyncArgs): Promise<SyncResult> {
  let currentList: ManagementProviderEntry[];

  if (prefetchedConfig) {
    currentList = prefetchedConfig;
  } else {
    const getRes = await fetchWithTimeout(`${managementUrl}${managementPath}`, {
      headers: { "Authorization": `Bearer ${secretKey}` }
    });

    if (!getRes.ok) {
      await getRes.body?.cancel();
      logger.error({ status: getRes.status }, "Failed to fetch current config from Management API");
      return {
        syncStatus: "failed",
        syncMessage: `Backend sync failed - provider ${operation === "create" ? "created" : "updated"} but may not work immediately`
      };
    }

    const configData = await getRes.json() as Record<string, unknown>;
    const listKey = managementPath.replace(/^\//, "");
    const listData = configData[listKey];
    currentList = Array.isArray(listData)
      ? listData.filter(isManagementProviderEntry)
      : [];
  }

  // Keyless providers (e.g. local Ollama) have no enabled keys: keep the
  // Management API payload shape stable with a single empty entry.
  const apiKeyEntries = providerData.apiKeyEntries.length > 0
    ? providerData.apiKeyEntries
    : [{ apiKey: "" }];

  const newEntry = {
    name: providerData.providerId,
    prefix: providerData.prefix,
    "base-url": providerData.baseUrl,
    "api-key-entries": apiKeyEntries.map(entry => ({
      "api-key": entry.apiKey,
      ...(entry.weight !== undefined && entry.weight !== null ? { weight: entry.weight } : {}),
      ...((entry.proxyUrl ?? providerData.proxyUrl) ? { "proxy-url": entry.proxyUrl ?? providerData.proxyUrl } : {})
    })),
    models: providerData.models.map(m => ({ name: m.upstreamName, alias: m.alias })),
    "excluded-models": providerData.excludedModels.map(e => e.pattern),
    ...(providerData.headers ? { headers: providerData.headers } : {})
  };

  let newList: unknown[];
  if (operation === "create") {
    newList = [...currentList, newEntry];
  } else {
    // Update: replace existing entry, or append if not found (e.g. after proxy restart)
    const existingIndex = currentList.findIndex(
      (entry) => entry.name === providerData.providerId
    );
    if (existingIndex >= 0) {
      newList = currentList.map((entry) =>
        entry.name === providerData.providerId ? newEntry : entry
      );
    } else {
      newList = [...currentList, newEntry];
    }
  }

  logger.info({ operation, providerId: providerData.providerId, entryCount: newList.length }, "Syncing provider to CLIProxyAPI (named-list)");

  const putRes = await fetchWithTimeout(`${managementUrl}${managementPath}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secretKey}`
    },
    body: JSON.stringify(newList)
  });

  if (!putRes.ok) {
    const errorBody = await putRes.text().catch(() => "unreadable");
    logger.error({ status: putRes.status, errorBody }, `Failed to sync custom provider to Management API (${operation})`);
    return {
      syncStatus: "failed",
      syncMessage: `Backend sync failed - provider ${operation === "create" ? "created" : "updated"} but may not work immediately`
    };
  }

  return { syncStatus: "ok" };
}

interface FlatListSyncArgs {
  managementUrl: string;
  secretKey: string;
  managementPath: string;
  providerData: SyncProviderData;
  operation: "create" | "update";
  prefetchedConfig?: ManagementProviderEntry[];
}

/**
 * Entry key for flat-list providers: the routing prefix if set, otherwise the
 * providerId. Legacy flat lists may also key by `name`, so update logic
 * checks both.
 */
function flatListEntryKey(providerData: SyncProviderData): string {
  return providerData.prefix || providerData.providerId;
}

async function syncFlatList({
  managementUrl, secretKey, managementPath, providerData, operation, prefetchedConfig,
}: FlatListSyncArgs): Promise<SyncResult> {
  let currentList: ManagementProviderEntry[];

  if (prefetchedConfig) {
    currentList = prefetchedConfig;
  } else {
    const getRes = await fetchWithTimeout(`${managementUrl}${managementPath}`, {
      headers: { "Authorization": `Bearer ${secretKey}` }
    });

    if (!getRes.ok) {
      await getRes.body?.cancel();
      logger.error({ status: getRes.status }, "Failed to fetch flat list from Management API");
      return {
        syncStatus: "failed",
        syncMessage: `Backend sync failed - provider ${operation === "create" ? "created" : "updated"} but may not work immediately`
      };
    }

    const configData = await getRes.json() as Record<string, unknown>;
    const listKey = managementPath.replace(/^\//, "");
    const listData = configData[listKey];
    currentList = Array.isArray(listData)
      ? listData.filter(isManagementProviderEntry)
      : [];
  }

  const entryKey = flatListEntryKey(providerData);

  // Keyless providers get a single empty-key entry.
  const apiKeyEntries = providerData.apiKeyEntries.length > 0
    ? providerData.apiKeyEntries
    : [{ apiKey: "" }];

  // Flat-list entry: shallow shape, no nested api-key-entries.
  const firstKey = apiKeyEntries[0]!;
  const newEntry: Record<string, unknown> = {
    name: entryKey,
    "api-key": firstKey.apiKey,
    ...(firstKey.weight !== undefined && firstKey.weight !== null ? { weight: firstKey.weight } : {}),
  };

  let newList: unknown[];
  if (operation === "create") {
    newList = [...currentList, newEntry];
  } else {
    // Update: remove any existing entry keyed by entryKey OR legacy name, then add new
    const filtered = currentList.filter((entry) => {
      const entryName = typeof entry.name === "string" ? entry.name : undefined;
      return entryName !== entryKey && entryName !== providerData.providerId;
    });
    newList = [...filtered, newEntry];
  }

  logger.info({ operation, providerId: providerData.providerId, entryKey, entryCount: newList.length }, "Syncing provider to CLIProxyAPI (flat-list)");

  const putRes = await fetchWithTimeout(`${managementUrl}${managementPath}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secretKey}`
    },
    body: JSON.stringify(newList)
  });

  if (!putRes.ok) {
    const errorBody = await putRes.text().catch(() => "unreadable");
    logger.error({ status: putRes.status, errorBody }, `Failed to sync flat-list provider to Management API (${operation})`);
    return {
      syncStatus: "failed",
      syncMessage: `Backend sync failed - provider ${operation === "create" ? "created" : "updated"} but may not work immediately`
    };
  }

  return { syncStatus: "ok" };
}
