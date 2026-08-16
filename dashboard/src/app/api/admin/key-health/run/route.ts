import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { runKeyHealthCheck } from "@/lib/key-health/check";

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
    // Manual run always executes, even if the feature is disabled.
    const summary = await runKeyHealthCheck({ force: true });

    logAuditAsync({
      userId: session.userId,
      action: AUDIT_ACTION.SETTINGS_CHANGED,
      target: "key_health",
      metadata: {
        manualRun: true,
        probed: summary.probedCount,
        disabled: summary.disabledKeys.length,
        resync: summary.resyncStatus,
      },
      ipAddress: extractIpAddress(request),
    });

    return NextResponse.json({
      checked: summary.checked,
      settings: summary.settings,
      probedCount: summary.probedCount,
      okCount: summary.okCount,
      invalidCount: summary.invalidCount,
      unreachableCount: summary.unreachableCount,
      disabledKeys: summary.disabledKeys,
      resyncStatus: summary.resyncStatus,
    });
  } catch (error) {
    return Errors.internal("run key health check", error);
  }
}
