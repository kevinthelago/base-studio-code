// -- Predicate-based readiness (#199 / #365) ------------------------------------
// PR-merged / issue-closed have an authoritative emitter (the director), so they arrive
// as explicit satisfy events. A `predicate:` dep does NOT -- "the symbol exists", "the
// stub is implemented", "tests pass" has no one to emit it, so the coordinator POLLS it:
// the host evaluates the predicate against the repo and, when it holds, the latch is set
// (the third satisfy path). Kept pure -- the actual repo-checking lives in the injected
// `evaluate`, so the readiness logic stays exhaustively unit-testable.
import type {
  CoordRef,
  Waiter,
  CoordState,
  Predicate,
  PredicateEvaluator,
} from "./coordination.types";
import { refKey, isSatisfied, satisfy } from "./coordinationState";

/** Parse a predicate's inner expr (the part after `predicate:`) into a typed {@link
 *  Predicate}. Never throws -- an unrecognized/headless expr becomes `custom`. Pure. */
export function parsePredicate(expr: string): Predicate {
  const e = expr.trim();
  if (e === "tests-pass" || e === "tests") return { kind: "tests-pass" };
  const colon = e.indexOf(":");
  if (colon > 0) {
    const head = e.slice(0, colon);
    const rest = e.slice(colon + 1).trim();
    if (rest) {
      if (head === "symbol") return { kind: "symbol", name: rest };
      if (head === "file-exists" || head === "file") return { kind: "file-exists", path: rest };
      if (head === "stub") return { kind: "stub", name: rest };
    }
  }
  return { kind: "custom", expr: e };
}

/**
 * Evaluate every UNSATISFIED `predicate:` dep currently gating a parked waiter and satisfy
 * the latches whose predicate now holds -- the polled, third satisfy path alongside
 * merged/closed/landed (a satisfied predicate uses source `landed`: it finished, like any
 * produced ref). Distinct refs are evaluated once each (a predicate shared by N waiters is
 * checked one time). Returns the next state + the waiters now fully ready (all deps
 * satisfied), removed from the table -- feed them to {@link planWakes} exactly like a
 * satisfy event's `woken`. Pure (the repo-checking is in `evaluate`) and idempotent:
 * re-polling an already-satisfied predicate is a no-op. `at` stamps the satisfy time so the
 * auto-wake recency gate ({@link isFreshlyReady}) treats a polled predicate like any latch.
 */
export function evaluatePredicates(
  s: CoordState,
  evaluate: PredicateEvaluator,
  at: number,
): { state: CoordState; woken: Waiter[] } {
  const seen = new Set<string>();
  const toSatisfy: CoordRef[] = [];
  for (const wtr of s.waiters) {
    for (const d of wtr.deps) {
      if (d.kind !== "predicate") continue;
      const key = refKey(d);
      if (seen.has(key)) continue;        // each distinct predicate evaluated once
      seen.add(key);
      if (isSatisfied(s, d)) continue;    // already latched -- skip
      if (evaluate(d.expr) === true) toSatisfy.push(d);
    }
  }
  let state = s;
  const wokenIds = new Set<string>();
  const woken: Waiter[] = [];
  for (const ref of toSatisfy) {
    const r = satisfy(state, ref, "landed", at);
    state = r.state;
    for (const wtr of r.woken) {
      if (!wokenIds.has(wtr.session)) { wokenIds.add(wtr.session); woken.push(wtr); }
    }
  }
  return { state, woken };
}

/**
 * The distinct, still-unsatisfied `predicate:` exprs currently gating a parked waiter -- the
 * exact set the runtime must re-check this poll. This is the contract the host evaluator
 * consumes: the poll loop calls this, hands the list to the host (which checks the repo and
 * returns which now hold), then feeds the result back through {@link evaluatePredicates}.
 * Pure and dedup'd (a predicate shared by N waiters appears once); empty when nothing is
 * predicate-gated, so the runtime can skip the host round-trip entirely. The inner expr is
 * returned (the part after `predicate:`), ready for {@link parsePredicate}.
 */
export function pendingPredicateExprs(s: CoordState): string[] {
  const seen = new Set<string>();
  const exprs: string[] = [];
  for (const wtr of s.waiters) {
    for (const d of wtr.deps) {
      if (d.kind !== "predicate") continue;
      if (isSatisfied(s, d)) continue;
      const key = refKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      exprs.push(d.expr);
    }
  }
  return exprs;
}
