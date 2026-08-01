// Completion outranks idle on the quiet branches (#4124).
//
// `complete` was derived only from RUNTIME session signals — an `ended` verdict of `done`, or an
// explicit maintenance park. Both describe a session, and sessions end. The issues do not. So a worker
// that finished its lane read `idle` (live but quiet) or `off` (session reclaimed) — the same words a
// node with nothing to do reports, which is how "idle won against completed".
import { describe, it, expect } from "vitest";
import { applyFleetLiveStatus } from "./lib/agentStall";
import type { GRawNode } from "./lib/glanceGraph";

const node = (id: string, progress?: { done: number; total: number }): GRawNode =>
  ({ id, slug: id, role: "service", health: "off", activity: "idle", progress }) as GRawNode;

const sig = (over: Partial<Parameters<typeof applyFleetLiveStatus>[2]> = {}) => ({
  livePaneIds: new Set<string>(), paneStatus: {}, waiting: [], now: 0, ...over,
}) as Parameters<typeof applyFleetLiveStatus>[2];

const only = (nodes: GRawNode[], s = sig()) => applyFleetLiveStatus(nodes, "proj", s)[0];

describe("a finished worker never reads idle (#4124)", () => {
  it("reads COMPLETE when its session is gone, not `off`", () => {
    // `off` means never launched. A worker that finished and was then reclaimed is not that.
    const out = only([node("api", { done: 3, total: 3 })]);
    expect(out.health).toBe("complete");
    expect(out.activity).toBe("complete");
  });

  it("reads COMPLETE when its session is live but quiet, not `idle`", () => {
    const out = only([node("api", { done: 2, total: 2 })], sig({ livePaneIds: new Set(["proj:api"]) }));
    expect(out.health).toBe("complete");
    expect(out.activity).toBe("complete");
  });

  it("still reads OFF when there is no session AND work remains", () => {
    const out = only([node("api", { done: 1, total: 3 })]);
    expect(out.health).toBe("off");
    expect(out.activity).toBe("idle");
  });

  it("still reads IDLE when a live session has work left", () => {
    const out = only([node("api", { done: 1, total: 3 })], sig({ livePaneIds: new Set(["proj:api"]) }));
    expect(out.health).toBe("healthy");
    expect(out.activity).toBe("idle");
  });

  it("a node owning NO issues is unaffected — completion is not vacuously true", () => {
    // 0/0 must not read as finished, or every unplanned node in the graph would claim completion.
    expect(only([node("standing", { done: 0, total: 0 })]).health).toBe("off");
    expect(only([node("standing")]).health).toBe("off");
  });

  it("a session actively BUILDING still reads building", () => {
    // What it is doing right now is the more urgent fact — even with its planned issues closed, which
    // is exactly the maintenance case.
    const out = only(
      [node("api", { done: 2, total: 2 })],
      sig({ livePaneIds: new Set(["proj:api"]), paneStatus: { "proj:api": "run" } }),
    );
    expect(out.activity).toBe("building");
  });

  it("a QUARANTINED worker still reads error — completion never hides something to act on", () => {
    const out = only(
      [node("api", { done: 2, total: 2 })],
      sig({ quarantined: { "proj:api": { summary: "drifted" } } } as never),
    );
    expect(out.health).toBe("error");
  });

  it("a worker parked on a QUESTION still reads waiting", () => {
    // Blocked on a person outranks finished: the park is what needs resolving.
    const out = only(
      [node("api", { done: 2, total: 2 })],
      sig({ livePaneIds: new Set(["proj:api"]), waiting: [{ session: "proj:api", at: 0, reason: "which repo?" }] } as never),
    );
    expect(out.activity).toBe("waiting");
  });

  it("a MAINTAINING worker reads complete even after its session is reclaimed (#4124)", () => {
    // THE ONE THAT WAS ACTUALLY BITING. The maintaining branch sat BELOW the `!livePaneIds` gate, so it
    // was unreachable for exactly the worker it describes: a maintenance park means "finished, standing
    // by", and a standing-by session is the first thing a reaper or a restart takes. Once the pane left
    // `livePaneIds` the node fell to `off`/`idle`. Measured: 34 panes have emitted `maintain`.
    const out = only(
      [node("api")],                                   // no progress data at all — the signal is the park
      sig({ maintaining: new Set(["proj:api"]) } as never),
    );
    expect(out.health).toBe("complete");
    expect(out.activity).toBe("complete");
  });

  it("a maintaining worker whose session IS live still reads complete", () => {
    const out = only(
      [node("api")],
      sig({ livePaneIds: new Set(["proj:api"]), maintaining: new Set(["proj:api"]) } as never),
    );
    expect(out.health).toBe("complete");
  });

  it("maintenance still loses to quarantine — something to act on outranks finished", () => {
    const out = only(
      [node("api")],
      sig({ maintaining: new Set(["proj:api"]), quarantined: { "proj:api": { summary: "drifted" } } } as never),
    );
    expect(out.health).toBe("error");
  });

  it("says WHY, so the state is discoverable from the node's own reason", () => {
    expect(only([node("api", { done: 3, total: 3 })]).reason).toMatch(/every owned issue complete/);
  });
});
