// The ONE owner of "the current designer loop" (#3850) — published by the pump, read by the banner.
//
// Both consumers used to derive it independently: the banner ran `bsc loop list` + `bsc loop show`, and the
// pump ran the same two. Four process spawns per cycle for one fact, showing up in the #3842 perf log as
// identical-duration pairs. The duplication was a SYMPTOM — shared derived state with no owner, so every
// consumer re-derived it.
//
// The PUMP is the owner, because it already reads both and reads them freshest. It publishes here; the
// banner subscribes and makes no `bsc` calls at all. Four spawns per cycle become two.
//
// Why the pump doesn't just consume a shared snapshot the other way round: its decision depends on seeing
// the turn flip PROMPTLY. Driving off state that could be a poll-interval stale would let it dispatch the
// next directive before the designer's turn landed — the exact flooding the pump's turn-order signal exists
// to prevent. So the actor keeps its own read and shares the result; the display follows the actor.
//
// Deliberately a module-level observable rather than a Zustand slice: one producer, one consumer, ephemeral
// polled state — and the store's own rule is that persisted app state is not a cache for derived reads.

import { useEffect, useState } from "react";

/** The open designer loop as the banner needs to render it. `null` when no loop is open. */
export interface DesignerLoopState {
  id: number;
  /** The designer's recorded turns — each one a shot-paired change. */
  changes: number;
  cost: number;
}

let current: DesignerLoopState | null = null;
const listeners = new Set<(s: DesignerLoopState | null) => void>();

/** Publish the loop state observed this tick. Called by the pump — the one reader of `bsc loop`.
 *  Skips notifying when nothing changed, so a steady loop doesn't re-render the banner every tick. */
export function publishDesignerLoopState(next: DesignerLoopState | null): void {
  const same = current === next
    || (!!current && !!next && current.id === next.id
        && current.changes === next.changes && current.cost === next.cost);
  if (same) return;
  current = next;
  for (const fn of listeners) fn(next);
}

/** Subscribe to the published loop state. The banner's only source. */
export function useDesignerLoopState(): DesignerLoopState | null {
  const [state, setState] = useState<DesignerLoopState | null>(current);
  useEffect(() => {
    // Re-sync on mount: the pump may have published while this component was unmounted.
    setState(current);
    listeners.add(setState);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}
