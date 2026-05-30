import { describe, it, expect } from "vitest";
import {
  type Waiter,
  emptyCoordState, refKey, parseRef, isSatisfied, isReady,
  registerWaiter, satisfy, fail, stalledWaiters,
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
