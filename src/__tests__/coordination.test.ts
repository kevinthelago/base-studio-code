import { describe, it, expect } from "vitest";
import {
  type Waiter, type CoordRef,
  emptyCoordState, refKey, parseRef, isSatisfied, isReady,
  registerWaiter, satisfy, fail, stalledWaiters,
  parseCoordLine, applyCoordEvent, ingestCoordLog,
  wakePromptFor, planWakes, coordinationSummary,
  readinessAt, isFreshlyReady,
  detectDeadlocks, hasDeadlock, defaultProducerOf, buildProducerOf,
  producesFromPaneStreams,
  parsePredicate, evaluatePredicates,
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
      { kind: "session", id: "t0p2" },
    ] as const;
    for (const r of refs) expect(parseRef(refKey(r))).toEqual(r);
  });

  it("keys are the wire tokens", () => {
    expect(refKey({ kind: "issue", number: 42 })).toBe("#42");
    expect(refKey({ kind: "contract", name: "X" })).toBe("contract:X");
    expect(refKey({ kind: "file", path: "a/b.ts" })).toBe("file:a/b.ts");
    expect(refKey({ kind: "predicate", expr: "p" })).toBe("predicate:p");
    expect(refKey({ kind: "session", id: "t1p0" })).toBe("session:t1p0");
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

describe("predicate-based readiness (#365)", () => {
  const pred = (expr: string): CoordRef => ({ kind: "predicate", expr });

  it("parsePredicate dispatches every kind + falls back to custom", () => {
    expect(parsePredicate("tests-pass")).toEqual({ kind: "tests-pass" });
    expect(parsePredicate("tests")).toEqual({ kind: "tests-pass" });
    expect(parsePredicate("symbol:TunnelState")).toEqual({ kind: "symbol", name: "TunnelState" });
    expect(parsePredicate("file-exists:src/lib/x.ts")).toEqual({ kind: "file-exists", path: "src/lib/x.ts" });
    expect(parsePredicate("file:src/lib/x.ts")).toEqual({ kind: "file-exists", path: "src/lib/x.ts" });
    expect(parsePredicate("stub:handleFoo")).toEqual({ kind: "stub", name: "handleFoo" });
    expect(parsePredicate("whatever the host wants")).toEqual({ kind: "custom", expr: "whatever the host wants" });
    expect(parsePredicate("symbol:")).toEqual({ kind: "custom", expr: "symbol:" }); // headless -> custom
  });

  it("satisfies a predicate dep when the evaluator returns true, waking the waiter", () => {
    const s = registerWaiter(emptyCoordState(), w("A", [pred("tests-pass")])).state;
    expect(s.waiters).toHaveLength(1);
    const r = evaluatePredicates(s, (e) => e === "tests-pass", 100);
    expect(r.woken.map((x) => x.session)).toEqual(["A"]);
    expect(r.state.waiters).toHaveLength(0);
    expect(isSatisfied(r.state, pred("tests-pass"))).toBe(true);
    expect(readinessAt(w("A", [pred("tests-pass")]), r.state)).toBe(100); // stamped for the recency gate
  });

  it("leaves the waiter parked when the predicate is false or not-yet-evaluable", () => {
    const s = registerWaiter(emptyCoordState(), w("A", [pred("tests-pass")])).state;
    expect(evaluatePredicates(s, () => false, 1).woken).toHaveLength(0);
    expect(evaluatePredicates(s, () => undefined, 1).woken).toHaveLength(0);
    expect(evaluatePredicates(s, () => false, 1).state.waiters).toHaveLength(1);
  });

  it("gates a mixed waiter: predicate alone does not wake until the other dep lands too", () => {
    const issue1 = { kind: "issue", number: 1 } as const;
    let s = registerWaiter(emptyCoordState(), w("B", [issue1, pred("tests-pass")])).state;
    s = evaluatePredicates(s, () => true, 1).state; // predicate satisfied, #1 still pending
    expect(s.waiters.map((x) => x.session)).toEqual(["B"]);
    const sat = satisfy(s, issue1, "merged", 2);
    expect(sat.woken.map((x) => x.session)).toEqual(["B"]); // now all deps satisfied
  });

  it("evaluates a shared predicate once and wakes every waiter on it", () => {
    let calls = 0;
    let s = emptyCoordState();
    s = registerWaiter(s, w("A", [pred("symbol:Foo")])).state;
    s = registerWaiter(s, w("B", [pred("symbol:Foo")])).state;
    const r = evaluatePredicates(s, () => { calls++; return true; }, 1);
    expect(calls).toBe(1); // distinct predicate evaluated a single time
    expect(r.woken.map((x) => x.session).sort()).toEqual(["A", "B"]);
  });

  it("is idempotent: re-polling an already-satisfied predicate is a no-op", () => {
    let s = registerWaiter(emptyCoordState(), w("A", [pred("tests-pass")])).state;
    s = evaluatePredicates(s, () => true, 1).state;
    const again = evaluatePredicates(s, () => true, 2);
    expect(again.woken).toHaveLength(0);
    expect(again.state.waiters).toHaveLength(0);
  });

  it("ignores non-predicate deps entirely", () => {
    const s = registerWaiter(emptyCoordState(), w("A", [{ kind: "issue", number: 1 }])).state;
    const r = evaluatePredicates(s, () => true, 1); // evaluator would say yes, but no predicate dep
    expect(r.woken).toHaveLength(0);
    expect(r.state.waiters).toHaveLength(1);
  });
});

describe("cycle / deadlock detection", () => {
  const sess = (id: string): CoordRef => ({ kind: "session", id });
  // Park `session` blocked on each of `on` (as session: refs).
  const block = (session: string, ...on: string[]): Waiter =>
    ({ session, deps: on.map(sess), registeredAt: 0 });
  const state = (...waiters: Waiter[]) => ({ latches: {}, waiters });

  it("parses + keys the session ref grammar", () => {
    expect(parseRef("session:t0p2")).toEqual({ kind: "session", id: "t0p2" });
    expect(parseRef("session:")).toBeNull();
    expect(defaultProducerOf({ kind: "session", id: "t0p2" })).toBe("t0p2");
    expect(defaultProducerOf({ kind: "issue", number: 1 })).toBeUndefined();
  });

  it("finds a mutual A<->B deadlock", () => {
    const s = state(block("A", "B"), block("B", "A"));
    const cycles = detectDeadlocks(s);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].cycle].sort()).toEqual(["A", "B"]);
    expect(hasDeadlock(s)).toBe(true);
  });

  it("finds a 3-session ring A->B->C->A", () => {
    const s = state(block("A", "B"), block("B", "C"), block("C", "A"));
    const cycles = detectDeadlocks(s);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].cycle].sort()).toEqual(["A", "B", "C"]);
  });

  it("detects a self-wait (session blocked on its own output)", () => {
    const s = state(block("A", "A"));
    expect(detectDeadlocks(s).map((d) => d.cycle)).toEqual([["A"]]);
  });

  it("no false positive for a linear chain A->B->C", () => {
    const s = state(block("A", "B"), block("B", "C"), block("C", "done"));
    // C waits on session:done which is not a parked waiter -> no edge, no cycle.
    expect(detectDeadlocks(s)).toEqual([]);
    expect(hasDeadlock(s)).toBe(false);
  });

  it("a satisfied dep breaks the edge, so it is no longer a deadlock", () => {
    const s = { latches: { "session:B": { state: "satisfied" as const, source: "merged" as const, at: 1 } },
                waiters: [block("A", "B"), block("B", "A")] };
    // B's dep on A still stands, but A's dep on B is satisfied -> A->B edge gone -> no ring.
    expect(detectDeadlocks(s)).toEqual([]);
  });

  it("issue/contract deps yield no edge under the default resolver (no false positives)", () => {
    const s = {
      latches: {},
      waiters: [
        { session: "A", deps: [{ kind: "issue" as const, number: 2 }], registeredAt: 0 },
        { session: "B", deps: [{ kind: "issue" as const, number: 1 }], registeredAt: 0 },
      ],
    };
    expect(detectDeadlocks(s)).toEqual([]);
  });

  it("a plan-derived producerOf lights up contract/issue cycles (#199 AC#7 forward-compat)", () => {
    // A produces #1 & waits on contract:Y; B produces contract:Y & waits on #1 -> ring.
    const s = {
      latches: {},
      waiters: [
        { session: "A", deps: [{ kind: "contract" as const, name: "Y" }], registeredAt: 0 },
        { session: "B", deps: [{ kind: "issue" as const, number: 1 }], registeredAt: 0 },
      ],
    };
    const producerOf = buildProducerOf([
      { session: "A", issues: ["#1"] },
      { session: "B", contracts: ["Y"] },
    ]);
    const cycles = detectDeadlocks(s, producerOf);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].cycle].sort()).toEqual(["A", "B"]);
  });

  it("coordinationSummary marks deadlocked sessions", () => {
    const s = state(block("A", "B"), block("B", "A"), block("C", "free"));
    const view = coordinationSummary(s);
    const byId = Object.fromEntries(view.map((v) => [v.session, v.deadlocked]));
    expect(byId).toEqual({ A: true, B: true, C: false });
  });
});

