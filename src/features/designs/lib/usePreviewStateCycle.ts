// usePreviewStateCycle (#3555) — gently auto-cycle a SMALL preview through the states a component actually
// supports (loading → loaded → error; empty is skipped, see `previewCycleStates`). The cycling is the only
// React here; the "which states" decision is the pure `previewCycleStates`. The preview's own build
// opacity-dip reads as a soft crossfade between states, so no animation is needed here.
import { useEffect, useState } from "react";
import type { ComponentRecord } from "./model";
import { previewCycleStates, type PreviewState } from "./componentPreview";

/** Milliseconds each state holds before the cycle advances — calm, not flickery. */
export const PREVIEW_CYCLE_MS = 2800;

/**
 * The data-state a small preview should render right now, auto-advancing through the component's cyclable
 * states on a timer. A component with a single cyclable state (just `loaded`) never advances. Cycling
 * pauses while `paused` (e.g. the pointer is over the preview) so it holds still to be inspected, and
 * resets to the first state when the selected component changes.
 */
export function usePreviewStateCycle(comp: ComponentRecord, paused: boolean): PreviewState {
  const states = previewCycleStates(comp);
  // `comp.id` in the key restarts the cycle on a component switch even when two components share a state set.
  const cycleKey = `${comp.id}|${states.join(",")}`;
  const [st, setSt] = useState({ key: cycleKey, idx: 0 });
  // Reset to the first state when the component / its cyclable set changes — React's guarded
  // adjust-state-during-render pattern (NOT a setState-in-effect), so the cycle restarts cleanly.
  const idx = st.key === cycleKey ? st.idx : 0;
  if (st.key !== cycleKey) setSt({ key: cycleKey, idx: 0 });
  useEffect(() => {
    if (paused || states.length < 2) return undefined;
    const t = setInterval(() => setSt((s) => ({ key: s.key, idx: (s.idx + 1) % states.length })), PREVIEW_CYCLE_MS);
    return () => clearInterval(t);
  }, [cycleKey, paused, states.length]);
  return states[idx % states.length] ?? "loaded";
}
