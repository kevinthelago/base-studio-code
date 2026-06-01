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

/** A structured dependency target -- what a session is blocked *on*, or what landed. */
export type CoordRef =
  | { kind: "issue"; number: number }   // #42
  | { kind: "contract"; name: string }  // contract:TunnelState
  | { kind: "file"; path: string }      // file:src/lib/x.ts
  | { kind: "predicate"; expr: string }; // predicate:tests-pass

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
  /** Sessions paused for the user (#297 checkpoint/confirm flow) — woken manually. */
  waiting: WaitingSession[];
  /** Sessions that asked the DIRECTOR a question (#369) — woken when it answers. */
  asking: AskingSession[];
}

/** A session paused for the USER, not blocked on a dependency latch (#297). It carries
 *  no deps, never participates in auto-wake, and is resumed only from the inbox. */
export interface WaitingSession {
  /** The parked session/pane id. Unique key — a newer wait replaces the entry. */
  session: string;
  /** Why it paused (the `bsc-wait` note); may be empty. */
  reason: string;
  /** Resume seed (e.g. a checkpoint doc relpath); carried into the wake prompt. */
  checkpoint?: string;
  /** When the pause was declared (ms epoch), passed in by the caller. */
  at: number;
}

/** A session parked on a `bsc-ask` question to the director (#369). Unlike a user-wait,
 *  it is resumed automatically when the director answers via `bsc-answer <session>`. */
export interface AskingSession {
  session: string;
  question: string;
  checkpoint?: string;
  at: number;
}

/** A pending wake produced when the director answers an asking session (#369). */
export interface AnsweredWake {
  session: string;
  answer: string;
  checkpoint?: string;
  at: number;
}

export function emptyCoordState(): CoordState {
  return { latches: {}, waiters: [], waiting: [], asking: [] };
}

/** Canonical string key for a ref -- the `bsc-blocked --on <token>` wire form too. */
export function refKey(ref: CoordRef): string {
  switch (ref.kind) {
    case "issue": return `#${ref.number}`;
    case "contract": return `contract:${ref.name}`;
    case "file": return `file:${ref.path}`;
    case "predicate": return `predicate:${ref.expr}`;
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
  const probe: CoordState = { latches, waiters: s.waiters, waiting: s.waiting, asking: s.asking };
  const woken = s.waiters.filter((w) => isReady(probe, w));
  const wokenIds = new Set(woken.map((w) => w.session));
  return { state: { latches, waiters: s.waiters.filter((w) => !wokenIds.has(w.session)), waiting: s.waiting, asking: s.asking }, woken };
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
  const next: CoordState = { latches, waiters: s.waiters, waiting: s.waiting, asking: s.asking };
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
  | { type: "woke"; session: string; at: number }
  | { type: "waiting"; session: string; reason: string; checkpoint?: string; at: number }
  | { type: "ask"; session: string; question: string; checkpoint?: string; at: number }
  | { type: "answer"; target: string; answer: string; at: number };

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
    case "waiting":
      return { type: "waiting", session, reason: rest[0] ?? "", checkpoint: rest[1]?.trim() || undefined, at };
    case "ask":
      return { type: "ask", session, question: rest[0] ?? "", checkpoint: rest[1]?.trim() || undefined, at };
    case "answer": {
      const target = (rest[0] ?? "").trim();
      return target ? { type: "answer", target, answer: rest[1] ?? "", at } : null;
    }
    case "woke":
      return { type: "woke", session, at };
    default:
      return null;
  }
}

