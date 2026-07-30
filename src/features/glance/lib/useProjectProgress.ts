// Every local project's issue completion (#4052) — the OPEN-ISSUES half of the L0 `modifying` health
// state.
//
// ONE SPAWN FOR ALL PROJECTS. `bsc project progress --json` walks the hubs and counts each plan.db
// inside a single process; the alternative — `bsc plan list` per project — is the N-per-pane fan-out
// shape that has cost this app whole seconds before (#3908 / #3912 / #3944 / #3954). With ~29 hubs
// locally that is 29 process spawns per poll versus one, which is the difference between a background
// read and a visible stall.
//
// Distinct from `useStreamProgress`, which reads ONE drilled project's issues and partitions them per
// STREAM for the L1 progress bars. This one is per PROJECT and spans all of them — different scope,
// different question, and it must keep working when nothing is drilled at all.
import { useEffect, useMemo, useState } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { usePoll } from "@/shared/hooks/usePoll";

/** One project's issue counts, as the CLI reports them. */
export interface ProjectProgressRow {
  key: string;
  done: number;
  total: number;
}

/** Issue counts move at human speed — a worker closing one is a minutes-scale event — and this drives a
 *  colour, not a number on screen. A fast poll would spend a spawn to re-read an unchanged answer. */
export const PROJECT_PROGRESS_POLL_MS = 30_000;

/**
 * Project keys with at least one issue NOT yet done.
 *
 * A project the CLI omits (no plan.db, or a plan store with no issues table) is simply absent from the
 * set — never assumed to have open work. Guessing the busy state from a missing read would light up
 * every unplanned hub on the board, and a wrong signal here is worse than none: the whole point of the
 * state is that it means something.
 *
 * The read failing likewise keeps the LAST GOOD answer rather than clearing, so a transient spawn
 * failure doesn't make every project blink out of `modifying` and back.
 */
export function useProjectProgress(enabled = true): ReadonlySet<string> {
  const [rows, setRows] = useState<ProjectProgressRow[]>([]);

  // Stop accumulating when Glance is not mounted/enabled — and drop what we had, so a re-enable
  // re-reads rather than rendering a possibly-stale board.
  useEffect(() => {
    if (!enabled) setRows([]);
  }, [enabled]);

  usePoll(async (isCancelled) => {
    if (!enabled) return;
    const next = await bscJson<ProjectProgressRow[] | null>(null, ["project", "progress", "--json"], null);
    if (isCancelled() || !Array.isArray(next)) return;   // read failed ⇒ keep the last good answer
    setRows(next);
  }, PROJECT_PROGRESS_POLL_MS, [enabled]);

  return useMemo(() => openIssueKeys(rows), [rows]);
}

/** The set of keys with unfinished work: `done < total`. `total === 0` is NOT open work — a planned
 *  project with zero issues has nothing in flight, and counting it would make the state meaningless for
 *  every hub that was scaffolded and abandoned. Pure + exported for direct unit testing. */
export function openIssueKeys(rows: readonly ProjectProgressRow[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    if (r && typeof r.key === "string" && r.total > 0 && r.done < r.total) out.add(r.key);
  }
  return out;
}
