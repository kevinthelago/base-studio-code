// Tests for the runtime fault → routed fix decision core (#2265). Covers the three acceptance
// guarantees — the auto-triage GATE, DEDUP per fingerprint, and the RATE-LIMIT / fan-out cap — plus
// the resolve→clear path and severity/threshold filtering.
import { describe, it, expect } from "vitest";
import {
  planFaultDispatch,
  unresolvedCount,
  faultDispatchPrompt,
  DEFAULT_FAULT_TRIAGE,
  type FaultLite,
  type FaultTriageConfig,
} from "./faultTriage";

const cfg = (over: Partial<FaultTriageConfig> = {}): FaultTriageConfig => ({
  enabled: true,
  ...DEFAULT_FAULT_TRIAGE,
  ...over,
});

const fault = (fp: string, over: Partial<FaultLite> = {}): FaultLite => ({
  fingerprint: fp,
  level: "error",
  title: `fault ${fp}`,
  count: 1,
  ...over,
});

describe("planFaultDispatch — the gate", () => {
  it("dispatches nothing when auto-triage is OFF (surface-only)", () => {
    const faults = [fault("a"), fault("b", { level: "fatal" })];
    const plan = planFaultDispatch(faults, [], cfg({ enabled: false }));
    expect(plan.dispatch).toEqual([]);
    // The ledger is still pruned to open faults, but nothing is routed.
    expect(plan.nextDispatched).toEqual([]);
  });

  it("dispatches when ON", () => {
    const plan = planFaultDispatch([fault("a")], [], cfg());
    expect(plan.dispatch.map((d) => d.fingerprint)).toEqual(["a"]);
    expect(plan.nextDispatched).toEqual(["a"]);
  });
});

describe("planFaultDispatch — dedup by fingerprint", () => {
  it("routes a given fingerprint exactly once across cycles", () => {
    const faults = [fault("a")];
    const first = planFaultDispatch(faults, [], cfg());
    expect(first.dispatch).toHaveLength(1);
    // Second cycle: same open fault, already dispatched → no re-dispatch (idempotent).
    const second = planFaultDispatch(faults, first.nextDispatched, cfg());
    expect(second.dispatch).toEqual([]);
    expect(second.nextDispatched).toEqual(["a"]);
  });

  it("collapses N occurrences of one fault (a higher count) into one dispatch", () => {
    // A fault that fired 500× is still ONE fingerprint → one dispatch, never 500.
    const plan = planFaultDispatch([fault("storm", { count: 500 })], [], cfg());
    expect(plan.dispatch).toHaveLength(1);
    expect(plan.dispatch[0].count).toBe(500);
  });
});

describe("planFaultDispatch — rate-limit / fan-out cap", () => {
  it("never exceeds maxPerCycle in a single tick (a fault storm can't spawn a fleet)", () => {
    const faults = Array.from({ length: 50 }, (_, i) => fault(`f${i}`));
    const plan = planFaultDispatch(faults, [], cfg({ maxPerCycle: 2, maxInFlight: 100 }));
    expect(plan.dispatch).toHaveLength(2);
  });

  it("never exceeds maxInFlight across cycles", () => {
    const faults = Array.from({ length: 50 }, (_, i) => fault(`f${i}`));
    const c = cfg({ maxPerCycle: 2, maxInFlight: 3 });
    // Cycle 1: 2 dispatched (per-cycle cap).
    const c1 = planFaultDispatch(faults, [], c);
    expect(c1.dispatch).toHaveLength(2);
    // Cycle 2: 2 in-flight, cap 3 → only 1 slot left despite the per-cycle cap of 2.
    const c2 = planFaultDispatch(faults, c1.nextDispatched, c);
    expect(c2.dispatch).toHaveLength(1);
    expect(c2.nextDispatched).toHaveLength(3);
    // Cycle 3: at the cap → nothing.
    const c3 = planFaultDispatch(faults, c2.nextDispatched, c);
    expect(c3.dispatch).toEqual([]);
    expect(c3.nextDispatched).toHaveLength(3);
  });

  it("routes the worst faults first when slots are scarce (severity, then volume)", () => {
    const faults = [
      fault("warnish", { level: "warn", count: 99 }),
      fault("small", { level: "error", count: 1 }),
      fault("big", { level: "error", count: 40 }),
      fault("fatal", { level: "fatal", count: 1 }),
    ];
    const plan = planFaultDispatch(faults, [], cfg({ maxPerCycle: 2, minLevel: "warn" }));
    // fatal wins, then the higher-volume error.
    expect(plan.dispatch.map((d) => d.fingerprint)).toEqual(["fatal", "big"]);
  });
});

