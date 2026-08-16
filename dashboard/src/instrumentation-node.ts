/**
 * Node.js-only instrumentation — imported conditionally from instrumentation.ts.
 * Starts a periodic quota alert checker with a configurable interval.
 * Both the check interval and alert cooldown are read from DB settings.
 */

import { runAlertCheck, getCheckIntervalMs } from "@/lib/quota-alerts";
import { resyncCustomProviders } from "@/lib/providers/resync";
import { runKeyHealthCheck, getKeyHealthIntervalMs } from "@/lib/key-health/check";
import { logger } from "@/lib/logger";

// Idempotency guard for HMR in dev — prevents duplicate intervals
const globalForScheduler = globalThis as typeof globalThis & {
  __quotaSchedulerRegistered?: boolean;
  __keyHealthSchedulerRegistered?: boolean;
};

function scheduleTimeout(callback: () => void | Promise<void>, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

export function registerNodeInstrumentation() {
  if (globalForScheduler.__quotaSchedulerRegistered) return;
  globalForScheduler.__quotaSchedulerRegistered = true;

  // Delay start to let the server fully initialize
  const STARTUP_DELAY_MS = 30_000; // 30 seconds

  scheduleTimeout(() => {
    startQuotaAlertScheduler();
  }, STARTUP_DELAY_MS);

  scheduleTimeout(() => {
    resyncCustomProviders().catch((err) => {
      logger.error({ err }, "Startup custom provider resync failed");
    });
  }, 15_000);

  scheduleTimeout(() => {
    startKeyHealthScheduler();
  }, STARTUP_DELAY_MS);
}

function startQuotaAlertScheduler() {
  let isRunning = false;

  const run = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const managementKey = process.env.MANAGEMENT_API_KEY;
      if (!managementKey) {
        logger.warn("Quota alert scheduler: MANAGEMENT_API_KEY not set, skipping");
        return;
      }

      const port = process.env.PORT ?? "3000";
      const baseUrl = process.env.NEXTAUTH_URL ?? process.env.DASHBOARD_URL ?? `http://localhost:${port}`;

      const quotaFetcher = async () => {
        try {
          const res = await fetch(`${baseUrl}/api/quota`, {
            headers: { "X-Internal-Key": managementKey },
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) return null;
          return res.json();
        } catch {
          return null;
        }
      };

      const result = await runAlertCheck(quotaFetcher, baseUrl);

      if (result.alertsSent && result.alertsSent > 0) {
        logger.info(
          { alertsSent: result.alertsSent },
          "Scheduled quota alert check: alerts sent"
        );
      }
    } catch (error) {
      // Log but never crash — scheduler errors must not take down the server
      logger.error({ error }, "Quota alert scheduler error");
    } finally {
      isRunning = false;
    }
  };

  // Use recursive setTimeout so interval can be re-read from DB each cycle
  const scheduleNext = async () => {
    await run();
    try {
      const intervalMs = await getCheckIntervalMs();
      scheduleTimeout(scheduleNext, intervalMs);
    } catch {
      // Fallback to 5 minutes if DB read fails
      scheduleTimeout(scheduleNext, 5 * 60 * 1000);
    }
  };

  scheduleNext();
}

function startKeyHealthScheduler() {
  let isRunning = false;

  const run = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const summary = await runKeyHealthCheck();
      if (summary.checked) {
        logger.info(
          {
            probed: summary.probedCount,
            disabled: summary.disabledKeys.length,
            resync: summary.resyncStatus,
          },
          "Scheduled key health check completed"
        );
      }
    } catch (error) {
      // Log but never crash — scheduler errors must not take down the server
      logger.error({ error }, "Key health scheduler error");
    } finally {
      isRunning = false;
    }
  };

  // Use recursive setTimeout so interval can be re-read from DB each cycle
  const scheduleNext = async () => {
    await run();
    try {
      const intervalMs = await getKeyHealthIntervalMs();
      scheduleTimeout(scheduleNext, intervalMs);
    } catch {
      // Fallback to 60 minutes if DB read fails
      scheduleTimeout(scheduleNext, 60 * 60 * 1000);
    }
  };

  scheduleNext();
}
