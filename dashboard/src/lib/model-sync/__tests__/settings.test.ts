import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("@/lib/db", () => ({
  prisma: {
    systemSetting: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customProvider: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    customProviderModel: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/providers/upstream-check", () => ({
  fetchUpstreamModels: vi.fn(),
}));

// Import after mocks
import { prisma } from "@/lib/db";
import { fetchUpstreamModels } from "@/lib/providers/upstream-check";
import {
  getModelSyncSettings,
  getModelSyncIntervalMs,
  runModelSync,
} from "@/lib/model-sync/check";

const mockPrisma = vi.mocked(prisma);
const mockFetchUpstreamModels = vi.mocked(fetchUpstreamModels);

describe("model-sync/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ------------------------------------------------------------------ */
  /* getModelSyncSettings                                                */
  /* ------------------------------------------------------------------ */

  describe("getModelSyncSettings", () => {
    it("returns defaults when no SystemSetting rows exist", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([]);

      const settings = await getModelSyncSettings();

      expect(settings).toEqual({
        enabled: false,
        intervalMinutes: 60,
      });
    });

    it("reads custom settings from SystemSetting rows", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
        { key: "model_sync_interval_minutes", value: "30" },
      ]);

      const settings = await getModelSyncSettings();

      expect(settings).toEqual({
        enabled: true,
        intervalMinutes: 30,
      });
    });

    it("falls back to default interval when value is NaN", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
        { key: "model_sync_interval_minutes", value: "not-a-number" },
      ]);

      const settings = await getModelSyncSettings();

      expect(settings.intervalMinutes).toBe(60);
    });

    it("falls back to default interval when value is less than 1", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_interval_minutes", value: "0" },
      ]);

      const settings = await getModelSyncSettings();

      expect(settings.intervalMinutes).toBe(60);
    });
  });

  /* ------------------------------------------------------------------ */
  /* getModelSyncIntervalMs                                              */
  /* ------------------------------------------------------------------ */

  describe("getModelSyncIntervalMs", () => {
    it("returns interval in milliseconds from settings", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_interval_minutes", value: "30" },
      ]);

      const ms = await getModelSyncIntervalMs();

      expect(ms).toBe(30 * 60_000);
    });

    it("returns default interval when no setting exists", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([]);

      const ms = await getModelSyncIntervalMs();

      expect(ms).toBe(60 * 60_000);
    });
  });

  /* ------------------------------------------------------------------ */
  /* runModelSync                                                        */
  /* ------------------------------------------------------------------ */

  describe("runModelSync", () => {
    it("returns unchecked summary when feature is disabled", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([]);

      const summary = await runModelSync();

      expect(summary).toEqual({
        checked: false,
        providerResults: [],
        syncedCount: 0,
        skippedCount: 0,
        failedCount: 0,
      });
    });

    it("force: true bypasses enabled=false", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "false" },
      ]);
      mockPrisma.customProvider.findMany.mockResolvedValue([]);

      const summary = await runModelSync({ force: true });

      expect(summary.checked).toBe(true);
      expect(mockPrisma.customProvider.findMany).toHaveBeenCalledWith({
        include: { keys: true },
        where: { autoUpdateModels: true },
      });
    });

    it("returns correct counters for successful sync", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
      ]);

      mockPrisma.customProvider.findMany.mockResolvedValue([
        {
          id: "cp_1",
          providerId: "openrouter",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiType: "openai-compatible",
        },
        {
          id: "cp_2",
          providerId: "ollama",
          name: "Ollama",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-compatible",
        },
      ]);

      mockFetchUpstreamModels
        .mockResolvedValueOnce({
          status: "success",
          models: [
            { id: "model-a", name: "Model A" },
            { id: "model-b", name: "Model B" },
          ],
        })
        .mockResolvedValueOnce({
          status: "success",
          models: [{ id: "llama3", name: "llama3" }],
        });

      mockPrisma.customProviderModel.findMany.mockResolvedValue([]);
      mockPrisma.customProvider.update.mockResolvedValue({} as never);

      const summary = await runModelSync({ force: true });

      expect(summary.checked).toBe(true);
      expect(summary.syncedCount).toBe(2);
      expect(summary.skippedCount).toBe(0);
      expect(summary.failedCount).toBe(0);
      expect(summary.providerResults).toHaveLength(2);
      expect(summary.providerResults[0]).toEqual({
        providerId: "openrouter",
        name: "OpenRouter",
        status: "ok",
      });
      expect(summary.providerResults[1]).toEqual({
        providerId: "ollama",
        name: "Ollama",
        status: "ok",
      });
    });

    it("skips providers when upstream returns non-success", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
      ]);

      mockPrisma.customProvider.findMany.mockResolvedValue([
        {
          id: "cp_1",
          providerId: "bad-provider",
          name: "Bad Provider",
          baseUrl: "https://bad.example.com/v1",
          apiType: "openai-compatible",
        },
      ]);

      mockFetchUpstreamModels.mockResolvedValueOnce({
        status: "unauthorized",
      });

      const summary = await runModelSync({ force: true });

      expect(summary.skippedCount).toBe(1);
      expect(summary.syncedCount).toBe(0);
      expect(summary.providerResults[0]).toEqual({
        providerId: "bad-provider",
        name: "Bad Provider",
        status: "skipped",
        reason: "Upstream fetch failed: unauthorized",
      });
    });

    it("records failures when fetchUpstreamModels throws", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
      ]);

      mockPrisma.customProvider.findMany.mockResolvedValue([
        {
          id: "cp_1",
          providerId: "crash-provider",
          name: "Crash Provider",
          baseUrl: "https://crash.example.com/v1",
          apiType: "openai-compatible",
        },
      ]);

      mockFetchUpstreamModels.mockRejectedValueOnce(
        new Error("Connection refused")
      );

      const summary = await runModelSync({ force: true });

      expect(summary.failedCount).toBe(1);
      expect(summary.syncedCount).toBe(0);
      expect(summary.providerResults[0]).toEqual({
        providerId: "crash-provider",
        name: "Crash Provider",
        status: "failed",
        reason: "Connection refused",
      });
    });

    it("does not add duplicate models (append-only)", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
      ]);

      mockPrisma.customProvider.findMany.mockResolvedValue([
        {
          id: "cp_1",
          providerId: "test-provider",
          name: "Test Provider",
          baseUrl: "https://test.example.com/v1",
          apiType: "openai-compatible",
        },
      ]);

      mockFetchUpstreamModels.mockResolvedValueOnce({
        status: "success",
        models: [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" },
        ],
      });

      // model-a already exists
      mockPrisma.customProviderModel.findMany.mockResolvedValue([
        { id: "m_1", customProviderId: "cp_1", upstreamName: "model-a", alias: "Model A" },
      ] as never);
      mockPrisma.customProvider.update.mockResolvedValue({} as never);

      const summary = await runModelSync({ force: true });

      expect(summary.syncedCount).toBe(1);
      // Only model-b should be added (model-a already exists)
      expect(mockPrisma.customProviderModel.createMany).toHaveBeenCalledWith({
        data: [
          {
            customProviderId: "cp_1",
            upstreamName: "model-b",
            alias: "Model B",
          },
        ],
      });
    });

    it("updates lastModelsSyncAt after successful sync", async () => {
      mockPrisma.systemSetting.findMany.mockResolvedValue([
        { key: "model_sync_enabled", value: "true" },
      ]);

      mockPrisma.customProvider.findMany.mockResolvedValue([
        {
          id: "cp_1",
          providerId: "test-provider",
          name: "Test Provider",
          baseUrl: "https://test.example.com/v1",
          apiType: "openai-compatible",
        },
      ]);

      mockFetchUpstreamModels.mockResolvedValueOnce({
        status: "success",
        models: [{ id: "model-a", name: "Model A" }],
      });

      mockPrisma.customProviderModel.findMany.mockResolvedValue([]);
      mockPrisma.customProvider.update.mockResolvedValue({} as never);

      await runModelSync({ force: true });

      expect(mockPrisma.customProvider.update).toHaveBeenCalledWith({
        where: { id: "cp_1" },
        data: { lastModelsSyncAt: expect.any(Date) },
      });
    });
  });
});
