import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { getUser } from "@/lib/auth/dal";
import { verifyPassword } from "@/lib/auth/password";
import { isUserAdmin } from "@/lib/auth/admin";
import { decryptProviderKey } from "@/lib/providers/encrypt";
import { logger } from "@/lib/logger";
import { fetchUpstreamModels, mapUpstreamResultToStatus } from "@/lib/providers/upstream-check";
import { apiError, apiSuccess, Errors, ERROR_CODE } from "@/lib/errors";

export type KeyStatus = "ok" | "invalid" | "unreachable" | "disabled" | "unknown";

export interface ManagedKey {
  id: string;
  apiKey: string;
  enabled: boolean;
  weight: number | null;
  proxyUrl: string | null;
  status: KeyStatus;
  message?: string;
  autoDisabledAt?: string | null;
  autoDisableReason?: string | null;
}

const KeysPasswordSchema = z.object({
  password: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const rateLimit = checkRateLimitWithPreset(request, "custom-providers-keys", "CUSTOM_PROVIDERS");
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
    const validated = KeysPasswordSchema.parse(body);

    const provider = await prisma.customProvider.findUnique({
      where: { id },
      include: { keys: true }
    });

    if (!provider) {
      return Errors.notFound("Provider");
    }

    const isAdmin = await isUserAdmin(session.userId);
    const isOwner = provider.userId === session.userId;

    // Keys are sensitive material: only the provider owner or an admin may
    // list them, and they must re-authenticate with their password first.
    if (!isOwner && !isAdmin) {
      return Errors.forbidden();
    }

    const user = await getUser(session.userId);
    if (!user) {
      return apiError(ERROR_CODE.USER_NOT_FOUND, "User not found", 404);
    }

    const passwordValid = await verifyPassword(validated.password, user.passwordHash);
    if (!passwordValid) {
      return apiError(ERROR_CODE.AUTH_FAILED, "Invalid password", 401);
    }

    // Decrypt + probe each stored key. Disabled keys and legacy hash-only keys
    // are reported without an upstream call; enabled keys are validated in
    // parallel against the provider's /models endpoint.
    const managedKeys: ManagedKey[] = await Promise.all(
      provider.keys
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(async (key): Promise<ManagedKey> => {
          const base = {
            id: key.id,
            apiKey: "",
            enabled: key.enabled,
            weight: key.weight,
            proxyUrl: key.proxyUrl,
          };

          if (!key.enabled) {
            return {
              ...base,
              status: "disabled",
              autoDisabledAt: key.autoDisabledAt?.toISOString() ?? null,
              autoDisableReason: key.autoDisableReason,
            };
          }

          if (!key.apiKeyEncrypted) {
            return { ...base, status: "unknown", message: "No encrypted copy stored" };
          }

          const decrypted = decryptProviderKey(key.apiKeyEncrypted);
          if (!decrypted) {
            logger.error({ providerId: provider.providerId, keyId: key.id }, "Failed to decrypt stored API key");
            return { ...base, status: "unknown", message: "Failed to decrypt stored API key" };
          }

          const result = await fetchUpstreamModels(provider.baseUrl, decrypted);
          const { status, message } = mapUpstreamResultToStatus(result);
          return { ...base, apiKey: decrypted, status, message };
        })
    );

    return apiSuccess({ keys: managedKeys });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return Errors.zodValidation(error.issues);
    }
    return Errors.internal("POST /api/custom-providers/[id]/keys error", error);
  }
}
