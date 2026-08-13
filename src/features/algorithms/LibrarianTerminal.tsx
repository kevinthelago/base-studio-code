// LibrarianTerminal (#2787/#3357) — the Algorithms tab's docked bottom panel showing the app-owned
// knowledge-store librarian session. Renders the shared SessionDock shell (#2808).
//
// #3357: migrated off the bespoke single-mount xterm (`useLibrarianTerminal` → `useScreenSession`) onto the
// shared TerminalHost, so this dock only drops a <TerminalSlot> and the host re-parents the one live
// terminal into it — which is what lets the Glance librarian node MORPH into the running session. The
// session's lifecycle (lazy start on first showing, warm across navigation, 30-minute idle reaper) is owned
// by the studios feature.
//
// #system-sessions-are-per-technology: there is now one librarian PER LANGUAGE KIT, and this dock FOLLOWS
// the page's active language rather than holding a selection of its own — navigating to a technology is
// what pulls up that technology's session. Two selections for one concept is how they drift apart.
//
// LAZY, and per-tech lazily: `useStudioViewer` is called for the ACTIVE session only, so switching
// languages starts the one you moved to and drops the viewer count on the one you left (which arms its
// idle reaper). Nothing pre-starts the other languages' sessions, and nothing starts any of them until
// this page is actually on screen — a rail with three languages must not cost three Claude processes.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { STUDIO_SESSIONS, studioForTech, useStudioViewer, useStudioPageShowing } from "@/features/studio-sessions";

export function LibrarianTerminal({ height, tech }: { height?: number; tech: string }) {
  // The Algorithms page is kept MOUNTED but CSS-hidden across page switches (#2827) — mounting is not
  // "on screen", so the viewer count (and thus the reaper) keys off the shell's actual page state.
  
  const studio = studioForTech("librarian", tech);
  const pageShowing = useStudioPageShowing(studio);
  // A language with no session (a graph that grew a fourth tech) shows an empty dock rather than
  // defaulting to some other language's librarian — docking the rust session on a page showing go
  // algorithms looks like it is working, which is worse than showing nothing.
  const showing = pageShowing && !!studio;
  useStudioViewer(studio, showing);

  const def = studio ? STUDIO_SESSIONS[studio] : null;
  return (
    <SessionDock
      testid="librarian-terminal"
      height={height}
      title={`◆ Knowledge librarian · ${tech} · the graph via bsc graph`}
      subtitle="algorithms-studio · restricted"
    >
      {def ? (
        <TerminalSlot paneId={def.paneId} visible={showing} focused={false} />
      ) : null}
    </SessionDock>
  );
}
