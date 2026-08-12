// Per-worker issue progress, derived from the FLEET PLAN (#4102).
//
// ── WHY THIS EXISTS ALONGSIDE `streamProgress.ts` ────────────────────────────────────────────────
// #4050 derived progress entirely from plan.db's `issues` table: it partitioned `bsc plan list` by
// each issue's `stream` field. That is correct wherever those rows exist — and invisible wherever they
// do not. Measured on the live store (`plans/studio-code.db`): 40 `fleet_streams`, 40 `features`, and
// ZERO `issues`. So every stream got `total: 0`, and `GlanceNode`'s (correct) `total > 0` guard hid a
// bar it had no data for. The bars had simply never had an input.
//
// Ownership was not missing, only stored elsewhere: a stream carries its own work as GitHub refs in
// `AgentStream.issues` (`["#3898","#3979"]`) — 60 refs across 24 of the 40 streams. That is the
// authoritative ownership record, it is already in memory via the fleet plan, and it needs no network.
//
// ── THE SPLIT: OWNERSHIP IS LOCAL, DONE-NESS IS EVIDENCE ─────────────────────────────────────────
// So `total` comes from the plan (always available, always right) and `done` comes from whatever
// evidence exists that a ref is finished — plan.db statuses where rows were authored, GitHub
// open/closed otherwise. Unioning them means a project with a populated plan.db keeps working exactly
// as it did under #4050, while one without it stops rendering a permanently empty graph.
//
// Keeping `total` off plan.db is the actual fix. A denominator that silently drops to zero does not
// look broken — it looks like a fleet that owns no work.

import type { StreamProgress } from "./streamProgress";

/** The minimum shape this needs from a fleet stream — kept structural so the pure fn does not drag in
 *  the whole `AgentStream` (and so tests can state a stream in one line). */
export interface OwningStream {
  id: string;
  /** Issue refs this stream owns, e.g. `["#3898"]`. */
  issues: readonly string[];
}

/** Normalise a ref for comparison: `#3898`, `3898` and ` #3898 ` are the same issue.
 *
 *  Worth doing rather than trusting equality — the refs come from three places (the plan's stored
 *  strings, plan.db's `ref` column, GitHub's numeric `number`) and a formatting mismatch between any
 *  two would show as a bar stuck at 0/N, which is exactly the failure this file exists to end. */
