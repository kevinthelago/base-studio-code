import { describe, it, expect } from "vitest";
import {
  paneKey,
  parsePaneKey,
  paneCountForLayout,
  aggregateTabState,
  clearTabStatuses,
  type PaneStatus,
  type StatusTab,
} from "./paneStatus";

// A legacy/positional tab (no id, no kind) → paneIdFor yields `t{idx}p{n}`.
const ptab = (layout: string): StatusTab => ({ layout });

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
    expect(aggregateTabState(ptab("2×2"), 0, {})).toBe("idle");
    expect(aggregateTabState(ptab("2×2"), 0, { t0p0: "idle", t0p1: "idle" })).toBe("idle");
  });

  it("is run when any in-grid pane is running", () => {
    expect(aggregateTabState(ptab("2×2"), 0, { t0p0: "on", t0p3: "run" })).toBe("run");
  });

  it("is on when at least one pane is attached and none is running", () => {
    expect(aggregateTabState(ptab("2×2"), 0, { t0p0: "idle", t0p1: "on" })).toBe("on");
  });

  it("only counts the SOURCE tab's panes, not other tabs", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "idle", t1p0: "run" };
    expect(aggregateTabState(ptab("2×2"), 0, statuses)).toBe("idle");
    expect(aggregateTabState(ptab("2×2"), 1, statuses)).toBe("run");
  });

  // layout-change: a pane that fell outside the (now smaller) grid stops contributing.
  it("ignores panes trimmed out by a layout shrink", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "idle", t0p3: "run" };
    expect(aggregateTabState(ptab("2×2"), 0, statuses)).toBe("run"); // p3 is in a 2×2
    expect(aggregateTabState(ptab("1×1"), 0, statuses)).toBe("idle"); // p3 trimmed out of a 1×1
  });

  // disabled-pane: a disabled cell never counts, even if it carries a stale "run".
  it("excludes disabled panes from the rollup", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "run", t0p1: "idle" };
    expect(aggregateTabState(ptab("2×2"), 0, statuses)).toBe("run");
    expect(aggregateTabState(ptab("2×2"), 0, statuses, { t0p0: true })).toBe("idle");
  });

  // mid-turn-pause: one pane pausing to idle must not pull the tab out of "run"
  // while another pane is still working.
  it("stays run when one pane pauses but another keeps working", () => {
    expect(aggregateTabState(ptab("2×2"), 0, { t0p0: "run", t0p1: "idle", t0p2: "on" })).toBe("run");
  });

  // #1176 regression: a MANUAL tab's panes are keyed `man:<tabId>:p<n>`, NOT positional —
  // the rollup must read those ids (the bug rolled up nothing → a stuck activity dot).
  it("rolls up a manual tab's `man:` pane ids (not positional)", () => {
    const tab: StatusTab = { id: "tab-A", layout: "2×2" };
    expect(aggregateTabState(tab, 0, { "man:tab-A:p1": "run" })).toBe("run");
    expect(aggregateTabState(tab, 0, { "man:tab-A:p0": "on" })).toBe("on");
    // A stray positional id at this index does NOT count for a manual tab.
    expect(aggregateTabState(tab, 0, { t0p0: "run" })).toBe("idle");
    // Disabled keyed by the manual id excludes the cell.
    expect(aggregateTabState(tab, 0, { "man:tab-A:p0": "run" }, { "man:tab-A:p0": true })).toBe("idle");
  });

  // #1176 regression: fleet/triage tabs carry minted `paneIds[]` (director/worker ids).
  it("rolls up a fleet tab's minted paneIds", () => {
    const tab: StatusTab = { id: "x", kind: "build", layout: "1×2", paneIds: ["proj:director", "proj:auth"] };
    expect(aggregateTabState(tab, 0, { "proj:auth": "run" })).toBe("run");
    expect(aggregateTabState(tab, 0, { "proj:director": "on" })).toBe("on");
  });
});

describe("clearTabStatuses (#435 — stale clear on close/remount)", () => {
  it("drops only the target tab's pane statuses", () => {
    const statuses: Record<string, PaneStatus> = {
      t0p0: "run", t0p1: "on",
      t1p0: "run", t1p1: "idle",
    };
    expect(clearTabStatuses(statuses, ptab("2×2"), 0)).toEqual({ t1p0: "run", t1p1: "idle" });
  });

  it("leaves non-pane keys untouched and does not mutate the input", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "run", apply_tag: "run" as PaneStatus };
    const out = clearTabStatuses(statuses, ptab("2×2"), 0);
    expect(out).toEqual({ apply_tag: "run" }); // unrecognized key kept; positional t0p* dropped
    expect(statuses).toEqual({ t0p0: "run", apply_tag: "run" }); // unchanged
  });

  // remount: after clearing, the aggregate for that tab is idle until panes re-emit —
  // so a relaunched tab never inherits the prior session's running dot.
  it("makes the cleared tab aggregate to idle", () => {
    const statuses: Record<string, PaneStatus> = { t0p0: "run", t0p1: "run" };
    const cleared = clearTabStatuses(statuses, ptab("2×2"), 0);
    expect(aggregateTabState(ptab("2×2"), 0, cleared)).toBe("idle");
  });

  // #1176 regression: clears a manual tab's `man:` ids (the positional parse kept them,
  // so a relaunched manual tab inherited a stale running dot).
  it("clears a manual tab's `man:` ids and keeps other tabs", () => {
    const statuses: Record<string, PaneStatus> = {
      "man:tab-A:p0": "run", "man:tab-A:p1": "on",
      "man:tab-B:p0": "run",
    };
    expect(clearTabStatuses(statuses, { id: "tab-A" }, 0)).toEqual({ "man:tab-B:p0": "run" });
  });
});
