import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/session", () => ({
  verifySession: vi.fn(() => ({ userId: "test-user" })),
}));

vi.mock("@/lib/auth/origin", () => ({ validateOrigin: vi.fn(() => null) }));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: vi.fn(() => ({ allowed: true })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const envMock: { ALLOW_LOCAL_PROVIDER_URLS: boolean } = {
  ALLOW_LOCAL_PROVIDER_URLS: false,
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

const fetchUpstreamModelsMock = vi.fn<
  (baseUrl: string, apiKey?: string) => Promise<{ status: string } & Record<string, unknown>>
>();
vi.mock("@/lib/providers/upstream-check", () => ({
  fetchUpstreamModels: (baseUrl: string, apiKey?: string) => fetchUpstreamModelsMock(baseUrl, apiKey),
}));

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/custom-providers/check-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/custom-providers/check-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.ALLOW_LOCAL_PROVIDER_URLS = false;
  });

  it("returns valid=true when the upstream accepts the key", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "success" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("treats an empty /models response as a valid key", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "empty" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("treats an invalid-format response as a valid key (2xx upstream)", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "invalid-format" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("returns valid=false when the upstream rejects the key", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "unauthorized" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "sk-bad" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.message).toBeDefined();
  });

  it("returns valid=false for private/localhost URLs when the flag is off", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "blocked" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "http://localhost:11434/v1", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.message).toMatch(/private or localhost/i);
  });

  it("returns valid=false when the hostname cannot be resolved", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "dns-failed" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://does-not-exist.invalid/v1", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it("returns valid=false when the models endpoint is missing", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "not-found" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it("returns valid=false when the upstream responds with an HTTP error", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "http-error", httpStatus: 500 });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.message).toContain("500");
  });

  it("returns valid=false when the upstream times out", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "timeout" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it("returns valid=false with a network error message", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "network-error", message: "ECONNREFUSED" });
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.message).toBe("ECONNREFUSED");
  });

  it("validates the body with Zod and returns 400 for an invalid URL", async () => {
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "not-a-url", apiKey: "k" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_SCHEMA_ERROR");
    expect(fetchUpstreamModelsMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is missing", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    vi.mocked(verifySession).mockReturnValueOnce(null as never);
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.status).toBe(401);
    expect(fetchUpstreamModelsMock).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");
    vi.mocked(checkRateLimitWithPreset).mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 } as never);
    const { POST } = await import("./route");
    const res = await POST(buildRequest({ baseUrl: "https://api.example.com/v1", apiKey: "k" }));
    expect(res.status).toBe(429);
    expect(fetchUpstreamModelsMock).not.toHaveBeenCalled();
  });
});
