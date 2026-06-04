import { describe, it, expect } from "vitest";
import {
  paneKey,
  parsePaneKey,
  paneCountForLayout,
  aggregateTabState,
  clearTabStatuses,
  type PaneStatus,
} from "../lib/paneStatus";

describe("paneKey / parsePaneKey", () => {
  it("round-trips a (tab, pane) cell", () => {
    expect(paneKey(2, 5)).toBe("t2p5");
    expect(parsePaneKey("t2p5")).toEqual({ tabIdx: 2, paneIdx: 5 });
  });
  it("returns null for a non-pane key", () => {
    expect(parsePaneKey("apply_tag")).toBeNull();
    expect(parsePaneKey("t2")).toBeNull();
  });
});

describe("paneCountForLayout", () => {
  it("multiplies cols × rows", () => {
    expect(paneCountForLayout("2×2")).toBe(4);
    expect(paneCountForLayout("4×4")).toBe(16);
    expect(paneCountForLayout("3×2")).toBe(6);
    expect(paneCountForLayout("1×1")).toBe(1);
  });
  it("falls back to 1 on a malformed layout", () => {
    expect(paneCountForLayout("garbage")).toBe(1);
    expect(paneCountForLayout("")).toBe(1);
  });
});

describe("aggregateTabState (#435 — tab rollup)", () => {
  it("is idle when every pane is idle / missing", () => {
    expect(aggregateTabState(0, "2×2", {})).toBe("idle");
    expect(aggregateTabState(0, "2×2", { t0p0: "idle", t0p1: "idle" })).toBe("idle");
  });

  it("is run when any in-grid pane is running", () => {
    expect(aggregateTabState(0, "2×2", { t0p0: "on", t0p3: "run" })).toBe("run");
  });

  it("is on when at least one pane is attached and none is running", () => {
    expect(aggregateTabState(0, "2×2", { t0p0: "idle", t0p1: "on" })).toBe("on");
  });

  it("only counts the SOURCE tab's panes, not other tabs", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "idle", t1p0: "run" };
    expect(aggregateTabState(0, "2×2", statuses)).toBe("idle");
    expect(aggregateTabState(1, "2×2", statuses)).toBe("run");
  });

  // layout-change: a pane that fell outside the (now smaller) grid stops contributing.
  it("ignores panes trimmed out by a layout shrink", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "idle", t0p3: "run" };
    expect(aggregateTabState(0, "2×2", statuses)).toBe("run"); // p3 is in a 2×2
    expect(aggregateTabState(0, "1×1", statuses)).toBe("idle"); // p3 trimmed out of a 1×1
  });

  // disabled-pane: a disabled cell never counts, even if it carries a stale "run".
  it("excludes disabled panes from the rollup", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "run", t0p1: "idle" };
    expect(aggregateTabState(0, "2×2", statuses)).toBe("run");
    expect(aggregateTabState(0, "2×2", statuses, { t0p0: true })).toBe("idle");
  });

  // mid-turn-pause: one pane pausing to idle must not pull the tab out of "run"
  // while another pane is still working.
  it("stays run when one pane pauses but another keeps working", () => {
    expect(aggregateTabState(0, "2×2", { t0p0: "run", t0p1: "idle", t0p2: "on" })).toBe("run");
  });
});

describe("clearTabStatuses (#435 — stale clear on close/remount)", () => {
  it("drops only the target tab's pane statuses", () => {
    const statuses: Record<string, PaneStatus> = {
      t0p0: "run", t0p1: "on",
      t1p0: "run", t1p1: "idle",
    };
    expect(clearTabStatuses(statuses, 0)).toEqual({ t1p0: "run", t1p1: "idle" });
  });

  it("leaves non-pane keys untouched and does not mutate the input", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "run" };
    const out = clearTabStatuses(statuses, 0);
    expect(out).toEqual({});
    expect(statuses).toEqual({ t0p0: "run" }); // unchanged
  });

  // remount: after clearing, the aggregate for that tab is idle until panes re-emit —
  // so a relaunched tab never inherits the prior session's running dot.
  it("makes the cleared tab aggregate to idle", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "run", t0p1: "run" };
    const cleared = clearTabStatuses(statuses, 0);
    expect(aggregateTabState(0, "2×2", cleared)).toBe("idle");
  });
});
