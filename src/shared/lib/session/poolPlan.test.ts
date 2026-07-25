import { describe, it, expect } from "vitest";
import { planPool, MAX_WARM_POLLS, type RequestRow, type PoolSession } from "./poolPlan";

const open = (id: number): RequestRow => ({ id, status: "open" });
const claimed = (id: number, by: string): RequestRow => ({ id, status: "claimed", claimedBy: by });
const resolved = (id: number): RequestRow => ({ id, status: "resolved" });
const warming = (paneId: string, pollsWarming = 0): PoolSession => ({ paneId, claimedId: null, pollsWarming });
const busy = (paneId: string, claimedId: number): PoolSession => ({ paneId, claimedId, pollsWarming: 0 });

// cap is TOTAL incl. the standing session, so overflow is capped at cap-1. Use cap 3 ⇒ 2 overflow.
const CAP = 3;

describe("planPool — the warm-pool overflow decision (#3535)", () => {
  it("spawns NOTHING and closes every session when auto-spawn is off", () => {
    const p = planPool({ requests: [open(1)], sessions: [busy("pool-a", 9)], enabled: false, cap: CAP });
    expect(p.spawn).toBe(false);
    expect(p.close).toEqual(["pool-a"]); // the pool drains to just the standing session
    expect(p.sessions).toEqual([]);
    expect(p.reason).toMatch(/auto-spawn/i);
  });

  it("with the primary busy and claimable work, spawns ONE overflow (prefer, then scale)", () => {
    // The standing session has claimed #1 (it is the primary); #2 is still claimable. No overflow yet.
    const p = planPool({
      requests: [claimed(1, "debug-studio:debugger"), open(2)],
      sessions: [],
      enabled: true,
      cap: CAP,
    });
    expect(p.spawn).toBe(true);
    expect(p.close).toEqual([]);
  });

  it("does NOT spawn a second while one is still warming — paced one at a time", () => {
    const p = planPool({
      requests: [open(2), open(3)], // two claimable, but...
      sessions: [warming("pool-a")], // ...a session is still warming
      enabled: true,
      cap: CAP,
    });
    expect(p.spawn).toBe(false);
    expect(p.reason).toMatch(/warming/i);
    // the warming session is kept, its counter bumped
    expect(p.sessions).toEqual([{ paneId: "pool-a", claimedId: null, pollsWarming: 1 }]);
  });

  it("transitions a warming session to busy once the queue shows its claim", () => {
    const p = planPool({
      requests: [claimed(2, "pool-a")],
      sessions: [warming("pool-a", 1)],
      enabled: true,
      cap: CAP,
    });
    expect(p.sessions).toEqual([{ paneId: "pool-a", claimedId: 2, pollsWarming: 0 }]);
    expect(p.close).toEqual([]);
    // no claimable work left ⇒ no new spawn
    expect(p.spawn).toBe(false);
    expect(p.reason).toMatch(/no claimable/i);
  });

  it("closes a session when its claimed request resolves — work done", () => {
    const p = planPool({
      requests: [resolved(2)], // pool-a's request is now resolved
      sessions: [busy("pool-a", 2)],
      enabled: true,
      cap: CAP,
    });
    expect(p.close).toEqual(["pool-a"]);
    expect(p.sessions).toEqual([]);
  });

  it("closes a session that lost its claim (unclaimed / regrabbed by another)", () => {
    // pool-a thought it held #2, but the queue now shows #2 claimed by someone else.
    const p = planPool({
      requests: [claimed(2, "debug-studio:debugger")],
      sessions: [busy("pool-a", 2)],
      enabled: true,
      cap: CAP,
    });
    expect(p.close).toEqual(["pool-a"]);
  });

  it("reaps a session that warms out (never claims anything)", () => {
    const atLimit = planPool({
      requests: [], // nothing to claim — it lost the race / queue drained
      sessions: [warming("pool-a", MAX_WARM_POLLS)],
      enabled: true,
      cap: CAP,
    });
    expect(atLimit.close).toEqual(["pool-a"]); // exceeded MAX_WARM_POLLS this cycle
    expect(atLimit.sessions).toEqual([]);
  });

  it("keeps a warming session that is still within the grace window", () => {
    const p = planPool({
      requests: [],
      sessions: [warming("pool-a", 0)],
      enabled: true,
      cap: CAP,
    });
    expect(p.close).toEqual([]);
    expect(p.sessions[0].pollsWarming).toBe(1);
  });

  it("respects the overflow cap (cap - 1), counting live sessions, and flags capacity pressure", () => {
    // cap 3 ⇒ 2 overflow max. Two already busy + more claimable work ⇒ still no spawn, AND atCapacity.
    const p = planPool({
      requests: [claimed(1, "pool-a"), claimed(2, "pool-b"), open(3), open(4)],
      sessions: [busy("pool-a", 1), busy("pool-b", 2)],
      enabled: true,
      cap: CAP,
    });
    expect(p.spawn).toBe(false);
    expect(p.reason).toMatch(/cap/i);
    expect(p.close).toEqual([]);
    // The "we need more but can't" signal the mount logs (#3535).
    expect(p.atCapacity).toBe(true);
    expect(p.waiting).toBe(2); // #3 and #4 are waiting with no free session
  });

  it("does not flag capacity pressure when the block is pacing or empty queue, only the cap", () => {
    // warming (paced) — not capacity pressure.
    const paced = planPool({ requests: [open(1), open(2)], sessions: [warming("x")], enabled: true, cap: CAP });
    expect(paced.atCapacity).toBe(false);
    expect(paced.waiting).toBe(0);
    // empty queue — not capacity pressure.
    const empty = planPool({ requests: [claimed(1, "x")], sessions: [busy("x", 1)], enabled: true, cap: CAP });
    expect(empty.atCapacity).toBe(false);
  });

  it("does not spawn when there is no claimable work even if under cap", () => {
    const p = planPool({
      requests: [claimed(1, "pool-a")], // the only request is already being worked
      sessions: [busy("pool-a", 1)],
      enabled: true,
      cap: CAP,
    });
    expect(p.spawn).toBe(false);
    expect(p.reason).toMatch(/no claimable/i);
  });

  it("nothing is ever silently dropped — a non-spawn always carries a reason", () => {
    // Exhaustive-ish: across a spread of states, spawn===false implies a reason string.
    const states: PoolPlanInputLite[] = [
      { requests: [], sessions: [] },
      { requests: [open(1)], sessions: [warming("x")] },
      { requests: [claimed(1, "x")], sessions: [busy("x", 1)] },
      { requests: [open(1), open(2)], sessions: [busy("x", 9), busy("y", 8)] },
    ];
    for (const s of states) {
      const p = planPool({ ...s, enabled: true, cap: CAP });
      if (!p.spawn) expect(p.reason, JSON.stringify(s)).toBeTruthy();
    }
  });
});

type PoolPlanInputLite = { requests: RequestRow[]; sessions: PoolSession[] };
