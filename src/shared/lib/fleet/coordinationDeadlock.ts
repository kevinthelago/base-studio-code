// -- Cycle / deadlock detection (#199 AC#5) -------------------------------------
// "Satisfied" is monotonic, so the *only* way a parked waiter never wakes is a wait-for
// CYCLE: A waits on something B produces while B waits on something A produces (or a
// longer ring). No producer in the ring can move, so all of them hang. The runtime must
// DETECT this and escalate rather than spin forever (the planning critic rejects a cyclic
// plan up front; this is the runtime safety net for cycles that slip through).
//
// To build the wait-for graph we need to know which session is expected to satisfy a dep.
// A `session:<id>` dep names that producer directly (id -> that session). Other ref kinds
// (#issue, contract:, file:, predicate:) carry no producer in the log today, so they yield
// NO edge under the default resolver -- zero false positives. Pass a plan-derived resolver
// from {@link buildProducerOf} (fed by the fleet's Produces/Consumes + issue/file ownership)
// and the same algorithm lights up for contract/issue/file cycles too (#199 AC#7). Pure (no
// IO) so it's fully testable.
import { matchGlob } from "../session/sessionRoles";
import type {
  CoordRef,
  CoordState,
  ProducerOf,
  SessionProduces,
  Deadlock,
} from "./coordination.types";
import { isSatisfied } from "./coordinationState";

/** The default resolver: only a `session:<id>` dep yields a producer (itself). All other
 *  kinds are unknown until plan-derived Produces/Consumes is supplied (#199 AC#7). */
export function defaultProducerOf(ref: CoordRef): string | undefined {
  return ref.kind === "session" ? ref.id : undefined;
}

/** Parse an issue ref (`#42`, `42`, or `42`) into its number, or undefined if not one. */
function issueNumber(ref: string | number): number | undefined {
  const n = typeof ref === "number" ? ref : Number(String(ref).trim().replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Build a {@link ProducerOf} from the plan's Produces/Consumes data (#199 AC#7): each
 * session declares the contracts, issues, and file globs it produces, and the resolver
 * maps a dep ref back to the session expected to satisfy it. This is what lights up
 * contract/issue/file wait-for cycles in {@link detectDeadlocks} — not just `session:`
 * ones (which it still resolves, like {@link defaultProducerOf}).
 *
 * First declaration wins on a collision (a contract/issue should have exactly one
 * producer; the planning critic rejects duplicate `produces`). Predicate deps never
 * resolve to a producer (no session "produces" a predicate). Pure.
 */
export function buildProducerOf(producers: SessionProduces[]): ProducerOf {
  const byContract = new Map<string, string>();
  const byIssue = new Map<number, string>();
  const fileOwners: { glob: string; session: string }[] = [];
  for (const p of producers) {
    for (const name of p.contracts ?? []) {
      if (name && !byContract.has(name)) byContract.set(name, p.session);
    }
    for (const ref of p.issues ?? []) {
      const n = issueNumber(ref);
      if (n !== undefined && !byIssue.has(n)) byIssue.set(n, p.session);
    }
    for (const glob of p.owns ?? []) if (glob) fileOwners.push({ glob, session: p.session });
  }
  return (ref) => {
    switch (ref.kind) {
      case "session": return ref.id;
      case "contract": return byContract.get(ref.name);
      case "issue": return byIssue.get(ref.number);
      case "file": return fileOwners.find((o) => matchGlob(o.glob, ref.path))?.session;
      case "predicate": return undefined;
    }
  };
}

/**
 * Project a `paneId -> launched-stream` map (the store's `fleetPaneStreams`) into the
 * {@link SessionProduces} list {@link buildProducerOf} consumes. The producing `session`
 * is the PANE id — the same id space waiters register under (BSC_AUDIT_PANE) — so the
 * resolved edges land on real parked panes, not on stream slugs. Each stream's `owns`
 * and `issues` (and any future `contracts`) become its produced refs. Structural typing:
 * an `AgentStream` satisfies this shape, so the store passes its fleet map straight in.
 * Pure. See `buildProducerOf(producesFromPaneStreams(map))` for the full resolver.
 */
export function producesFromPaneStreams(
  paneStreams: Record<string, { owns?: string[]; issues?: (string | number)[]; contracts?: string[] }>,
): SessionProduces[] {
  return Object.entries(paneStreams).map(([session, s]) => ({
    session,
    owns: s.owns,
    issues: s.issues,
    contracts: s.contracts,
  }));
}

/**
 * Find every wait-for cycle among the parked waiters. An edge `A -> B` means waiter A has
 * an UNSATISFIED dep that waiter B is expected to produce (a satisfied dep imposes no wait,
 * and an edge to a non-waiter is harmless since that producer can still finish). Cycles are
 * the strongly-connected components of size >= 2, plus any self-loop. Idempotent + pure.
 */
export function detectDeadlocks(s: CoordState, producerOf: ProducerOf = defaultProducerOf): Deadlock[] {
  const waiterIds = new Set(s.waiters.map((w) => w.session));
  const adj = new Map<string, Set<string>>();
  for (const w of s.waiters) {
    const outs = new Set<string>();
    for (const d of w.deps) {
      if (isSatisfied(s, d)) continue;             // satisfied -> no longer blocking
      const p = producerOf(d);
      if (p && waiterIds.has(p)) outs.add(p);      // only an edge to another parked session
    }
    adj.set(w.session, outs);
  }
  return tarjanCycles(adj);
}

/** Whether any parked waiter sits in a wait-for cycle. */
export function hasDeadlock(s: CoordState, producerOf: ProducerOf = defaultProducerOf): boolean {
  return detectDeadlocks(s, producerOf).length > 0;
}

/** Tarjan's SCC -- the cyclic components (size >= 2) plus self-loops, each as a `Deadlock`.
 *  Graphs are tiny (one node per parked pane), so recursive DFS is fine. */
function tarjanCycles(adj: Map<string, Set<string>>): Deadlock[] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: Deadlock[] = [];

  const connect = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const nxt of adj.get(v) ?? []) {
      if (!idx.has(nxt)) {
        connect(nxt);
        low.set(v, Math.min(low.get(v)!, low.get(nxt)!));
      } else if (onStack.has(nxt)) {
        low.set(v, Math.min(low.get(v)!, idx.get(nxt)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let node: string;
      do {
        node = stack.pop()!;
        onStack.delete(node);
        comp.push(node);
      } while (node !== v);
      // A multi-node SCC is a ring; a lone node is a cycle only if it waits on itself.
      if (comp.length > 1 || adj.get(comp[0])?.has(comp[0])) {
        cycles.push({ cycle: comp.reverse() });
      }
    }
  };

  for (const n of adj.keys()) if (!idx.has(n)) connect(n);
  return cycles;
}
