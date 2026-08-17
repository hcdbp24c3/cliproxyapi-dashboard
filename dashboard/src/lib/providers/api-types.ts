/**
 * Custom Provider API Types
 *
 * Maps each custom provider to its CLIProxyAPI management config list.
 * - "openai-compatible" → named list (/openai-compatibility), entries keyed by name
 * - All others → flat lists (e.g. /claude-api-key), entries keyed by api-key
 */

export const CUSTOM_PROVIDER_API_TYPES = {
  OPENAI_COMPATIBLE: "openai-compatible",
  CLAUDE: "claude",
  GEMINI: "gemini",
  CODEX: "codex",
  VERTEX: "vertex",
  XAI: "xai",
  INTERACTIONS: "interactions",
} as const;

export type CustomProviderApiType =
  (typeof CUSTOM_PROVIDER_API_TYPES)[keyof typeof CUSTOM_PROVIDER_API_TYPES];

/**
 * Maps each API type to its CLIProxyAPI management endpoint path.
 * "openai-compatible" uses the named list; all others use flat lists.
 */
export const API_TYPE_MANAGEMENT_PATH: Record<CustomProviderApiType, string> = {
  "openai-compatible": "/openai-compatibility",
  claude: "/claude-api-key",
  gemini: "/gemini-api-key",
  codex: "/codex-api-key",
  vertex: "/vertex-api-key",
  xai: "/xai-api-key",
  interactions: "/interactions-api-key",
};

/**
 * Returns true if the API type uses a flat list (all types except openai-compatible).
 * Flat lists have entries keyed by "api-key" rather than "name".
 */
export function isFlatListType(apiType: CustomProviderApiType): boolean {
  return apiType !== "openai-compatible";
}
