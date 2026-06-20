import { describe, it, expect } from "vitest";
import { panesToReap, isReapable, thresholdFor, DEFAULT_REAPER_CONFIG, type ReaperPane, type ReaperConfig } from "./idleReaper";

const NOW = 1_000_000_000;
const cfg: ReaperConfig = { enabled: true, idleMs: 30 * 60_000, workerIdleMs: null };

const pane = (over: Partial<ReaperPane>): ReaperPane => ({
  paneId: "t0p0", status: "idle", role: "planner", lastActivityMs: NOW - 60 * 60_000,
  focused: false, dormant: false, ...over,
});

describe("idle reaper eligibility (#849)", () => {
  it("reaps an idle, non-focused project session past the threshold", () => {
    expect(isReapable(pane({}), cfg, NOW)).toBe(true);
  });

  it("never reaps the focused pane", () => {
    expect(isReapable(pane({ focused: true }), cfg, NOW)).toBe(false);
  });

  it("never reaps a mid-turn (run) pane", () => {
    expect(isReapable(pane({ status: "run" }), cfg, NOW)).toBe(false);
  });

  it("never reaps an already-dormant pane", () => {
    expect(isReapable(pane({ dormant: true }), cfg, NOW)).toBe(false);
  });

  it("does not reap before the idle threshold elapses", () => {
    expect(isReapable(pane({ lastActivityMs: NOW - 10 * 60_000 }), cfg, NOW)).toBe(false);
  });

  it("does nothing when disabled", () => {
    expect(isReapable(pane({}), { ...cfg, enabled: false }, NOW)).toBe(false);
  });

  it("leaves workers/director alone by default (workerIdleMs = null)", () => {
    expect(isReapable(pane({ role: "worker" }), cfg, NOW)).toBe(false);
    expect(isReapable(pane({ role: "director" }), cfg, NOW)).toBe(false);
    expect(thresholdFor("worker", cfg)).toBeNull();
    expect(thresholdFor("planner", cfg)).toBe(cfg.idleMs);
  });

  it("reaps workers only under the separate longer threshold when opted in", () => {
    const optIn: ReaperConfig = { ...cfg, workerIdleMs: 2 * 60 * 60_000 }; // 2h
    // 1h idle worker: under the 2h worker threshold → not yet.
    expect(isReapable(pane({ role: "worker", lastActivityMs: NOW - 60 * 60_000 }), optIn, NOW)).toBe(false);
    // 3h idle worker: past it → reaped.
    expect(isReapable(pane({ role: "worker", lastActivityMs: NOW - 3 * 60 * 60_000 }), optIn, NOW)).toBe(true);
  });

  it("panesToReap selects only the eligible pane ids from a mixed snapshot", () => {
    const panes: ReaperPane[] = [
      pane({ paneId: "idle-old" }),                                  // ✓ reap
      pane({ paneId: "focused", focused: true }),                    // ✗ watching
      pane({ paneId: "running", status: "run" }),                    // ✗ mid-turn
      pane({ paneId: "fresh", lastActivityMs: NOW - 60_000 }),       // ✗ too recent
      pane({ paneId: "worker", role: "worker" }),                    // ✗ conservative
      pane({ paneId: "dormant", dormant: true }),                    // ✗ already reaped
    ];
    expect(panesToReap(panes, cfg, NOW)).toEqual(["idle-old"]);
  });

  it("default config is on, 30m for projects, workers off", () => {
    expect(DEFAULT_REAPER_CONFIG.enabled).toBe(true);
    expect(DEFAULT_REAPER_CONFIG.idleMs).toBe(30 * 60_000);
    expect(DEFAULT_REAPER_CONFIG.workerIdleMs).toBeNull();
  });
});
