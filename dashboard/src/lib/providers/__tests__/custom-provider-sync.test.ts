import { describe, it, expect, vi } from "vitest";
import { mergeProviderKeyEntries } from "@/lib/providers/custom-provider-sync";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: {
    CLIPROXYAPI_MANAGEMENT_URL: "http://localhost:8080",
    MANAGEMENT_API_KEY: "test-key",
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/cache", () => ({ invalidateProxyModelsCache: vi.fn() }));

describe("mergeProviderKeyEntries", () => {
  it("keeps existing keys first, then appends incoming keys", () => {
    const existing = [{ apiKey: "key-a" }, { apiKey: "key-b" }];
    const incoming = [{ apiKey: "key-c" }];

    expect(mergeProviderKeyEntries(existing, incoming)).toEqual([
      { apiKey: "key-a" },
      { apiKey: "key-b" },
      { apiKey: "key-c" },
    ]);
  });

  it("drops exact duplicates across both lists", () => {
    const existing = [{ apiKey: "key-a" }, { apiKey: "key-b" }];
    const incoming = [{ apiKey: "key-b" }, { apiKey: "key-c" }];

    expect(mergeProviderKeyEntries(existing, incoming)).toEqual([
      { apiKey: "key-a" },
      { apiKey: "key-b" },
      { apiKey: "key-c" },
    ]);
  });

  it("normalizes whitespace before deduplicating", () => {
    const existing = [{ apiKey: "key-a" }];
    const incoming = [{ apiKey: "  key-a  " }, { apiKey: "key-b" }];

    expect(mergeProviderKeyEntries(existing, incoming)).toEqual([
      { apiKey: "key-a" },
      { apiKey: "key-b" },
    ]);
  });

  it("preserves weight and proxyUrl metadata from both sources", () => {
    const existing = [{ apiKey: "key-a", weight: 2 }];
    const incoming = [{ apiKey: "key-b", proxyUrl: "http://proxy:8080" }];

    expect(mergeProviderKeyEntries(existing, incoming)).toEqual([
      { apiKey: "key-a", weight: 2 },
      { apiKey: "key-b", proxyUrl: "http://proxy:8080" },
    ]);
  });

  it("does not mutate the input arrays", () => {
    const existing = [{ apiKey: "key-a" }];
    const incoming = [{ apiKey: "key-a" }, { apiKey: "key-b" }];

    mergeProviderKeyEntries(existing, incoming);

    expect(existing).toEqual([{ apiKey: "key-a" }]);
    expect(incoming).toEqual([{ apiKey: "key-a" }, { apiKey: "key-b" }]);
  });

  it("handles empty existing keys", () => {
    const incoming = [{ apiKey: "key-a" }, { apiKey: "key-b" }];

    expect(mergeProviderKeyEntries([], incoming)).toEqual([
      { apiKey: "key-a" },
      { apiKey: "key-b" },
    ]);
  });
});
