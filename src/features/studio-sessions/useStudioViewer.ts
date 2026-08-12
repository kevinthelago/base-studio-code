// useStudioViewer (#3357) — the ONE way a surface says "I am showing this studio session".
//
// Both surfaces that can show a studio terminal call it: the studio page's `SessionDock` and the Glance
// node morph. For as long as the caller is showing it the studio's viewer count is held above zero, which
// keeps the idle reaper disarmed. When the last viewer goes away the reaper arms; the session stays warm on
// TerminalHost throughout, so re-opening inside the window reattaches to the SAME conversation.
//
// SHOWING IS NO LONGER STARTING (#rendering-a-studio-node-must-not-start-its-session). These hooks used to
// call `openStudio` too, which put the studio in `wantedStudios` → `StudioSessionMount` → a live PTY. Since
// `useStudioPageShowing` is true whenever the shell is on that page, merely NAVIGATING to the Design Studio
// (or Algorithms, or Teams) launched an agent — and because the reaper drops an unwatched studio after 30
// minutes, navigating back started it again. From outside that reads as sessions starting themselves.
//
// The two halves were one call and are now separated on purpose:
//   • VIEWING stays automatic — a surface showing a RUNNING session must pin it, or watching a session
//     could get it reaped out from under you.
//   • STARTING needs a deliberate act by the user.
//
// WHAT COUNTS AS DELIBERATE differs between the two callers, which is why the hooks below differ:
//   • a studio PAGE is "showing" the moment the shell navigates to it, and navigating is not asking for
//     an agent — so `useStudioViewer` never starts. Its dock renders `StudioTerminalSlot`, which offers
//     the Start control when the session is down.
//   • a Glance MORPH only exists because the user CLICKED that node to expand it. Expanding a studio node
//     that is off is a request to start it, so `useStudioViewers` still starts — the lazy load this
//     feature was built around. (`placements` is the open-morph list, not the rendered nodes, so a studio
//     node merely drawn on the canvas still starts nothing.)
import { useEffect } from "react";
import { useAppStore } from "@/store";
import type { StudioId } from "./lib/studioSessions";

/**
 * Register this component as a viewer of `id`'s studio session while `showing` is true.
 *
 * @param id      the studio, or null when this surface currently shows no studio (the hook then no-ops,
 *                so a caller with a conditional target — the Glance morph — can still call it
 *                unconditionally, as the rules of hooks require).
 * @param showing whether the surface is ACTUALLY on screen. A page dock stays MOUNTED but CSS-hidden when
 *                the user switches pages (`KeptMountedPage`), and a mounted-but-hidden dock must not pin
 *                the session alive forever — otherwise the reaper could never fire after a first visit.
 */
export function useStudioViewer(id: StudioId | null | undefined, showing = true): void {
  useEffect(() => {
    if (!id || !showing) return;
    // Viewer registration ONLY — no `openStudio`. Showing a studio does not start it (see the header).
    useAppStore.getState().addStudioViewer(id);
    return () => { useAppStore.getState().removeStudioViewer(id); };
  }, [id, showing]);
}

/**
 * The MANY form of {@link useStudioViewer} — register this surface as a viewer of every studio in `ids`.
 *
 * Needed since #3361, where several node morphs can be open at once: the single-id hook cannot be called
 * in a loop (a variable hook count breaks the rules of hooks), and calling it once with only the
 * most-recently-opened id would leave every other open studio unpinned — so the reaper could kill a
 * session the user is looking at in another morph.
 *
 * Keyed on the joined id list, so opening a second studio re-runs the effect: the cleanup decrements the
 * already-open studios and the body immediately re-increments them. That transient dip to 0 is harmless —
 * the reaper only ARMS a timer at 0 and re-checks the live count when it fires (tens of minutes later),
 * by which point the count is back up.
 */
export function useStudioViewers(ids: readonly StudioId[], showing = true): void {
  const key = ids.join(",");
  useEffect(() => {
    if (!showing || !key) return;
    const list = key.split(",") as StudioId[];
    const st = useAppStore.getState();
    // Starts as well as pins — UNLIKE the single form above. A morph is only in this list because the
    // user expanded that node, and expanding a studio node that is off is how you start it. The reaper
    // cannot fight this: it only arms at zero viewers, and an open morph holds the count above zero.
    for (const id of list) { st.openStudio(id); st.addStudioViewer(id); }
    return () => {
      const s = useAppStore.getState();
      for (const id of list) s.removeStudioViewer(id);
    };
  }, [key, showing]);
}