/** Fold one event into the latch state, returning what it triggered. */
export function applyCoordEvent(s: CoordState, e: CoordEvent): {
  state: CoordState; woken: Waiter[]; ready: boolean; stalled: Waiter[]; answered: AnsweredWake[];
} {
  switch (e.type) {
    case "blocked": {
      const r = registerWaiter(s, { session: e.session, deps: e.deps, checkpoint: e.checkpoint, registeredAt: e.at });
      // A session that now declares a real dependency leaves the manual-wait list.
      const state = { ...r.state, waiting: r.state.waiting.filter((w) => w.session !== e.session) };
      return { state, woken: [], ready: r.ready, stalled: [], answered: [] };
    }
    case "waiting": {
      const waiting = [
        ...s.waiting.filter((w) => w.session !== e.session),
        { session: e.session, reason: e.reason, checkpoint: e.checkpoint, at: e.at },
      ];
      return { state: { ...s, waiting }, woken: [], ready: false, stalled: [], answered: [] };
    }
    case "landed":
    case "merged":
    case "closed": {
      const r = satisfy(s, e.ref, e.type, e.at);
      return { state: r.state, woken: r.woken, ready: false, stalled: [], answered: [] };
    }
    case "failed": {
      const r = fail(s, e.ref, e.reason, e.at);
      return { state: r.state, woken: [], ready: false, stalled: r.stalled, answered: [] };
    }
    case "woke": {
      return { state: { latches: s.latches, waiters: s.waiters.filter((w) => w.session !== e.session), waiting: s.waiting.filter((w) => w.session !== e.session), asking: s.asking.filter((a) => a.session !== e.session) }, woken: [], ready: false, stalled: [], answered: [] };
    }
    case "ask": {
      const asking = [
        ...s.asking.filter((a) => a.session !== e.session),
        { session: e.session, question: e.question, checkpoint: e.checkpoint, at: e.at },
      ];
      // Asking the director supersedes any prior user-wait registration for this session.
      const waiting = s.waiting.filter((w) => w.session !== e.session);
      return { state: { ...s, asking, waiting }, woken: [], ready: false, stalled: [], answered: [] };
    }
    case "answer": {
      const ask = s.asking.find((a) => a.session === e.target);
      const asking = s.asking.filter((a) => a.session !== e.target);
      const answered: AnsweredWake[] = ask
        ? [{ session: e.target, answer: e.answer, checkpoint: ask.checkpoint, at: e.at }]
        : [];
      return { state: { ...s, asking }, woken: [], ready: false, stalled: [], answered };
    }
  }
}

/**
 * Replay a whole `$BSC_COORD_LOG` (oldest-first) into latch state, collecting the waiters
 * still awaiting wake in `ready` (became ready, no `woke` ack yet) -- the coordinator's
 * rebuild-from-disk. Unparseable lines are skipped.
 */
export function ingestCoordLog(lines: string[], initial: CoordState = emptyCoordState()): {
  state: CoordState; woken: Waiter[]; ready: Waiter[]; answered: AnsweredWake[];
} {
  let state = initial;
  const woken: Waiter[] = [];
  // `pending`: waiters that became ready (all deps satisfied) and have NOT yet been
  // acknowledged by a `woke` event -- i.e. the ones still awaiting actuation. The woke
  // event is what makes the wake idempotent across polls + app restarts.
  const pending = new Map<string, Waiter>();
  // `answeredPending`: asking sessions the director has answered (#369) but that have not
  // yet acked with a `woke` — the ones still awaiting an auto-wake with the answer.
  const answeredPending = new Map<string, AnsweredWake>();
  for (const line of lines) {
    const ev = parseCoordLine(line);
    if (!ev) continue;
    if (ev.type === "woke") {
      pending.delete(ev.session);
      answeredPending.delete(ev.session);
      state = applyCoordEvent(state, ev).state;
      continue;
    }
    const r = applyCoordEvent(state, ev);
    state = r.state;
    for (const w of r.woken) {
      woken.push(w);
      pending.set(w.session, w);
    }
    for (const a of r.answered) answeredPending.set(a.session, a);
  }
  return { state, woken, ready: [...pending.values()], answered: [...answeredPending.values()] };
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

/**
 * Compose the wake prompt for a session that paused for the USER (#297 checkpoint/
 * confirm flow) — names the reason it paused and points at the checkpoint so the
 * fresh session resumes in context. Unlike {@link wakePromptFor}, there are no deps
 * to report; the user has decided to resume it.
 */
export function waitingWakePrompt(w: WaitingSession): string {
  const lines = [
    w.reason.trim()
      ? `You paused for confirmation: ${w.reason.trim()} — the user has resumed you; proceed.`
      : "You paused for the user — you have been resumed; proceed.",
  ];
  if (w.checkpoint) {
    lines.push(`Resume from your checkpoint: ${w.checkpoint} — read it first, then continue from where you left off.`);
  }
  return lines.join("\n");
}

/**
 * Compose the wake prompt for a session the DIRECTOR answered (#369). Carries the
 * director's answer and points at the checkpoint, so the fresh session resumes on that
 * basis without re-asking. This is what makes "defer to the director" a real round-trip.
 */
export function answerWakePrompt(a: AnsweredWake): string {
  const lines = [
    `The director answered your question: ${a.answer.trim() || "(see the director's notes)"} — proceed on that basis. Do not ask the user.`,
  ];
  if (a.checkpoint) {
    lines.push(`Resume from your checkpoint: ${a.checkpoint} — read it first, then continue.`);
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
}

/** Derive the inbox/health view from latch state: every still-parked waiter, each dep's
 *  status, and whether the chain is stalled (a failed dep). */
export function coordinationSummary(s: CoordState): BlockedView[] {
  return s.waiters.map((w) => {
    const deps = w.deps.map((d) => ({ ref: refKey(d), status: statusOf(s, d) }));
    return { session: w.session, checkpoint: w.checkpoint, deps, stalled: deps.some((d) => d.status === "failed") };
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
