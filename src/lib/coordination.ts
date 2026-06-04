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
  /** Sessions paused for the user (#297 checkpoint/confirm flow) — woken manually. */
  waiting: WaitingSession[];
  /** Sessions that asked the DIRECTOR a question (#369) — woken when it answers. */
  asking: AskingSession[];
  /** New work the ISSUER captured (#376), pending the director's routing decision. */
  issues: PendingIssue[];
}

/** A shaped issue the issuer captured, awaiting the director's `bsc-assign` (#376). The
 *  issuer does intake only; the director picks the owning worker by `owns`/stream. */
export interface PendingIssue {
  /** Stable key — the wire id, else `<session>@<at>`. Dedupes + lets `assign` clear it. */
  id: string;
  /** The issuer session that captured it. */
  session: string;
  /** Well-formed issue title. */
  title: string;
  /** Issue body (acceptance criteria, etc.); may be empty. */
  body?: string;
  /** The issuer's suggested repo or stream, from the plan (the director may override). */
  suggested?: string;
  /** When captured (ms epoch). */
  at: number;
}

/** A pending injection produced when the director assigns an issue to a worker (#376).
 *  Carries the issue into the target worker's fresh session, like {@link AnsweredWake}. */
export interface AssignedWork {
  /** The target worker session/pane id. */
  session: string;
  /** The issue title (when known). */
  title?: string;
  /** The issue body / instructions to start on. */
  body: string;
  /** Resume seed, if the target was parked with one. */
  checkpoint?: string;
  /** When assigned (ms epoch). */
  at: number;
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
  return { latches: {}, waiters: [], waiting: [], asking: [], issues: [] };
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
    waiting: s.waiting,
    asking: s.asking,
    issues: s.issues,
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
  const probe: CoordState = { latches, waiters: s.waiters, waiting: s.waiting, asking: s.asking, issues: s.issues };
  const woken = s.waiters.filter((w) => isReady(probe, w));
  const wokenIds = new Set(woken.map((w) => w.session));
  return { state: { latches, waiters: s.waiters.filter((w) => !wokenIds.has(w.session)), waiting: s.waiting, asking: s.asking, issues: s.issues }, woken };
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
  const next: CoordState = { latches, waiters: s.waiters, waiting: s.waiting, asking: s.asking, issues: s.issues };
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
  | { type: "answer"; target: string; answer: string; at: number }
  // Issuer flow (#376): the issuer captures new work; the director routes it to a worker.
  | { type: "issue"; session: string; id: string; title: string; body?: string; suggested?: string; at: number }
  | { type: "assign"; session: string; target: string; body: string; issueId?: string; title?: string; at: number }
  // Verification jury (#394): a juror reports a structured verdict on a landing; the
  // foreman tallies them and, on reject, drives the existing revert+ping reflex.
  | { type: "verdict"; juror: string; target: string; verdict: JuryVerdict; reason?: string; relevant?: boolean; at: number };

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
    case "issue": {
      // payload = <title> \t <body?> \t <suggested?> \t <id?>
      const title = (rest[0] ?? "").trim();
      if (!title) return null;
      const id = rest[3]?.trim() || `${session}@${at}`;
      return { type: "issue", session, id, title, body: rest[1]?.trim() || undefined, suggested: rest[2]?.trim() || undefined, at };
    }
    case "assign": {
      // payload = <target> \t <body> \t <issueId?> \t <title?>
      const target = (rest[0] ?? "").trim();
      if (!target) return null;
      return { type: "assign", session, target, body: rest[1] ?? "", issueId: rest[2]?.trim() || undefined, title: rest[3]?.trim() || undefined, at };
    }
    case "verdict": {
      // payload = <target> \t <pass|reject> \t <reason?> \t <relevant?>; the juror is the session column.
      const target = (rest[0] ?? "").trim();
      const v = (rest[1] ?? "").trim().toLowerCase();
      if (!target || (v !== "pass" && v !== "reject")) return null;
      const relevant = rest[3] === undefined ? undefined : rest[3].trim() !== "false" && rest[3].trim() !== "0";
      return { type: "verdict", juror: session, target, verdict: v, reason: rest[2]?.trim() || undefined, relevant, at };
    }
    case "woke":
      return { type: "woke", session, at };
    default:
      return null;
  }
}

