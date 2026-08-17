import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { lookup } from "dns/promises";
import type { CustomProviderApiType } from "./api-types";

export const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

interface OpenAIModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

interface OpenAIModelsResponse {
  data?: OpenAIModel[];
  models?: OpenAIModel[];
}

/**
 * Discriminated union describing the outcome of an SSRF-safe upstream
 * `/models` fetch. Consumers (fetch-models route, key validation, key status
 * checks) map these to their own responses.
 */
export type UpstreamFetchResult =
  | { status: "success"; models: Array<{ id: string; name: string }> }
  | { status: "invalid-url" }
  | { status: "blocked" }
  | { status: "dns-failed" }
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "http-error"; httpStatus: number }
  | { status: "empty" }
  | { status: "invalid-format" }
  | { status: "timeout" }
  | { status: "network-error"; message: string };

export type UpstreamKeyStatus = "ok" | "invalid" | "unreachable";

export interface UpstreamKeyStatusResult {
  status: UpstreamKeyStatus;
  message?: string;
}

/**
 * Map an upstream /models fetch result to a key status.
 * A 2xx response means the key was accepted; 401/403 means it is invalid;
 * everything else means the upstream could not be reached/queried.
 * Shared by the keys management route (POST /custom-providers/[id]/keys) and
 * the key health checker (lib/key-health/check.ts).
 */
export function mapUpstreamResultToStatus(
  result: UpstreamFetchResult
): UpstreamKeyStatusResult {
  switch (result.status) {
    case "success":
    case "empty":
    case "invalid-format":
      return { status: "ok" };
    case "unauthorized":
      return { status: "invalid" };
    case "not-found":
      return { status: "unreachable", message: "Models endpoint not found" };
    case "invalid-url":
      return { status: "unreachable", message: "Invalid URL" };
    case "blocked":
      return { status: "unreachable", message: "Cannot connect to private or localhost addresses" };
    case "dns-failed":
      return { status: "unreachable", message: "Could not resolve hostname" };
    case "http-error":
      return { status: "unreachable", message: `Upstream returned HTTP ${result.httpStatus}` };
    case "timeout":
      return { status: "unreachable", message: "Request timed out. The provider may be unreachable." };
    case "network-error":
      return { status: "unreachable", message: result.message };
  }
}

/**
 * Cloud instance-metadata endpoints. Always blocked regardless of
 * ALLOW_LOCAL_PROVIDER_URLS — unblocking these enables credential theft on
 * AWS/GCP/Azure/Alibaba/Oracle.
 */
function isCloudMetadataIPv4(a: number, b: number, c: number, d: number): boolean {
  // 169.254.169.254 (AWS, GCP, Azure, OpenStack, DigitalOcean, Oracle)
  if (a === 169 && b === 254 && c === 169 && d === 254) return true;
  // 100.100.100.200 (Alibaba Cloud)
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  return false;
}

/**
 * Normalize an IPv6 literal to lowercase and expand `::` to explicit zero groups
 * so we can do exact prefix/equality comparisons without worrying about the many
 * textual forms the same address can take (e.g. `fd00:ec2::254` vs
 * `fd00:ec2:0:0:0:0:0:254`).
 * Returns null if the input is not a syntactically valid IPv6 literal.
 */
function expandIPv6(raw: string): string | null {
  const value = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (!value.includes(":")) return null;

  // Split on the `::` shorthand (at most one occurrence).
  const parts = value.split("::");
  if (parts.length > 2) return null;

  const [headPart = "", tailPart = ""] = parts;
  const head = headPart === "" ? [] : headPart.split(":");
  const tail = parts.length === 2 && tailPart !== "" ? tailPart.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (parts.length === 1 && head.length !== 8) return null;
  if (parts.length === 2 && missing < 1) return null;

  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * IPv6 cloud instance-metadata endpoints. Always blocked regardless of
 * ALLOW_LOCAL_PROVIDER_URLS.
 */
function isCloudMetadataIPv6(expanded: string): boolean {
  // AWS EC2 IMDSv2 over IPv6: fd00:ec2::254
  if (expanded === "fd00:0ec2:0000:0000:0000:0000:0000:0254") return true;
  return false;
}

function isPrivateIPv4(a: number, b: number): boolean {
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 127) return true;                         // 127.0.0.0/8
  if (a === 0) return true;                           // 0.0.0.0/8
  return false;
}

