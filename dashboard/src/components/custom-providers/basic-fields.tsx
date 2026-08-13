"use client";

import { useTranslations } from "next-intl";
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
  errors,
  onNameChange,
  onProviderIdChange,
  onBaseUrlChange,
  onApiKeyChange,
  onPrefixChange,
  onProxyUrlChange,
}: BasicFieldsProps) {
  const t = useTranslations("providers");

  const apiKeyLines = apiKey
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const hasDuplicateKeys = new Set(apiKeyLines).size !== apiKeyLines.length;

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
          {hasDuplicateKeys && (
            <button
              type="button"
              onClick={handleDedupeKeys}
              disabled={saving}
              className="text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("fieldApiKeyDedupeButton")}
            </button>
          )}
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
          className="[field-sizing:content] min-h-[38px]"
        />
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
    </>
  );
}
