// The recovery ladder — the versions of a record's source the runtime may fall back to when the current
// one does not work.
//
// WHY THE EXISTING GATE WAS NOT ENOUGH. `renderGate`'s `lastGood` already prefers "the last version that
// rendered" over an empty surface, and that is the right instinct — but its memory is per SESSION, and a
// session that has only just booted has none. That is exactly the shape of the 02:00 incident: a designer
// rewrote five rendering-critical records at 01:39, the app was restarted, and on the fresh boot the first
// version of each record the gate ever saw was the broken one. Nothing had rendered yet, so there was
// nothing to fall back TO, and 8 of 9 workspaces render from these records.
//
// The rungs come from the record's own change history, which the Rust stamp boundary now populates with
// the `srcText` each write replaced. That is durable — it is in the store, not in a module-level Map — so
// it survives the restart that empties `lastGood`, and it is the same data `bsc ui revert` restores from.
// Together they mean a bad write degrades the surface it broke instead of the whole app, and the way back
// exists whether or not the record was ever packaged with a seed.
import type { ChangeEntry } from "@/features/designs/lib/model";

/** A record's retained earlier sources, NEWEST-FIRST — the versions to try after the current one fails.
 *
 *  Deduped, because a metadata-only write between two source edits leaves the same bytes reachable twice
 *  and re-compiling an identical source cannot produce a different outcome. Empty when the record has no
 *  history, no retained content, or has only ever been written once.
 *
 *  `current` is excluded when supplied: the ladder is what to try INSTEAD, and offering back the version
 *  that just failed would spend a compile to reach the same error. */
export function recoveryLadder(history: ChangeEntry[] | undefined, current?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // History is stored oldest-first; walk it backwards so the most recent rung is tried first.
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    const prev = history?.[i]?.prevSrc;
    if (typeof prev !== "string" || !prev.trim()) continue;
    if (prev === current || seen.has(prev)) continue;
    seen.add(prev);
    out.push(prev);
  }
  return out;
}

/** Does this record have any way back at all? The question the Design Studio asks to warn BEFORE a write,
 *  rather than after: a record with no rung and no packaged seed is one whose next bad write is
 *  unrecoverable, which is the state `graphprimitive` / `kitrenderer` / `insights` were in. */
export function hasRecoveryPath(record: { history?: ChangeEntry[]; builtin?: boolean }): boolean {
  return Boolean(record.builtin) || recoveryLadder(record.history).length > 0;
}
