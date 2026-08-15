# Spec: Custom Provider API Types + Auto-Update Models

**Status:** Draft (pending user review)
**Date:** 2026-08-15
**Author:** Sisyphus

## 1. Objective

Extend the Dashboard's custom provider feature beyond OpenAI-compatible endpoints and add a scheduled auto-update mechanism for provider model lists.

Two capabilities are delivered together:

1. **Full API type support for custom providers** — users can register custom providers of type `claude`, `gemini`, `codex`, `vertex`, `xai`, and `interactions`, in addition to the existing `openai-compatible` type.
2. **Auto-update models** — a scheduler periodically fetches the upstream model list of opted-in providers and adds newly discovered models to their mapping (keeping existing aliases, never deleting models that disappeared upstream).

## 2. Terminology

| Term | Meaning |
|------|---------|
| API type | The provider protocol family. Maps 1:1 to a CLIProxyAPI config list key. |
| Flat list | CLIProxyAPI key lists whose entries are keyed by `api-key` (claude/gemini/codex/vertex/xai/interactions). |
| Named list | CLIProxyAPI `openai-compatibility` list, keyed by `name`, entries carry nested `api-key-entries`. |
| Upstream models | Model list returned by the provider's models endpoint. |
| Provider mapping | `CustomProviderModel` rows (upstreamName → alias) + `CustomProviderExcludedModel` rows (patterns). |

## 3. Requirements

### 3.1 Functional

R1. A custom provider has exactly one `apiType` among:
     `openai-compatible` (default, backward compatible), `claude`, `gemini`, `codex`, `vertex`, `xai`, `interactions`.
R2. `apiType` is immutable after creation. Changing type requires creating a new provider (schema-level `apiType` is set at creation; PATCH rejects changes).
R3. Sync (create/update/delete/resync) targets the CLIProxyAPI Management API list matching the provider's `apiType`.
R4. Each provider has an `autoUpdateModels` boolean (default `false`) controlling scheduler participation.
R5. A global scheduler setting `modelSync.enabled` + `modelSync.intervalHours` (default: enabled `false`, interval `6h`) controls the periodic job.
R6. The scheduler fetches upstream models per API type, then **only inserts** `CustomProviderModel` rows whose `upstreamName` is not already present. Existing aliases are preserved. No deletions of stale models.
R7. After adding models, the affected provider is resynced to CLIProxyAPI so the new models take effect.
R8. Each provider records `lastModelsSyncAt` for UI display and debugging.
R9. Manual trigger: per-provider "sync models now" (from the provider card/modal) and admin "run now" (Settings page), both invoking the same job as the scheduler.

### 3.2 Non-functional / constraints

N1. Follow existing patterns: settings via `SystemSetting` (see key-health `check.ts`), scheduler via `instrumentation-node.ts` recursive setTimeout with `isRunning` guard and HMR idempotency flag, admin routes `admin/model-sync/route.ts` (GET/PUT) + `admin/model-sync/run/route.ts` (POST).
N2. No `any` types; Zod validation at API boundaries.
N3. All user-facing strings via `next-intl` (`en.json` source of truth, `de.json` mirrored).
N4. Management API round-trips: strip `auth-index` fields returned by GET before PUT (all lists). Entry identity: flat lists match by `api-key` (gemini additionally by `base-url`); named list matches by `name`.
N5. Scheduler must never crash the server: errors logged, cycle continues.
N6. `providerMutex`/`AsyncMutex` (management-api.ts) reused for Management API calls; scheduler is single-instance per process (recursive setTimeout + `isRunning`).

## 4. Design

### 4.1 Schema (Prisma)

File: `dashboard/prisma/schema.prisma`

```prisma
enum CustomProviderApiType {
  openai_compatible
  claude
  gemini
  codex
  vertex
  xai
  interactions
}

model CustomProvider {
  // ...existing fields...
  apiType          CustomProviderApiType @default(openai_compatible)
  autoUpdateModels Boolean              @default(false)
  lastModelsSyncAt DateTime?
}
```

- `CustomProviderModel`, `CustomProviderExcludedModel`, `CustomProviderKey` unchanged — all flat lists support `models`/`excluded-models` per entry (verified in `infrastructure/config/config.yaml`), so existing relations map 1:1.
- Migration: `npx prisma migrate dev --name add_custom_provider_api_type_auto_update`

### 4.2 API type → Management list mapping

| apiType | Management endpoint suffix | Entry identity | Extra fields |
|---------|---------------------------|----------------|--------------|
| `openai-compatible` | `/openai-compatibility` | `name` | `api-key-entries[]`, `headers` |
| `claude` | `/claude-api-key` | `api-key` | `cloak` (bool, optional) |
| `gemini` | `/gemini-api-key` | `api-key` + `base-url` | — |
| `codex` | `/codex-api-key` | `api-key` | — |
| `vertex` | `/vertex-api-key` | `api-key` | — |
| `xai` | `/xai-api-key` | `api-key` | — |
| `interactions` | `/interactions-api-key` | `api-key` | — |

