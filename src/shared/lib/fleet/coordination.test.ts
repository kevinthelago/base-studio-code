import { describe, it, expect } from "vitest";
import {
  type Waiter, type CoordRef, type CoordState,
  emptyCoordState, refKey, parseRef, isSatisfied, isReady,
  registerWaiter, satisfy, fail, stalledWaiters,
  parseCoordLine, applyCoordEvent, ingestCoordLog,
  wakePromptFor, planWakes, coordinationSummary, waitingWakePrompt, answerWakePrompt,
  readinessAt, isFreshlyReady,
  detectDeadlocks, hasDeadlock, defaultProducerOf, buildProducerOf,
  producesFromPaneStreams,
  parsePredicate, evaluatePredicates, pendingPredicateExprs,
  coordNotifications, assignWakePrompt,
  triageLanding, aggregateVerdicts, tallyVerdicts, planJuryAction,
  type JurorVerdict,
} from "./coordination";

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

  it("parses + folds a maintain event (#1957): a finished worker parks alive, leaving the user-wait", () => {
    expect(parseCoordLine(`${TS}\tw1\tmaintain\towned issues complete`))
      .toEqual({ type: "maintain", session: "w1", note: "owned issues complete", at });
    // Fold: entering maintenance replaces a prior user-wait and lands the session in `maintaining`.
    const waited = applyCoordEvent(emptyCoordState(), { type: "waiting", session: "w1", reason: "paused", at: 1 }).state;
    expect(waited.waiting.map((w) => w.session)).toContain("w1");
    const maint = applyCoordEvent(waited, { type: "maintain", session: "w1", note: "done", at: 2 }).state;
    expect(maint.maintaining).toEqual([{ session: "w1", note: "done", at: 2 }]);
    expect(maint.waiting.some((w) => w.session === "w1")).toBe(false); // left the user-wait list
  });

  it("parses + folds a planner brief (#2377): a mid-build plan update lands in state.briefs", () => {
    // Wire form: ts \t session \t brief \t <target> \t <body> \t <ref?>. The session column is
    // the planner's pane; `from` mirrors it, `id` is `<from>@<at>` for replay-dedup.
    expect(parseCoordLine(`${TS}\tplanner\tbrief\tdirector\tscope grew: add CSV export`))
      .toEqual({ type: "brief", from: "planner", target: "director", body: "scope grew: add CSV export", ref: undefined, id: `planner@${at}`, at });
    // Fold: the brief appends to the received-briefs list (no waiter/latch movement).
    const s = applyCoordEvent(emptyCoordState(), { type: "brief", from: "planner", target: "director", body: "add CSV export", id: `planner@${at}`, at }).state;
    expect(s.briefs).toEqual([{ id: `planner@${at}`, from: "planner", target: "director", body: "add CSV export", ref: undefined, at }]);
  });

  it("a planner brief carries a CoordRef the director can route onward (#2377)", () => {
    // The optional 3rd payload column is a coord-ref token, parsed like a dep (#issue / contract: / file:).
    const ev = parseCoordLine(`${TS}\tplanner\tbrief\tissuer\tre-sequence: #77 now blocks #78\t#77`);
    expect(ev).toEqual({ type: "brief", from: "planner", target: "issuer", body: "re-sequence: #77 now blocks #78", ref: { kind: "issue", number: 77 }, id: `planner@${at}`, at });
    const s = applyCoordEvent(emptyCoordState(), ev!).state;
    expect(s.briefs).toHaveLength(1);
    expect(s.briefs[0].ref).toEqual({ kind: "issue", number: 77 });
    // A contract ref parses too (the director can act on a changed contract).
    const c = parseCoordLine(`${TS}\tplanner\tbrief\tdirector\tAuth contract changed\tcontract:Auth`);
    expect((c as { ref: unknown }).ref).toEqual({ kind: "contract", name: "Auth" });
  });

  it("rejects a brief with no target or no body (#2377)", () => {
    expect(parseCoordLine(`${TS}\tplanner\tbrief\t\tbody but no target`)).toBeNull();
    expect(parseCoordLine(`${TS}\tplanner\tbrief\tdirector\t`)).toBeNull();
  });

  it("ingestCoordLog dedups a replayed brief by id (#2377)", () => {
    const line = `${TS}\tplanner\tbrief\tdirector\tadd CSV export`;
    const { state } = ingestCoordLog([line, line]);
    expect(state.briefs).toHaveLength(1);
  });

  it("parses + folds a studio commission (#2940): planner→designer lands in state.commissions", () => {
    // Wire form: ts \t session \t commission \t <target> \t <body> \t <ref?>. Mirrors a brief; the
    // session column is the requesting studio pane, `id` is `<from>@<at>` for delivery correlation.
    expect(parseCoordLine(`${TS}\tplanner\tcommission\tdesigner\tneed a weekly-activity heatmap`))
      .toEqual({ type: "commission", from: "planner", target: "designer", body: "need a weekly-activity heatmap", ref: undefined, id: `planner@${at}`, at });
    const s = applyCoordEvent(emptyCoordState(), { type: "commission", from: "planner", target: "designer", body: "need a heatmap", id: `planner@${at}`, at }).state;
    expect(s.commissions).toEqual([{ id: `planner@${at}`, from: "planner", target: "designer", body: "need a heatmap", ref: undefined, at }]);
  });

  it("a commission carries a CoordRef + routes to the librarian too (#2940)", () => {
    const ev = parseCoordLine(`${TS}\tdesigner\tcommission\tlibrarian\talgorithm to generate heatmap mock data\t#42`);
    expect(ev).toEqual({ type: "commission", from: "designer", target: "librarian", body: "algorithm to generate heatmap mock data", ref: { kind: "issue", number: 42 }, id: `designer@${at}`, at });
    const s = applyCoordEvent(emptyCoordState(), ev!).state;
    expect(s.commissions).toHaveLength(1);
    expect(s.commissions[0]).toMatchObject({ from: "designer", target: "librarian", ref: { kind: "issue", number: 42 } });
  });

  it("rejects a commission with no target or no body (#2940)", () => {
    expect(parseCoordLine(`${TS}\tplanner\tcommission\t\tbody but no target`)).toBeNull();
    expect(parseCoordLine(`${TS}\tplanner\tcommission\tdesigner\t`)).toBeNull();
  });

  it("a deliver stamps the authored artifact id on its matching commission (#2940)", () => {
    // Wire form: ts \t session \t deliver \t <commissionId> \t <artifactId>. The session column is the
    // delivering studio; correlation is by the commission id (not the pane).
    const id = `planner@${at}`;
    expect(parseCoordLine(`${TS}\tdesigner\tdeliver\t${id}\treact-d3:heatmap`))
      .toEqual({ type: "deliver", commissionId: id, artifactId: "react-d3:heatmap", from: "designer", at });
    let s = applyCoordEvent(emptyCoordState(), { type: "commission", from: "planner", target: "designer", body: "need a heatmap", id, at }).state;
    s = applyCoordEvent(s, { type: "deliver", commissionId: id, artifactId: "react-d3:heatmap", from: "designer", at: at + 1 }).state;
    expect(s.commissions).toEqual([{ id, from: "planner", target: "designer", body: "need a heatmap", ref: undefined, at, delivered: "react-d3:heatmap" }]);
  });

  it("rejects a deliver missing the commission id or the artifact id (#2940)", () => {
    expect(parseCoordLine(`${TS}\tdesigner\tdeliver\t\treact-d3:heatmap`)).toBeNull();
    expect(parseCoordLine(`${TS}\tdesigner\tdeliver\tplanner@1\t`)).toBeNull();
  });

  it("a deliver with no matching open commission is a harmless no-op (#2940)", () => {
    const s = applyCoordEvent(emptyCoordState(), { type: "deliver", commissionId: "ghost@9", artifactId: "x:y", from: "designer", at }).state;
    expect(s.commissions).toEqual([]);
  });

  it("ingestCoordLog round-trips a commission→deliver into a delivered commission (#2940)", () => {
    const id = `planner@${at}`;
    const { state } = ingestCoordLog([
      `${TS}\tplanner\tcommission\tdesigner\tneed a heatmap`,
      `${TS}\tdesigner\tdeliver\t${id}\treact-d3:heatmap`,
    ]);
    expect(state.commissions).toHaveLength(1);
    expect(state.commissions[0].delivered).toBe("react-d3:heatmap");
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

  describe("pendingPredicateExprs — the host-check worklist", () => {
    it("lists distinct unsatisfied predicate exprs, deduped, ignoring non-predicate deps", () => {
      let s = emptyCoordState();
      s = registerWaiter(s, w("A", [pred("symbol:Foo"), { kind: "issue", number: 1 }])).state;
      s = registerWaiter(s, w("B", [pred("symbol:Foo")])).state; // shared -> once
      s = registerWaiter(s, w("C", [pred("tests-pass")])).state;
      expect(pendingPredicateExprs(s).sort()).toEqual(["symbol:Foo", "tests-pass"]);
    });

    it("drops a predicate once it is satisfied (nothing left to re-check)", () => {
      let s = registerWaiter(emptyCoordState(), w("A", [pred("tests-pass")])).state;
      expect(pendingPredicateExprs(s)).toEqual(["tests-pass"]);
      s = evaluatePredicates(s, () => true, 1).state;
      expect(pendingPredicateExprs(s)).toEqual([]); // satisfied -> off the worklist
    });

    it("is empty when nothing is predicate-gated (so the runtime skips the host round-trip)", () => {
      const s = registerWaiter(emptyCoordState(), w("A", [{ kind: "issue", number: 1 }])).state;
      expect(pendingPredicateExprs(s)).toEqual([]);
    });

    it("round-trips through evaluatePredicates: a map keyed by the worklist wakes the waiter", () => {
      const s = registerWaiter(emptyCoordState(), w("A", [pred("file-exists:src/lib/x.ts")])).state;
      const holds: Record<string, boolean> = {};
      for (const e of pendingPredicateExprs(s)) holds[e] = true; // host says all hold
      const r = evaluatePredicates(s, (e) => holds[e], 42);
      expect(r.woken.map((x) => x.session)).toEqual(["A"]);
    });
  });
});

