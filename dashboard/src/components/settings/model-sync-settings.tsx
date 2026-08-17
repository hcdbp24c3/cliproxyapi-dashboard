"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { useAuth } from "@/hooks/use-auth";

interface ModelSyncSettingsData {
  enabled: boolean;
  intervalMinutes: number;
}

interface ModelSyncRunResult {
  checked: boolean;
  syncedCount: number;
  skippedCount: number;
  failedCount: number;
  providerResults: Array<{
    providerId: string;
    name: string;
    status: "ok" | "skipped" | "failed";
    reason?: string;
  }>;
}

export function ModelSyncSettings() {
  const { showToast } = useToast();
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.isAdmin ?? false;
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<ModelSyncSettingsData>({
    enabled: false,
    intervalMinutes: 60,
  });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<ModelSyncRunResult | null>(null);

  const t = useTranslations("modelSync");

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      setLoaded(true);
      return;
    }

    const init = async () => {
      try {
        const res = await fetch(API_ENDPOINTS.ADMIN.MODEL_SYNC);
        if (res.ok) {
          const data = await res.json();
          setSettings({
            enabled: data.enabled ?? false,
            intervalMinutes: data.intervalMinutes ?? 60,
          });
        }
      } catch {
      } finally {
        setLoaded(true);
      }
    };
    init();
  }, [isAdmin, authLoading]);

  if (authLoading || !loaded || !isAdmin) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(API_ENDPOINTS.ADMIN.MODEL_SYNC, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          intervalMinutes: settings.intervalMinutes,
        }),
      });
      if (res.ok) {
        showToast(t("toastSettingsSaved"), "success");
      } else {
        const errData = await res.json();
        const msg = errData?.error?.message ?? errData?.error ?? "Failed to save";
        showToast(msg, "error");
      }
    } catch {
      showToast(t("toastFailedToSave"), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch(API_ENDPOINTS.ADMIN.MODEL_SYNC_RUN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const msg = errData?.error?.message ?? errData?.error ?? "Sync failed";
        showToast(msg, "error");
        return;
      }
      const data = await res.json();
      setRunResult(data);
      showToast(t("toastSyncCompleted"), "success");
    } catch {
      showToast(t("toastSyncFailed"), "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">{t("sectionTitle")}</h2>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t("sectionDescription")}</p>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            onClick={() => setSettings((s) => ({ ...s, enabled: !s.enabled }))}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
              settings.enabled
                ? "bg-blue-500/100 border-blue-500"
                : "bg-[var(--surface-muted)] border-[var(--surface-border)]"
            )}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface-base)] transition-transform",
                settings.enabled ? "translate-x-4" : "translate-x-0.5"
              )}
            />
          </button>
          <span className="text-xs text-[var(--text-secondary)]">{t("enableLabel")}</span>
        </label>

        <div className="space-y-1">
          <label htmlFor="ms-interval" className="text-xs font-medium text-[var(--text-muted)]">{t("intervalLabel")}</label>
          <Input
            type="number"
            name="ms-interval"
            value={String(settings.intervalMinutes)}
            onChange={(v) => {
              const num = parseInt(v, 10);
              if (!Number.isNaN(num) && num >= 1 && num <= 1440) {
                setSettings((s) => ({ ...s, intervalMinutes: num }));
              } else if (v === "") {
                setSettings((s) => ({ ...s, intervalMinutes: 1 }));
              }
            }}
            placeholder="60"
          />
          <p className="text-[10px] text-[var(--text-muted)]">{t("intervalHint")}</p>
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("buttonSaving") : t("buttonSave")}
          </Button>
          <Button variant="secondary" onClick={handleRunNow} disabled={running}>
            {running ? t("buttonRunning") : t("buttonRunNow")}
          </Button>
        </div>

        {runResult && (
          <div className="rounded-sm border border-[var(--surface-border)] bg-[var(--surface-muted)] p-3 text-xs text-[var(--text-secondary)]">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{t("resultSynced", { count: runResult.syncedCount })}</span>
              <span>{t("resultSkipped", { count: runResult.skippedCount })}</span>
              <span>{t("resultFailed", { count: runResult.failedCount })}</span>
            </div>
            {runResult.providerResults.length > 0 && (
              <div className="mt-2">
                <ul className="list-inside list-disc space-y-0.5">
                  {runResult.providerResults.map((r) => (
                    <li key={r.providerId}>
                      {r.name}: {r.status}{r.reason ? ` (${r.reason})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
