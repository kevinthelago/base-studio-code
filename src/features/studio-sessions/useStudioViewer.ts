// useStudioViewer (#3357) — the ONE way a surface says "I am showing this studio session".
//
// Both surfaces that can show a studio terminal call it: the studio page's `SessionDock` and the Glance
// node morph. On the first call the studio becomes WANTED (the lazy start — nothing launches at app boot),
// and for as long as the caller is showing it the studio's viewer count is held above zero, which keeps the
// idle reaper disarmed. When the last viewer goes away the reaper arms; the session stays warm on
// TerminalHost throughout, so re-opening inside the window reattaches to the SAME conversation.
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
    const st = useAppStore.getState();
    // Showing it is what STARTS it: opening a studio page (or its Glance node) is the lazy launch.
    st.openStudio(id);
    st.addStudioViewer(id);
    return () => { useAppStore.getState().removeStudioViewer(id); };
  }, [id, showing]);
}

/**
 * The MANY form of {@link useStudioViewer} — register this surface as a viewer of every studio in `ids`.
 *
 * Needed since #3361, where the Glance terminal grid can show SEVERAL studio sessions at once: the
 * single-id hook cannot be called in a loop (a variable hook count breaks the rules of hooks), and
 * calling it once with only the most-recently-opened id would leave every other open studio unpinned —
 * so the reaper could kill a session the user is looking at.
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
    for (const id of list) { st.openStudio(id); st.addStudioViewer(id); }
    return () => {
      const s = useAppStore.getState();
      for (const id of list) s.removeStudioViewer(id);
    };
  }, [key, showing]);
}
