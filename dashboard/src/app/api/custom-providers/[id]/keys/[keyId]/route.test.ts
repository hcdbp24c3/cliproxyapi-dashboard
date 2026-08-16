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

const findUniqueMock = vi.fn<(arg?: unknown) => unknown>();
const updateKeyMock = vi.fn<
  (arg: { where: { id: string }; data: { enabled: boolean } }) => Record<string, unknown>
>();
vi.mock("@/lib/db", () => ({
  prisma: {
    customProvider: {
      findUnique: (arg?: unknown) => findUniqueMock(arg),
    },
    customProviderKey: {
      update: (arg: { where: { id: string }; data: { enabled: boolean } }) => updateKeyMock(arg),
    },
  },
}));

const decryptProviderKeyMock = vi.fn<(encrypted: string) => string | null>();
vi.mock("@/lib/providers/encrypt", () => ({
  decryptProviderKey: (encrypted: string) => decryptProviderKeyMock(encrypted),
}));

const syncCustomProviderToProxyMock = vi.fn<
  (args: object, mode: string) => Promise<{ syncStatus: string; syncMessage: string }>
>();
vi.mock("@/lib/providers/custom-provider-sync", () => ({
  syncCustomProviderToProxy: (args: object, mode: string) => syncCustomProviderToProxyMock(args, mode),
}));

const logAuditAsyncMock = vi.fn();
vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: { CUSTOM_PROVIDER_UPDATED: "CUSTOM_PROVIDER_UPDATED" },
  extractIpAddress: () => "127.0.0.1",
  logAuditAsync: (...args: unknown[]) => logAuditAsyncMock(...args),
}));

