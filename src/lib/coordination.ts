// Inter-session coordination core (#199): the lost-wakeup-safe readiness model.
//
// The key correctness insight: readiness is **state** (a queryable latch), not an
// edge-triggered ping. A producer that finishes *before* the waiter registers must not
// cause a lost wakeup and a permanent hang. So a blocking session both registers as a
// waiter AND immediately checks the latch (proceed now if already satisfied); satisfy
// events set the latch and return the waiters whose **all** deps are now satisfied.
//
// This module is pure (no PTY/store/IO) so it's exhaustively unit-testable. The wiring —
// `bsc-blocked --on` -> register, the director's merge/close -> satisfy, and waking the
// parked pane -- lands on top of it in later slices. `failed` is deliberately NOT a
// satisfy: dependents stay blocked and surface as a stalled chain (finished != succeeded).
import { matchGlob } from "./sessionRoles";

/** A structured dependency target -- what a session is blocked *on*, or what landed. */
export type CoordRef =
  | { kind: "issue"; number: number }   // #42
  | { kind: "contract"; name: string }  // contract:TunnelState
  | { kind: "file"; path: string }      // file:src/lib/x.ts
  | { kind: "predicate"; expr: string } // predicate:tests-pass
  | { kind: "session"; id: string };    // session:t0p2 -- "blocked until pane X finishes"

/** The authoritative signal that satisfied a latch (most->least authoritative). */
export type SatisfySource = "merged" | "closed" | "landed";

/** Per-ref latch status. `satisfied` wakes dependents; `failed` holds them (a stalled
 *  chain the director is alerted to) -- the two are distinct on purpose. */
export type LatchStatus =
  | { state: "satisfied"; source: SatisfySource; at: number }
  | { state: "failed"; reason: string; at: number };

/** A parked session waiting on every ref in `deps`. `checkpoint` is the compact resume
 *  seed (a `bsc-checkpoint` ref) carried into the wake prompt. */
export interface Waiter {
  /** The parked session/pane id. Unique key -- re-registering replaces the entry. */
  session: string;
  /** All of these must be satisfied for the waiter to wake. */
  deps: CoordRef[];
  /** Resume seed (e.g. a checkpoint doc relpath); carried into the wake prompt. */
  checkpoint?: string;
  /** When the block was declared (ms epoch), passed in by the caller. */
  registeredAt: number;
}

/** The coordinator's persistable state: the latch table + the waiter table. */
export interface CoordState {
  latches: Record<string, LatchStatus>;
  waiters: Waiter[];
}

export function emptyCoordState(): CoordState {
  return { latches: {}, waiters: [] };
}

/** Canonical string key for a ref -- the `bsc-blocked --on <token>` wire form too. */
export function refKey(ref: CoordRef): string {
  switch (ref.kind) {
    case "issue": return `#${ref.number}`;
    case "contract": return `contract:${ref.name}`;
    case "file": return `file:${ref.path}`;
    case "predicate": return `predicate:${ref.expr}`;
    case "session": return `session:${ref.id}`;
  }
}

/** Parse a `bsc-blocked --on` token (`#42`, `contract:X`, `file:path`, `predicate:expr`)
 *  back into a ref. Returns null for an unrecognized/empty token. A bare `42` or `#42`
 *  is an issue; an unprefixed non-numeric token is treated as a predicate. */
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
  const probe: CoordState = { latches, waiters: s.waiters };
  const woken = s.waiters.filter((w) => isReady(probe, w));
  const wokenIds = new Set(woken.map((w) => w.session));
  return { state: { latches, waiters: s.waiters.filter((w) => !wokenIds.has(w.session)) }, woken };
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
  const next: CoordState = { latches, waiters: s.waiters };
  return { state: next, stalled: stalledWaiters(next, ref) };
}

// -- Event ingestion (#199 slice 2) ---------------------------------------------
// `bsc-blocked --on <refs>` appends a TSV line to $BSC_COORD_LOG; the director's
// merge/close will append satisfy lines later. `parseCoordLine` turns one line into a
// typed event, `applyCoordEvent` folds it into the latch state, and `ingestCoordLog`
// replays a whole log -- so the coordinator is just "read the log -> CoordState".

/** A structured coordination event (one per `$BSC_COORD_LOG` line). */
export type CoordEvent =
  | { type: "blocked"; session: string; deps: CoordRef[]; checkpoint?: string; at: number }
  | { type: "landed"; ref: CoordRef; at: number }
  | { type: "merged"; ref: CoordRef; at: number }
  | { type: "closed"; ref: CoordRef; at: number }
  | { type: "failed"; ref: CoordRef; reason: string; at: number }
  | { type: "woke"; session: string; at: number };

