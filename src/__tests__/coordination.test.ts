import { describe, it, expect } from "vitest";
import {
  type Waiter,
  emptyCoordState, refKey, parseRef, isSatisfied, isReady,
  registerWaiter, satisfy, fail, stalledWaiters,
  parseCoordLine, applyCoordEvent, ingestCoordLog,
  wakePromptFor, planWakes, coordinationSummary,
  readinessAt, isFreshlyReady,
} from "../lib/coordination";

const w = (session: string, deps: Waiter["deps"], checkpoint?: string): Waiter =>
  ({ session, deps, checkpoint, registeredAt: 1 });

describe("refKey / parseRef", () => {
  it("round-trips every ref kind", () => {
    const refs = [
      { kind: "issue", number: 42 },
      { kind: "contract", name: "TunnelState" },
      { kind: "file", path: "src/lib/x.ts" },
      { kind: "predicate", expr: "tests-pass" },
    ] as const;
    for (const r of refs) expect(parseRef(refKey(r))).toEqual(r);
  });

  it("keys are the wire tokens", () => {
    expect(refKey({ kind: "issue", number: 42 })).toBe("#42");
    expect(refKey({ kind: "contract", name: "X" })).toBe("contract:X");
    expect(refKey({ kind: "file", path: "a/b.ts" })).toBe("file:a/b.ts");
    expect(refKey({ kind: "predicate", expr: "p" })).toBe("predicate:p");
  });

  it("parses lenient issue + predicate fallbacks", () => {
    expect(parseRef("42")).toEqual({ kind: "issue", number: 42 });
    expect(parseRef("#7")).toEqual({ kind: "issue", number: 7 });
    expect(parseRef("tests-pass")).toEqual({ kind: "predicate", expr: "tests-pass" });
  });

  it("rejects empty / malformed tokens", () => {
    expect(parseRef("")).toBeNull();
    expect(parseRef("   ")).toBeNull();
    expect(parseRef("#abc")).toBeNull();
    expect(parseRef("contract:")).toBeNull();
    expect(parseRef("bogus:x")).toBeNull();
  });
});

describe("readiness latch — lost-wakeup safety", () => {
  const dep = { kind: "issue", number: 1 } as const;

  it("waiter registered BEFORE the dep lands is added and woken on satisfy", () => {
    let s = emptyCoordState();
    const reg = registerWaiter(s, w("A", [dep]));
    expect(reg.ready).toBe(false);
    expect(reg.state.waiters).toHaveLength(1);
    s = reg.state;

    const sat = satisfy(s, dep, "merged", 10);
    expect(sat.woken.map((x) => x.session)).toEqual(["A"]);
    expect(sat.state.waiters).toHaveLength(0); // woken waiter removed
  });

  it("waiter registered AFTER the dep lands is immediately ready (no lost wakeup)", () => {
    let s = emptyCoordState();
    s = satisfy(s, dep, "closed", 5).state; // producer finished first
    const reg = registerWaiter(s, w("A", [dep]));
    expect(reg.ready).toBe(true);          // proceed now
    expect(reg.state.waiters).toHaveLength(0); // not parked
  });
});

describe("multi-dependency gating", () => {
  const d1 = { kind: "issue", number: 1 } as const;
  const d2 = { kind: "contract", name: "Y" } as const;

  it("wakes only when ALL deps are satisfied", () => {
    let s = registerWaiter(emptyCoordState(), w("B", [d1, d2])).state;

    const first = satisfy(s, d1, "merged", 1);
    expect(first.woken).toHaveLength(0);   // d2 still pending
    expect(first.state.waiters).toHaveLength(1);
    s = first.state;

    const second = satisfy(s, d2, "landed", 2);
    expect(second.woken.map((x) => x.session)).toEqual(["B"]);
    expect(second.state.waiters).toHaveLength(0);
  });

  it("isReady reflects partial satisfaction", () => {
    const s = satisfy(emptyCoordState(), d1, "merged", 1).state;
    expect(isReady(s, w("B", [d1, d2]))).toBe(false);
    expect(isReady(s, w("B", [d1]))).toBe(true);
  });
});