/**
 * Docker Compose service hostnames that are safe to reach from inside the network.
 * These resolve to private IPs but are trusted internal services, not SSRF targets.
 */
const ALLOWED_INTERNAL_HOSTS = new Set([
  "perplexity-sidecar",
  "cliproxyapi",
]);

/**
 * Block SSRF. Returns true when the hostname MUST be rejected.
 * When `allowLocal` is set, localhost/RFC1918/link-local are permitted, but
 * cloud-metadata addresses remain blocked unconditionally.
 */
function isPrivateHost(hostname: string, allowLocal: boolean): boolean {
  const lower = hostname.toLowerCase();

  if (ALLOWED_INTERNAL_HOSTS.has(lower)) {
    return false;
  }

  // IPv4 literal
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    const d = Number(ipv4Match[4]);
    if (isCloudMetadataIPv4(a, b, c, d)) return true;
    if (allowLocal) return false;
    return isPrivateIPv4(a, b);
  }

  if (lower === "localhost" || lower === "127.0.0.1" || lower === "[::1]" || lower === "0.0.0.0") {
    return !allowLocal;
  }

  // IPv6 (strip brackets for URL-style [::1])
  const ipv6 = lower.replace(/^\[|\]$/g, "");
  const expanded = expandIPv6(ipv6);
  if (expanded && isCloudMetadataIPv6(expanded)) return true;
  if (ipv6 === "::1" || ipv6.startsWith("fe80:") || ipv6.startsWith("fc") || ipv6.startsWith("fd")) {
    return !allowLocal;
  }

  // IPv4-mapped IPv6: ::ffff:A.B.C.D (dotted) or ::ffff:AABB:CCDD (hex)
  const dottedMatch = ipv6.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dottedMatch) {
    const a = Number(dottedMatch[1]);
    const b = Number(dottedMatch[2]);
    const c = Number(dottedMatch[3]);
    const d = Number(dottedMatch[4]);
    if (isCloudMetadataIPv4(a, b, c, d)) return true;
    if (allowLocal) return false;
    return isPrivateIPv4(a, b);
  }
  const hexMatch = ipv6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const [, hiPart, loPart] = hexMatch;
    if (!hiPart || !loPart) return true; // fail closed: unparseable mapped IPv6 is treated as private
    const hi = parseInt(hiPart, 16);
    const lo = parseInt(loPart, 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    if (isCloudMetadataIPv4(a, b, c, d)) return true;
    if (allowLocal) return false;
    return isPrivateIPv4(a, b);
  }

  return false;
}

function isIPv6Literal(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // URL.hostname returns bracket-less IPv6 for valid URLs, keep bracket stripping for safety.
  // We only need a reliable literal detector to skip DNS lookup; private/public decision is handled elsewhere.
  return value.includes(":");
}

function getFetchNetworkErrorMessage(fetchError: Error, hostname: string): string {
  const cause = "cause" in fetchError && fetchError.cause && typeof fetchError.cause === "object"
    ? fetchError.cause as Record<string, unknown>
    : null;

  const code = typeof cause?.code === "string" ? cause.code : null;
  const isIPv6Host = isIPv6Literal(hostname);

  if (code === "ENETUNREACH") {
    return isIPv6Host
      ? "IPv6 network unreachable from the dashboard container"
      : "Network unreachable from the dashboard container";
  }

  if (code === "EHOSTUNREACH") {
    return "Host unreachable from the dashboard container";
  }

  if (code === "ECONNREFUSED") {
    return "Connection refused by the provider endpoint";
  }

  if (code === "ETIMEDOUT") {
    return "Connection to the provider timed out";
  }

  return "Network error: unable to reach the provider";
}

