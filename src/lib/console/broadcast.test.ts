import { describe, it, expect } from "vitest";
import { computeBroadcastTargets } from "./broadcast";

describe("computeBroadcastTargets", () => {
  it("targets only the active tab's panes (never another tab)", () => {
    const { paneIds } = computeBroadcastTargets(2, 2, -1);
    expect(paneIds).toEqual(["t2p0", "t2p1"]);
    // every id belongs to tab 2
    expect(paneIds.every(id => id.startsWith("t2p"))).toBe(true);
  });

  it("excludes the focused pane (it self-handles via xterm)", () => {
    const { paneIds } = computeBroadcastTargets(0, 3, 1);
    expect(paneIds).toEqual(["t0p0", "t0p2"]);
  });

  it("does not suppress default when a pane in the tab is focused", () => {
    const { suppressDefault } = computeBroadcastTargets(0, 3, 1);
    expect(suppressDefault).toBe(false);
  });

  it("when no pane is focused, broadcasts to all panes and suppresses default", () => {
    const { paneIds, suppressDefault } = computeBroadcastTargets(1, 2, -1);
    expect(paneIds).toEqual(["t1p0", "t1p1"]);
    expect(suppressDefault).toBe(true);
  });

  it("ignores a stale focus index from a larger previous tab (does not skip a console)", () => {
    // focusedPaneIdx 3 carried over from a 2x2 tab, but this tab has only 2 panes.
    const { paneIds, suppressDefault } = computeBroadcastTargets(1, 2, 3);
    expect(paneIds).toEqual(["t1p0", "t1p1"]); // both consoles still receive input
    expect(suppressDefault).toBe(true);        // nothing in-tab is focused
  });

  it("treats a negative focus index as no focus", () => {
    const { paneIds, suppressDefault } = computeBroadcastTargets(0, 1, -1);
    expect(paneIds).toEqual(["t0p0"]);
    expect(suppressDefault).toBe(true);
  });

  it("single-pane tab with that pane focused broadcasts to nothing extra", () => {
    const { paneIds, suppressDefault } = computeBroadcastTargets(0, 1, 0);
    expect(paneIds).toEqual([]);
    expect(suppressDefault).toBe(false);
  });
});
