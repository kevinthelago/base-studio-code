// Many stops must render as ONE banner (`one-stop-banner-per-pane-fills-the-screen`).
//
// The events that end several sessions at once — an app relaunch, a fleet stop, a reaper sweep after
// the renderer dies — are exactly the ones that used to fill the screen with full-width bars, so the
// worst display coincided with the worst moment.
import { describe, it, expect } from "vitest";
import { stopsForNotice, stopSummary, type PaneStop } from "@/app/console/lib/paneStops";

const NOW = 1_000_000;
const stop = (paneId: string, reason: PaneStop["reason"], atOffset = 0, lastOutput?: string): PaneStop =>
  ({ paneId, reason, detail: "d", at: NOW - atOffset, lastOutput }) as PaneStop;

describe("collapsing many stops", () => {
  it("puts FAULTS first, whatever the order they arrived in", () => {
    // A fault carries its last words, and nothing else in the app has them once the pane is
    // recreated. Burying an exit=1 under six routine closes is how the one line worth reading
    // goes unread.
    const list = [
      stop("a:1", "app-closed", 100),
      stop("b:2", "app-closed", 50),
      stop("c:3", "failed", 400, "panic: boom"),
      stop("d:4", "app-closed", 10),
    ];
    const ordered = stopsForNotice(list, NOW);
    expect(ordered[0].paneId).toBe("c:3");
    expect(ordered[0].reason).toBe("failed");
  });

  it("orders the rest newest-first behind the faults", () => {
    const list = [stop("a:1", "app-closed", 300), stop("b:2", "app-closed", 10)];
    expect(stopsForNotice(list, NOW).map((s) => s.paneId)).toEqual(["b:2", "a:1"]);
  });

  it("summarises BY REASON, not by pane id", () => {
    // The ids are in the rows; this line answers "what happened to my sessions", which is a reason.
    const list = [
      stop("a:1", "app-closed", 10),
      stop("b:2", "app-closed", 20),
      stop("c:3", "reaped", 30),
    ];
    const s = stopSummary(stopsForNotice(list, NOW));
    expect(s).toContain("3 sessions stopped");
    expect(s).toContain("2 closed by the app");
    expect(s).toContain("1 reclaimed while idle");
    expect(s).not.toContain("a:1");
  });

  it("names the fault's reason first in the summary too", () => {
    const list = [stop("a:1", "app-closed", 10), stop("c:3", "failed", 20, "boom")];
    expect(stopSummary(stopsForNotice(list, NOW)).indexOf("error"))
      .toBeLessThan(stopSummary(stopsForNotice(list, NOW)).indexOf("closed by the app"));
  });

  it("reads naturally for a single stop", () => {
    expect(stopSummary(stopsForNotice([stop("a:1", "finished", 10)], NOW))).toContain("1 session stopped");
  });

  it("drops stops past the notice window, so the banner cannot grow forever", () => {
    const old = stop("old:1", "app-closed", 60_000);
    const fresh = stop("new:1", "app-closed", 100);
    expect(stopsForNotice([old, fresh], NOW).map((s) => s.paneId)).toEqual(["new:1"]);
  });

  it("is empty when nothing is active, so the banner does not render at all", () => {
    expect(stopsForNotice([stop("x:1", "app-closed", 60_000)], NOW)).toEqual([]);
    expect(stopSummary([])).toBe("");
  });
});