/**
 * Check if a resolved IP address is private/internal.
 * Used after DNS resolution to prevent DNS rebinding attacks.
 */
function isPrivateResolvedIP(ip: string, allowLocal: boolean): boolean {
  // IPv4
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    const d = Number(ipv4Match[4]);
    if (isCloudMetadataIPv4(a, b, c, d)) return true;
    if (allowLocal) return false;
    return isPrivateIPv4(a, b);
  }

  // IPv6 loopback and private ranges
  const normalized = ip.toLowerCase();
  const expanded = expandIPv6(normalized);
  if (expanded && isCloudMetadataIPv6(expanded)) return true;
  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return !allowLocal;
  }

  // IPv4-mapped IPv6
  const mappedMatch = normalized.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mappedMatch) {
    const a = Number(mappedMatch[1]);
    const b = Number(mappedMatch[2]);
    const c = Number(mappedMatch[3]);
    const d = Number(mappedMatch[4]);
    if (isCloudMetadataIPv4(a, b, c, d)) return true;
    if (allowLocal) return false;
    return isPrivateIPv4(a, b);
  }

  return false;
}

/**
 * Validate a provider base URL and build the `/models` endpoint URL with full
 * SSRF + DNS-rebinding protection. Returns `{ ok: true, url }` when the
 * endpoint is safe to fetch, or `{ ok: false, result }` with the failure reason.
 */
export async function validateUpstreamUrl(
  baseUrl: string
): Promise<{ ok: true; url: URL } | { ok: false; result: UpstreamFetchResult }> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(`${normalizedBaseUrl}/models`);
  } catch {
    return { ok: false, result: { status: "invalid-url" } };
  }

  const allowLocal = env.ALLOW_LOCAL_PROVIDER_URLS;

  if (isPrivateHost(parsedUrl.hostname, allowLocal)) {
    logger.warn({ hostname: parsedUrl.hostname }, "Blocked SSRF attempt to private host");
    return { ok: false, result: { status: "blocked" } };
  }

  // DNS rebinding protection: resolve hostname and verify the IP is not private.
  // This prevents attackers from using a domain that initially resolves to a public IP
  // but re-resolves to an internal IP (e.g., 127.0.0.1) at request time.
  // Skip check for allowed internal Docker hosts (they resolve to private IPs by design).
  const ipv4Match = parsedUrl.hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const isIpLiteral = !!ipv4Match || isIPv6Literal(parsedUrl.hostname);
  if (!isIpLiteral && !ALLOWED_INTERNAL_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    try {
      const resolved = await lookup(parsedUrl.hostname);
      if (isPrivateResolvedIP(resolved.address, allowLocal)) {
        logger.warn(
          { hostname: parsedUrl.hostname, resolvedIp: resolved.address },
          "Blocked SSRF: hostname resolved to private IP (possible DNS rebinding)"
        );
        return { ok: false, result: { status: "blocked" } };
      }
    } catch (dnsError) {
      logger.warn({ hostname: parsedUrl.hostname, err: dnsError }, "DNS resolution failed for provider URL");
      return { ok: false, result: { status: "dns-failed" } };
    }
  }

  return { ok: true, url: parsedUrl };
}

export interface FetchUpstreamModelsOptions {
  /** Provider API type — determines auth headers and models endpoint path. Defaults to `"openai-compatible"`. */
  apiType?: CustomProviderApiType;
  /** Additional headers merged into the request (e.g. custom auth tokens). */
  headers?: Record<string, string>;
}