describe("planFaultDispatch — severity + threshold filters", () => {
  it("skips faults below minLevel", () => {
    const plan = planFaultDispatch([fault("w", { level: "warn" })], [], cfg({ minLevel: "error" }));
    expect(plan.dispatch).toEqual([]);
  });

  it("skips faults below the count threshold", () => {
    const faults = [fault("rare", { count: 1 }), fault("common", { count: 5 })];
    const plan = planFaultDispatch(faults, [], cfg({ threshold: 3 }));
    expect(plan.dispatch.map((d) => d.fingerprint)).toEqual(["common"]);
  });
});

describe("planFaultDispatch — resolve → clear path", () => {
  it("drops a resolved fault from the ledger, freeing its fan-out slot", () => {
    const c = cfg({ maxInFlight: 1, maxPerCycle: 1 });
    // Cycle 1: dispatch "a"; now at the fan-out cap.
    const c1 = planFaultDispatch([fault("a")], [], c);
    expect(c1.dispatch).toHaveLength(1);
    // "b" appears but "a" is still open (in-flight) → capped, no dispatch.
    const c2 = planFaultDispatch([fault("a"), fault("b")], c1.nextDispatched, c);
    expect(c2.dispatch).toEqual([]);
    // "a" is resolved (the fix landed → `bsc errors resolve`), so it drops from the unresolved list.
    // The slot frees and "b" dispatches; "a" is pruned from the ledger.
    const c3 = planFaultDispatch([fault("b")], c2.nextDispatched, c);
    expect(c3.dispatch.map((d) => d.fingerprint)).toEqual(["b"]);
    expect(c3.nextDispatched).toEqual(["b"]);
  });

  it("re-dispatches a fault that recurs after being resolved", () => {
    // Dispatch, resolve (drops from unresolved list), then it recurs (errordb re-opens the fingerprint).
    const c1 = planFaultDispatch([fault("flaky")], [], cfg());
    expect(c1.dispatch).toHaveLength(1);
    // Resolved → not in the unresolved list this cycle → pruned from the ledger.
    const c2 = planFaultDispatch([], c1.nextDispatched, cfg());
    expect(c2.nextDispatched).toEqual([]);
    // Recurrence: the same fingerprint is open again and no longer tracked → re-dispatched.
    const c3 = planFaultDispatch([fault("flaky")], c2.nextDispatched, cfg());
    expect(c3.dispatch.map((d) => d.fingerprint)).toEqual(["flaky"]);
  });

  it("prunes the ledger even when the gate is off", () => {
    // Toggle off but a previously-tracked fault resolved → still pruned, so a later toggle-on is clean.
    const plan = planFaultDispatch([], ["gone"], cfg({ enabled: false }));
    expect(plan.nextDispatched).toEqual([]);
  });
});

describe("unresolvedCount + faultDispatchPrompt", () => {
  it("counts only unresolved faults", () => {
    expect(unresolvedCount([fault("a"), fault("b", { resolvedAt: 123 }), fault("c")])).toBe(2);
  });

  it("builds a director prompt that names each fault and the emitters", () => {
    const p = faultDispatchPrompt([{ fingerprint: "abc", level: "fatal", title: "boom", count: 3 }]);
    expect(p).toContain("boom");
    expect(p).toContain("abc");
    expect(p).toContain("bsc-issue");
    expect(p).toContain("bsc-assign");
    expect(p).toContain("bsc errors resolve");
  });
});