Centralized constant (new file `src/lib/providers/api-types.ts`):

```typescript
export const CUSTOM_PROVIDER_API_TYPES = ["openai-compatible", "claude", "gemini", "codex", "vertex", "xai", "interactions"] as const;
export type CustomProviderApiType = (typeof CUSTOM_PROVIDER_API_TYPES)[number];

export const API_TYPE_MANAGEMENT_PATH: Record<CustomProviderApiType, string> = {
  "openai-compatible": "openai-compatibility",
  claude: "claude-api-key",
  gemini: "gemini-api-key",
  codex: "codex-api-key",
  vertex: "vertex-api-key",
  xai: "xai-api-key",
  interactions: "interactions-api-key",
};

export function isFlatListType(type: CustomProviderApiType): boolean {
  return type !== "openai-compatible";
}
```

### 4.3 Sync layer (`src/lib/providers/custom-provider-sync.ts`)

Extend `SyncProviderData` with `apiType: CustomProviderApiType` (default `"openai-compatible"`).

Refactor `syncCustomProviderToProxy(data, mode)` internals:

1. Resolve management path: `API_TYPE_MANAGEMENT_PATH[data.apiType]`.
2. GET current list (existing `fetchWithTimeout`, `MANAGEMENT_API_KEY` auth).
3. Build the outgoing list:
   - **Flat lists**: entry per enabled key → `{ "api-key", prefix, "base-url", models, "excluded-models", cloak? }`. Entry identity match against existing list by `api-key` (+`base-url` for gemini). Replace matching entries, keep others.
   - **Named list (openai-compatible)**: existing behavior — single entry `{ name: providerId, prefix, "base-url", "api-key-entries", models, "excluded-models", headers }`, matched by `name`.
4. Strip `auth-index` (and any unknown response-only fields) from entries before PUT.
5. PUT the full list.

Update the DELETE path in `src/app/api/custom-providers/[id]/route.ts` (currently hardcodes `/openai-compatibility` at line ~343) to use the provider's `apiType` mapping; for flat lists filter by `api-key` set instead of `name`.

Update `src/lib/providers/resync.ts` to pass `apiType` through.

### 4.4 `fetchUpstreamModels` — type-aware model fetching

File: `src/lib/providers/upstream-check.ts`

Signature: `fetchUpstreamModels(baseUrl, apiKey, options?: { apiType?: CustomProviderApiType })` — default `openai-compatible`.

| apiType | Request | Response parse |
|---------|---------|----------------|
| openai-compatible, codex, xai, interactions | `GET {baseUrl}/models`, `Authorization: Bearer` | `{ data: [{ id }] }` → `[{id}]` |
| claude | `GET {baseUrl}/v1/models`, headers `x-api-key` + `anthropic-version` | `{ data: [{ id }] }` → `[{id}]` |
| gemini, vertex | `GET {baseUrl}/v1beta/models`, header `x-goog-api-key` | `{ models: [{ name: "models/gemini-..." }] }` → strip `models/` prefix → `[{id}]` |

All return the existing `{ models: [{ id }] }` shape so callers are unchanged.

Update `src/app/api/custom-providers/fetch-models/route.ts`: accept `apiType` in the POST body (`{ baseUrl, apiKey, apiType }`), validate via Zod, pass through.

### 4.5 Scheduler (`src/lib/model-sync/` new module)

New directory `src/lib/model-sync/`:

**`settings.ts`** — mirror `key-health/check.ts` settings section:

```typescript
export const MODEL_SYNC_SETTING_KEYS = {
  ENABLED: "model_sync_enabled",
  INTERVAL_HOURS: "model_sync_interval_hours",
} as const;

export const MODEL_SYNC_DEFAULTS = { enabled: false, intervalHours: 6 } as const;

export interface ModelSyncSettings { enabled: boolean; intervalHours: number; }
export async function getModelSyncSettings(): Promise<ModelSyncSettings>
export async function getModelSyncIntervalMs(): Promise<number>  // intervalHours * 3600_000, min 1h
```

**`run.ts`** — the job:

```typescript
export interface ModelSyncRunSummary {
  checked: boolean;
  skippedReason?: string;
  settings: ModelSyncSettings;
  scannedProviderCount: number;
  updatedProviderCount: number;
  addedModelCount: number;
  failures: Array<{ providerId: string; message: string }>;
}

export async function runModelAutoUpdate(): Promise<ModelSyncRunSummary>
```