/**
 * Parse one TSV `$BSC_COORD_LOG` line into an event, or null if unrecognized.
 * Columns: `ts \t session \t kind \t <payload…>`.
 * - blocked: payload = `<comma-refs> \t <checkpoint?>`
 * - landed/merged/closed: payload = `<ref>`
 * - failed: payload = `<ref> \t <reason>`
 */
export function parseCoordLine(line: string): CoordEvent | null {
  const cols = line.replace(/\r?\n$/, "").split("\t");
  if (cols.length < 4) return null;
  const [ts, session, kind, ...rest] = cols;
  const parsed = Date.parse(ts);
  const at = Number.isFinite(parsed) ? parsed : 0;
  switch (kind) {
    case "blocked": {
      const deps = (rest[0] ?? "").split(",").map(parseRef).filter((r): r is CoordRef => r !== null);
      if (deps.length === 0) return null;
      const checkpoint = rest[1]?.trim() || undefined;
      return { type: "blocked", session, deps, checkpoint, at };
    }
    case "landed":
    case "merged":
    case "closed": {
      const ref = parseRef(rest[0] ?? "");
      return ref ? { type: kind as "landed" | "merged" | "closed", ref, at } : null;
    }
    case "failed": {
      const ref = parseRef(rest[0] ?? "");
      return ref ? { type: "failed", ref, reason: rest[1] ?? "", at } : null;
    }
    case "woke":
      return { type: "woke", session, at };
    default:
      return null;
  }
}

/** Fold one event into the latch state, returning what it triggered. */
export function applyCoordEvent(s: CoordState, e: CoordEvent): {
  state: CoordState; woken: Waiter[]; ready: boolean; stalled: Waiter[];
} {
  switch (e.type) {
    case "blocked": {
      const r = registerWaiter(s, { session: e.session, deps: e.deps, checkpoint: e.checkpoint, registeredAt: e.at });
      return { state: r.state, woken: [], ready: r.ready, stalled: [] };
    }
    case "landed":
    case "merged":
    case "closed": {
      const r = satisfy(s, e.ref, e.type, e.at);
      return { state: r.state, woken: r.woken, ready: false, stalled: [] };
    }
    case "failed": {
      const r = fail(s, e.ref, e.reason, e.at);
      return { state: r.state, woken: [], ready: false, stalled: r.stalled };
    }
    case "woke": {
      return { state: { latches: s.latches, waiters: s.waiters.filter((w) => w.session !== e.session) }, woken: [], ready: false, stalled: [] };
    }
  }
}

/**
 * Replay a whole `$BSC_COORD_LOG` (oldest-first) into latch state, collecting the waiters
 * still awaiting wake in `ready` (became ready, no `woke` ack yet) -- the coordinator's
 * rebuild-from-disk. Unparseable lines are skipped.
 */
export function ingestCoordLog(lines: string[], initial: CoordState = emptyCoordState()): {
  state: CoordState; woken: Waiter[]; ready: Waiter[];
} {
  let state = initial;
  const woken: Waiter[] = [];
  // `pending`: waiters that became ready (all deps satisfied) and have NOT yet been
  // acknowledged by a `woke` event -- i.e. the ones still awaiting actuation. The woke
  // event is what makes the wake idempotent across polls + app restarts.
  const pending = new Map<string, Waiter>();
  for (const line of lines) {
    const ev = parseCoordLine(line);
    if (!ev) continue;
    if (ev.type === "woke") {
      pending.delete(ev.session);
      state = applyCoordEvent(state, ev).state;
      continue;
    }
    const r = applyCoordEvent(state, ev);
    state = r.state;
    for (const w of r.woken) {
      woken.push(w);
      pending.set(w.session, w);
    }
  }
  return { state, woken, ready: [...pending.values()] };
}

// -- Wake planning + inbox view (#199 slice 3) ----------------------------------
// Pure "decide + present": given the ingested latch state, what to wake (with what
// prompt) and what the inbox/health view shows. The store/PTY execution (relaunch the
// pane, render the panel) is a thin layer on top of these in a later slice.

export interface WakeAction {
  /** The parked session/pane to relaunch. */
  session: string;
  /** The token-aware wake prompt seeded into the fresh session. */
  prompt: string;
  /** The deps that gated this waiter (now all satisfied). */
  deps: CoordRef[];
}

/** A ref's latch status as a short label (for prompts + the inbox view). */
function statusOf(s: CoordState, ref: CoordRef): "satisfied" | "failed" | "pending" {
  const l = s.latches[refKey(ref)];
  return l?.state === "satisfied" ? "satisfied" : l?.state === "failed" ? "failed" : "pending";
}

/**
 * Compose the token-aware wake prompt for a woken waiter -- names the landed deps (with
 * how they were satisfied) and points at the checkpoint, so the FRESH session resumes
 * without re-deriving context (never `--continue` on a fat transcript; see #199).
 */
