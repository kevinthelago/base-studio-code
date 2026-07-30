// Inter-session coordination types (#199 / #1633): the type/interface declarations for the
// lost-wakeup-safe readiness model. Split out of `coordination.ts` so the data shapes live
// apart from the pure runtime logic. `coordination.ts` re-exports everything here, so the
// public import surface (`@/shared/lib/fleet/coordination`) is unchanged.

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
  /** Workers in MAINTENANCE (#1957): they finished every owned issue and parked alive + ready
   *  instead of ending — the director routes new/regressed lane work to them via `bsc-assign`.
   *  Cleared when the worker is dispatched (assign/answer) or resumes (woke). */
  maintaining: MaintainingSession[];
  /** Mid-build plan updates the PLANNER pushed to a running director/issuer (#2377) — the
   *  planner's runtime voice into the fleet, beyond the one-shot kickoff/plan.db handoff.
   *  Appended (never auto-cleared); the director reconciles the plan and routes any carried
   *  `ref` onward via `bsc-assign`. */
  briefs: ReceivedBrief[];
  /** Open commissions in the studio network (#2940): a studio session (planner/designer) asked
   *  another (designer/librarian) to author an artifact. The pump routes each to the target studio
   *  session; a matching `deliver` sets `delivered` (the authored artifact's id) so the pump can
   *  surface the result back to the requester. Appended + dedup by id; never auto-removed (the
   *  surfacing is guarded once-per-commission by the pump, like {@link ReceivedBrief}). */
  commissions: OpenCommission[];
  /** OPEN project change-requests (#4000/#4001): a worker asked the DIRECTOR for something outside
   *  its own worktree — an integration branch that does not exist, a kickoff path that is wrong. The
   *  pump surfaces each to the director once; a matching `request-resolved` removes it, so unlike
   *  {@link ReceivedBrief} this list genuinely empties. The durable record lives in the project's
   *  plan.db (`bsc plan request`); this is only the delivery signal. */
  requests: OpenRequest[];
}

/** A worker→director change request awaiting an answer (#4001). The `cmd` grounding is what makes it
 *  actionable without a conversation: the exact command that failed. */
export interface OpenRequest {
  /** The plan.db row id — how the director resolves it (`bsc plan request resolve <id>`). */
  id: string;
  /** The requesting SESSION — the emitting pane id, from the coord line's session column. NOT the
   *  plan.db row's `from`, which records the STREAM (`$BSC_STREAM`). Both identify the same worker;
   *  the pane id is the more useful one here because it is what the director would `bsc-answer`. */
  from: string;
  /** What is being asked for. */
  text: string;
  /** When it was filed (epoch ms), for the surfaced-once key. */
  at: number;
}

/** A structured plan update the planner streamed to a running director/issuer (#2377). The
 *  planner is plan-only, so a brief is a COORDINATION write (append to `coord.log`), never a
 *  code/git write — the first runtime consumer of the planner→{director,issuer} org edge.
 *  Modelled like {@link PendingIssue}/{@link AssignedWork}. */
export interface ReceivedBrief {
  /** Stable key (`<from>@<at>`) — dedupes a replayed log + keys the surfaced-once guard. */
  id: string;
  /** The originating session (the planner's pane id / "planner"). */
  from: string;
  /** The intended audience — `"director"`, `"issuer"`, or a specific session id. */
  target: string;
  /** The brief prose (a plan change, added scope, a re-sequencing directive). */
  body: string;
  /** Optional structured ref the director can act on onward (a new/updated `#issue`,
   *  a `contract:`, a `file:`) — e.g. route it to the owning worker via `bsc-assign`. */
  ref?: CoordRef;
  /** When pushed (ms epoch). */
  at: number;
}

/** A commission in the studio-session network (#2940): a studio session asked another to author an
 *  artifact into its own store (designer → a `bsc ui` component; librarian → a `bsc graph` impl).
 *  Modelled like {@link ReceivedBrief}; a `deliver` correlates back by {@link id} and sets
 *  {@link delivered}. */
export interface OpenCommission {
  /** Stable key (`<from>@<at>`) — the id a `deliver` references to resolve + route the result back. */
  id: string;
  /** The requesting studio session (the emitter's pane id, e.g. the planner or designer pane). */
  from: string;
  /** The target studio — `"designer"` | `"librarian"` (or a specific session id). */
  target: string;
  /** What to author (the spec / need). */
  body: string;
  /** Optional structured ref the requester carried (a `#issue`, a `file:`, a `contract:`). */
  ref?: CoordRef;
  /** When commissioned (ms epoch). */
  at: number;
  /** Set once a matching `deliver` arrives: the authored artifact's id (component id / impl id). */
  delivered?: string;
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

/** A worker in MAINTENANCE (#1957): it finished every owned issue and, instead of ending, parked
 *  alive in a ready posture. Unlike a user-wait it needs no human action — it idles cheaply until
 *  the director dispatches new lane work (`bsc-assign`) or a regression wakes it. */
export interface MaintainingSession {
  session: string;
  /** The standing note (the `bsc-maintain` message), e.g. "owned issues complete — standing by". */
  note: string;
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
  // Maintenance mode (#1957): a finished worker parks alive + ready instead of ending.
  | { type: "maintain"; session: string; note?: string; at: number }
  // Planner brief (#2377): the planner streams a mid-build plan update to a director/issuer.
  // #4001 — the worker→director request lane. Both ends are events because the pump derives its
  // pending set from the LOG: `request` opens one, `request-resolved` closes it.
  | { type: "request"; session: string; id: string; text: string; at: number }
  | { type: "request-resolved"; id: string; at: number }
  | { type: "brief"; from: string; target: string; body: string; ref?: CoordRef; id: string; at: number }
  // Studio network (#2940): a studio session commissions another to author an artifact; the target
  // delivers its id back. `commission` mirrors `brief`; `deliver` correlates by the commission id.
  | { type: "commission"; from: string; target: string; body: string; ref?: CoordRef; id: string; at: number }
  | { type: "deliver"; commissionId: string; artifactId: string; from: string; at: number }
  // Verification jury (#394): a juror reports a structured verdict on a landing; the
  // foreman tallies them and, on reject, drives the existing revert+ping reflex.
  | { type: "verdict"; juror: string; target: string; verdict: JuryVerdict; reason?: string; relevant?: boolean; at: number };

export interface WakeAction {
  /** The parked session/pane to relaunch. */
  session: string;
  /** The token-aware wake prompt seeded into the fresh session. */
  prompt: string;
  /** The deps that gated this waiter (now all satisfied). */
  deps: CoordRef[];
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

/** Evaluates whether a predicate expression currently holds against the repo. Injected by
 *  the runtime (the host runs the actual check); pure here so it's testable. Returns
 *  `true` (holds -> satisfy), `false` (does not hold), or `undefined` (not yet evaluable
 *  -- left pending, retried on the next poll). The arg is the predicate's inner expr (the
 *  part after `predicate:`) -- feed it through {@link parsePredicate} to dispatch on kind. */
export type PredicateEvaluator = (expr: string) => boolean | undefined;

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

/** Resolves which session is expected to satisfy a dep ref, or undefined if unknown. */
export type ProducerOf = (ref: CoordRef) => string | undefined;

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

/** A detected wait-for cycle: the parked sessions that mutually block, in ring order.
 *  A single-element cycle is a session waiting (transitively) on its own output. */
export interface Deadlock {
  cycle: string[];
}

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