Algorithm:
1. Read settings; if `!enabled`, return `{ checked: false, skippedReason: "disabled" }`.
2. Load providers with `autoUpdateModels: true` (include `models`, `keys`).
3. For each provider (sequential; Management API calls serialized by existing mutex):
   a. Fetch upstream models via `fetchUpstreamModels(baseUrl, decryptedPrimaryKey, { apiType })`. If fetch fails → record failure, continue.
   b. Compute existing `upstreamName` set. Insert rows for upstream ids not present, `alias = upstreamName` (no smart aliasing; user can edit alias later).
   c. If any rows inserted → `syncCustomProviderToProxy(..., "update")` to push new models; update `lastModelsSyncAt`.
4. Return summary.

**Scheduler registration** — `src/instrumentation-node.ts`:

- Add `__modelSyncSchedulerRegistered` to `globalForScheduler`.
- `startModelSyncScheduler()` identical to `startKeyHealthScheduler()`: `isRunning` guard, recursive `scheduleTimeout`, interval from `getModelSyncIntervalMs()`, fallback `6 * 60 * 60 * 1000` on DB read failure, startup delay 30s via existing `STARTUP_DELAY_MS`.
- Register in `registerNodeInstrumentation()`.

**Admin API:**

- `src/app/api/admin/model-sync/route.ts` — GET returns `ModelSyncSettings`; PUT validates + upserts `SystemSetting` rows (pattern: `admin/key-health/route.ts`).
- `src/app/api/admin/model-sync/run/route.ts` — POST runs `runModelAutoUpdate()`, returns summary (pattern: `admin/key-health/run/route.ts`). Admin-only + `verifySession` + `validateOrigin`.

**Per-provider manual trigger:**

- `src/app/api/custom-providers/[id]/sync-models/route.ts` — POST, ownership check (owner or admin, same as `[id]/route.ts` PATCH), runs the same insert+resync for that single provider (extracted helper from `run.ts`, e.g. `syncProviderModels(providerId)`), returns `{ addedModels, lastModelsSyncAt }`.

### 4.6 Provider CRUD routes + validation

- `src/lib/validation/schemas.ts`: add to `CustomProviderSchema`:
  - `apiType: z.enum([...CUSTOM_PROVIDER_API_TYPES]).optional()` (create only)
  - `autoUpdateModels: z.boolean().optional()`
- `src/app/api/custom-providers/route.ts` (POST): accept `apiType` (required for new providers? — default `openai-compatible` when omitted), `autoUpdateModels`; persist.
- `src/app/api/custom-providers/[id]/route.ts` (PATCH): reject `apiType` changes (`Errors.validation("API type cannot be changed after creation")`); accept `autoUpdateModels`; pass `apiType` into sync call.
- Existing query/list serializers (`custom-provider-section.tsx` types, API responses) extended with `apiType`, `autoUpdateModels`, `lastModelsSyncAt`.

### 4.7 UI

**Provider modal** (`src/components/custom-provider-modal.tsx`, `src/components/custom-providers/basic-fields.tsx`):
- API type dropdown (7 options, default `openai-compatible`), disabled when editing (immutable).
- Toggle "Auto-update models" (`autoUpdateModels`).
- When `apiType === "claude"`: optional `cloak` toggle (stored in `headers`? — no; see 4.7.1).
- "Sync models now" button when editing (calls `[id]/sync-models` POST) showing `lastModelsSyncAt`.

**Provider section** (`src/components/providers/custom-provider-section.tsx`):
- Badge showing apiType on each provider card.
- Optionally show `lastModelsSyncAt` (formatted).

**Settings page** (`src/components/settings/`, new `model-sync-settings.tsx` following `key-health-settings.tsx`):
- Global enable toggle + interval hours input + "Run now" admin button + result summary display.

#### 4.7.1 Claude `cloak` storage decision

`cloak` is a CLIProxyAPI per-entry flag. Two options:
- (a) Add `cloak Boolean @default(false)` column to `CustomProvider` (only meaningful for claude; ignored elsewhere).
- (b) Store in existing `headers` JSON — semantically wrong.

Choose (a): explicit column, simple sync mapping, no magic in `headers`.

### 4.8 i18n

`dashboard/messages/en.json` (source of truth) + `de.json`:

- `customProviders.apiTypes.*`: labels for 7 types.
- `customProviders.autoUpdateModels`, `customProviders.lastSynced`, `customProviders.syncNow`, `customProviders.syncModelsNow`, `customProviders.apiTypeImmutable`, `customProviders.cloak`.
- `settings.modelSync.*`: title, description, enabled, intervalHours, runNow, lastRunSummary, addedModels, failures.

## 5. Edge Cases