describe("buildProducerOf — plan-derived resolver (#199 AC#7)", () => {
  it("resolves contract / issue / file / session refs to their producing session", () => {
    const p = buildProducerOf([
      { session: "api", contracts: ["TunnelState"], issues: ["#12", 13], owns: ["src/lib/**"] },
      { session: "ui", contracts: ["LoginView"], issues: ["#20"], owns: ["src/components/login/**"] },
    ]);
    expect(p({ kind: "contract", name: "TunnelState" })).toBe("api");
    expect(p({ kind: "contract", name: "LoginView" })).toBe("ui");
    expect(p({ kind: "issue", number: 12 })).toBe("api");
    expect(p({ kind: "issue", number: 13 })).toBe("api");   // bare number issue ref
    expect(p({ kind: "issue", number: 20 })).toBe("ui");
    expect(p({ kind: "file", path: "src/lib/tunnel.ts" })).toBe("api");  // glob match
    expect(p({ kind: "file", path: "src/components/login/Form.tsx" })).toBe("ui");
    expect(p({ kind: "session", id: "whoever" })).toBe("whoever"); // session: still self-resolves
  });

  it("returns undefined for unknown refs and never resolves a predicate", () => {
    const p = buildProducerOf([{ session: "api", contracts: ["X"], issues: ["#1"], owns: ["src/api/**"] }]);
    expect(p({ kind: "contract", name: "Unmentioned" })).toBeUndefined();
    expect(p({ kind: "issue", number: 999 })).toBeUndefined();
    expect(p({ kind: "file", path: "docs/readme.md" })).toBeUndefined();
    expect(p({ kind: "predicate", expr: "tests-pass" })).toBeUndefined();
  });

  it("first declaration wins on a duplicate contract/issue (one producer per ref)", () => {
    const p = buildProducerOf([
      { session: "first", contracts: ["Shared"], issues: ["#5"] },
      { session: "second", contracts: ["Shared"], issues: ["#5"] },
    ]);
    expect(p({ kind: "contract", name: "Shared" })).toBe("first");
    expect(p({ kind: "issue", number: 5 })).toBe("first");
  });

  it("tolerates malformed issue refs and empty/absent fields", () => {
    const p = buildProducerOf([
      { session: "a" },                                  // no fields
      { session: "b", issues: ["#0", "#-1", "abc", ""], contracts: [""], owns: [""] },
    ]);
    expect(p({ kind: "issue", number: 0 })).toBeUndefined();
    expect(p({ kind: "contract", name: "" })).toBeUndefined();
    expect(p({ kind: "file", path: "" })).toBeUndefined();
  });

  it("drives detectDeadlocks for a file:/issue: wait-for ring (issue/file deps light up)", () => {
    // A owns src/db/** and waits on file:src/api/x.ts; B owns src/api/** and waits on #1
    // (which A produces) -> a real cross-kind ring that the default resolver misses.
    const s = {
      latches: {},
      waiters: [
        { session: "A", deps: [{ kind: "file" as const, path: "src/api/x.ts" }], registeredAt: 0 },
        { session: "B", deps: [{ kind: "issue" as const, number: 1 }], registeredAt: 0 },
      ],
    };
    const producerOf = buildProducerOf([
      { session: "A", issues: ["#1"], owns: ["src/db/**"] },
      { session: "B", owns: ["src/api/**"] },
    ]);
    expect(detectDeadlocks(s, producerOf)).toHaveLength(1);
    expect(detectDeadlocks(s)).toEqual([]);  // default resolver sees no edge -> no false alarm
  });
});

