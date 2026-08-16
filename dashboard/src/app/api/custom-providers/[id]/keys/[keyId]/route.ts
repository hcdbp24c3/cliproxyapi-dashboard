import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { isUserAdmin } from "@/lib/auth/admin";
import { decryptProviderKey } from "@/lib/providers/encrypt";
import { logger } from "@/lib/logger";
import { syncCustomProviderToProxy, type SyncProviderKeyEntry } from "@/lib/providers/custom-provider-sync";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";
import { apiSuccess, Errors } from "@/lib/errors";

const ToggleKeySchema = z.object({
  enabled: z.boolean(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const { id, keyId } = await params;

  const rateLimit = checkRateLimitWithPreset(request, "custom-providers-key-toggle", "CUSTOM_PROVIDERS");
  if (!rateLimit.allowed) {
    return Errors.rateLimited(rateLimit.retryAfterSeconds);
  }

  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  const originError = validateOrigin(request);
  if (originError) return originError;

  try {
    const body = await request.json();
    const validated = ToggleKeySchema.parse(body);

    const provider = await prisma.customProvider.findUnique({
      where: { id },
      include: { keys: true, models: true, excludedModels: true }
    });

    if (!provider) {
      return Errors.notFound("Provider");
    }

    const isAdmin = await isUserAdmin(session.userId);
    const isOwner = provider.userId === session.userId;

    // Only the provider owner or an admin may toggle a provider's keys,
    // matching the ownership convention in `PATCH /api/custom-providers/[id]`.
    if (!isOwner && !isAdmin) {
      return Errors.forbidden();
    }

    const targetKey = provider.keys.find((key) => key.id === keyId);
    if (!targetKey) {
      return Errors.notFound("API key");
    }

    const updatedKey = await prisma.customProviderKey.update({
      where: { id: keyId },
      data: validated.enabled
        ? {
            enabled: true,
            // Manual re-enable clears prior auto-disable state so the key starts
            // a fresh key-health cycle (re-probe from 0 failures).
            autoDisabledAt: null,
            autoDisableReason: null,
            probeFailureCount: 0,
          }
        : { enabled: false }
    });

    // Re-sync the provider so the proxy config reflects the new enabled set.
    // Mirrors the sync/audit flow in `PATCH /api/custom-providers/[id]`.
    const apiKeyEntries: SyncProviderKeyEntry[] = [];
    let syncBlockedReason: string | null = null;

    for (const key of provider.keys) {
      if (key.id === keyId) {
        if (!validated.enabled) continue;
      } else if (!key.enabled) {
        continue;
      }

      if (!key.apiKeyEncrypted) {
        syncBlockedReason = "Provider has a legacy key without an encrypted copy - re-enter the key to enable sync";
        break;
      }

      const decrypted = decryptProviderKey(key.apiKeyEncrypted);
      if (!decrypted) {
        syncBlockedReason = "Failed to decrypt stored API key";
        logger.error({ providerId: provider.providerId, keyId: key.id }, "Failed to decrypt stored API key");
        break;
      }

      apiKeyEntries.push({ apiKey: decrypted, weight: key.weight, proxyUrl: key.proxyUrl });
    }

    let syncStatus: "ok" | "failed" = "ok";
    let syncMessage: string | undefined;

    if (!syncBlockedReason) {
      const syncResult = await syncCustomProviderToProxy({
        providerId: provider.providerId,
        prefix: provider.prefix,
        baseUrl: provider.baseUrl,
        apiKeyEntries,
        proxyUrl: provider.proxyUrl,
        headers: provider.headers as Record<string, string> | null,
        models: provider.models,
        excludedModels: provider.excludedModels
      }, "update");

      syncStatus = syncResult.syncStatus;
      syncMessage = syncResult.syncMessage;
    } else {
      syncStatus = "failed";
      syncMessage = "Backend sync failed - could not retrieve API key for update";
      logger.error("Failed to sync toggled custom provider key: no API key available");
    }

    logAuditAsync({
      userId: session.userId,
      action: AUDIT_ACTION.CUSTOM_PROVIDER_UPDATED,
      target: provider.providerId,
      metadata: {
        providerId: id,
        keyId,
        keyEnabled: validated.enabled,
        name: provider.name,
        ownerUserId: provider.userId,
        actedAsAdmin: !isOwner,
      },
      ipAddress: extractIpAddress(request),
    });

    return apiSuccess({ key: updatedKey, syncStatus, syncMessage });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return Errors.zodValidation(error.issues);
    }
    return Errors.internal("PATCH /api/custom-providers/[id]/keys/[keyId] error", error);
  }
}
