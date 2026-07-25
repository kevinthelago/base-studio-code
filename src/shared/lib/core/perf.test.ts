import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { timed, timedSync, formatPerfSummary } from "./perf";
import { log } from "./log";
import { useAppStore } from "@/store";
import type { PerfConfig } from "@/store";

afterEach(() => vi.restoreAllMocks());

const ZERO = {
  jankCount: 0, jankTotalMs: 0, jankWorstMs: 0,
  ptyEvents: 0, ptyBytes: 0, ptyHandlerMs: 0, renders: 0,
  storeWrites: {} as Record<string, number>, terminals: 0,
};

describe("formatPerfSummary", () => {
  it("returns null when there was no jank and no pty activity", () => {
    expect(formatPerfSummary({ ...ZERO, terminals: 16 }, 2000)).toBeNull();
  });

  it("reports the elapsed window and jank stats", () => {
    const line = formatPerfSummary({ ...ZERO, jankCount: 6, jankTotalMs: 3746, jankWorstMs: 745, terminals: 16 }, 4000);
    expect(line).toContain("4.0s");
    expect(line).toContain("jank 6×");
    expect(line).toContain("worst 745ms");
    expect(line).toContain("16 terms");
  });

  it("reports pty throughput as events / KB / write-ms", () => {
    const line = formatPerfSummary({ ...ZERO, ptyEvents: 312, ptyBytes: 491520, ptyHandlerMs: 210, terminals: 16 }, 2000)!;
    expect(line).toContain("pty 312 evt");
    expect(line).toContain("480KB");
    expect(line).toContain("210ms write");
  });

  it("includes the terminal count even when only pty activity is present", () => {
    const line = formatPerfSummary({ ...ZERO, ptyEvents: 1, ptyBytes: 10, ptyHandlerMs: 1, terminals: 4 }, 2000)!;
    expect(line).toContain("4 terms");
  });

  it("reports the render count when present", () => {
    const line = formatPerfSummary({ ...ZERO, jankCount: 1, jankTotalMs: 120, jankWorstMs: 120, renders: 47, terminals: 16 }, 2000)!;
    expect(line).toContain("47 renders");
  });

  it("surfaces the most-frequently-written store keys", () => {
    const line = formatPerfSummary(
      { ...ZERO, renders: 220, storeWrites: { focusedAgentName: 220, paneCwds: 3 }, terminals: 16 },
      2000,
    )!;
    expect(line).toContain("store focusedAgentName×220");
  });

  it("appends JS heap usage when a snapshot is provided", () => {
    const line = formatPerfSummary({ ...ZERO, ptyEvents: 1, ptyBytes: 10, ptyHandlerMs: 1, terminals: 16 }, 2000, { usedMB: 1800, limitMB: 2048 })!;
    expect(line).toContain("heap 1800/2048MB");
  });

  it("omits heap when no snapshot is available", () => {
    const line = formatPerfSummary({ ...ZERO, renders: 1, terminals: 1 }, 2000, null)!;
    expect(line).not.toContain("heap");
  });
});

describe("timed", () => {
  it("returns the wrapped operation's resolved value", async () => {
    const result = await timed("op", async () => 42);
    expect(result).toBe(42);
  });

  it("does not warn when the operation is under the threshold", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await timed("fast", async () => "x", 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with the label when the operation exceeds the threshold", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    // threshold 0 → any measurable duration triggers the warning
    await timed("slow-op", async () => "x", 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("slow-op");
  });

  it("still times (and rethrows) when the operation throws", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await expect(timed("boom", async () => { throw new Error("nope"); }, 0)).rejects.toThrow("nope");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ── perfConfig store slice ────────────────────────────────────────────────────

const DEFAULT_CONFIG: PerfConfig = {
  enabled: true,
  intervalSecs: 2,
  retentionHours: 24,
  maxDbMb: 50,
  trackProcess: true,
  trackFrontend: true,
};

describe("perfConfig store slice", () => {
  beforeEach(() => {
    useAppStore.setState({ perfConfig: { ...DEFAULT_CONFIG } });
    vi.clearAllMocks();
  });

  it("has default config with collection enabled at 2s", () => {
    const { perfConfig } = useAppStore.getState();
    expect(perfConfig.enabled).toBe(true);
    expect(perfConfig.intervalSecs).toBe(2);
  });

  it("setPerfConfig updates the in-store config", () => {
    useAppStore.getState().setPerfConfig({ ...DEFAULT_CONFIG, enabled: false, intervalSecs: 5 });
    const { perfConfig } = useAppStore.getState();
    expect(perfConfig.enabled).toBe(false);
    expect(perfConfig.intervalSecs).toBe(5);
  });

  it("setPerfConfig calls perf_set_config on the backend", () => {
    useAppStore.getState().setPerfConfig({ ...DEFAULT_CONFIG, retentionHours: 6 });
    expect(invoke).toHaveBeenCalledWith(
      "perf_set_config",
      expect.objectContaining({ retentionHours: 6 }),
    );
  });

  it("setPerfConfig passes camelCase keys matching the Rust command", () => {
    useAppStore.getState().setPerfConfig({
      enabled: true,
      intervalSecs: 1,
      retentionHours: 72,
      maxDbMb: 10,
      trackProcess: false,
      trackFrontend: true,
    });
    expect(invoke).toHaveBeenCalledWith("perf_set_config", {
      enabled: true,
      intervalSecs: 1,
      retentionHours: 72,
      maxDbMb: 10,
      trackProcess: false,
      trackFrontend: true,
    });
  });
});

// ── perf_record_frontend_sample / perf_clear_history via mocked invoke ────────

describe("perf backend commands (mocked invoke)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("perf_record_frontend_sample resolves without throwing", async () => {
    await expect(
      invoke("perf_record_frontend_sample", {
        heapUsedMb: 128,
        jankCount: 3,
        jankTotalMs: 450,
        ptyEvents: 20,
        ptyBytes: 40960,
      })
    ).resolves.toBeNull();
  });

  it("perf_clear_history resolves without throwing", async () => {
    await expect(
      invoke("perf_clear_history")
    ).resolves.toBeNull();
  });

  it("perf_get_config resolves without throwing", async () => {
    await expect(
      invoke("perf_get_config")
    ).resolves.toBeNull();
  });
});

describe("timedSync (#3618)", () => {
  it("returns the fn result untouched", () => {
    expect(timedSync("x", () => 42)).toBe(42);
  });

  it("does NOT log a fast call (under the threshold)", () => {
    const warn = vi.spyOn(log, "warn");
    timedSync("fast", () => 1, 16);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs `[perf] <label> took Nms` when the call exceeds the threshold", () => {
    const warn = vi.spyOn(log, "warn");
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(25);
    timedSync("buildGraph:glance-project", () => 1, 16);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("buildGraph:glance-project took 25ms"));
  });

  it("still times (and rethrows) when the fn throws", () => {
    const warn = vi.spyOn(log, "warn");
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30);
    expect(() => timedSync("boom", () => { throw new Error("e"); }, 16)).toThrow("e");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom took 30ms"));
  });
});
