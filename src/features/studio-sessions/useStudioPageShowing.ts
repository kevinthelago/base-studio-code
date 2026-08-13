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
  id: StudioId | null | undefined,
  s: { activeWorkspace: string; projectsPageMode: string },
  detached: { page: string; section: string } | null,
): boolean {
  // Null-tolerant for the same reason `useStudioViewer` is (#system-sessions-are-per-technology): a
  // per-technology dock resolves its session from the page's current selection, and a technology with
  // no session yields null. The rules of hooks require the call to be unconditional, so the NULL has to
  // be absorbed here rather than at the call site.
  //
  // UNRECOGNISED-tolerant too, which is a DIFFERENT case and the one that actually bit
  // (#a-stale-studio-id-in-a-record-must-not-kill-a-page). Callers include components compiled from
  // component RECORDS, whose source is data the type system never checked — so `id` can be a
  // non-null string naming a studio that no longer exists. `STUDIO_SESSIONS[retired]` is `undefined`,
  // and reading `.sectionId` off it threw all the way out to `GraphErrorBoundary`, which fell the
  // WHOLE page back: one stale id in one dock took down Algorithms entirely.
  //
  // A record is untrusted input by construction — the loader error-boundaries a render throw for
  // exactly that reason — so a helper it calls degrades instead of throwing. The dock shows nothing;
  // the page renders.
  const def = id ? STUDIO_SESSIONS[id] : undefined;
  if (!def) return false;
  // A torn-off section window renders exactly ONE page and has no rail — it is showing iff it IS this page.
  if (detached) return detached.page === def.pageKey && detached.section === def.sectionId;
  return s.activeWorkspace === "projects" && s.projectsPageMode === def.sectionId;
}

export function useStudioPageShowing(id: StudioId | null | undefined): boolean {
  const activeWorkspace = useAppStore((st) => st.activeWorkspace);
  const projectsPageMode = useAppStore((st) => st.projectsPageMode);
  return studioPageShowing(id, { activeWorkspace, projectsPageMode }, detachedSection());
}
