import { describe, it, expect } from "vitest";
import { planRequestSessions, type RequestSession, type RequestRow } from "@/shared/lib/session/poolPlan";
import { requestPaneId } from "@/shared/lib/session/requestSpawn";

// #one-request-one-debug-session — the 1:1 plan. Every CLAIMED request holds exactly one session, named
// for it; a session dies with its request.
//
// WHAT THESE REPLACE. The #3535 pool tests covered pacing (one warming at a time), a cap, and a warm-out
// reaper. None of those rules exist any more, and the tests for them were deleted rather than adapted:
// each described a behaviour that only made sense when a session launched WITHOUT work and had to race
// for it. Keeping them "passing" against 1:1 would have meant asserting rules the code no longer has.
//
// The gate and the reconcile survive, so those are still pinned — including the two cases that make the
// difference between a tidy queue and an orphaned session nobody can see.

const claimed = (id: number): RequestRow => ({ id, status: "claimed", claimedBy: null });
const open = (id: number): RequestRow => ({ id, status: "open", claimedBy: null });
const resolved = (id: number): RequestRow => ({ id, status: "resolved", claimedBy: null });
const session = (id: number): RequestSession => ({ paneId: requestPaneId(id) });

describe("the gate", () => {
  it("starts nothing and closes everything when auto-spawn is off", () => {
    const p = planRequestSessions({ requests: [claimed(1), claimed(2)], sessions: [session(1)], enabled: false });
    expect(p.start).toEqual([]);
    expect(p.close).toEqual([requestPaneId(1)]);
    expect(p.sessions).toEqual([]);
    expect(p.reason).toBeTruthy(); // the gate names itself — a stalled pool must be diagnosable
  });

  it("treats null/undefined as off, not as on", () => {
    for (const enabled of [null, undefined]) {
      expect(planRequestSessions({ requests: [claimed(1)], sessions: [], enabled }).start).toEqual([]);
    }
  });
});

describe("1:1 — a session per claimed request", () => {
  it("starts one session for every claimed request, all in the same cycle", () => {
    // The pool started at most ONE per cycle to pace growth toward a cap. With no cap there is nothing
    // to pace against, and staggering would just make the queue drain slower for no benefit.
    const p = planRequestSessions({ requests: [claimed(1), claimed(2), claimed(3)], sessions: [], enabled: true });
    expect(p.start).toEqual([1, 2, 3]);
    expect(p.close).toEqual([]);
  });

  it("never starts a second session for a request that already has one", () => {
    const p = planRequestSessions({ requests: [claimed(1), claimed(2)], sessions: [session(1)], enabled: true });
    expect(p.start).toEqual([2]);
    expect(p.sessions).toEqual([session(1)]); // the live one is kept, not restarted
  });

  it("does NOT start a session for an OPEN request — the mount claims first", () => {
    // The claim is the side effect that turns `open` into `claimed` AND yields the id to bind to. Planning
    // off `claimed` is what keeps this function pure; planning off `open` would start a session for work
    // another holder (the standing debug session) may be about to take.
    const p = planRequestSessions({ requests: [open(1), open(2)], sessions: [], enabled: true });
    expect(p.start).toEqual([]);
    expect(p.reason).toBe("no claimed requests");
  });
});

describe("a session dies with its request", () => {
  it("closes the session whose request resolved, and only that one", () => {
    const p = planRequestSessions({
      requests: [resolved(1), claimed(2)],
      sessions: [session(1), session(2)],
      enabled: true,
    });
    expect(p.close).toEqual([requestPaneId(1)]);
    expect(p.sessions).toEqual([session(2)]);
    expect(p.start).toEqual([]);
  });

  it("closes a session whose request VANISHED from the queue entirely", () => {
    // `bsc request remove`, or a prune. An id the queue no longer knows must not keep a session alive
    // forever — that is precisely the orphan the reaper used to exist for, handled here by reconciling
    // against the queue rather than by counting idle polls.
    const p = planRequestSessions({ requests: [claimed(2)], sessions: [session(1), session(2)], enabled: true });
    expect(p.close).toEqual([requestPaneId(1)]);
    expect(p.sessions).toEqual([session(2)]);
  });

  it("closes a pane whose id names no request at all", () => {
    // A leftover `debug-studio:pool-0` from the retired scheme, or anything else unparseable. Unresolvable
    // ⇒ closed, so a rename can never strand a session that nothing will ever reap.
    const p = planRequestSessions({
      requests: [claimed(1)],
      sessions: [{ paneId: "debug-studio:pool-0" }, session(1)],
      enabled: true,
    });
    expect(p.close).toEqual(["debug-studio:pool-0"]);
    expect(p.sessions).toEqual([session(1)]);
  });
});

describe("it says why when it starts nothing", () => {
  it("distinguishes an empty queue from a fully-served one", () => {
    expect(planRequestSessions({ requests: [], sessions: [], enabled: true }).reason).toBe("no claimed requests");
    expect(
      planRequestSessions({ requests: [claimed(1)], sessions: [session(1)], enabled: true }).reason,
    ).toBe("every claimed request already has a session");
  });

  it("gives no reason when it IS starting something", () => {
    expect(planRequestSessions({ requests: [claimed(1)], sessions: [], enabled: true }).reason).toBeUndefined();
  });
});
