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
