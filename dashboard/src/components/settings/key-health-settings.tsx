"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { useAuth } from "@/hooks/use-auth";

interface KeyHealthSettings {
  enabled: boolean;
  intervalMinutes: number;
  maxRetries: number;
}

interface KeyHealthRunResult {
  checked: boolean;
  probedCount: number;
  okCount: number;
  invalidCount: number;
  unreachableCount: number;
  disabledKeys: Array<{ keyId: string; providerId: string; reason: string }>;
  resyncStatus: "ok" | "failed";
}

export function KeyHealthSettings() {
  const { showToast } = useToast();
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.isAdmin ?? false;
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<KeyHealthSettings>({
    enabled: false,
    intervalMinutes: 60,
    maxRetries: 3,
  });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<KeyHealthRunResult | null>(null);

  const t = useTranslations("keyHealth");

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      setLoaded(true);
      return;
    }

    const init = async () => {
      try {
        const res = await fetch(API_ENDPOINTS.ADMIN.KEY_HEALTH);
        if (res.ok) {
          const data = await res.json();
          setSettings({
            enabled: data.enabled ?? false,
            intervalMinutes: data.intervalMinutes ?? 60,
            maxRetries: data.maxRetries ?? 3,
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
      const res = await fetch(API_ENDPOINTS.ADMIN.KEY_HEALTH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          intervalMinutes: settings.intervalMinutes,
          maxRetries: settings.maxRetries,
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
      const res = await fetch(API_ENDPOINTS.ADMIN.KEY_HEALTH_RUN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const msg = errData?.error?.message ?? errData?.error ?? "Check failed";
        showToast(msg, "error");
        return;
      }
      const data = await res.json();
      setRunResult(data);
      showToast(t("toastCheckCompleted"), "success");
    } catch {
      showToast(t("toastCheckFailed"), "error");
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
          <label htmlFor="kh-interval" className="text-xs font-medium text-[var(--text-muted)]">{t("intervalLabel")}</label>
          <Input
            type="number"
            name="kh-interval"
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

        <div className="space-y-1">
          <label htmlFor="kh-max-retries" className="text-xs font-medium text-[var(--text-muted)]">{t("maxRetriesLabel")}</label>
          <Input
            type="number"
            name="kh-max-retries"
            value={String(settings.maxRetries)}
            onChange={(v) => {
              const num = parseInt(v, 10);
              if (!Number.isNaN(num) && num >= 0 && num <= 10) {
                setSettings((s) => ({ ...s, maxRetries: num }));
              } else if (v === "") {
                setSettings((s) => ({ ...s, maxRetries: 0 }));
              }
            }}
            placeholder="3"
          />
          <p className="text-[10px] text-[var(--text-muted)]">{t("maxRetriesHint")}</p>
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
              <span>{t("resultProbed", { count: runResult.probedCount })}</span>
              <span>{t("resultOk", { count: runResult.okCount })}</span>
              <span>{t("resultInvalid", { count: runResult.invalidCount })}</span>
              <span>{t("resultUnreachable", { count: runResult.unreachableCount })}</span>
            </div>
            {runResult.disabledKeys.length > 0 && (
              <div className="mt-2">
                <div className="font-medium text-[var(--text-primary)]">{t("resultDisabledTitle", { count: runResult.disabledKeys.length })}</div>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {runResult.disabledKeys.map((k) => (
                    <li key={k.keyId}>{k.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {runResult.resyncStatus === "failed" && (
              <div className="mt-2 text-amber-700">{t("resultResyncFailed")}</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
