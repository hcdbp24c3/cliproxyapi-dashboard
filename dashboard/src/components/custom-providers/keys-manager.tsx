"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Modal, ModalHeader, ModalTitle, ModalContent, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { extractApiError } from "@/lib/utils";

type KeyStatus = "ok" | "invalid" | "unreachable" | "disabled" | "unknown";

interface ManagedKey {
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

interface KeysManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  providerId: string;
  providerName: string;
}

const statusStyles: Record<KeyStatus, string> = {
  ok: "bg-emerald-500/10 text-emerald-600",
  invalid: "bg-red-500/10 text-red-600",
  unreachable: "bg-amber-500/10 text-amber-600",
  disabled: "bg-gray-500/10 text-gray-500",
  unknown: "bg-gray-500/10 text-gray-500",
};

export function KeysManagerModal({ isOpen, onClose, providerId, providerName }: KeysManagerModalProps) {
  const t = useTranslations("providers");
  const { showToast } = useToast();

  const [password, setPassword] = useState("");
  const [keys, setKeys] = useState<ManagedKey[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPassword("");
      setKeys(null);
      setRevealedKeys(new Set());
      setTogglingId(null);
    }
  }, [isOpen]);

  const loadKeys = async () => {
    if (!password) {
      showToast(t("keysManagerPasswordRequired"), "error");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(API_ENDPOINTS.CUSTOM_PROVIDERS.KEYS(providerId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        const data = await response.json();
        setKeys(data.keys ?? []);
        setRevealedKeys(new Set());
      } else {
        let data: unknown = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        showToast(extractApiError(data, t("keysManagerLoadFailed")), "error");
      }
    } catch {
      showToast(t("toastNetworkError"), "error");
    } finally {
      setLoading(false);
    }
  };

  const toggleKey = async (keyId: string, enabled: boolean) => {
    setTogglingId(keyId);
    try {
      const response = await fetch(API_ENDPOINTS.CUSTOM_PROVIDERS.KEY(providerId, keyId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      if (response.ok) {
        const data = await response.json();
        setKeys((prev) =>
          prev ? prev.map((k) => (k.id === keyId ? { ...k, enabled: data.key?.enabled ?? enabled } : k)) : prev
        );
        showToast(enabled ? t("keysManagerEnabledToast") : t("keysManagerDisabledToast"), "success");
      } else {
        let data: unknown = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        showToast(extractApiError(data, t("keysManagerToggleFailed")), "error");
      }
    } catch {
      showToast(t("toastNetworkError"), "error");
    } finally {
      setTogglingId(null);
    }
  };

  const toggleReveal = (keyId: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) {
        next.delete(keyId);
      } else {
        next.add(keyId);
      }
      return next;
    });
  };

  const copyKey = async (apiKey: string) => {
    try {
      await navigator.clipboard.writeText(apiKey);
      showToast(t("keysManagerCopiedToast"), "success");
    } catch {
      showToast(t("keysManagerCopyFailedToast"), "error");
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} className="max-w-2xl">
      <ModalHeader>
        <ModalTitle>{t("keysManagerTitle", { name: providerName })}</ModalTitle>
      </ModalHeader>

      <ModalContent>
        {keys === null ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">{t("keysManagerPasswordHint")}</p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) void loadKeys();
              }}
              placeholder={t("keysManagerPasswordPlaceholder")}
              autoComplete="current-password"
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{t("keysManagerEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {keys.map((key) => {
              const revealed = revealedKeys.has(key.id);
              return (
                <div
                  key={key.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-muted)] p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="truncate font-mono text-xs text-[var(--text-primary)]">
                        {revealed ? key.apiKey : "•".repeat(Math.min(key.apiKey.length || 24, 24))}
                      </code>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusStyles[key.status]}`}
                      >
                        {t(`keysManagerStatus_${key.status}`)}
                      </span>
                      {key.autoDisabledAt && (
                        <span
                          className="shrink-0 rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-600"
                          title={key.autoDisableReason ?? undefined}
                        >
                          {t("keysManagerAutoDisabled")}
                        </span>
                      )}
                    </div>
                    {key.message && <p className="mt-1 text-xs text-[var(--text-muted)]">{key.message}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      disabled={!key.apiKey}
                      onClick={() => toggleReveal(key.id)}
                      className="px-2.5 py-1 text-xs"
                    >
                      {revealed ? t("keysManagerHideKey") : t("keysManagerShowKey")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!key.apiKey}
                      onClick={() => void copyKey(key.apiKey)}
                      className="px-2.5 py-1 text-xs"
                    >
                      {t("keysManagerCopy")}
                    </Button>
                    <Button
                      variant={key.enabled ? "danger" : "secondary"}
                      disabled={togglingId === key.id}
                      onClick={() => void toggleKey(key.id, !key.enabled)}
                      className="px-2.5 py-1 text-xs"
                    >
                      {togglingId === key.id
                        ? t("keysManagerToggling")
                        : key.enabled
                          ? t("keysManagerDisable")
                          : t("keysManagerEnable")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ModalContent>

      <ModalFooter>
        {keys !== null && (
          <Button variant="secondary" onClick={() => setKeys(null)}>
            {t("keysManagerReload")}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t("customProviderCancelButton")}
        </Button>
        {keys === null && (
          <Button onClick={() => void loadKeys()} disabled={loading || !password}>
            {loading ? t("keysManagerLoading") : t("keysManagerUnlock")}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
