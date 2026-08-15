import { describe, it, expect } from "vitest";
import { requestPaneId, requestNodeId, requestIdFromNodeId, requestIdFromPaneId } from "@/shared/lib/session/requestSpawn";

// The spawn DECISION lives in poolPlan.ts (tested in poolPlan.test.ts); this file covers identity only —
// the pane/node ids and the inverses the mount and the Glance graph use to get back to a request.
//
// #one-request-one-debug-session made the number a REQUEST ID rather than a pool slot. That is why the
// inverses matter more than they used to: a slot was a bookkeeping integer, but a request id is the join
// between a running session, its node, and the work it was given — so a wrong parse silently binds a
// session to someone else's request.
describe("request-session identity", () => {
  it("names a request's pane under the full-capability debug-studio prefix", () => {
    expect(requestPaneId(0)).toBe("debug-studio:req-0");
    expect(requestPaneId(78)).toBe("debug-studio:req-78");
    // Under `debug-studio:` so isFullCapabilitySession matches it (#3520) — the prefix is what that
    // predicate keys on, never the singleton id.
    expect(requestPaneId(3).startsWith("debug-studio:")).toBe(true);
  });

  it("names a request's Glance node distinctly from its pane", () => {
    expect(requestNodeId(0)).toBe("debugger-req-0");
    expect(requestNodeId(78)).toBe("debugger-req-78");
    expect(requestNodeId(1)).not.toBe(requestPaneId(1));
  });

  it("resolves a node back to its request, and rejects non-request nodes", () => {
    expect(requestIdFromNodeId("debugger-req-0")).toBe(0);
    expect(requestIdFromNodeId("debugger-req-42")).toBe(42);
    expect(requestIdFromNodeId(requestNodeId(5))).toBe(5); // round-trip
    expect(requestIdFromNodeId("debugger")).toBeNull(); // the standing session node
    expect(requestIdFromNodeId("designer")).toBeNull();
    expect(requestIdFromNodeId("debugger-req-x")).toBeNull(); // non-numeric
  });

  it("resolves a pane id back to its request", () => {
    expect(requestIdFromPaneId("debug-studio:req-0")).toBe(0);
    expect(requestIdFromPaneId(requestPaneId(9))).toBe(9); // round-trip
    expect(requestIdFromPaneId("debug-studio:debugger")).toBeNull(); // the standing session pane
    expect(requestIdFromPaneId("proj:auth")).toBeNull();
  });

  it("does NOT answer to the retired pool ids — a stale pane must not bind to a request", () => {
    // The previous scheme was `debug-studio:pool-<slot>` / `debugger-pool-<slot>`. A pane left over from
    // it names a SLOT, and reading that integer as a request id would attach a session to unrelated work.
    // The plan closes what it cannot resolve, so returning null here is what reaps a stale pane.
    expect(requestIdFromPaneId("debug-studio:pool-0")).toBeNull();
    expect(requestIdFromNodeId("debugger-pool-0")).toBeNull();
  });
});
