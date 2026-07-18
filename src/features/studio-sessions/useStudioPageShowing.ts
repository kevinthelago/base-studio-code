// useStudioPageShowing (#3357) — is a studio's own page actually ON SCREEN right now?
//
// The studio pages are KEPT MOUNTED (`KeptMountedPage`): once visited they stay in the tree and are only
// CSS-hidden when the user switches away. So "my dock component is mounted" is NOT "the user is looking at
// this studio" — if the viewer ref-count keyed off mounting, it would stay ≥1 forever after the first visit
// and the idle reaper could never fire. This derives the real answer from the shell's page state.
import { useAppStore } from "@/store";
import { detachedSection } from "@/app/console/lib/detachWindow";
import { STUDIO_SESSIONS, type StudioId } from "./lib/studioSessions";

/** Pure rule: which page is showing, given the shell state and (for a tear-off) this window's identity. */
export function studioPageShowing(
  id: StudioId,
  s: { activeWorkspace: string; projectsPageMode: string },
  detached: { page: string; section: string } | null,
): boolean {
  const def = STUDIO_SESSIONS[id];
  // A torn-off section window renders exactly ONE page and has no rail — it is showing iff it IS this page.
  if (detached) return detached.page === def.pageKey && detached.section === def.sectionId;
  return s.activeWorkspace === "projects" && s.projectsPageMode === def.sectionId;
}

export function useStudioPageShowing(id: StudioId): boolean {
  const activeWorkspace = useAppStore((st) => st.activeWorkspace);
  const projectsPageMode = useAppStore((st) => st.projectsPageMode);
  return studioPageShowing(id, { activeWorkspace, projectsPageMode }, detachedSection());
}
