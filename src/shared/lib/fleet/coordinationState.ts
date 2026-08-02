// Inter-session coordination core (#199): the lost-wakeup-safe readiness model.
//
// The key correctness insight: readiness is **state** (a queryable latch), not an
// edge-triggered ping. A producer that finishes *before* the waiter registers must not
// cause a lost wakeup and a permanent hang. So a blocking session both registers as a
// waiter AND immediately checks the latch (proceed now if already satisfied); satisfy
// events set the latch and return the waiters whose **all** deps are now satisfied.
//
// This module is pure (no PTY/store/IO) so it's exhaustively unit-testable. Half its wiring is live:
// the completion emitters (`bsc-landed`/`merged`/`closed`/`failed`) -> satisfy, and the Flow tab wakes a
// ready pane. The other half is not — registration used to come from a `bsc-blocked --on` shell helper,
// and #1039 removed runtime dependency-wait outright rather than replacing it, so nothing declares
// dependence mid-task any more; `streamGate.ts` decides the same question at LAUNCH instead, off the
// plan's `dependsOn`. `failed` is deliberately NOT a satisfy: dependents stay blocked and surface as a
// stalled chain (finished != succeeded).
import type {
  CoordRef,
  SatisfySource,
  Waiter,
  CoordState,
} from "./coordination.types";

export function emptyCoordState(): CoordState {
  return { latches: {}, waiters: [], waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [] };
}

/** Canonical string key for a ref -- and the wire form too: it is exactly the token the completion
 *  emitters take as their argument (`bsc-landed '#42'`, `bsc-merged contract:X`). */
export function refKey(ref: CoordRef): string {
  switch (ref.kind) {
    case "issue": return `#${ref.number}`;
    case "contract": return `contract:${ref.name}`;
    case "file": return `file:${ref.path}`;
    case "predicate": return `predicate:${ref.expr}`;
    case "session": return `session:${ref.id}`;
  }
}

/** Parse a wire token (`#42`, `contract:X`, `file:path`, `predicate:expr`) back into a ref -- the
 *  argument form of `bsc-landed`/`merged`/`closed`/`failed`, and of the dep columns in a pre-#1039
 *  `blocked` line. Returns null for an unrecognized/empty token. A bare `42` or `#42` is an issue; an
 *  unprefixed non-numeric token is treated as a predicate. */
export function parseRef(token: string): CoordRef | null {
  const t = token.trim();
  if (!t) return null;
  if (t.startsWith("#")) {
    const n = Number(t.slice(1));
    return Number.isInteger(n) && n > 0 ? { kind: "issue", number: n } : null;
  }
  const colon = t.indexOf(":");
  if (colon > 0) {
    const prefix = t.slice(0, colon);
    const rest = t.slice(colon + 1).trim();
    if (!rest) return null;
    if (prefix === "contract") return { kind: "contract", name: rest };
    if (prefix === "file") return { kind: "file", path: rest };
    if (prefix === "predicate") return { kind: "predicate", expr: rest };
    if (prefix === "session") return { kind: "session", id: rest };
    return null;
  }
  if (/^\d+$/.test(t)) return { kind: "issue", number: Number(t) };
  return { kind: "predicate", expr: t };
}

/** Whether `ref` is satisfied (truly done -- not merely failed). */
export function isSatisfied(s: CoordState, ref: CoordRef): boolean {
  return s.latches[refKey(ref)]?.state === "satisfied";
}

/** Whether all of a waiter's deps are satisfied. */
export function isReady(s: CoordState, w: Waiter): boolean {
  return w.deps.every((d) => isSatisfied(s, d));
}

/** Waiters currently blocked on a ref that has *failed* -- a stalled chain to escalate. */
export function stalledWaiters(s: CoordState, ref: CoordRef): Waiter[] {
  const key = refKey(ref);
  if (s.latches[key]?.state !== "failed") return [];
  return s.waiters.filter((w) => w.deps.some((d) => refKey(d) === key));
}

/**
 * Register a blocking session. Returns the next state and `ready`: whether all its deps
 * are ALREADY satisfied (the register-then-check that defeats lost wakeups -- the caller
 * should proceed immediately when `ready`). When already ready, the waiter is not added
 * (nothing to wait for); otherwise it's added/replaced by `session` id (idempotent).
 */
export function registerWaiter(s: CoordState, w: Waiter): { state: CoordState; ready: boolean } {
  const ready = isReady(s, w);
  const others = s.waiters.filter((x) => x.session !== w.session);
  const state: CoordState = {
    latches: s.latches,
    waiters: ready ? others : [...others, w],
    waiting: s.waiting,
    asking: s.asking,
    issues: s.issues,
    maintaining: s.maintaining,
    briefs: s.briefs,
    forks: s.forks,
    requests: s.requests,
    commissions: s.commissions,
  };
  return { state, ready };
}

/**
 * Mark a ref satisfied (a `landed`/`merged`/`closed` event). Sets the latch and returns
 * the waiters that are now fully ready (all deps satisfied), removing them from the
 * table. Idempotent: re-delivering the same satisfy is harmless (readiness is state).
 */
export function satisfy(
  s: CoordState,
  ref: CoordRef,
  source: SatisfySource,
  at: number,
): { state: CoordState; woken: Waiter[] } {
  const latches = { ...s.latches, [refKey(ref)]: { state: "satisfied" as const, source, at } };
  const probe: CoordState = { latches, waiters: s.waiters, waiting: s.waiting, asking: s.asking, issues: s.issues, maintaining: s.maintaining, briefs: s.briefs, forks: s.forks, commissions: s.commissions, requests: s.requests };
  const woken = s.waiters.filter((w) => isReady(probe, w));
  const wokenIds = new Set(woken.map((w) => w.session));
  return { state: { latches, waiters: s.waiters.filter((w) => !wokenIds.has(w.session)), waiting: s.waiting, asking: s.asking, issues: s.issues, maintaining: s.maintaining, briefs: s.briefs, forks: s.forks, commissions: s.commissions, requests: s.requests }, woken };
}

/**
 * Mark a ref failed (a `failed` event). Does NOT satisfy the latch -- dependents stay
 * blocked. Returns the waiters now stalled on this failed ref so the caller can raise a
 * blocked-chain alert. Idempotent.
 */
export function fail(
  s: CoordState,
  ref: CoordRef,
  reason: string,
  at: number,
): { state: CoordState; stalled: Waiter[] } {
  const latches = { ...s.latches, [refKey(ref)]: { state: "failed" as const, reason, at } };
  const next: CoordState = { latches, waiters: s.waiters, waiting: s.waiting, asking: s.asking, issues: s.issues, maintaining: s.maintaining, briefs: s.briefs, forks: s.forks, commissions: s.commissions, requests: s.requests };
  return { state: next, stalled: stalledWaiters(next, ref) };
}
