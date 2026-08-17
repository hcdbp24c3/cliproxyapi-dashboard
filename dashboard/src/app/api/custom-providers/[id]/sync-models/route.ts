import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { fetchUpstreamModels } from "@/lib/providers/upstream-check";
import { decryptProviderKey } from "@/lib/providers/encrypt";
import type { CustomProviderApiType } from "@/lib/providers/api-types";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  const { id } = await params;

  const provider = await prisma.customProvider.findUnique({
    where: { id },
    include: { keys: true },
  });

  if (!provider) {
    return Errors.notFound("Provider not found");
  }

  if (provider.userId !== session.userId) {
    return Errors.forbidden();
  }

  try {
    const enabledKey = provider.keys.find(
      (k) => k.enabled && k.apiKeyEncrypted
    );
    const decryptedKey = enabledKey?.apiKeyEncrypted
      ? decryptProviderKey(enabledKey.apiKeyEncrypted) ?? undefined
      : undefined;

    const apiType = provider.apiType as CustomProviderApiType;
    const result = await fetchUpstreamModels(
      provider.baseUrl,
      decryptedKey,
      { apiType }
    );

    if (result.status !== "success" || !result.models) {
      return Errors.validation(
        `Upstream fetch failed: ${result.status}`
      );
    }

    // Clear existing mappings and re-add all upstream models
    await prisma.customProviderModel.deleteMany({
      where: { customProviderId: provider.id },
    });

    if (result.models.length > 0) {
      await prisma.customProviderModel.createMany({
        data: result.models.map((m) => ({
          customProviderId: provider.id,
          upstreamName: m.id,
          alias: m.name || m.id,
        })),
      });
    }

    await prisma.customProvider.update({
      where: { id: provider.id },
      data: { lastModelsSyncAt: new Date() },
    });

    return NextResponse.json({
      models: result.models.map((m) => m.id),
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    return Errors.internal("sync models for provider", error);
  }
}