describe("failure does not satisfy", () => {
  const dep = { kind: "issue", number: 9 } as const;

  it("a failed ref holds dependents and surfaces them as stalled", () => {
    let s = registerWaiter(emptyCoordState(), w("C", [dep])).state;
    const f = fail(s, dep, "tests red", 3);
    s = f.state;

    expect(isSatisfied(s, dep)).toBe(false);
    expect(f.stalled.map((x) => x.session)).toEqual(["C"]); // alertable chain
    expect(s.waiters).toHaveLength(1);                       // still parked
    expect(stalledWaiters(s, dep).map((x) => x.session)).toEqual(["C"]);
  });

  it("a later satisfy on the same ref can still recover it (failed -> satisfied)", () => {
    let s = registerWaiter(emptyCoordState(), w("C", [dep])).state;
    s = fail(s, dep, "tests red", 3).state;
    const sat = satisfy(s, dep, "merged", 4);
    expect(sat.woken.map((x) => x.session)).toEqual(["C"]);
  });
});

describe("idempotency & fan-out", () => {
  const dep = { kind: "issue", number: 1 } as const;

  it("re-registering a session replaces its entry (no duplicates)", () => {
    let s = registerWaiter(emptyCoordState(), w("A", [dep])).state;
    s = registerWaiter(s, w("A", [dep], "checkpoint-2")).state;
    expect(s.waiters).toHaveLength(1);
    expect(s.waiters[0].checkpoint).toBe("checkpoint-2");
  });

  it("re-delivering a satisfy is harmless", () => {
    let s = registerWaiter(emptyCoordState(), w("A", [dep])).state;
    s = satisfy(s, dep, "merged", 1).state;
    const again = satisfy(s, dep, "merged", 1);
    expect(again.woken).toHaveLength(0); // already woken/removed
    expect(again.state.waiters).toHaveLength(0);
  });

  it("one satisfy wakes every waiter on that ref", () => {
    let s = emptyCoordState();
    s = registerWaiter(s, w("A", [dep])).state;
    s = registerWaiter(s, w("B", [dep])).state;
    const sat = satisfy(s, dep, "closed", 1);
    expect(sat.woken.map((x) => x.session).sort()).toEqual(["A", "B"]);
    expect(sat.state.waiters).toHaveLength(0);
  });
});

describe("event ingestion — parseCoordLine", () => {
  const TS = "2026-05-30T17:00:00Z";
  const at = Date.parse(TS);

  it("parses a blocked line with multiple deps + checkpoint", () => {
    const line = `${TS}\tpane-3\tblocked\t#42,contract:TunnelState\t.bsc/cp/pane-3.md`;
    expect(parseCoordLine(line)).toEqual({
      type: "blocked",
      session: "pane-3",
      deps: [{ kind: "issue", number: 42 }, { kind: "contract", name: "TunnelState" }],
      checkpoint: ".bsc/cp/pane-3.md",
      at,
    });
  });

  it("parses a blocked line with no checkpoint column", () => {
    const ev = parseCoordLine(`${TS}\tpane-1\tblocked\t#7`);
    expect(ev).toMatchObject({ type: "blocked", session: "pane-1", checkpoint: undefined });
    expect((ev as { deps: unknown }).deps).toEqual([{ kind: "issue", number: 7 }]);
  });

  it("parses satisfy + failed lines", () => {
    expect(parseCoordLine(`${TS}\td\tmerged\t#9`)).toEqual({ type: "merged", ref: { kind: "issue", number: 9 }, at });
    expect(parseCoordLine(`${TS}\td\tclosed\tcontract:X`)).toEqual({ type: "closed", ref: { kind: "contract", name: "X" }, at });
    expect(parseCoordLine(`${TS}\td\tfailed\t#9\ttests red`)).toEqual({ type: "failed", ref: { kind: "issue", number: 9 }, reason: "tests red", at });
  });

  it("rejects malformed / short / unknown-kind lines", () => {
    expect(parseCoordLine("")).toBeNull();
    expect(parseCoordLine("a\tb\tc")).toBeNull();           // too few columns
    expect(parseCoordLine(`${TS}\td\tbogus\t#1`)).toBeNull(); // unknown kind
    expect(parseCoordLine(`${TS}\td\tblocked\t`)).toBeNull(); // no valid refs
  });

  it("tolerates a bad timestamp (at -> 0) and a trailing newline", () => {
    const ev = parseCoordLine(`not-a-date\td\tmerged\t#1\n`);
    expect(ev).toEqual({ type: "merged", ref: { kind: "issue", number: 1 }, at: 0 });
  });
});

