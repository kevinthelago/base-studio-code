// LibrarianTerminal (#2787/#3357) — the Algorithms tab's docked bottom panel showing the app-owned
// knowledge-store librarian session. Renders the shared SessionDock shell (#2808).
//
// #3357: migrated off the bespoke single-mount xterm (`useLibrarianTerminal` → `useScreenSession`) onto the
// shared TerminalHost, so this dock only drops a <TerminalSlot> and the host re-parents the one live
// terminal into it — which is what lets the Glance `librarian` node MORPH into the running session. The
// session's lifecycle (lazy start on first showing, warm across navigation, 30-minute idle reaper) is owned
// by the studios feature.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { STUDIO_SESSIONS, useStudioViewer, useStudioPageShowing } from "@/features/studio-sessions";

export function LibrarianTerminal({ height }: { height?: number }) {
  // The Algorithms page is kept MOUNTED but CSS-hidden across page switches (#2827) — mounting is not
  // "on screen", so the viewer count (and thus the reaper) keys off the shell's actual page state.
  const showing = useStudioPageShowing("librarian");
  useStudioViewer("librarian", showing);
  return (
    <SessionDock
      testid="librarian-terminal"
      height={height}
      title="◆ Knowledge librarian · the graph via bsc graph"
      subtitle="algorithms-studio · restricted"
    >
      <TerminalSlot paneId={STUDIO_SESSIONS.librarian.paneId} visible={showing} focused={false} />
    </SessionDock>
  );
}
