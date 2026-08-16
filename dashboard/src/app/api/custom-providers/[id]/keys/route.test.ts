import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/session", () => ({
  verifySession: vi.fn(() => ({ userId: "user-1" })),
}));

vi.mock("@/lib/auth/origin", () => ({ validateOrigin: vi.fn(() => null) }));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: vi.fn(() => ({ allowed: true })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const adminMock = vi.fn<(userId?: string) => Promise<boolean>>(async () => false);
vi.mock("@/lib/auth/admin", () => ({
  isUserAdmin: (userId: string) => adminMock(userId),
}));

const getUserMock = vi.fn();
vi.mock("@/lib/auth/dal", () => ({
  getUser: () => getUserMock(),
}));

const verifyPasswordMock = vi.fn<(password: string, hash: string) => Promise<boolean>>();
vi.mock("@/lib/auth/password", () => ({
  verifyPassword: (password: string, hash: string) => verifyPasswordMock(password, hash),
}));

const findUniqueMock = vi.fn<(arg?: unknown) => unknown>();
vi.mock("@/lib/db", () => ({
  prisma: {
    customProvider: {
      findUnique: (arg?: unknown) => findUniqueMock(arg),
    },
  },
}));

const decryptProviderKeyMock = vi.fn<(encrypted: string) => string | null>();
vi.mock("@/lib/providers/encrypt", () => ({
  decryptProviderKey: (encrypted: string) => decryptProviderKeyMock(encrypted),
}));

const fetchUpstreamModelsMock = vi.fn<
  (baseUrl: string, apiKey?: string) => Promise<{ status: string } & Record<string, unknown>>
>();
vi.mock("@/lib/providers/upstream-check", () => ({
  fetchUpstreamModels: (baseUrl: string, apiKey?: string) => fetchUpstreamModelsMock(baseUrl, apiKey),
  mapUpstreamResultToStatus: (result: { status: string; httpStatus?: number }) => {
    switch (result.status) {
      case "success":
      case "empty":
      case "invalid-format":
        return { status: "ok" };
      case "unauthorized":
        return { status: "invalid" };
      default:
        return { status: "unreachable", message: `unreachable (${result.status})` };
    }
  },
}));

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/custom-providers/p1/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseProvider = {
  id: "p1",
  userId: "user-1",
  name: "z.ai",
  providerId: "zai",
  baseUrl: "https://api.z.ai",
  keys: [],
};

describe("POST /api/custom-providers/[id]/keys (password-gated key management)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminMock.mockResolvedValue(false);
    findUniqueMock.mockResolvedValue(baseProvider);
    getUserMock.mockResolvedValue({ id: "user-1", passwordHash: "hash" });
    verifyPasswordMock.mockResolvedValue(true);
  });

  async function callPost(body: unknown) {
    const { POST } = await import("./route");
    return POST(buildRequest(body), { params: Promise.resolve({ id: "p1" }) });
  }

  it("rejects missing password with 400", async () => {
    const res = await callPost({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the provider does not exist", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(404);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-owner non-admin", async () => {
    findUniqueMock.mockResolvedValue({ ...baseProvider, userId: "someone-else" });
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(403);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the user record is missing", async () => {
    getUserMock.mockResolvedValue(null);
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(404);
  });

  it("returns 401 when the password is wrong", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    const res = await callPost({ password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("allows the owner with a valid password and returns probed keys", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "success" });
    findUniqueMock.mockResolvedValue({
      ...baseProvider,
      keys: [
        {
          id: "k1",
          apiKeyEncrypted: "enc1",
          enabled: true,
          weight: 1,
          proxyUrl: null,
          sortOrder: 0,
        },
        {
          id: "k2",
          apiKeyEncrypted: "enc2",
          enabled: false,
          weight: null,
          proxyUrl: null,
          sortOrder: 1,
        },
      ],
    });
    decryptProviderKeyMock.mockImplementation((encrypted: string) => `decrypted-${encrypted}`);
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(2);
    // Enabled key was probed against the upstream.
    expect(body.keys[0]).toMatchObject({ id: "k1", status: "ok", apiKey: "decrypted-enc1" });
    // Disabled key is reported without an upstream call.
    expect(body.keys[1]).toMatchObject({ id: "k2", status: "disabled" });
    expect(fetchUpstreamModelsMock).toHaveBeenCalledTimes(1);
    expect(fetchUpstreamModelsMock).toHaveBeenCalledWith("https://api.z.ai", "decrypted-enc1");
  });

  it("reports an invalid key when the upstream returns 401", async () => {
    fetchUpstreamModelsMock.mockResolvedValueOnce({ status: "unauthorized" });
    findUniqueMock.mockResolvedValue({
      ...baseProvider,
      keys: [
        {
          id: "k1",
          apiKeyEncrypted: "enc1",
          enabled: true,
          weight: null,
          proxyUrl: null,
          sortOrder: 0,
        },
      ],
    });
    decryptProviderKeyMock.mockReturnValue("decrypted");
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys[0].status).toBe("invalid");
  });

  it("reports unknown when the encrypted copy cannot be decrypted", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseProvider,
      keys: [
        {
          id: "k1",
          apiKeyEncrypted: "enc1",
          enabled: true,
          weight: null,
          proxyUrl: null,
          sortOrder: 0,
        },
      ],
    });
    decryptProviderKeyMock.mockReturnValue(null);
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys[0].status).toBe("unknown");
    expect(fetchUpstreamModelsMock).not.toHaveBeenCalled();
  });

  it("sorts keys by sortOrder", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseProvider,
      keys: [
        {
          id: "later",
          apiKeyEncrypted: "enc-later",
          enabled: false,
          weight: null,
          proxyUrl: null,
          sortOrder: 2,
        },
        {
          id: "first",
          apiKeyEncrypted: "enc-first",
          enabled: false,
          weight: null,
          proxyUrl: null,
          sortOrder: 0,
        },
      ],
    });
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys.map((k: { id: string }) => k.id)).toEqual(["first", "later"]);
  });

  it("returns 429 when rate limited", async () => {
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");
    vi.mocked(checkRateLimitWithPreset).mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 } as never);
    const res = await callPost({ password: "secret" });
    expect(res.status).toBe(429);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