/**
 * Fetch the model list from an upstream provider with SSRF protection,
 * DNS-rebinding checks, and a 10-second timeout.
 *
 * Dispatches per `apiType`:
 * - **openai-compatible / codex / xai / interactions** — `GET /models` with `Authorization: Bearer` header.
 * - **claude** — `GET /models` with `x-api-key` header + `anthropic-version: 1.0-2023-06-01`.
 * - **gemini** — `GET /v1beta/models` with `x-goog-api-key` header. Strips leading `models/` from returned IDs.
 * - **vertex** — Returns empty list immediately (Vertex AI is POST-only; no model list endpoint).
 *
 * Returns a discriminated result instead of throwing so callers can map
 * failures to their own error responses.
 */
export async function fetchUpstreamModels(
  baseUrl: string,
  apiKey?: string,
  options?: FetchUpstreamModelsOptions
): Promise<UpstreamFetchResult> {
  const apiType = options?.apiType ?? "openai-compatible";

  // Vertex AI has no model list endpoint (POST-only key management).
  if (apiType === "vertex") {
    return { status: "success", models: [] };
  }

  const validated = await validateUpstreamUrl(baseUrl);
  if (!validated.ok) return validated.result;

  // Gemini uses /v1beta/models; all other types use the /models path from validation.
  const modelsEndpoint =
    apiType === "gemini"
      ? new URL(`${validated.url.origin}/v1beta/models`).toString()
      : validated.url.toString();

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_FETCH_TIMEOUT_MS);

  try {
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json"
    };

    switch (apiType) {
      case "claude":
        if (apiKey && apiKey.length > 0) {
          requestHeaders["x-api-key"] = apiKey;
        }
        requestHeaders["anthropic-version"] = "1.0-2023-06-01";
        break;
      case "gemini":
        if (apiKey && apiKey.length > 0) {
          requestHeaders["x-goog-api-key"] = apiKey;
        }
        break;
      default:
        if (apiKey && apiKey.length > 0) {
          requestHeaders["Authorization"] = `Bearer ${apiKey}`;
        }
        break;
    }

    if (options?.headers) {
      Object.assign(requestHeaders, options.headers);
    }

    const response = await fetch(modelsEndpoint, {
      method: "GET",
      headers: requestHeaders,
      signal: controller.signal,
      redirect: "error"
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        return { status: "unauthorized" };
      }
      if (response.status === 404) {
        return { status: "not-found" };
      }
      logger.error({ status: response.status, url: modelsEndpoint }, "Failed to fetch models from provider");
      return { status: "http-error", httpStatus: response.status };
    }

    const responseData = await response.json();

    // Gemini returns { models: [{ name: "models/<id>", displayName: "..." }] }
    if (apiType === "gemini") {
      const geminiModels = responseData?.models;
      if (!Array.isArray(geminiModels)) {
        logger.error({ responseData }, "Invalid Gemini models response format");
        return { status: "invalid-format" };
      }
      if (geminiModels.length === 0) {
        return { status: "empty" };
      }
      const models = geminiModels.map((m: { name?: string; displayName?: string }) => {
        const rawName = m.name ?? "";
        const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
        return { id, name: m.displayName ?? id };
      });
      return { status: "success", models };
    }

    const modelList = (responseData as OpenAIModelsResponse).data || (responseData as OpenAIModelsResponse).models || [];

    if (!Array.isArray(modelList)) {
      logger.error({ responseData }, "Invalid models response format");
      return { status: "invalid-format" };
    }

    if (modelList.length === 0) {
      return { status: "empty" };
    }

    const models = modelList.map(model => ({
      id: model.id,
      name: model.id
    }));

    return { status: "success", models };

  } catch (fetchError) {
    clearTimeout(timeoutId);

    if (fetchError instanceof Error) {
      if (fetchError.name === "AbortError") {
        logger.error({ url: modelsEndpoint }, "Fetch models request timed out");
        return { status: "timeout" };
      }

      logger.error({ err: fetchError, url: modelsEndpoint }, "Failed to fetch models from provider");
      return { status: "network-error", message: getFetchNetworkErrorMessage(fetchError, validated.url.hostname) };
    }

    return { status: "network-error", message: "Network error: unable to reach the provider" };
  }
}