describe("producesFromPaneStreams — pane-id bridge for the resolver (#199 AC#7)", () => {
  it("keys producers by PANE id so resolved edges land on parked panes", () => {
    // The store map: pane t0p1 ran the `api` stream, t0p2 ran `ui`. Waiters in the
    // coord log are pane ids, so the producer's `session` must be the pane id too.
    const paneStreams = {
      t0p1: { id: "api", name: "API", repo: "o/r", owns: ["src/lib/**"], issues: ["#12"], dependsOn: [] },
      t0p2: { id: "ui",  name: "UI",  repo: "o/r", owns: ["src/ui/**"],  issues: ["#20"], dependsOn: [] },
    };
    const p = buildProducerOf(producesFromPaneStreams(paneStreams));
    expect(p({ kind: "file", path: "src/lib/x.ts" })).toBe("t0p1");
    expect(p({ kind: "issue", number: 12 })).toBe("t0p1");
    expect(p({ kind: "issue", number: 20 })).toBe("t0p2");
    expect(p({ kind: "file", path: "src/ui/Form.tsx" })).toBe("t0p2");
  });

  it("detects a wait-for ring between two panes via their owned globs/issues", () => {
    // t0p1 owns src/db/** and waits on a file t0p2 owns; t0p2 waits on an issue t0p1 owns.
    const s = {
      latches: {},
      waiters: [
        { session: "t0p1", deps: [{ kind: "file" as const, path: "src/api/x.ts" }], registeredAt: 0 },
        { session: "t0p2", deps: [{ kind: "issue" as const, number: 7 }], registeredAt: 0 },
      ],
    };
    const paneStreams = {
      t0p1: { id: "db",  name: "DB",  repo: "o/r", owns: ["src/db/**"],  issues: ["#7"], dependsOn: [] },
      t0p2: { id: "api", name: "API", repo: "o/r", owns: ["src/api/**"], issues: [],     dependsOn: [] },
    };
    const producerOf = buildProducerOf(producesFromPaneStreams(paneStreams));
    const cycles = detectDeadlocks(s, producerOf);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].cycle].sort()).toEqual(["t0p1", "t0p2"]);
  });

  it("is empty for an empty map (no fleet launched -> falls back to default resolver)", () => {
    expect(producesFromPaneStreams({})).toEqual([]);
    // An empty producer list resolves nothing but session: refs.
    const p = buildProducerOf(producesFromPaneStreams({}));
    expect(p({ kind: "contract", name: "X" })).toBeUndefined();
    expect(p({ kind: "session", id: "t0p3" })).toBe("t0p3");
  });
});
