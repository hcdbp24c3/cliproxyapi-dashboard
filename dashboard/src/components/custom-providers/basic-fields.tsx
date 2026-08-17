"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface BasicFieldsProps {
  name: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  prefix: string;
  proxyUrl: string;
  isEdit: boolean;
  saving: boolean;
  checkingKey: boolean;
  keysMode: "replace" | "append";
  errors: {
    name: string;
    providerId: string;
    baseUrl: string;
  };
  onNameChange: (value: string) => void;
  onProviderIdChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onPrefixChange: (value: string) => void;
  onProxyUrlChange: (value: string) => void;
  onKeysModeChange: (mode: "replace" | "append") => void;
  onCheckKey: () => void;
  apiType?: string;
  autoUpdateModels?: boolean;
  cloak?: boolean;
  onApiTypeChange?: (value: string) => void;
  onAutoUpdateModelsChange?: (value: boolean) => void;
  onCloakChange?: (value: boolean) => void;
}

export function BasicFields({
  name,
  providerId,
  baseUrl,
  apiKey,
  prefix,
  proxyUrl,
  isEdit,
  saving,
  checkingKey,
  keysMode,
  errors,
  onNameChange,
  onProviderIdChange,
  onBaseUrlChange,
  onApiKeyChange,
  onPrefixChange,
  onProxyUrlChange,
  onKeysModeChange,
  onCheckKey,
  apiType = "openai-compatible",
  autoUpdateModels = false,
  cloak = false,
  onApiTypeChange,
  onAutoUpdateModelsChange,
  onCloakChange,
}: BasicFieldsProps) {
  const t = useTranslations("providers");
  const [showKeys, setShowKeys] = useState(false);

  const apiKeyLines = apiKey
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const handleDedupeKeys = () => {
    const seen = new Set<string>();
    const deduped = apiKeyLines.filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
    onApiKeyChange(deduped.join("\n"));
  };

  return (
    <>
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-semibold text-[var(--text-primary)]">
          {t("fieldNameLabel")} <span className="text-red-600">*</span>
        </label>
        <Input
          type="text"
          name="name"
          value={name}
          onChange={onNameChange}
          placeholder={t("fieldNamePlaceholder")}
          required
          disabled={saving}
        />
        {errors.name && <p className="mt-1.5 text-xs text-red-600">{errors.name}</p>}
      </div>

      <div>
        <label htmlFor="providerId" className="mb-2 block text-sm font-semibold text-[var(--text-primary)]">
          {t("fieldProviderIdLabel")} <span className="text-red-600">*</span>
        </label>
        <Input
          type="text"
          name="providerId"
          value={providerId}
          onChange={onProviderIdChange}
          placeholder={t("fieldProviderIdPlaceholder")}
          required
          disabled={saving || isEdit}
          className={isEdit ? "opacity-60 cursor-not-allowed" : ""}
        />
        {errors.providerId && <p className="mt-1.5 text-xs text-red-600">{errors.providerId}</p>}
        {!errors.providerId && <p className="mt-1.5 text-xs text-[var(--text-muted)]">{t("fieldProviderIdHint")} {isEdit ? t("fieldProviderIdHintEdit") : t("fieldProviderIdHintNew")}</p>}
      </div>

      <div>
        <label htmlFor="baseUrl" className="mb-2 block text-sm font-semibold text-[var(--text-primary)]">
          {t("fieldBaseUrlLabel")} <span className="text-red-600">*</span>
        </label>
        <Input
          type="text"
          name="baseUrl"
          value={baseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("fieldBaseUrlPlaceholder")}
          required
          disabled={saving}
        />
        {errors.baseUrl && <p className="mt-1.5 text-xs text-red-600">{errors.baseUrl}</p>}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor="apiKey" className="block text-sm font-semibold text-[var(--text-primary)]">
            {t("fieldApiKeyLabel")}
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowKeys(!showKeys)}
              disabled={saving}
              className="flex items-center gap-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={showKeys ? t("fieldApiKeyHideButton") : t("fieldApiKeyShowButton")}
            >
              {showKeys ? (
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              ) : (
                <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              )}
              {showKeys ? t("fieldApiKeyHideButton") : t("fieldApiKeyShowButton")}
            </button>
            <button
              type="button"
              onClick={handleDedupeKeys}
              disabled={saving || apiKeyLines.length < 2}
              className="text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("fieldApiKeyDedupeButton")}
            </button>
            <button
              type="button"
              onClick={onCheckKey}
              disabled={saving || checkingKey}
              className="text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {checkingKey ? t("fieldApiKeyCheckingButton") : t("fieldApiKeyCheckButton")}
            </button>
          </div>
        </div>
        <Textarea
          name="apiKey"
          value={apiKey}
          onChange={onApiKeyChange}
          placeholder={isEdit ? t("fieldApiKeyEditPlaceholder") : t("fieldApiKeyPlaceholder")}
          rows={1}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          className={showKeys ? "[field-sizing:content] min-h-[38px]" : "[field-sizing:content] min-h-[38px] [text-security:disc] [-webkit-text-security:disc]"}
        />
        {isEdit && apiKeyLines.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border/60 bg-background/50 px-3 py-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">{t("fieldApiKeyModeLabel")}</span>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-primary)]">
              <input
                type="radio"
                name="keysMode"
                checked={keysMode === "replace"}
                onChange={() => onKeysModeChange("replace")}
                disabled={saving}
                className="h-3.5 w-3.5"
              />
              {t("fieldApiKeyModeReplace")}
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-primary)]">
              <input
                type="radio"
                name="keysMode"
                checked={keysMode === "append"}
                onChange={() => onKeysModeChange("append")}
                disabled={saving}
                className="h-3.5 w-3.5"
              />
              {t("fieldApiKeyModeAppend")}
            </label>
          </div>
        )}
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">{isEdit ? t("fieldApiKeyEditHint") : t("fieldApiKeyOptionalHint")}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{t("fieldApiKeyLinesHint")}</p>
      </div>

      <div>
        <label htmlFor="prefix" className="mb-2 block text-sm font-semibold text-[var(--text-primary)]">
          {t("fieldPrefixLabel")}
        </label>
        <Input
          type="text"
          name="prefix"
          value={prefix}
          onChange={onPrefixChange}
          placeholder={t("fieldPrefixPlaceholder")}
          disabled={saving}
        />
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">{t("fieldPrefixHint")}</p>
      </div>

      <div>
        <label htmlFor="proxyUrl" className="mb-2 block text-sm font-semibold text-[var(--text-primary)]">
          {t("fieldProxyUrlLabel")}
        </label>
        <Input
          type="text"
          name="proxyUrl"
          value={proxyUrl}
          onChange={onProxyUrlChange}
          placeholder={t("fieldProxyUrlPlaceholder")}
          disabled={saving}
        />
      </div>

      {/* API Type + Options */}
      <div className="space-y-3 rounded-md border border-[var(--surface-border)] bg-[var(--surface-muted)] p-3">
        <div className="space-y-1">
          <label htmlFor="apiType" className="text-xs font-medium text-[var(--text-muted)]">
            {t("apiTypeLabel")}
          </label>
          <select
            id="apiType"
            value={apiType}
            onChange={(e) => onApiTypeChange?.(e.target.value)}
            disabled={saving || isEdit}
            className={`w-full rounded-md border border-[var(--surface-border)] bg-[var(--surface-base)] px-3 py-1.5 text-sm text-[var(--text-primary)] ${isEdit ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            <option value="openai-compatible">{t("apiTypes.openaiCompatible")}</option>
            <option value="claude">{t("apiTypes.claude")}</option>
            <option value="gemini">{t("apiTypes.gemini")}</option>
            <option value="codex">{t("apiTypes.codex")}</option>
            <option value="vertex">{t("apiTypes.vertex")}</option>
            <option value="xai">{t("apiTypes.xai")}</option>
            <option value="interactions">{t("apiTypes.interactions")}</option>
          </select>
          {isEdit && <p className="text-[10px] text-[var(--text-muted)]">{t("apiTypeEditHint")}</p>}
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <button
            type="button"
            role="switch"
            aria-checked={autoUpdateModels}
            onClick={() => onAutoUpdateModelsChange?.(!autoUpdateModels)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
              autoUpdateModels
                ? "bg-blue-500/100 border-blue-500"
                : "bg-[var(--surface-muted)] border-[var(--surface-border)]"
            )}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface-base)] transition-transform",
                autoUpdateModels ? "translate-x-4" : "translate-x-0.5"
              )}
            />
          </button>
          <span className="text-xs text-[var(--text-secondary)]">{t("autoUpdateModelsLabel")}</span>
        </label>
        <p className="text-[10px] text-[var(--text-muted)]">{t("autoUpdateModelsHint")}</p>

        {apiType !== "openai-compatible" && (
          <label className="flex items-center gap-2 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={cloak}
              onClick={() => onCloakChange?.(!cloak)}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
                cloak
                  ? "bg-blue-500/100 border-blue-500"
                  : "bg-[var(--surface-muted)] border-[var(--surface-border)]"
              )}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface-base)] transition-transform",
                  cloak ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </button>
            <span className="text-xs text-[var(--text-secondary)]">{t("cloakLabel")}</span>
          </label>
        )}
        {apiType !== "openai-compatible" && (
          <p className="text-[10px] text-[var(--text-muted)]">{t("cloakHint")}</p>
        )}
      </div>
    </>
  );
}