export function wakePromptFor(w: Waiter, s: CoordState): string {
  const landed = w.deps
    .map((d) => {
      const l = s.latches[refKey(d)];
      const via = l?.state === "satisfied" ? l.source : "ready";
      return `${refKey(d)} (${via})`;
    })
    .join(", ");
  const lines = [
    `Your blocking ${w.deps.length === 1 ? "dependency has" : "dependencies have"} landed -- resume now.`,
    `Satisfied: ${landed}.`,
  ];
  if (w.checkpoint) {
    lines.push(`Resume from your checkpoint: ${w.checkpoint} -- read it first, then continue from where you left off.`);
  }
  return lines.join("\n");
}

/** Map newly-woken waiters to wake actions (the prompt-injection payloads slice 4 runs). */
export function planWakes(woken: Waiter[], s: CoordState): WakeAction[] {
  return woken.map((w) => ({ session: w.session, deps: w.deps, prompt: wakePromptFor(w, s) }));
}

/** One blocked session as the inbox / blocked-chain health view would show it. */
export interface BlockedView {
  session: string;
  checkpoint?: string;
  deps: { ref: string; status: "satisfied" | "failed" | "pending" }[];
  /** True when any dep has failed -- a stalled chain to escalate. */
  stalled: boolean;
  /** True when this session is part of a wait-for cycle -- a deadlock to escalate
   *  (no producer will ever satisfy it, so it would otherwise hang forever). */
  deadlocked: boolean;
}

/** Derive the inbox/health view from latch state: every still-parked waiter, each dep's
 *  status, whether the chain is stalled (a failed dep), and whether it sits in a wait-for
 *  cycle (a deadlock). `producerOf` resolves which session satisfies a dep (defaults to
 *  the `session:` self-resolver -- see {@link detectDeadlocks}). */
export function coordinationSummary(s: CoordState, producerOf: ProducerOf = defaultProducerOf): BlockedView[] {
  const deadlocked = new Set(detectDeadlocks(s, producerOf).flatMap((d) => d.cycle));
  return s.waiters.map((w) => {
    const deps = w.deps.map((d) => ({ ref: refKey(d), status: statusOf(s, d) }));
    return {
      session: w.session,
      checkpoint: w.checkpoint,
      deps,
      stalled: deps.some((d) => d.status === "failed"),
      deadlocked: deadlocked.has(w.session),
    };
  });
}

// -- Auto-wake recency gate (#199) ----------------------------------------------
// The always-on coordinator only auto-relaunches a ready session if its deps landed
// RECENTLY, so an app restart (which replays the whole log) can't relaunch sessions whose
// dependencies were satisfied long ago and were never woken. The manual Wake button has
// no such limit. Kept pure (takes `now`) so it's testable.

/** Newest moment among a waiter's deps at which one became satisfied (ms epoch), or 0. */
export function readinessAt(w: Waiter, s: CoordState): number {
  let newest = 0;
  for (const d of w.deps) {
    const l = s.latches[refKey(d)];
    if (l?.state === "satisfied" && l.at > newest) newest = l.at;
  }
  return newest;
}

/** Whether `w` became ready within `windowMs` of `now`. */
export function isFreshlyReady(w: Waiter, s: CoordState, now: number, windowMs: number): boolean {
  const at = readinessAt(w, s);
  return at > 0 && now - at < windowMs;
}

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

/** Resolves which session is expected to satisfy a dep ref, or undefined if unknown. */
export type ProducerOf = (ref: CoordRef) => string | undefined;

/** The default resolver: only a `session:<id>` dep yields a producer (itself). All other
 *  kinds are unknown until plan-derived Produces/Consumes is supplied (#199 AC#7). */
export function defaultProducerOf(ref: CoordRef): string | undefined {
  return ref.kind === "session" ? ref.id : undefined;
}

/** One session's declared outputs -- the plan-derived data a {@link ProducerOf} is built
 *  from. The fields mirror what the planner already carries: `contracts` are
 *  `FeatureContract.produces[].name`, `issues` are `AgentStream.issues`, and `owns` are
 *  `AgentStream.owns` (file globs). `session` is the producing session id -- the SAME id
 *  space as a waiter's `session` and a `session:<id>` ref (the launched pane id), so the
 *  resolved edges land on real parked waiters. */
export interface SessionProduces {
  /** Producing session id (pane id) -- must match the waiter ids edges connect to. */
  session: string;
  /** Contract names it produces (resolves `contract:<name>` deps). */
  contracts?: string[];
  /** Issue refs it owns -- `#42`, `42`, or a number (resolves `#issue` deps). */
  issues?: (string | number)[];
  /** File globs it owns -- `src/lib/**` (resolves `file:<path>` deps via glob match). */
  owns?: string[];
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

/** A detected wait-for cycle: the parked sessions that mutually block, in ring order.
 *  A single-element cycle is a session waiting (transitively) on its own output. */
export interface Deadlock {
  cycle: string[];
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
