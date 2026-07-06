import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";

vi.mock("@/shared/lib/core/bsc", () => ({
  // Must resolve the fallback like the real bridge: this file imports @/store, whose
  // persist-rehydrate calls `bscJson(...).then(...)` — a bare vi.fn() returns undefined
  // and that `.then` becomes an unhandled rejection that fails the whole vitest run (#2414).
  bscJson: vi.fn(async (_key: string | null, _args: string[], fallback: unknown) => fallback),
  bscWrite: vi.fn(async () => {}),
}));
vi.mock("./tunnelClient", () => ({
  tunnelSetHookTelemetry: vi.fn().mockResolvedValue(undefined),
}));

import { bscJson } from "@/shared/lib/core/bsc";
import { tunnelSetHookTelemetry } from "./tunnelClient";
import { useTunnelHookTelemetry, toHookTelemetryFrame } from "./useTunnelHookTelemetry";

// A day the fixed `now` below falls inside the 14-day window of.
const NOW = new Date("2026-05-29T12:00:00.000Z");
const TS = new Date("2026-05-29T09:00:00.000Z").getTime();

// TSV hook-fire lines: `ts \t event \t hook \t outcome` (legacy 4-col shape parseHookLog tolerates).
function line(hook: string, event: string, outcome: string, ts = TS): string {
  return `${ts}\t${event}\t${hook}\t${outcome}`;
}

describe("toHookTelemetryFrame (#937)", () => {
  it("aggregates the log into the read-only wire frame (camelCase, per-hook, daily)", () => {
    const lines = [
      line("bsc-deny", "PreToolUse", "allow"),
      line("bsc-deny", "PreToolUse", "block"),
      line("bsc-audit", "PostToolUse", "ok"),
    ];
    const frame = toHookTelemetryFrame(lines, NOW);
    expect(frame.total).toBe(3);
    expect(frame.allows).toBe(1);
    expect(frame.blocks).toBe(1);
    expect(frame.allowRate).toBe(50); // 1 / (1 + 1)
    expect(frame.perHook).toEqual(
      expect.arrayContaining([expect.objectContaining({ hook: "bsc-deny", event: "PreToolUse", fires: 2 })]),
    );
    expect(frame.daily.length).toBe(14); // stable window length
    // Sum across buckets (TZ-independent — which local day a fire lands in isn't asserted).
    expect(frame.daily.reduce((n, d) => n + d.blocks, 0)).toBe(1);
    expect(frame.daily.reduce((n, d) => n + d.allows, 0)).toBe(2); // allow + ok
  });

  it("is safe on an empty log (allowRate defaults to 100)", () => {
    const frame = toHookTelemetryFrame([], NOW);
    expect(frame.total).toBe(0);
    expect(frame.allowRate).toBe(100);
    expect(frame.perHook).toEqual([]);
  });
});

describe("useTunnelHookTelemetry (#937)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The hook aggregates with `new Date()` (a real-time 14-day window), so the fixture line must be
    // RECENT — a hardcoded past date rots out of the window over time and the frame reads all-zeros.
    vi.mocked(bscJson).mockResolvedValue([line("bsc-deny", "PreToolUse", "block", Date.now() - 3_600_000)]);
    useAppStore.setState({ tunnelRunning: true });
  });

  it("projects hook telemetry to the phone when the tunnel is running", async () => {
    renderHook(() => useTunnelHookTelemetry());
    await waitFor(() => expect(tunnelSetHookTelemetry).toHaveBeenCalled());
    const frame = vi.mocked(tunnelSetHookTelemetry).mock.calls[0][0];
    expect(frame).toEqual(
      expect.objectContaining({ total: 1, blocks: 1, perHook: expect.any(Array) }),
    );
  });

  it("does not project while the tunnel is down", async () => {
    useAppStore.setState({ tunnelRunning: false });
    renderHook(() => useTunnelHookTelemetry());
    await new Promise((r) => setTimeout(r, 0));
    expect(bscJson).not.toHaveBeenCalled();
    expect(tunnelSetHookTelemetry).not.toHaveBeenCalled();
  });
});