describe("event ingestion — applyCoordEvent + ingestCoordLog", () => {
  const TS = "2026-05-30T17:00:00Z";

  it("a blocked event then its merged event wakes the waiter", () => {
    let s = emptyCoordState();
    s = applyCoordEvent(s, { type: "blocked", session: "A", deps: [{ kind: "issue", number: 1 }], at: 1 }).state;
    const r = applyCoordEvent(s, { type: "merged", ref: { kind: "issue", number: 1 }, at: 2 });
    expect(r.woken.map((w) => w.session)).toEqual(["A"]);
  });

  it("ingestCoordLog replays a log to final state + accumulated wakes", () => {
    const log = [
      `${TS}\tA\tblocked\t#1`,
      `${TS}\tB\tblocked\t#1,#2`,
      "garbage line — skipped",
      `${TS}\tx\tmerged\t#1`,   // wakes A (only dep), not B (still needs #2)
      `${TS}\tx\tclosed\t#2`,   // now wakes B
    ];
    const { state, woken } = ingestCoordLog(log);
    expect(woken.map((w) => w.session)).toEqual(["A", "B"]);
    expect(state.waiters).toHaveLength(0);
    expect(isSatisfied(state, { kind: "issue", number: 1 })).toBe(true);
  });

  it("a failed event surfaces the stalled waiter and does not wake it", () => {
    const s = applyCoordEvent(emptyCoordState(), { type: "blocked", session: "C", deps: [{ kind: "issue", number: 9 }], at: 1 }).state;
    const r = applyCoordEvent(s, { type: "failed", ref: { kind: "issue", number: 9 }, reason: "red", at: 2 });
    expect(r.woken).toHaveLength(0);
    expect(r.stalled.map((w) => w.session)).toEqual(["C"]);
  });
});

describe("wake planning + inbox view", () => {
  const issue1 = { kind: "issue", number: 1 } as const;
  const contractY = { kind: "contract", name: "Y" } as const;

  it("wakePromptFor names landed deps (with source) + the checkpoint", () => {
    let s = emptyCoordState();
    s = satisfy(s, issue1, "merged", 1).state;
    s = satisfy(s, contractY, "landed", 2).state;
    const prompt = wakePromptFor(
      { session: "B", deps: [issue1, contractY], checkpoint: ".bsc/cp/B.md", registeredAt: 0 },
      s,
    );
    expect(prompt).toContain("dependencies have landed");
    expect(prompt).toContain("#1 (merged)");
    expect(prompt).toContain("contract:Y (landed)");
    expect(prompt).toContain(".bsc/cp/B.md");
  });

  it("wakePromptFor uses singular phrasing + omits checkpoint when absent", () => {
    const s = satisfy(emptyCoordState(), issue1, "closed", 1).state;
    const prompt = wakePromptFor({ session: "A", deps: [issue1], registeredAt: 0 }, s);
    expect(prompt).toContain("dependency has landed");
    expect(prompt).not.toContain("checkpoint");
  });

  it("planWakes maps woken waiters from a satisfy into actions", () => {
    let s = registerWaiter(emptyCoordState(), { session: "A", deps: [issue1], checkpoint: "cp", registeredAt: 0 }).state;
    const { woken, state } = satisfy(s, issue1, "merged", 1);
    s = state;
    const actions = planWakes(woken, s);
    expect(actions).toHaveLength(1);
    expect(actions[0].session).toBe("A");
    expect(actions[0].prompt).toContain("#1 (merged)");
  });

  it("coordinationSummary reports per-dep status + the stalled flag", () => {
    let s = emptyCoordState();
    s = registerWaiter(s, { session: "A", deps: [issue1, contractY], registeredAt: 0 }).state;
    s = registerWaiter(s, { session: "B", deps: [issue1], registeredAt: 0 }).state;
    s = satisfy(s, issue1, "merged", 1).state;  // wakes B; A still waits on Y
    s = fail(s, contractY, "broke", 2).state;    // A now stalled

    const view = coordinationSummary(s);
    expect(view.map((v) => v.session)).toEqual(["A"]); // B was woken + removed
    const a = view[0];
    expect(a.stalled).toBe(true);
    expect(a.deps).toEqual([
      { ref: "#1", status: "satisfied" },
      { ref: "contract:Y", status: "failed" },
    ]);
  });
});

