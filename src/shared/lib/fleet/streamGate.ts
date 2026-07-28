// The dependency gate (#3931) — decide, from a fleet's `dependsOn` graph, which streams may START.
//
// #199 built a lost-wakeup-safe readiness model; #1039 removed its only producer (`bsc-blocked --on`),
// leaving half a circuit: workers still DECLARE COMPLETION, nothing declares DEPENDENCE. This reconnects
// it at LAUNCH rather than mid-task, which is what makes it compatible with #1039 — that issue's
// objection was that a PARKED worker is a worker not working, and nothing here ever parks a started
// session. A stream is simply not started until its upstreams have landed, and once started it never
// waits again.
//
// The launcher is also a better producer than the shell helper ever was: it reads `dependsOn` from
// plan.db, so dependence comes from the PLAN rather than from an agent remembering to run a command.
//
// ── What counts as "landed" ────────────────────────────────────────────────────────────────────────
// Measured on both live fleets before this was written, because the obvious answers are empty:
//
//   | signal                          | network-monitor | cli-typer |
//   |---------------------------------|-----------------|-----------|
//   | issues in plan.db               | 0               | 0         |
//   | coord-log events for the project| 0               | free-text refs, never `session:` |
//   | stream branches merged into HEAD| 38 / 38         | 3 / 10    |
//
// So an issue-keyed latch never satisfies, and a session latch is worse than useless — it HANGS: with
// zero coord events, `network-monitor` would start its 1 root stream and leave the other 37 dark
// forever. Branch-merge state is the signal that actually exists, so the rule is three tiers OR'd —
// each is independent positive evidence that the work is done, and requiring all three reproduces the
// hang this is meant to avoid:
//
//   1. ISSUES DONE   — owns issues and every one is complete/verified. Strongest; needs issues.
//   2. BRANCH MERGED — its branch is an ancestor of the clone's HEAD. The durable floor (#3931).
//   3. SESSION LATCH — a landed/merged/closed coord event on its session, or it is `maintaining`.
//
// Pure (no IO, no store) so the whole rule is exhaustively unit-testable; the callers probe the three
// signals and inject them.

/** The slice of a fleet stream this module reasons about. */
export interface GateStream {
  id: string;
  /** Upstream stream ids. Planning-time sequencing (#1039) — now also the launch gate. */
  dependsOn?: string[];
  /** Issue refs this stream owns. */
  issues?: string[];
}

/** The three landing signals, probed by the caller. */
export interface LandedEvidence {
  /** Issue refs that are `complete`/`verified` (see {@link doneIssueRefs}). */
  doneIssues: ReadonlySet<string>;
  /** Stream ids whose branch is merged into its clone's HEAD (`fleet_landed_streams`). */
  mergedBranches: ReadonlySet<string>;
  /** Stream ids whose SESSION reported done — a coord latch or the maintenance posture. */
  sessionDone: ReadonlySet<string>;
}

/** A stream held back by the gate, and what it is waiting for. */
export interface HeldStream {
  streamId: string;
  /** The unlanded upstreams it is waiting on. Empty only when `deadlocked`. */
  waitingOn: string[];
  /** True when the stream sits in a `dependsOn` CYCLE — it can never become ready on its own. */
  deadlocked: boolean;
}

export interface GatePartition {
  /** Every dep landed — start these now. */
  ready: GateStream[];
  /** Already landed — these relaunch into MAINTENANCE, not build. */
  landed: GateStream[];
  /** Not started; registered as waiters until their upstreams land. */
  held: HeldStream[];
}

/**
 * Which streams have LANDED — tier 1 OR tier 2 OR tier 3 (see the module header for why it is an OR).
 *
 * Tier 1 mirrors `streamComplete`: a stream must own at least one issue for its issue set to be
 * evidence — a stream with no issues has nothing to be "all done", so an empty `issues[]` is NOT
 * vacuous completion. Without that guard every stream on a 0-issue fleet would read as finished.
 */
export function landedStreams(streams: readonly GateStream[], ev: LandedEvidence): Set<string> {
  const out = new Set<string>();
  for (const s of streams) {
    const issues = s.issues ?? [];
    const byIssues = issues.length > 0 && issues.every((r) => ev.doneIssues.has(r));
    if (byIssues || ev.mergedBranches.has(s.id) || ev.sessionDone.has(s.id)) out.add(s.id);
  }
  return out;
}

/**
 * The stream ids that can never become ready because they sit in (or downstream of) a `dependsOn`
 * cycle among UNLANDED streams. A landed stream breaks a cycle — its dep edges no longer matter — so
 * the search runs over the unlanded subgraph only.
 *
 * Iterative Kahn peel rather than an SCC pass: repeatedly remove unlanded streams whose deps are all
 * satisfiable, and whatever cannot be peeled is either in a cycle or downstream of one. Both cases are
 * equally stuck and equally worth surfacing, so they are reported together (#3931 slice 4 renders them).
 */
export function deadlockedStreams(streams: readonly GateStream[], landed: ReadonlySet<string>): Set<string> {
  const unlanded = streams.filter((s) => !landed.has(s.id));
  const known = new Set(streams.map((s) => s.id));
  // Seed with everything already satisfiable: landed streams, plus any dep naming a stream that isn't
  // in this fleet at all (a dangling id can never land, but it also isn't a CYCLE — treating it as a
  // cycle would mislabel a plan typo as a deadlock, so it stays a plain unmet dep).
  const settled = new Set<string>(landed);
  let progressed = true;
  const remaining = new Map(unlanded.map((s) => [s.id, s.dependsOn ?? []]));
  while (progressed) {
    progressed = false;
    for (const [id, deps] of remaining) {
      // A dep outside the fleet is not resolvable here — it blocks, but it is not a cycle. Skip it
      // for the peel so it doesn't make its dependents look deadlocked.
      if (deps.every((d) => settled.has(d) || !known.has(d))) {
        settled.add(id);
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  return new Set(remaining.keys());
}

/**
 * Partition a fleet for launch: what starts now, what is already done, and what waits.
 *
 * Readiness does NOT cascade within one pass — a stream is ready only when every dep has actually
 * LANDED, never when a dep is merely *about to start*. That is the whole point of the gate: `B` waits
 * for `A` to finish, not for `A` to launch. Order is preserved within each bucket.
 */
export function partitionByDeps(streams: readonly GateStream[], ev: LandedEvidence): GatePartition {
  const landedIds = landedStreams(streams, ev);
  const deadlocked = deadlockedStreams(streams, landedIds);
  const ready: GateStream[] = [];
  const landed: GateStream[] = [];
  const held: HeldStream[] = [];
  for (const s of streams) {
    if (landedIds.has(s.id)) { landed.push(s); continue; }
    const waitingOn = (s.dependsOn ?? []).filter((d) => !landedIds.has(d));
    if (waitingOn.length === 0) { ready.push(s); continue; }
    held.push({ streamId: s.id, waitingOn, deadlocked: deadlocked.has(s.id) });
  }
  return { ready, landed, held };
}

/** A user-facing reason for why a stream is held — the string the Glance node overlay shows (#3931). */
export function heldReason(h: HeldStream): string {
  const list = h.waitingOn.join(", ");
  if (h.deadlocked) return `dependency cycle — cannot start (waiting on ${list})`;
  return h.waitingOn.length === 1
    ? `waiting on ${list} to land`
    : `waiting on ${h.waitingOn.length} upstreams to land (${list})`;
}
