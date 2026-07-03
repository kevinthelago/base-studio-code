// fleetHealth (#2240) — the unified error feed.
import { describe, it, expect } from "vitest";
import { buildFleetHealth } from "./fleetHealth";

describe("buildFleetHealth (#2240)", () => {
  const nameByPane = new Map([["p1", "alpha"], ["p2", "beta"]]);

  it("merges every signal, pins live coord issues on top, resolves names, and counts", () => {
    const h = buildFleetHealth({
      perm: [{ ts_ms: 100, session: "p1", summary: "scope block src/App.tsx" }],
      quarantined: { p2: { streamId: "s-beta", summary: "denied git push --force", at: 200 } },
      ended: {
        p1: { state: "blocked", streamId: "s-alpha", summary: "1/3 landed", at: 150 },
        p3: { state: "done", streamId: "s-c", summary: "3/3", at: 300 }, // done is NOT an error
      },
      blocked: [{ session: "p1", stalled: true, deadlocked: false, deps: [{ ref: "#42", status: "failed" }] }],
      nameByPane,
    });
    expect(h.hasIssues).toBe(true);
    expect(h.total).toBe(4);                 // stall + quarantine + blocked + denied (done excluded)
    expect(h.items[0].kind).toBe("stalled"); // live coord issue pinned to top
    expect(h.items[0].detail).toContain("#42");
    expect(h.items[0].label).toBe("alpha");  // p1 → name
    expect(h.counts.quarantine).toBe(1);
    expect(h.counts.blocked).toBe(1);
    expect(h.counts.denied).toBe(1);
    expect(h.items.some((i) => i.detail === "3/3")).toBe(false); // done not surfaced
  });

  it("nothing wrong (only a done worker) → no issues", () => {
    const h = buildFleetHealth({
      perm: [], quarantined: {}, blocked: [],
      ended: { p1: { state: "done", streamId: "s", summary: "ok", at: 1 } },
      nameByPane: new Map(),
    });
    expect(h.hasIssues).toBe(false);
    expect(h.total).toBe(0);
  });
});