const baseProvider = {
  id: "p1",
  userId: "user-1",
  name: "z.ai",
  providerId: "zai",
  prefix: "zai",
  baseUrl: "https://api.z.ai",
  proxyUrl: null,
  headers: null,
  models: [],
  excludedModels: [],
  keys: [
    {
      id: "k1",
      apiKeyEncrypted: "enc1",
      enabled: true,
      weight: 1,
      proxyUrl: null,
      sortOrder: 0,
    },
  ],
};

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/custom-providers/p1/keys/k1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/custom-providers/[id]/keys/[keyId] (enable/disable toggle)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminMock.mockResolvedValue(false);
    findUniqueMock.mockResolvedValue(baseProvider);
    updateKeyMock.mockImplementation(({ data }) => ({
      id: "k1",
      apiKeyEncrypted: "enc1",
      enabled: data.enabled,
      weight: 1,
      proxyUrl: null,
      sortOrder: 0,
    }));
    decryptProviderKeyMock.mockReturnValue("decrypted");
    syncCustomProviderToProxyMock.mockResolvedValue({ syncStatus: "ok", syncMessage: "Synced" });
  });

  async function callPatch(body: unknown) {
    const { PATCH } = await import("./route");
    return PATCH(buildRequest(body), { params: Promise.resolve({ id: "p1", keyId: "k1" }) });
  }

  it("rejects a non-boolean body with 400", async () => {
    const res = await callPatch({ enabled: "yes" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_SCHEMA_ERROR");
    expect(updateKeyMock).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    vi.mocked(verifySession).mockReturnValueOnce(null as never);
    const res = await callPatch({ enabled: false });
    expect(res.status).toBe(401);
    expect(updateKeyMock).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const { checkRateLimitWithPreset } = await import("@/lib/auth/rate-limit");
    vi.mocked(checkRateLimitWithPreset).mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 } as never);
    const res = await callPatch({ enabled: false });
    expect(res.status).toBe(429);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the provider does not exist", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await callPatch({ enabled: false });
    expect(res.status).toBe(404);
    expect(updateKeyMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-owner non-admin", async () => {
    findUniqueMock.mockResolvedValue({ ...baseProvider, userId: "someone-else" });
    const res = await callPatch({ enabled: false });
    expect(res.status).toBe(403);
    expect(updateKeyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the key is not part of the provider", async () => {
    // Override provider keys to exclude the requested key id.
    findUniqueMock.mockResolvedValue({ ...baseProvider, keys: [] });
    const { PATCH } = await import("./route");
    const res = await PATCH(buildRequest({ enabled: false }), {
      params: Promise.resolve({ id: "p1", keyId: "missing" }),
    });
    expect(res.status).toBe(404);
    expect(updateKeyMock).not.toHaveBeenCalled();
  });

  it("toggles the key off, syncs the remaining keys, and logs an audit entry", async () => {
    const res = await callPatch({ enabled: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key.enabled).toBe(false);
    expect(body.syncStatus).toBe("ok");
    // Disabling the only key -> no keys are synced to the proxy.
    expect(syncCustomProviderToProxyMock).toHaveBeenCalledTimes(1);
    const syncArgs = syncCustomProviderToProxyMock.mock.calls[0] as unknown as [
      { apiKeyEntries: unknown[] },
      string,
    ];
    expect(syncArgs[0].apiKeyEntries).toEqual([]);
    expect(syncArgs[1]).toBe("update");
    expect(logAuditAsyncMock).toHaveBeenCalledTimes(1);
    const auditArgs = logAuditAsyncMock.mock.calls[0] as unknown as [
      { action: string; metadata: { keyEnabled: boolean; actedAsAdmin: boolean } },
    ];
    expect(auditArgs[0].action).toBe("CUSTOM_PROVIDER_UPDATED");
    expect(auditArgs[0].metadata.keyEnabled).toBe(false);
    expect(auditArgs[0].metadata.actedAsAdmin).toBe(false);
  });

  it("syncs enabled sibling keys when toggling one key off", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseProvider,
      keys: [
        { id: "k1", apiKeyEncrypted: "enc1", enabled: true, weight: 1, proxyUrl: null, sortOrder: 0 },
        { id: "k2", apiKeyEncrypted: "enc2", enabled: true, weight: 2, proxyUrl: null, sortOrder: 1 },
      ],
    });
    decryptProviderKeyMock.mockImplementation((encrypted: string) => `decrypted-${encrypted}`);
    const res = await callPatch({ enabled: false });
    expect(res.status).toBe(200);
    const syncArgs = syncCustomProviderToProxyMock.mock.calls[0] as unknown as [
      { apiKeyEntries: Array<{ apiKey: string; weight: number | null }> },
    ];
    // k1 is disabled so it is excluded; k2 remains.
    expect(syncArgs[0].apiKeyEntries).toEqual([{ apiKey: "decrypted-enc2", weight: 2, proxyUrl: null }]);
  });

  it("allows an admin to toggle and marks the audit entry as admin action", async () => {
    adminMock.mockResolvedValue(true);
    // Provider owned by someone else so the toggle is an admin (not owner) action.
    findUniqueMock.mockResolvedValue({ ...baseProvider, userId: "someone-else" });
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(200);
    expect(updateKeyMock).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: { enabled: true, autoDisabledAt: null, autoDisableReason: null, probeFailureCount: 0 },
    });
    const auditArgs = logAuditAsyncMock.mock.calls[0] as unknown as [
      { metadata: { actedAsAdmin: boolean } },
    ];
    expect(auditArgs[0].metadata.actedAsAdmin).toBe(true);
  });

  it("reports a failed sync when the stored key cannot be decrypted", async () => {
    decryptProviderKeyMock.mockReturnValue(null);
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.syncStatus).toBe("failed");
    expect(body.syncMessage).toContain("could not retrieve API key");
    expect(syncCustomProviderToProxyMock).not.toHaveBeenCalled();
  });

  it("reports a failed sync for a legacy key without an encrypted copy", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseProvider,
      keys: [{ id: "k1", apiKeyEncrypted: null, enabled: true, weight: null, proxyUrl: null, sortOrder: 0 }],
    });
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.syncStatus).toBe("failed");
    expect(syncCustomProviderToProxyMock).not.toHaveBeenCalled();
  });

  it("propagates a failed proxy sync result", async () => {
    syncCustomProviderToProxyMock.mockResolvedValue({ syncStatus: "failed", syncMessage: "Proxy down" });
    const res = await callPatch({ enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.syncStatus).toBe("failed");
    expect(body.syncMessage).toBe("Proxy down");
  });
});