/** Fold one event into the latch state, returning what it triggered. */
export function applyCoordEvent(s: CoordState, e: CoordEvent): {
  state: CoordState; woken: Waiter[]; ready: boolean; stalled: Waiter[]; answered: AnsweredWake[]; assigned: AssignedWork[];
} {
  switch (e.type) {
    case "blocked": {
      const r = registerWaiter(s, { session: e.session, deps: e.deps, checkpoint: e.checkpoint, registeredAt: e.at });
      // A session that now declares a real dependency leaves the manual-wait list.
      const state = { ...r.state, waiting: r.state.waiting.filter((w) => w.session !== e.session) };
      return { state, woken: [], ready: r.ready, stalled: [], answered: [], assigned: [] };
    }
    case "waiting": {
      const waiting = [
        ...s.waiting.filter((w) => w.session !== e.session),
        { session: e.session, reason: e.reason, checkpoint: e.checkpoint, at: e.at },
      ];
      return { state: { ...s, waiting }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "landed":
    case "merged":
    case "closed": {
      const r = satisfy(s, e.ref, e.type, e.at);
      return { state: r.state, woken: r.woken, ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "failed": {
      const r = fail(s, e.ref, e.reason, e.at);
      return { state: r.state, woken: [], ready: false, stalled: r.stalled, answered: [], assigned: [] };
    }
    case "woke": {
      return { state: { latches: s.latches, waiters: s.waiters.filter((w) => w.session !== e.session), waiting: s.waiting.filter((w) => w.session !== e.session), asking: s.asking.filter((a) => a.session !== e.session), issues: s.issues }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "ask": {
      const asking = [
        ...s.asking.filter((a) => a.session !== e.session),
        { session: e.session, question: e.question, checkpoint: e.checkpoint, at: e.at },
      ];
      // Asking the director supersedes any prior user-wait registration for this session.
      const waiting = s.waiting.filter((w) => w.session !== e.session);
      return { state: { ...s, asking, waiting }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "answer": {
      // The director is addressing a specific worker — resume it whatever its park (an
      // ask, a dependency block, or a user-wait) and deliver the directive (#376). bsc-answer
      // is the director's universal "unblock + tell this worker" command, not just for asks.
      const ask = s.asking.find((a) => a.session === e.target);
      const waiter = s.waiters.find((w) => w.session === e.target);
      const waitS = s.waiting.find((w) => w.session === e.target);
      const checkpoint = ask?.checkpoint ?? waitS?.checkpoint ?? waiter?.checkpoint;
      const answered: AnsweredWake[] = [{ session: e.target, answer: e.answer, checkpoint, at: e.at }];
      return {
        state: {
          ...s,
          asking: s.asking.filter((a) => a.session !== e.target),
          waiters: s.waiters.filter((w) => w.session !== e.target),
          waiting: s.waiting.filter((w) => w.session !== e.target),
        },
        woken: [], ready: false, stalled: [], answered, assigned: [],
      };
    }
    case "issue": {
      // The issuer captured new work — append it to the director's pending-issue
      // intake list (dedup by id so a replayed log doesn't double it).
      const issues = [
        ...s.issues.filter((i) => i.id !== e.id),
        { id: e.id, session: e.session, title: e.title, body: e.body, suggested: e.suggested, at: e.at },
      ];
      return { state: { ...s, issues }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "assign": {
      // The director routed an issue to a worker — resume that worker whatever its
      // park and inject the issue, and clear the matching pending issue from intake.
      const waiter = s.waiters.find((w) => w.session === e.target);
      const waitS = s.waiting.find((w) => w.session === e.target);
      const ask = s.asking.find((a) => a.session === e.target);
      const checkpoint = ask?.checkpoint ?? waitS?.checkpoint ?? waiter?.checkpoint;
      const assigned: AssignedWork[] = [{ session: e.target, title: e.title, body: e.body, checkpoint, at: e.at }];
      return {
        state: {
          ...s,
          asking: s.asking.filter((a) => a.session !== e.target),
          waiters: s.waiters.filter((w) => w.session !== e.target),
          waiting: s.waiting.filter((w) => w.session !== e.target),
          issues: e.issueId ? s.issues.filter((i) => i.id !== e.issueId) : s.issues,
        },
        woken: [], ready: false, stalled: [], answered: [], assigned,
      };
    }
    case "verdict":
      // Verdicts don't move the latch/waiter state — the foreman tallies them off the
      // log (see {@link tallyVerdicts} / {@link planJuryAction}) and emits the revert
      // (a `failed` event) when the panel rejects. So this fold is a no-op.
      return { state: s, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
  }
}

/**
 * Replay a whole `$BSC_COORD_LOG` (oldest-first) into latch state, collecting the waiters
 * still awaiting wake in `ready` (became ready, no `woke` ack yet) -- the coordinator's
 * rebuild-from-disk. Unparseable lines are skipped.
 */
export function ingestCoordLog(lines: string[], initial: CoordState = emptyCoordState()): {
  state: CoordState; woken: Waiter[]; ready: Waiter[]; answered: AnsweredWake[]; assigned: AssignedWork[];
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
  // `assignedPending`: workers the director assigned new work (#376), awaiting injection.
  const assignedPending = new Map<string, AssignedWork>();
  for (const line of lines) {
    const ev = parseCoordLine(line);
    if (!ev) continue;
    if (ev.type === "woke") {
      pending.delete(ev.session);
      answeredPending.delete(ev.session);
      assignedPending.delete(ev.session);
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
    for (const a of r.assigned) assignedPending.set(a.session, a);
  }
  return {
    state, woken, ready: [...pending.values()],
    answered: [...answeredPending.values()], assigned: [...assignedPending.values()],
  };
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
    `The director responded: ${a.answer.trim() || "(see the director's notes)"} — proceed on that basis; you are no longer parked. Do not ask the user.`,
  ];
  if (a.checkpoint) {
    lines.push(`Resume from your checkpoint: ${a.checkpoint} — read it first, then continue.`);
  }
  return lines.join("\n");
}

/**
 * Compose the injection prompt for a worker the director assigned new work (#376).
 * States it is new work routed by the director, carries the title + body, and points
 * at the checkpoint so a resumed worker re-grounds before starting. The worker then
 * flows into its normal implement → integrate loop.
 */
export function assignWakePrompt(a: AssignedWork): string {
  const lines = [
    `The director assigned you new work${a.title ? `: ${a.title}` : ""}. Start on it now and carry it through your normal loop (implement → gate → integrate). Do not ask the user.`,
  ];
  if (a.body.trim()) lines.push("", a.body.trim());
  if (a.checkpoint) {
    lines.push("", `First re-read your checkpoint: ${a.checkpoint}, then begin the new work.`);
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

// -- Predicate-based readiness (#199 / #365) ------------------------------------
// PR-merged / issue-closed have an authoritative emitter (the director), so they arrive
// as explicit satisfy events. A `predicate:` dep does NOT -- "the symbol exists", "the
// stub is implemented", "tests pass" has no one to emit it, so the coordinator POLLS it:
// the host evaluates the predicate against the repo and, when it holds, the latch is set
// (the third satisfy path). Kept pure -- the actual repo-checking lives in the injected
// `evaluate`, so the readiness logic stays exhaustively unit-testable.

/** A parsed `predicate:` expression -- the readiness checks the host evaluates against
 *  the repo. The inner expr (after the `predicate:` prefix) carries an optional kind
 *  prefix: `tests-pass`, `symbol:<Name>`, `file-exists:<path>`, `stub:<name>`; anything
 *  else is a `custom` expr the host interprets. Lets the evaluator dispatch on kind. */
export type Predicate =
  | { kind: "tests-pass" }
  | { kind: "symbol"; name: string }       // symbol:TunnelState -- a symbol exists in the tree
  | { kind: "file-exists"; path: string }  // file-exists:src/lib/x.ts
  | { kind: "stub"; name: string }         // stub:handleFoo -- a stub/impl landed
  | { kind: "custom"; expr: string };      // anything else -- host-defined

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

/** Evaluates whether a predicate expression currently holds against the repo. Injected by
 *  the runtime (the host runs the actual check); pure here so it's testable. Returns
 *  `true` (holds -> satisfy), `false` (does not hold), or `undefined` (not yet evaluable
 *  -- left pending, retried on the next poll). The arg is the predicate's inner expr (the
 *  part after `predicate:`) -- feed it through {@link parsePredicate} to dispatch on kind. */
export type PredicateEvaluator = (expr: string) => boolean | undefined;

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

// -- Mobile-push notifications (#199 AC#5 / #366) -------------------------------
// The coordinator must reach the human/director on their phone when a chain needs
// attention -- a dep just LANDED (a parked session is wakeable) or a chain is STUCK
// (a failed dep, or a wait-for deadlock no producer will ever clear). Delivery rides
// the existing tunnel `user_request` -> FCM path (a parked pane flipped to
// awaiting_input with this summary as its prompt; see useCoordinator). Kept pure here
// -- "which sessions alert, with what message" -- so the escalation logic is testable
// without the tunnel. One notification per session, most-severe-wins:
// deadlocked > stalled (both are "stuck"); `ready` comes from a disjoint set (the
// newly-woken waiters, which are no longer parked) so it never collides.

export type CoordNotificationKind = "ready" | "stalled" | "deadlocked";

/** A push-worthy coordination event for one session: what happened and a mobile-facing
 *  one-liner. `refs` are the involved dep keys (for the inbox / notification body). */
export interface CoordNotification {
  kind: CoordNotificationKind;
  /** The parked/woken session (pane id) the notification is about. */
  session: string;
  /** A short human/mobile-facing summary -- used as the `user_request` prompt. */
  summary: string;
  /** The dep keys involved (landed deps for `ready`; the stuck deps otherwise). */
  refs: string[];
  /** A stable de-dupe key (`<kind>:<session>`) so a poll loop fires each alert once. */
  key: string;
}

function notificationSummary(kind: CoordNotificationKind, session: string, refs: string[]): string {
  const list = refs.join(", ");
  switch (kind) {
    case "ready":
      return `${session}: ${refs.length === 1 ? "dependency" : "dependencies"} landed (${list}) -- ready to resume.`;
    case "stalled":
      return `${session}: blocked chain stalled -- a dependency failed (${list}). Needs attention.`;
    case "deadlocked":
      return `${session}: wait-for deadlock (${list}) -- no producer can clear it. Needs the director.`;
  }
}

/**
 * Derive the push notifications for the current coordinator state (#366): the newly-ready
 * waiters (their gating deps just landed -- wakeable) plus every still-parked waiter whose
 * chain is STUCK -- a failed dep (stalled) or a wait-for cycle (deadlocked). One
 * notification per session, deadlocked taking precedence over stalled (the more severe
 * "no producer will ever clear it"). `ready` is the disjoint list of waiters that just
 * became ready (e.g. {@link ingestCoordLog}'s `ready`, or a satisfy/predicate event's
 * `woken`) -- they're already removed from `s.waiters`, so the ready set and the
 * stuck set never overlap. Pure + deterministic (no IO); the tunnel delivery is a thin
 * layer on top in useCoordinator. `producerOf` resolves deadlock edges (see
 * {@link detectDeadlocks}; defaults to the `session:` self-resolver).
 */
export function coordNotifications(
  s: CoordState,
  ready: Waiter[] = [],
  producerOf: ProducerOf = defaultProducerOf,
): CoordNotification[] {
  const out: CoordNotification[] = [];
  for (const w of ready) {
    const refs = w.deps.map(refKey);
    out.push({ kind: "ready", session: w.session, refs, summary: notificationSummary("ready", w.session, refs), key: `ready:${w.session}` });
  }
  const deadlocked = new Set(detectDeadlocks(s, producerOf).flatMap((d) => d.cycle));
  for (const w of s.waiters) {
    if (deadlocked.has(w.session)) {
      const refs = w.deps.filter((d) => !isSatisfied(s, d)).map(refKey);
      out.push({ kind: "deadlocked", session: w.session, refs, summary: notificationSummary("deadlocked", w.session, refs), key: `deadlocked:${w.session}` });
      continue; // deadlocked outranks stalled -- one notification per session
    }
    const failedRefs = w.deps.filter((d) => s.latches[refKey(d)]?.state === "failed").map(refKey);
    if (failedRefs.length > 0) {
      out.push({ kind: "stalled", session: w.session, refs: failedRefs, summary: notificationSummary("stalled", w.session, failedRefs), key: `stalled:${w.session}` });
    }
  }
  return out;
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

// -- Verification jury (#394) ----------------------------------------------------
// The jury is the watchdog's BRAIN, not a new gate. Under self-merge a worker writes
// the code AND its tests and merges on a green gate -- which proves internal
// consistency, not correctness. The jury reviews POST-merge and async: each juror
// judges the landing from a DIFFERENT anchor than the worker used (acceptance
// criteria / lens / subsystem slice), so their errors are uncorrelated; a reject
// drives the SAME revert+ping reflex the watchdog already runs (#382), with the
// juror's reason as a fix-forward instruction. Pure + testable; the foreman/strategy
// wiring lands on top.

/** Cheap, risk-triage signals about a landing — decide fast-path vs convene a panel. */
export interface LandingSignals {
  /** The change touched a shared / contract file (high blast radius). */
  touchesSharedOrContract?: boolean;
  /** The change touched a security-sensitive path. */
  securitySensitive?: boolean;
  /** A region that was reverted before (repeat-offender). */
  revertedBefore?: boolean;
  /** Lines changed in the diff. */
  diffLines?: number;
  /** Coverage delta (negative = a drop). */
  coverageDelta?: number;
}

export type TriageDecision = "fast-path" | "panel";

/** Risk-triage thresholds (overridable). */
export interface TriageConfig {
  /** Diffs at/above this many lines convene a panel. */
  maxDiffLines: number;
  /** Coverage drops at/below this delta convene a panel. */
  minCoverageDelta: number;
}

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = { maxDiffLines: 150, minCoverageDelta: -1 };

/**
 * Risk-triage a landing: a cheap signal decides whether the full jury convenes or the
 * change takes the fast-path (no panel). Any high-risk signal — a shared/contract file,
 * a security path, a repeat-offender region, a large diff, or a coverage drop — forces a
 * panel; otherwise fast-path. Like risk-based testing: spend the panel where it pays.
 */
export function triageLanding(sig: LandingSignals, cfg: TriageConfig = DEFAULT_TRIAGE_CONFIG): TriageDecision {
  if (sig.touchesSharedOrContract || sig.securitySensitive || sig.revertedBefore) return "panel";
  if ((sig.diffLines ?? 0) >= cfg.maxDiffLines) return "panel";
  if (sig.coverageDelta !== undefined && sig.coverageDelta <= cfg.minCoverageDelta) return "panel";
  return "fast-path";
}

export type JuryVerdict = "pass" | "reject";

/** One juror's structured verdict on a landing. `relevant` (default true) marks whether
 *  the change touches this juror's slice — used by the quorum rule. */
export interface JurorVerdict {
  juror: string;
  verdict: JuryVerdict;
  reason?: string;
  location?: string;
  relevant?: boolean;
}

/** How the foreman tallies the panel. veto: any reject fails. majority: >half reject.
 *  quorum: only jurors whose slice the change touches vote, majority of those. */
export type AggregationRule = "veto" | "majority" | "quorum";

/** Strictness when a juror is uncertain. pass-unless-concrete (default for a merge gate):
 *  only a reject WITH a concrete reason counts — keeps the fleet flowing. reject-on-doubt:
 *  every reject counts (safety over speed; for bug-hunts). */
export type JuryStrictness = "pass-unless-concrete" | "reject-on-doubt";

export interface JuryAggregate {
  verdict: JuryVerdict;
  /** The jurors whose rejection counted toward the outcome. */
  rejecters: string[];
  /** The first counted rejecter's reason — the fix-forward instruction. */
  reason?: string;
}

/**
 * Aggregate a panel's verdicts into one outcome, robust to noisy jurors. Under the
 * default `pass-unless-concrete` strictness a reject only counts if it carries a reason,
 * so a juror that rejects on vague doubt can't sink a landing. The `quorum` rule first
 * restricts to jurors whose slice the change touches (`relevant !== false`), so an
 * off-slice juror's noise is ignored entirely.
 */
export function aggregateVerdicts(
  verdicts: JurorVerdict[],
  rule: AggregationRule,
  strictness: JuryStrictness = "pass-unless-concrete",
): JuryAggregate {
  const counts = (v: JurorVerdict) =>
    v.verdict === "reject" && (strictness === "reject-on-doubt" || !!v.reason?.trim());
  const panel = rule === "quorum" ? verdicts.filter((v) => v.relevant !== false) : verdicts;
  const rejects = panel.filter(counts);
  const reject =
    rule === "veto"
      ? rejects.length > 0
      : rejects.length * 2 > panel.length; // strict majority (of the relevant panel for quorum)
  return {
    verdict: reject ? "reject" : "pass",
    rejecters: reject ? rejects.map((v) => v.juror) : [],
    reason: reject ? rejects.find((v) => v.reason?.trim())?.reason : undefined,
  };
}

/** Fold verdict events into per-landing tallies (keyed by the verdict `target`). A juror's
 *  latest verdict on a target replaces an earlier one. Non-verdict events are ignored. */
export function tallyVerdicts(events: CoordEvent[]): Map<string, JurorVerdict[]> {
  const byTarget = new Map<string, Map<string, JurorVerdict>>();
  for (const e of events) {
    if (e.type !== "verdict") continue;
    const jurors = byTarget.get(e.target) ?? new Map<string, JurorVerdict>();
    jurors.set(e.juror, { juror: e.juror, verdict: e.verdict, reason: e.reason, relevant: e.relevant });
    byTarget.set(e.target, jurors);
  }
  const out = new Map<string, JurorVerdict[]>();
  for (const [target, jurors] of byTarget) out.set(target, [...jurors.values()]);
  return out;
}

/** What the foreman does with a tallied landing: pass, or revert + ping the owner. The
 *  `ref` is the landing parsed as a coord ref (an issue #, a `session:` id, …), ready to
 *  feed into {@link fail} — the SAME revert reflex the watchdog runs (#382). */
export interface JuryAction {
  target: string;
  action: "pass" | "revert";
  ref: CoordRef | null;
  /** The fix-forward reason (a counted rejecter's reason), present on a revert. */
  reason?: string;
  /** The owner-facing ping message, present on a revert. */
  ping?: string;
}

/** Compose the owner-facing ping for a rejected landing — the fix-forward instruction. */
export function juryPingMessage(target: string, reason: string | undefined): string {
  return `The verification jury rejected ${target}: ${reason?.trim() || "see the jurors' notes"}. It was reverted — fix forward and re-land.`;
}

/**
 * Decide the foreman's action for a landing from its panel: aggregate the verdicts and,
 * on reject, produce a revert targeting the landing ref plus an owner ping carrying the
 * reason. On pass, no action. This is the reject→revert+ping wiring in pure form — the
 * caller feeds `ref` into {@link fail} and delivers `ping` via the existing notification
 * path.
 */
export function planJuryAction(
  target: string,
  verdicts: JurorVerdict[],
  rule: AggregationRule,
  strictness: JuryStrictness = "pass-unless-concrete",
): JuryAction {
  const agg = aggregateVerdicts(verdicts, rule, strictness);
  if (agg.verdict === "pass") return { target, action: "pass", ref: parseRef(target) };
  return {
    target,
    action: "revert",
    ref: parseRef(target),
    reason: agg.reason,
    ping: juryPingMessage(target, agg.reason),
  };
}