E1. **Empty list on first sync** — GET returns `[]`; PUT replaces wholesale; fine.
E2. **Management API unreachable** — sync/delete reports `syncStatus: "failed"` with message (existing behavior preserved); scheduler records failure, continues.
E3. **`MANAGEMENT_API_KEY` not set** — existing behavior: sync unavailable message; scheduler job itself still runs locally (DB-side) but resync step will fail gracefully — log only.
E4. **Provider keyless / legacy hash-only keys** — existing sync-blocked logic unchanged (PATCH path). Auto-update requires ≥1 decryptable enabled key; otherwise skipped with reason in summary.
E5. **Gemini dedupe** — match by `api-key` + `base-url`; two providers sharing a key but different base URLs are distinct entries.
E6. **Model id prefix stripping** — gemini/vertex: `models/gemini-2.5-flash` → `gemini-2.5-flash`; other types returned as-is. Idempotent for re-runs (existing `upstreamName` set prevents duplicates).
E7. **Scheduler overlap** — `isRunning` guard prevents concurrent cycles; recursive setTimeout schedules next only after current completes.
E8. **HMR in dev** — `__modelSyncSchedulerRegistered` guard prevents duplicate intervals.
E9. **Auto-update never deletes** — stale upstream models remain in mapping (requirement R6). Documented in UI tooltip.
E10. **Interval bounds** — clamp to min 1h, max 168h (7 days) in validation and settings reader fallback.
E11. **apiType change on PATCH** — rejected (R2); UI disables the dropdown in edit mode.
E12. **DB read failure in scheduler cycle** — fallback interval 6h (mirrors key-health 60min fallback).

## 6. Testing

### Unit (Vitest)
- `src/lib/providers/__tests__/api-types.test.ts` — mapping table, `isFlatListType`.
- `src/lib/providers/__tests__/custom-provider-sync.test.ts` — extend: flat-list payload builder per type; `auth-index` stripping; gemini key+base-url identity; claude `cloak` passthrough.
- `src/lib/providers/__tests__/upstream-check.test.ts` — extend: claude header set + parse; gemini `models/` prefix stripping; xai/interactions OpenAI-style.
- `src/lib/model-sync/__tests__/settings.test.ts` — defaults, invalid values, clamping.
- `src/lib/model-sync/__tests__/run.test.ts` — disabled skip; only-insert (existing alias preserved, stale not deleted); fetch failure recorded; resync triggered only when rows added; `lastModelsSyncAt` updated.

### API route tests
- `src/app/api/admin/model-sync/route.test.ts` — GET defaults; PUT persists; auth required.
- `src/app/api/admin/model-sync/run/route.test.ts` — POST runs job, returns summary; auth required.
- `src/app/api/custom-providers/[id]/sync-models/route.test.ts` — owner/admin auth; adds models; 404 unknown provider.
- `src/app/api/custom-providers/route.test.ts` / `[id]/route.test.ts` — extend: apiType create default + explicit; PATCH rejects apiType change; autoUpdateModels round-trip.

### E2E (Playwright) — optional / not blocking
- Create claude provider via UI, verify badge + sync.

## 7. Files Changed (summary)

| Area | File(s) |
|------|---------|
| Schema | `prisma/schema.prisma` + migration |
| New | `src/lib/providers/api-types.ts` |
| Sync | `src/lib/providers/custom-provider-sync.ts` |
| Fetch | `src/lib/providers/upstream-check.ts` |
| Resync | `src/lib/providers/resync.ts` |
| New module | `src/lib/model-sync/{settings.ts,run.ts}` |
| Scheduler | `src/instrumentation-node.ts` |
| API routes | `src/app/api/admin/model-sync/{route.ts,run/route.ts}`, `src/app/api/custom-providers/[id]/sync-models/route.ts`, `.../custom-providers/route.ts`, `.../[id]/route.ts`, `.../fetch-models/route.ts` |
| Validation | `src/lib/validation/schemas.ts` |
| UI | `src/components/custom-provider-modal.tsx`, `custom-providers/basic-fields.tsx`, `providers/custom-provider-section.tsx`, `settings/model-sync-settings.tsx` |
| i18n | `messages/en.json`, `messages/de.json` |
| Tests | listed in §6 |

## 8. Out of Scope

- OAuth providers (Claude/Gemini/Codex OAuth) — custom providers only.
- Deleting stale models on auto-update (by design; see R6/E9).
- Smart alias generation from upstream names.
- Per-provider custom sync intervals (global setting only).
- Support for `protocol` restrictions / `antigravity` protocol.
- Backfilling `apiType` from existing CLIProxyAPI config (new providers default `openai-compatible`).

## 9. Assumptions (pending user confirmation)

1. `apiType` immutable after creation — confirmed direction.
2. Default interval 6h.
3. Manual trigger exists at both per-provider and admin levels.
4. Global setting default `enabled: false` (opt-in per provider; user enables global + per-provider to activate).