describe("cycle / deadlock detection", () => {
  const sess = (id: string): CoordRef => ({ kind: "session", id });
  // Park `session` blocked on each of `on` (as session: refs).
  const block = (session: string, ...on: string[]): Waiter =>
    ({ session, deps: on.map(sess), registeredAt: 0 });
  const state = (...waiters: Waiter[]) => ({ latches: {}, waiters, waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [] });

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
                waiters: [block("A", "B"), block("B", "A")], waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [] };
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
      waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
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
      waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
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
      waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
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
      waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
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

describe("coordNotifications — mobile push payloads (#366)", () => {
  const issue = (n: number): CoordRef => ({ kind: "issue", number: n });
  const sess = (id: string): CoordRef => ({ kind: "session", id });

  it("emits a ready notification for each freshly-ready waiter", () => {
    const ready = [w("A", [issue(1), issue(2)])];
    const notes = coordNotifications(emptyCoordState(), ready);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("ready");
    expect(notes[0].session).toBe("A");
    expect(notes[0].key).toBe("ready:A");
    expect(notes[0].refs).toEqual(["#1", "#2"]);
    expect(notes[0].summary).toMatch(/landed/);
  });

  it("emits a stalled notification for a waiter with a failed dep", () => {
    let s = registerWaiter(emptyCoordState(), w("C", [issue(1)])).state;
    s = fail(s, issue(1), "build broke", 5).state;
    const notes = coordNotifications(s);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("stalled");
    expect(notes[0].session).toBe("C");
    expect(notes[0].refs).toEqual(["#1"]);
    expect(notes[0].key).toBe("stalled:C");
  });

  it("emits a deadlocked notification for a wait-for cycle and outranks stalled", () => {
    // A<->B deadlock; the same refs are unsatisfied (no producer can clear them).
    const s = { latches: {}, waiters: [w("A", [sess("B")]), w("B", [sess("A")])], waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [] };
    const notes = coordNotifications(s);
    expect(notes.map((n) => n.kind)).toEqual(["deadlocked", "deadlocked"]);
    expect(notes.map((n) => n.session).sort()).toEqual(["A", "B"]);
    expect(notes.every((n) => n.refs.length === 1)).toBe(true);
  });

  it("a deadlocked-AND-failed session reports deadlocked only (most severe wins)", () => {
    // A waits on session:B (the deadlock edge) and on a failed issue. One notification.
    let s: CoordState = { latches: {}, waiters: [w("A", [sess("B"), issue(9)]), w("B", [sess("A")])], waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [] };
    s = fail(s, issue(9), "nope", 1).state;
    const notes = coordNotifications(s);
    const byId = Object.fromEntries(notes.map((n) => [n.session, n.kind]));
    expect(byId.A).toBe("deadlocked"); // not stalled, even though #9 failed
    expect(notes.filter((n) => n.session === "A")).toHaveLength(1);
  });

  it("a healthy parked waiter (pending, no failure, no cycle) yields nothing", () => {
    const s = registerWaiter(emptyCoordState(), w("A", [issue(1)])).state;
    expect(coordNotifications(s)).toEqual([]);
  });

  it("ready and stuck sets are disjoint — both surface together", () => {
    let s = registerWaiter(emptyCoordState(), w("C", [issue(1)])).state;
    s = fail(s, issue(1), "broke", 1).state;        // C stalled (still parked)
    const ready = [w("A", [issue(2)])];              // A already woken (not in s.waiters)
    const notes = coordNotifications(s, ready);
    expect(notes.map((n) => `${n.kind}:${n.session}`).sort()).toEqual(["ready:A", "stalled:C"]);
  });
});

describe("waiting sessions (#297 checkpoint/confirm pauses)", () => {
  it("parseCoordLine reads a waiting line with reason + checkpoint", () => {
    const ev = parseCoordLine("2026-05-31T00:00:00Z\tpane-1\twaiting\tneed your OK on the schema\t.msc/cp.md");
    expect(ev).toEqual({ type: "waiting", session: "pane-1", reason: "need your OK on the schema", checkpoint: ".msc/cp.md", at: Date.parse("2026-05-31T00:00:00Z") });
  });

  it("parseCoordLine tolerates an empty reason", () => {
    const ev = parseCoordLine("2026-05-31T00:00:00Z\tpane-1\twaiting\t\t");
    expect(ev).toMatchObject({ type: "waiting", session: "pane-1", reason: "", checkpoint: undefined });
  });

  it("a waiting event parks the session (manual-wake only, not in ready)", () => {
    const r = ingestCoordLog([
      "2026-05-31T00:00:00Z\tpane-1\twaiting\tconfirm the API shape\t",
    ]);
    expect(r.ready).toEqual([]);                       // never auto-woken
    expect(r.state.waiting.map((x) => x.session)).toEqual(["pane-1"]);
    expect(r.state.waiting[0].reason).toBe("confirm the API shape");
  });

  it("a newer waiting replaces the prior one for the same session", () => {
    const r = ingestCoordLog([
      "2026-05-31T00:00:00Z\tp\twaiting\tfirst\t",
      "2026-05-31T00:01:00Z\tp\twaiting\tsecond\t",
    ]);
    expect(r.state.waiting).toHaveLength(1);
    expect(r.state.waiting[0].reason).toBe("second");
  });

  it("a woke event clears the waiting session", () => {
    const r = ingestCoordLog([
      "2026-05-31T00:00:00Z\tp\twaiting\thold\t",
      "2026-05-31T00:02:00Z\tp\twoke\t",
    ]);
    expect(r.state.waiting).toEqual([]);
  });

  it("declaring a real dependency moves the session off the manual-wait list", () => {
    const r = ingestCoordLog([
      "2026-05-31T00:00:00Z\tp\twaiting\thold\t",
      "2026-05-31T00:01:00Z\tp\tblocked\t#42\t",
    ]);
    expect(r.state.waiting).toEqual([]);                // now a latch waiter instead
    expect(r.state.waiters.map((x) => x.session)).toEqual(["p"]);
  });

  it("waitingWakePrompt names the reason and the checkpoint", () => {
    const p = waitingWakePrompt({ session: "p", reason: "confirm the schema", checkpoint: ".msc/cp.md", at: 1 });
    expect(p).toMatch(/confirm the schema/);
    expect(p).toMatch(/Resume from your checkpoint: \.msc\/cp\.md/);
  });

  it("waitingWakePrompt has a sensible empty-reason fallback", () => {
    expect(waitingWakePrompt({ session: "p", reason: "", at: 1 })).toMatch(/you have been resumed/i);
  });
});


describe("ask / answer round-trip (#369)", () => {
  const TAB = String.fromCharCode(9);
  const line = (...cols: string[]) => cols.join(TAB);

  it("parses ask and answer events", () => {
    expect(parseCoordLine(line("2026-06-01T00:00:00Z", "w1", "ask", "need the API shape", "cp.md")))
      .toEqual({ type: "ask", session: "w1", question: "need the API shape", checkpoint: "cp.md", at: Date.parse("2026-06-01T00:00:00Z") });
    expect(parseCoordLine(line("2026-06-01T00:00:00Z", "dir", "answer", "w1", "use cursor pagination")))
      .toEqual({ type: "answer", target: "w1", answer: "use cursor pagination", at: Date.parse("2026-06-01T00:00:00Z") });
  });

  it("ask registers an asking session; an answer resumes it with the answer", () => {
    const r1 = ingestCoordLog([line("2026-06-01T00:00:00Z", "w1", "ask", "tabs or spaces?", "cp.md")]);
    expect(r1.state.asking.map((a) => a.session)).toEqual(["w1"]);
    expect(r1.answered).toEqual([]);

    const r2 = ingestCoordLog([
      line("2026-06-01T00:00:00Z", "w1", "ask", "tabs or spaces?", "cp.md"),
      line("2026-06-01T00:01:00Z", "dir", "answer", "w1", "spaces"),
    ]);
    expect(r2.state.asking).toEqual([]);
    expect(r2.answered).toHaveLength(1);
    expect(r2.answered[0]).toMatchObject({ session: "w1", answer: "spaces", checkpoint: "cp.md" });
  });

  it("a woke ack clears the answered-pending wake (idempotent across polls)", () => {
    const r = ingestCoordLog([
      line("2026-06-01T00:00:00Z", "w1", "ask", "q", "cp.md"),
      line("2026-06-01T00:01:00Z", "dir", "answer", "w1", "do X"),
      line("2026-06-01T00:02:00Z", "w1", "woke", "", ""),
    ]);
    expect(r.answered).toEqual([]);
    expect(r.state.asking).toEqual([]);
  });

  it("answering a BLOCKED worker resumes it and clears the block (#376)", () => {
    const r = ingestCoordLog([
      line("2026-06-01T00:00:00Z", "w3", "blocked", "maintainer-secrets", "cp.md"),
      line("2026-06-01T00:01:00Z", "dir", "answer", "w3", "do not wait; pick up #351"),
    ]);
    expect(r.state.waiters.map((w) => w.session)).toEqual([]);  // unblocked
    expect(r.answered).toHaveLength(1);
    expect(r.answered[0]).toMatchObject({ session: "w3", answer: "do not wait; pick up #351", checkpoint: "cp.md" });
  });

  it("answering a session that is not parked still delivers the directive", () => {
    const r = ingestCoordLog([line("2026-06-01T00:01:00Z", "dir", "answer", "ghost", "hi")]);
    expect(r.answered).toHaveLength(1);
    expect(r.answered[0]).toMatchObject({ session: "ghost", answer: "hi" });
  });

  it("answerWakePrompt carries the answer and forbids asking the user", () => {
    const p = answerWakePrompt({ session: "w1", answer: "use cursor pagination", checkpoint: "cp.md", at: 1 });
    expect(p).toMatch(/use cursor pagination/);
    expect(p).toMatch(/Do not ask the user/);
    expect(p).toMatch(/Resume from your checkpoint: cp\.md/);
  });
});

describe("issuer flow (#376) — issue intake + director assign → worker inject", () => {
  const line = (...cols: (string | number)[]) => cols.join("\t");

  it("parses a bsc-issue line into an issue event with a default id", () => {
    const ev = parseCoordLine(line("2026-06-03T00:00:00Z", "t0p3", "issue", "Add export button", "AC: clicking exports CSV", "own/web"));
    expect(ev).toMatchObject({
      type: "issue", session: "t0p3", title: "Add export button",
      body: "AC: clicking exports CSV", suggested: "own/web",
    });
    expect((ev as { id: string }).id).toBe("t0p3@" + Date.parse("2026-06-03T00:00:00Z"));
  });

  it("uses an explicit issue id when provided", () => {
    const ev = parseCoordLine(line("2026-06-03T00:00:00Z", "t0p3", "issue", "T", "", "", "ISS-1"));
    expect((ev as { id: string }).id).toBe("ISS-1");
  });

  it("rejects an issue line with no title", () => {
    expect(parseCoordLine(line("2026-06-03T00:00:00Z", "t0p3", "issue", ""))).toBeNull();
  });

  it("an issue event folds into the director's pending-issue list (dedup by id)", () => {
    const e1 = parseCoordLine(line("2026-06-03T00:00:00Z", "t0p3", "issue", "A", "", "", "ISS-1"))!;
    const e2 = parseCoordLine(line("2026-06-03T00:00:01Z", "t0p3", "issue", "A (refined)", "", "", "ISS-1"))!;
    let s = emptyCoordState();
    s = applyCoordEvent(s, e1).state;
    s = applyCoordEvent(s, e2).state;
    expect(s.issues).toHaveLength(1);
    expect(s.issues[0].title).toBe("A (refined)");
  });

  it("parses a bsc-assign line and produces an injection for the target worker", () => {
    const ev = parseCoordLine(line("2026-06-03T00:00:02Z", "director", "assign", "t1p2", "Build the export button", "ISS-1", "Add export button"));
    expect(ev).toMatchObject({ type: "assign", target: "t1p2", body: "Build the export button", issueId: "ISS-1", title: "Add export button" });
    const r = applyCoordEvent(emptyCoordState(), ev!);
    expect(r.assigned).toEqual([{ session: "t1p2", title: "Add export button", body: "Build the export button", checkpoint: undefined, at: Date.parse("2026-06-03T00:00:02Z") }]);
  });

  it("assign clears the matching pending issue and resumes a parked target", () => {
    const log = [
      line("2026-06-03T00:00:00Z", "t0p3", "issue", "Add export", "AC", "own/web", "ISS-1"),
      line("2026-06-03T00:00:01Z", "t1p2", "ask", "what next?"),
      line("2026-06-03T00:00:02Z", "director", "assign", "t1p2", "Do ISS-1", "ISS-1", "Add export"),
    ];
    const r = ingestCoordLog(log);
    expect(r.state.issues).toHaveLength(0);            // pending issue cleared
    expect(r.state.asking.find((a) => a.session === "t1p2")).toBeUndefined(); // worker resumed
    expect(r.assigned.map((a) => a.session)).toEqual(["t1p2"]);
  });

  it("an assigned wake stops being pending once the worker acks with `woke`", () => {
    const log = [
      line("2026-06-03T00:00:02Z", "director", "assign", "t1p2", "Do it", "", ""),
      line("2026-06-03T00:00:03Z", "t1p2", "woke", ""),
    ];
    expect(ingestCoordLog(log).assigned).toEqual([]);
  });

  it("assignWakePrompt carries the title + body and forbids asking the user", () => {
    const p = assignWakePrompt({ session: "t1p2", title: "Add export", body: "Build it; AC: CSV", at: 1 });
    expect(p).toMatch(/assigned you new work: Add export/);
    expect(p).toMatch(/Build it; AC: CSV/);
    expect(p).toMatch(/Do not ask the user/);
  });
});

describe("verification jury (#394)", () => {
  const j = (juror: string, verdict: "pass" | "reject", reason?: string, relevant?: boolean): JurorVerdict =>
    ({ juror, verdict, reason, relevant });

  describe("triageLanding (risk triage)", () => {
    it("fast-paths a small, low-risk change", () => {
      expect(triageLanding({ diffLines: 12, coverageDelta: 0 })).toBe("fast-path");
      expect(triageLanding({})).toBe("fast-path");
    });

    it("convenes a panel on any high-risk signal", () => {
      expect(triageLanding({ touchesSharedOrContract: true })).toBe("panel");
      expect(triageLanding({ securitySensitive: true })).toBe("panel");
      expect(triageLanding({ revertedBefore: true })).toBe("panel");
      expect(triageLanding({ diffLines: 200 })).toBe("panel");
      expect(triageLanding({ coverageDelta: -5 })).toBe("panel");
    });

    it("honors a custom threshold config", () => {
      expect(triageLanding({ diffLines: 60 }, { maxDiffLines: 50, minCoverageDelta: -10 })).toBe("panel");
      expect(triageLanding({ coverageDelta: -3 }, { maxDiffLines: 50, minCoverageDelta: -10 })).toBe("fast-path");
    });
  });

  describe("aggregateVerdicts", () => {
    it("veto: any concrete reject fails the landing", () => {
      const r = aggregateVerdicts([j("a", "pass"), j("b", "reject", "null deref at L20")], "veto");
      expect(r.verdict).toBe("reject");
      expect(r.rejecters).toEqual(["b"]);
      expect(r.reason).toBe("null deref at L20");
    });

    it("majority: rejects only when more than half reject", () => {
      expect(aggregateVerdicts([j("a", "reject", "x"), j("b", "pass"), j("c", "pass")], "majority").verdict).toBe("pass");
      expect(aggregateVerdicts([j("a", "reject", "x"), j("b", "reject", "y"), j("c", "pass")], "majority").verdict).toBe("reject");
    });

    it("pass-unless-concrete: a reject with no reason is noise and is ignored", () => {
      // One noisy juror rejects without a reason → veto should still pass.
      expect(aggregateVerdicts([j("noisy", "reject"), j("b", "pass")], "veto").verdict).toBe("pass");
      // reject-on-doubt counts it.
      expect(aggregateVerdicts([j("noisy", "reject"), j("b", "pass")], "veto", "reject-on-doubt").verdict).toBe("reject");
    });

    it("quorum: only jurors whose slice the change touches vote", () => {
      // Off-slice juror rejects but is irrelevant → quorum passes; veto would reject.
      const verdicts = [j("onslice", "pass", undefined, true), j("offslice", "reject", "unrelated", false)];
      expect(aggregateVerdicts(verdicts, "quorum").verdict).toBe("pass");
      expect(aggregateVerdicts(verdicts, "veto").verdict).toBe("reject");
    });

    it("is robust to a single noisy rejecter among a passing majority (majority rule)", () => {
      const r = aggregateVerdicts([j("a", "pass"), j("b", "pass"), j("c", "reject", "maybe?")], "majority");
      expect(r.verdict).toBe("pass");
    });
  });

  describe("tallyVerdicts", () => {
    it("groups verdict events by target, latest-per-juror wins", () => {
      const ev = (juror: string, target: string, v: string, reason = "") =>
        parseCoordLine(["2026-06-03T00:00:00Z", juror, "verdict", target, v, reason].join("\t"))!;
      const tally = tallyVerdicts([ev("j1", "#42", "reject", "bug"), ev("j1", "#42", "pass"), ev("j2", "#42", "pass")]);
      expect(tally.get("#42")).toHaveLength(2);                 // j1 + j2, j1's pass replaced its reject
      expect(tally.get("#42")!.find((v) => v.juror === "j1")!.verdict).toBe("pass");
    });
  });

  describe("planJuryAction (reject → revert + ping)", () => {
    it("a passing panel takes no action", () => {
      const action = planJuryAction("#42", [j("a", "pass"), j("b", "pass")], "veto");
      expect(action.action).toBe("pass");
    });

    it("a rejecting panel reverts the landing ref and pings the owner with the reason", () => {
      const action = planJuryAction("#42", [j("a", "reject", "breaks the contract at L9")], "veto");
      expect(action.action).toBe("revert");
      expect(action.ref).toEqual({ kind: "issue", number: 42 });
      expect(action.reason).toBe("breaks the contract at L9");
      expect(action.ping).toMatch(/breaks the contract at L9/);
      expect(action.ping).toMatch(/reverted/);
    });

    it("the revert ref feeds the existing fail() reflex — the same watchdog machinery", () => {
      const action = planJuryAction("session:t1p2", [j("a", "reject", "wrong")], "veto");
      expect(action.ref).toEqual({ kind: "session", id: "t1p2" });
      // Park a dependent on the landing, then apply the jury's revert via fail().
      const s = registerWaiter(emptyCoordState(), w("dep", [action.ref!])).state;
      const f = fail(s, action.ref!, action.reason ?? "", 1);
      expect(f.state.latches["session:t1p2"].state).toBe("failed");
      expect(f.stalled.map((x) => x.session)).toEqual(["dep"]);
    });
  });

  it("parseCoordLine round-trips a bsc-verdict line", () => {
    const ev = parseCoordLine(["2026-06-03T00:00:00Z", "juror-1", "verdict", "#42", "reject", "AC not met", "true"].join("\t"));
    expect(ev).toMatchObject({ type: "verdict", juror: "juror-1", target: "#42", verdict: "reject", reason: "AC not met", relevant: true });
    expect(parseCoordLine(["2026-06-03T00:00:00Z", "j", "verdict", "#42", "maybe"].join("\t"))).toBeNull(); // invalid verdict
  });
});

describe("worker→director change requests (#4001)", () => {
  const line = (kind: string, session: string, ...rest: string[]) =>
    ["2026-07-30T12:00:00Z", session, kind, ...rest].join("\t");

  it("opens a request and carries its id, requester and text", () => {
    const s = ingestCoordLog([line("request", "cli-platform", "7", "no develop branch to target")]).state;
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ id: "7", from: "cli-platform", text: "no develop branch to target" });
  });

  it("removes it when the director resolves it", () => {
    // This is what lets the pump PRUNE its surfaced-once key. Without it the request would be
    // surfaced once and then block its own key forever, so a re-file would never reach the director.
    const s = ingestCoordLog([
      line("request", "cli-platform", "7", "no develop branch"),
      line("request-resolved", "director", "7", "created develop from main"),
    ]).state;
    expect(s.requests).toEqual([]);
  });

  it("resolves only the request named, leaving other asks open", () => {
    const s = ingestCoordLog([
      line("request", "a", "1", "first"),
      line("request", "b", "2", "second"),
      line("request-resolved", "director", "1", "done"),
    ]).state;
    expect(s.requests.map((r) => r.id)).toEqual(["2"]);
  });

  it("dedupes a replayed log rather than doubling the ask", () => {
    // The coord log is re-read in full on every tick, so every event is seen many times.
    const l = line("request", "a", "3", "same ask");
    expect(ingestCoordLog([l, l, l]).state.requests).toHaveLength(1);
  });

  it("ignores a request with no id — it could never be resolved", () => {
    expect(ingestCoordLog([line("request", "a", "", "orphan")]).state.requests).toEqual([]);
    expect(ingestCoordLog([line("request-resolved", "director", "")]).state.requests).toEqual([]);
  });

  it("survives a resolve for a request it never saw opened", () => {
    // A log rotation can drop the opening event; the close must not throw or resurrect anything.
    expect(ingestCoordLog([line("request-resolved", "director", "99", "x")]).state.requests).toEqual([]);
  });
});
