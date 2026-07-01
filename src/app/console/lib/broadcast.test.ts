import { describe, it, expect } from "vitest";
import { computeBroadcastTargets } from "./broadcast";
import type { PaneIdentityTab } from "./paneIdentity";

// A positional/legacy tab (no id, no kind) → paneIdFor yields `t{idx}p{n}`.
const ptab = (layout: string): PaneIdentityTab & { layout: string } => ({ layout });

describe("computeBroadcastTargets", () => {
  it("targets only the active tab's panes (never another tab)", () => {
    const { paneIds } = computeBroadcastTargets(ptab("2×1"), 2, -1);
    expect(paneIds).toEqual(["t2p0", "t2p1"]);
    // every id belongs to tab 2
    expect(paneIds.every(id => id.startsWith("t2p"))).toBe(true);
  });

  it("excludes the focused pane (it self-handles via xterm)", () => {
    const { paneIds } = computeBroadcastTargets(ptab("3×1"), 0, 1);
    expect(paneIds).toEqual(["t0p0", "t0p2"]);
  });

  it("does not suppress default when a pane in the tab is focused", () => {
    const { suppressDefault } = computeBroadcastTargets(ptab("3×1"), 0, 1);
    expect(suppressDefault).toBe(false);
  });

  it("when no pane is focused, broadcasts to all panes and suppresses default", () => {
    const { paneIds, suppressDefault } = computeBroadcastTargets(ptab("2×1"), 1, -1);
    expect(paneIds).toEqual(["t1p0", "t1p1"]);
    expect(suppressDefault).toBe(true);
  });

  it("ignores a stale focus index from a larger previous tab (does not skip a console)", () => {
    // focusedPaneIdx 3 carried over from a 2x2 tab, but this tab has only 2 panes.
    const { paneIds, suppressDefault } = computeBroadcastTargets(ptab("2×1"), 1, 3);
    expect(paneIds).toEqual(["t1p0", "t1p1"]); // both consoles still receive input
    expect(suppressDefault).toBe(true);        // nothing in-tab is focused
  });

  it("treats a negative focus index as no focus", () => {
    const { paneIds, suppressDefault } = computeBroadcastTargets(ptab("1×1"), 0, -1);
    expect(paneIds).toEqual(["t0p0"]);
    expect(suppressDefault).toBe(true);
  });

  it("single-pane tab with that pane focused broadcasts to nothing extra", () => {
    const { paneIds, suppressDefault } = computeBroadcastTargets(ptab("1×1"), 0, 0);
    expect(paneIds).toEqual([]);
    expect(suppressDefault).toBe(false);
  });

  // #1176 regression: a manual tab's PTYs are keyed `man:<tabId>:p<n>`, so broadcasting
  // positional ids hit nothing. Targets must be the tab's stable ids.
  it("targets a manual tab's stable `man:` pane ids", () => {
    const { paneIds } = computeBroadcastTargets({ id: "tab-M", layout: "2×1" }, 0, -1);
    expect(paneIds).toEqual(["man:tab-M:p0", "man:tab-M:p1"]);
  });

  // A fleet tab's minted paneIds are the broadcast targets.
  it("targets a fleet tab's minted paneIds", () => {
    const tab = { id: "x", kind: "build" as const, layout: "2×1", paneIds: ["proj:director", "proj:auth"] };
    const { paneIds } = computeBroadcastTargets(tab, 0, 0); // p0 (director) focused → excluded
    expect(paneIds).toEqual(["proj:auth"]);
  });
});
