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

describe("declared maintenance is reaped immediately (#4025)", () => {
  const cfg = { enabled: true, idleMs: 30 * 60 * 1000, workerIdleMs: null, studioIdleMs: 30 * 60 * 1000 };
  const NOW = 1_000_000;
  const pane = (over: Partial<ReaperPane> = {}): ReaperPane => ({
    paneId: "k:auth", status: "idle", role: "worker", lastActivityMs: NOW, focused: false, dormant: false, ...over,
  });

  it("reaps a maintaining worker with NO idle threshold", () => {
    // lastActivityMs === now: it JUST declared maintenance and is already reapable. That is the point —
    // it has said its work is done, so the PTY holds nothing worth keeping (~413 MB each).
    expect(isReapable(pane({ maintaining: true }), cfg, NOW)).toBe(true);
  });

  it("still does NOT reap an ordinary idle worker", () => {
    // The `workerIdleMs: null` default exists because a worker parked on a real question is
    // indistinguishable from one that is done. Maintenance removes that ambiguity; nothing else does.
    expect(isReapable(pane({ lastActivityMs: NOW - 10 * 60 * 60 * 1000 }), cfg, NOW)).toBe(false);
  });

  it("never reaps a maintaining worker that is mid-turn", () => {
    // It re-entered maintenance but is working again (a dispatch landed). Killing it would cut off
    // work in flight — the one thing reaping must never do.
    expect(isReapable(pane({ maintaining: true, status: "run" }), cfg, NOW)).toBe(false);
  });

  it("never reaps the pane the user is watching, maintaining or not", () => {
    expect(isReapable(pane({ maintaining: true, focused: true }), cfg, NOW)).toBe(false);
  });

  it("does not reap twice", () => {
    expect(isReapable(pane({ maintaining: true, dormant: true }), cfg, NOW)).toBe(false);
  });

  it("respects the master switch", () => {
    expect(isReapable(pane({ maintaining: true }), { ...cfg, enabled: false }, NOW)).toBe(false);
  });

  it("selects it through panesToReap alongside ordinary candidates", () => {
    const out = panesToReap([pane({ maintaining: true }), pane({ paneId: "k:other" })], cfg, NOW);
    expect(out).toEqual(["k:auth"]);
  });
});
