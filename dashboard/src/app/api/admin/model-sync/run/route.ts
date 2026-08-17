import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { runModelSync } from "@/lib/model-sync/check";

export async function POST(request: NextRequest) {
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

  const originError = validateOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const summary = await runModelSync({ force: true });

    logAuditAsync({
      userId: session.userId,
      action: AUDIT_ACTION.SETTINGS_CHANGED,
      target: "model_sync",
      metadata: {
        manualRun: true,
        synced: summary.syncedCount,
        skipped: summary.skippedCount,
        failed: summary.failedCount,
      },
      ipAddress: extractIpAddress(request),
    });

    return NextResponse.json({
      checked: summary.checked,
      syncedCount: summary.syncedCount,
      skippedCount: summary.skippedCount,
      failedCount: summary.failedCount,
      providerResults: summary.providerResults,
    });
  } catch (error) {
    return Errors.internal("run model sync", error);
  }
}