describe("woke event + ready (idempotent actuation)", () => {
  const TS = "2026-05-30T18:00:00Z";

  it("parses a woke line", () => {
    expect(parseCoordLine(`${TS}\tt2p1\twoke\t\t`)).toEqual({ type: "woke", session: "t2p1", at: Date.parse(TS) });
  });

  it("ingestCoordLog.ready holds waiters whose deps landed but have no woke ack", () => {
    const log = [
      `${TS}\tt2p1\tblocked\t#1`,
      `${TS}\tx\tmerged\t#1`, // t2p1 now ready, unacked
    ];
    const { ready, woken } = ingestCoordLog(log);
    expect(woken.map((w) => w.session)).toEqual(["t2p1"]);
    expect(ready.map((w) => w.session)).toEqual(["t2p1"]);
  });

  it("a woke event removes the session from ready (no re-actuation)", () => {
    const log = [
      `${TS}\tt2p1\tblocked\t#1`,
      `${TS}\tx\tmerged\t#1`,
      `${TS}\tt2p1\twoke\t\t`, // acked → no longer ready
    ];
    const { ready, woken } = ingestCoordLog(log);
    expect(woken.map((w) => w.session)).toEqual(["t2p1"]); // it did become ready once
    expect(ready).toHaveLength(0);                          // but is acked, so not pending
  });

  it("re-blocking after a woke makes it ready again", () => {
    const log = [
      `${TS}\tt2p1\tblocked\t#1`,
      `${TS}\tx\tmerged\t#1`,
      `${TS}\tt2p1\twoke\t\t`,
      `${TS}\tt2p1\tblocked\t#2`, // blocks again on a new dep
      `${TS}\tx\tclosed\t#2`,      // ready again, unacked
    ];
    const { ready } = ingestCoordLog(log);
    expect(ready.map((w) => w.session)).toEqual(["t2p1"]);
  });
});

describe("auto-wake recency gate", () => {
  const dep = { kind: "issue", number: 1 } as const;
  const w = { session: "t0p0", deps: [dep], registeredAt: 0 };

  it("readinessAt is the newest satisfy time among deps", () => {
    let s = emptyCoordState();
    s = satisfy(s, dep, "merged", 5000).state;
    expect(readinessAt(w, s)).toBe(5000);
    expect(readinessAt(w, emptyCoordState())).toBe(0);
  });

  it("isFreshlyReady is true within the window, false outside / when unsatisfied", () => {
    const s = satisfy(emptyCoordState(), dep, "merged", 1_000_000).state;
    expect(isFreshlyReady(w, s, 1_000_000 + 60_000, 15 * 60_000)).toBe(true);   // 1 min later
    expect(isFreshlyReady(w, s, 1_000_000 + 20 * 60_000, 15 * 60_000)).toBe(false); // 20 min later
    expect(isFreshlyReady(w, emptyCoordState(), 1_000_000, 15 * 60_000)).toBe(false); // never satisfied
  });
});
