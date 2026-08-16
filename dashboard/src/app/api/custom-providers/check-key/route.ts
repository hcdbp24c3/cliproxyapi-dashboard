import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { z } from "zod";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { FetchModelsSchema } from "@/lib/validation/schemas";
import { apiSuccess, Errors } from "@/lib/errors";
import { fetchUpstreamModels } from "@/lib/providers/upstream-check";

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimitWithPreset(request, "custom-providers-check-key", "CUSTOM_PROVIDERS");
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
    const validated = FetchModelsSchema.parse(body);

    const result = await fetchUpstreamModels(validated.baseUrl, validated.apiKey);

    switch (result.status) {
      case "success":
      case "empty":
      case "invalid-format":
        // A 2xx response from the upstream means the API key was accepted.
        return apiSuccess({ valid: true });

      case "unauthorized":
        return apiSuccess({ valid: false, message: "Invalid API key" });

      case "invalid-url":
        return apiSuccess({ valid: false, message: "Invalid URL" });

      case "blocked":
        return apiSuccess({ valid: false, message: "Cannot connect to private or localhost addresses" });

      case "dns-failed":
        return apiSuccess({ valid: false, message: "Could not resolve hostname" });

      case "not-found":
        return apiSuccess({ valid: false, message: "Models endpoint not found" });

      case "http-error":
        return apiSuccess({ valid: false, message: `Upstream returned HTTP ${result.httpStatus}` });

      case "timeout":
        return apiSuccess({ valid: false, message: "Request timed out. The provider may be unreachable." });

      case "network-error":
        return apiSuccess({ valid: false, message: result.message });
    }

  } catch (error) {
    if (error instanceof z.ZodError) {
      return Errors.zodValidation(error.issues);
    }
    return Errors.internal("POST /api/custom-providers/check-key error", error);
  }
}
