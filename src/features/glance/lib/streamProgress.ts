// Per-stream issue progress (#4050) — how far through its owned work each fleet worker is.
//
// ── WHY ISSUES, AND NOT "PROGRESS THROUGH THE CURRENT ISSUE" ─────────────────────────────────────
// Because `done / owned` is a FACT. An agent does not emit a percentage-complete, so a bar measuring
// progress within a task would be an estimate dressed as a measurement — and a confidently wrong one,
// which is worse than no bar at all.
//
// ── ONE READ, PARTITIONED IN MEMORY ─────────────────────────────────────────────────────────────
// `OwnedIssue` carries its `stream`, and its own doc names this use: read a project's issues ONCE and
// partition by stream here, rather than querying per stream. Per-node reads are the N-per-pane fan-out
// shape that has repeatedly cost real time in this app (#3908 / #3912 / #3944 / #3954).

import { TERMINAL_GOOD, type OwnedIssue } from "@/shared/lib/fleet/workerEnd";

/** One stream's completion, as counts — never a pre-computed ratio, so a caller can render "3/7" as
 *  readily as a bar and neither has to reconstruct the other. */
export interface StreamProgress {
  done: number;
  total: number;
}

/**
 * Partition a project's issues into per-stream `done / total`.
 *
 * Issues with no `stream` are skipped: unowned work belongs to no worker, so counting it would make
 * every node's denominator wrong in the same invisible way.
 *
 * Done-ness is `TERMINAL_GOOD` (`complete` | `verified`) — the SAME set `classifyWorkerEnd` uses for
 * its verdict. A second definition here would eventually disagree with the card that says "finished".
 */
export function streamProgress(issues: readonly OwnedIssue[]): Map<string, StreamProgress> {
  const out = new Map<string, StreamProgress>();
  for (const i of issues) {
    const stream = i.stream?.trim();
    if (!stream) continue;
    const cur = out.get(stream) ?? { done: 0, total: 0 };
    cur.total += 1;
    if (TERMINAL_GOOD.has(i.status)) cur.done += 1;
    out.set(stream, cur);
  }
  return out;
}

/**
 * Refs of the issues plan.db considers FINISHED (#4102).
 *
 * Same `TERMINAL_GOOD` definition `streamProgress` counts with, exposed as refs so plan.db's evidence
 * can be unioned with the GitHub overlay into one done-set (`unionDone`). Deliberately NOT a second
 * notion of done-ness — `streamCompletion.ts` already made the point that a divergent definition
 * eventually disagrees with the card that says "finished".
 */
export function planDbDoneRefs(issues: readonly OwnedIssue[]): Set<string> {
  const out = new Set<string>();
  for (const i of issues) if (TERMINAL_GOOD.has(i.status)) out.add(i.ref);
  return out;
}

/**
 * Per-ref closed-ness from plan.db — `ref → true` when finished, `false` when it demonstrably is not.
 *
 * The distinction from {@link planDbDoneRefs} is the FALSE, and it is the whole point: a done-set can
 * only say "finished" or "not in the set", and "not in the set" conflates *this issue is open* with
 * *I have never heard of this issue*. The Plan dock has to tell those apart, because the first is a
 * state worth rendering and the second is the only one worth asking the user to connect GitHub for.
 *
 * Same `TERMINAL_GOOD` definition every other done-count uses — a second notion of done-ness here
 * would eventually let the node's bar and its issue list disagree, which is exactly the bug this fixes.
 */
export function planDbClosedByRef(issues: readonly OwnedIssue[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const i of issues) out.set(i.ref, TERMINAL_GOOD.has(i.status));
  return out;
}

/** The fill fraction, clamped to 0..1. `total === 0` ⇒ 0 (and the caller should render NO bar at all —
 *  an empty bar and a zero-progress bar say different things, and only one of them is true). */
export function progressFraction(p: StreamProgress | undefined): number {
  if (!p || p.total <= 0) return 0;
  return Math.max(0, Math.min(1, p.done / p.total));
}

/**
 * Attach each node's stream progress. A fleet node's id IS its stream id, which is what lets this be a
 * plain map lookup rather than another join.
 *
 * Returns the SAME array when nothing matched, so a project with no plan store (or a read that has not
 * landed yet) does not invalidate the memo that renders the graph.
 */
export function withStreamProgress<T extends { id: string; progress?: StreamProgress }>(
  nodes: readonly T[],
  byStream: ReadonlyMap<string, StreamProgress>,
): T[] {
  if (byStream.size === 0) return [...nodes];
  return nodes.map((n) => {
    const p = byStream.get(n.id);
    return p ? { ...n, progress: p } : n;
  });
}

/**
 * The project's progress across EVERY issue — including those no stream owns.
 *
 * `glance-progress-ref-namespace-split`. {@link streamProgress} deliberately SKIPS unowned issues,
 * because attributing them to a worker would make that worker's denominator wrong. But the project as a
 * whole owns all of them, so summing the per-stream rows is not the project's number and never was:
 * `studio-code` reads 24 issues here and 56 stream-owned refs there, and the two levels of the graph
 * showed those two numbers side by side with nothing to say they measured different things.
 *
 * Deliberately the SAME `complete | verified` definition as every other done-count in this file, and the
 * same one `bsc project progress` uses for the L0 node — so the director's bar and the project node's
 * bar are the same fact rather than two estimates that happen to agree.
 */
export function projectProgress(issues: readonly OwnedIssue[]): StreamProgress {
  let done = 0;
  for (const i of issues) if (TERMINAL_GOOD.has(i.status)) done += 1;
  return { done, total: issues.length };
}
