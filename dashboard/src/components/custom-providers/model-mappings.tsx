"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ModelMapping {
  _id: number;
  upstreamName: string;
  alias: string;
}

interface ModelMappingsProps {
  models: ModelMapping[];
  saving: boolean;
  error: string;
  onAddModelMapping: () => void;
  onRemoveModelMapping: (index: number) => void;
  onDeleteAllModelMappings: () => void;
  onUpdateModelMapping: (index: number, field: "upstreamName" | "alias", value: string) => void;
}

export function ModelMappings({
  models,
  saving,
  error,
  onAddModelMapping,
  onRemoveModelMapping,
  onDeleteAllModelMappings,
  onUpdateModelMapping,
}: ModelMappingsProps) {
  const t = useTranslations("providers");
  const filledCount = models.filter((m) => m.upstreamName && m.alias).length;

  return (
    <div>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
            {t("modelMappingsLabel")} <span className="text-red-500">*</span>
            <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs font-normal text-[var(--text-muted)]">
              {filledCount}
            </span>
          </span>
          <span className="text-sm text-[var(--text-muted)] transition-transform duration-200 group-open:rotate-90">▸</span>
        </summary>
        <div className="mt-2 space-y-2">
          {models.map((model, idx) => (
            <div key={model._id} className="flex gap-2">
              <Input
                type="text"
                name={`model-upstream-${idx}`}
                value={model.upstreamName}
                onChange={(val) => onUpdateModelMapping(idx, "upstreamName", val)}
                placeholder={t("modelUpstreamPlaceholder")}
                disabled={saving}
                className="flex-1"
              />
              <Input
                type="text"
                name={`model-alias-${idx}`}
                value={model.alias}
                onChange={(val) => onUpdateModelMapping(idx, "alias", val)}
                placeholder={t("modelAliasPlaceholder")}
                disabled={saving}
                className="flex-1"
              />
              {models.length > 1 && (
                <Button variant="danger" onClick={() => onRemoveModelMapping(idx)} className="px-3 shrink-0" disabled={saving}>
                  ✕
                </Button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={onAddModelMapping} className="px-3 py-1.5 text-xs" disabled={saving}>
              {t("addModelButton")}
            </Button>
            <Button variant="ghost" onClick={onDeleteAllModelMappings} className="px-3 py-1.5 text-xs text-red-500 hover:text-red-400" disabled={saving}>
              {t("deleteAllModelsButton")}
            </Button>
          </div>
        </div>
      </details>
      {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}
      {!error && <p className="mt-1.5 text-xs text-[var(--text-muted)]">{t("modelMappingsHint")}</p>}
    </div>
  );
}
