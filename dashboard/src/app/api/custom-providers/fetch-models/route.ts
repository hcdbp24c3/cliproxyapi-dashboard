import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { z } from "zod";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { FetchModelsSchema } from "@/lib/validation/schemas";
import { apiError, Errors, ERROR_CODE } from "@/lib/errors";
import { fetchUpstreamModels } from "@/lib/providers/upstream-check";

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimitWithPreset(request, "custom-providers-fetch-models", "CUSTOM_PROVIDERS");
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

    const result = await fetchUpstreamModels(validated.baseUrl, validated.apiKey, {
      apiType: validated.apiType,
    });

    switch (result.status) {
      case "success":
        return NextResponse.json({ models: result.models });
      case "invalid-url":
        return Errors.validation("Invalid URL");
      case "blocked":
        return Errors.validation("Cannot connect to private or localhost addresses");
      case "dns-failed":
        return Errors.validation("Could not resolve hostname");
      case "unauthorized":
        return Errors.invalidCredentials();
      case "not-found":
        return Errors.notFound("Models endpoint");
      case "empty":
        return Errors.notFound("Models");
      case "invalid-format":
        return Errors.internal("Invalid response format from provider");
      case "http-error":
        return Errors.badGateway(`Failed to fetch models (HTTP ${result.httpStatus})`);
      case "timeout":
        return Errors.gatewayTimeout("Request timed out. The provider may be unreachable.");
      case "network-error":
        return apiError(ERROR_CODE.UPSTREAM_ERROR, result.message, 503);
    }

  } catch (error) {
    if (error instanceof z.ZodError) {
      return Errors.zodValidation(error.issues);
    }
    return Errors.internal("POST /api/custom-providers/fetch-models error", error);
  }
}
