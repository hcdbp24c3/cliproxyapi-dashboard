import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getModelSyncSettings } from "@/lib/model-sync/check";

async function requireAdmin(): Promise<
  { userId: string; username: string } | NextResponse
> {
  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { isAdmin: true },
  });

  if (!user?.isAdmin) {
    return Errors.forbidden();
  }

  return { userId: session.userId, username: session.username };
}

export async function GET() {
  const authResult = await requireAdmin();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  try {
    const settings = await getModelSyncSettings();
    return NextResponse.json(settings);
  } catch (error) {
    return Errors.internal("fetch model sync settings", error);
  }
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const originError = validateOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const { enabled, intervalMinutes } = body;

    const updates: Array<{ key: string; value: string }> = [];

    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") {
        return Errors.validation("enabled must be a boolean.");
      }
      updates.push({
        key: "model_sync_enabled",
        value: String(enabled),
      });
    }

    if (intervalMinutes !== undefined) {
      const val = Number(intervalMinutes);
      if (!Number.isInteger(val) || val < 1 || val > 1440) {
        return Errors.validation(
          "intervalMinutes must be an integer between 1 and 1440."
        );
      }
      updates.push({
        key: "model_sync_interval_minutes",
        value: String(val),
      });
    }

    if (updates.length === 0) {
      return Errors.validation("No valid settings provided.");
    }

    await prisma.$transaction(
      updates.map(({ key, value }) =>
        prisma.systemSetting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        })
      )
    );

    logAuditAsync({
      userId: authResult.userId,
      action: AUDIT_ACTION.SETTINGS_CHANGED,
      target: "model_sync",
      metadata: { updatedKeys: updates.map((u) => u.key) },
      ipAddress: extractIpAddress(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return Errors.internal("update model sync settings", error);
  }
}
