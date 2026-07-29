import { describe, it, expect, beforeEach } from "vitest";
import { subscribePaneActivity, publishPaneActivity, currentPaneActivity } from "./usePaneActivityFeed";
import type { PaneActivity } from "./paneActivity";

const rows = (...panes: string[]): PaneActivity[] =>
  panes.map((p, i) => ({ pane: p, state: "run", at: 1000 + i }) as PaneActivity);

describe("pane-activity shared feed (#3944)", () => {
  beforeEach(() => publishPaneActivity([]));

  it("fans ONE publish out to every subscriber — the whole point", () => {
    // Previously each pane invoked `logs_pane_activity` itself, so N panes meant N identical
    // full-table reads per activity-log write (24% of all invoke time).
    const seen: PaneActivity[][] = [];
    const un = [
      subscribePaneActivity((r) => seen.push(r)),
      subscribePaneActivity((r) => seen.push(r)),
      subscribePaneActivity((r) => seen.push(r)),
    ];
    publishPaneActivity(rows("a", "b"));
    expect(seen).toHaveLength(3);
    expect(seen.every((r) => r.length === 2)).toBe(true);
    un.forEach((f) => f());
  });

  it("replays the current table to a LATE subscriber, so a pane mounting mid-stream isn't blind", () => {
    publishPaneActivity(rows("a"));
    const seen: PaneActivity[][] = [];
    const un = subscribePaneActivity((r) => seen.push(r));
    expect(seen).toHaveLength(1);
    expect(seen[0][0].pane).toBe("a");
    un();
  });

  it("does not replay an EMPTY table — that would clobber a consumer's state with nothing", () => {
    const seen: PaneActivity[][] = [];
    const un = subscribePaneActivity((r) => seen.push(r));
    expect(seen).toHaveLength(0);
    un();
  });

  it("stops delivering after unsubscribe", () => {
    let n = 0;
    const un = subscribePaneActivity(() => { n += 1; });
    publishPaneActivity(rows("a"));
    un();
    publishPaneActivity(rows("a", "b"));
    expect(n).toBe(1);
  });

  it("exposes the latest table synchronously", () => {
    publishPaneActivity(rows("x", "y", "z"));
    expect(currentPaneActivity().map((r) => r.pane)).toEqual(["x", "y", "z"]);
  });

  it("one subscriber throwing does not starve the others", () => {
    // A pane's callback writes an imperative ref; if one pane's handler ever throws, the remaining
    // panes must still get their rows or the console silently stops tracking turn state.
    const seen: string[] = [];
    const un = [
      subscribePaneActivity(() => { throw new Error("boom"); }),
      subscribePaneActivity(() => { seen.push("second"); }),
    ];
    expect(() => publishPaneActivity(rows("a"))).not.toThrow();
    expect(seen).toEqual(["second"]);
    un.forEach((f) => f());
  });
});