export function normalizeRef(ref: string | number): string {
  return String(ref).trim().replace(/^#/, "");
}

/**
 * Every alias a plan.db issue answers to, so a stream's ref can be matched against ITS OWN namespace.
 *
 * `glance-progress-ref-namespace-split`. A stream's `issues` and plan.db's `ref` column are two separate
 * ownership records, and they do not always speak the same language. Measured across the two live
 * projects:
 *
 *   base-studio-code   22 stream refs, ALL 22 are plan.db slugs   -> 22/22 resolve
 *   studio-code        56 stream refs, ALL bare GitHub numbers    -> 0/56 resolve (plan.db is slugs,
 *                                                                    and carries no gh_number at all)
 *
 * A slug that carries its origin number (`4260-sandbox-by-default-…`) therefore also answers to `4260`,
 * which is the one join available without a schema change — `bsc plan list --full` does not project
 * `gh_number`, so the number embedded in the ref is the only GitHub identity reachable from here.
 */
export function knownRefAliases(issues: readonly { ref: string }[]): Set<string> {
  const out = new Set<string>();
  for (const i of issues) {
    const ref = normalizeRef(i.ref ?? "");
    if (!ref) continue;
    out.add(ref);
    const lead = /^(\d+)-/.exec(ref);
    if (lead) out.add(lead[1]);
  }
  return out;
}

/**
 * Per-stream `done / total` for a fleet.
 *
 * `total` is what the stream OWNS. `done` counts its refs present in `doneRefs` — so a ref that is
 * done but owned by nobody cannot inflate anyone's progress, and a stream owning nothing yields
 * `total: 0`, which the node renders as NO bar (deliberately: an empty bar and a zero-progress bar
 * say different things, and only one of them is true).
 *
 * Pure. `doneRefs` may hold refs in either form; both sides are normalised.
 */
export function fleetPlanProgress(
  streams: readonly OwningStream[],
  doneRefs: ReadonlySet<string>,
  /** When set, ALSO emit this node id carrying the union of EVERY stream's refs (#4122).
   *
   *  The director is not a stream — it owns no lane — so a per-stream map leaves its node with no
   *  progress at all. But it is the one agent responsible for the whole board, so its bar is the
   *  project's: every issue any worker owns, de-duplicated, because two streams naming one ref is one
   *  piece of work and double-counting would make the director's denominator disagree with the sum of
   *  its workers'. */
  aggregateId?: string,
  /** The refs plan.db actually knows ({@link knownRefAliases}). When given, a stream whose refs are ALL
   *  unknown emits NO entry, so `mergeStreamProgress` lets plan.db answer instead.
   *
   *  `glance-progress-ref-namespace-split`: without this, a ref path that can never resolve still won,
   *  because winning only required `total > 0`. On `studio-code` every one of the 56 stream refs is a
   *  GitHub number this plan.db has no row for, so all 24 owning streams rendered `0/N` — and
   *  `design-studio`, which plan.db knows to be 8/8 DONE, rendered `0/15`. A denominator with no
   *  reachable numerator is not evidence; it is the absence of evidence wearing evidence's clothes.
   *
   *  Omitted ⇒ every stream emits, exactly as before (the pre-existing callers and tests are unchanged). */
  knownRefs?: ReadonlySet<string>,
): Map<string, StreamProgress> {
  const done = new Set<string>();
  for (const r of doneRefs) done.add(normalizeRef(r));
  const resolves = (r: string) => !knownRefs || knownRefs.has(r);

  const out = new Map<string, StreamProgress>();
  for (const s of streams) {
    // De-duplicate within a stream: a ref listed twice would push `done` past `total` and render a bar
    // over 100%. `progressFraction` clamps the fill, but the "3/2" label beside it would still be wrong.
    const refs = new Set(s.issues.map(normalizeRef));
    // Only a stream that owns refs AND resolves NONE of them stands aside. A stream owning NOTHING must
    // still emit `{0,0}` — that is the documented contract (`mergeStreamProgress` reads `total === 0` as
    // "owns no refs, let plan.db answer", and the node renders no bar). Skipping it here instead made
    // `fleetPlanProgress`'s own tests fail on `expected undefined`, which is the distinction: "owns
    // nothing" and "owns things I cannot resolve" reach the same UI, but only one of them is a fact
    // about the stream rather than about my ability to look it up.
    if (refs.size > 0 && ![...refs].some(resolves)) continue;
    let d = 0;
    for (const r of refs) if (done.has(r)) d += 1;
    out.set(s.id, { done: d, total: refs.size });
  }

  if (aggregateId) {
    // Union across streams, then count — NOT a sum of the per-stream rows, which would double-count a
    // ref two streams both claim.
    const all = new Set<string>();
    for (const s of streams) for (const r of s.issues) all.add(normalizeRef(r));
    // Same rule as a stream: an aggregate over refs that resolve to nothing is the director's `0/56`.
    if ([...all].some(resolves)) {
      let d = 0;
      for (const r of all) if (done.has(r)) d += 1;
      out.set(aggregateId, { done: d, total: all.size });
    }
  }
  return out;
}

/**
 * Combine the ref-derived progress with plan.db's own, per stream.
 *
 * A stream that owns refs uses the ref-derived numbers — that is the fix, and its denominator cannot
 * silently collapse to zero. A stream that owns NONE falls back to plan.db's entry, which preserves
 * #4050 exactly where it already worked: a project whose planner run authored issue rows carrying a
 * `stream` field, but whose stream records never listed the refs, still shows the bar it showed before.
 *
 * Neither source is dropped, so this cannot regress a project that was working.
 */
export function mergeStreamProgress(
  fromRefs: ReadonlyMap<string, StreamProgress>,
  fromPlanDb: ReadonlyMap<string, StreamProgress>,
): Map<string, StreamProgress> {
  const out = new Map<string, StreamProgress>(fromPlanDb);
  for (const [id, p] of fromRefs) {
    // `total === 0` means "owns no refs", which is not evidence of anything — let plan.db answer.
    if (p.total > 0) out.set(id, p);
  }
  return out;
}

/**
 * Union the done-evidence sources into the set `fleetPlanProgress` consumes.
 *
 * Both are partial and neither is authoritative alone: plan.db knows only what a planner run authored
 * (nothing, for a hand-assembled fleet), and GitHub knows only what a token could reach (nothing, when
 * disconnected). A ref that either source calls finished IS finished — treating one as authoritative
 * would make progress vanish the moment that source is the empty one, which is the bug being fixed.
 */
export function unionDone(...sources: ReadonlyArray<Iterable<string> | undefined>): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const r of src) out.add(normalizeRef(r));
  }
  return out;
}
