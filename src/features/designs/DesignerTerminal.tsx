// DesignerTerminal (#2471/#2597/#3357) — the Design Studio's ALWAYS-ON bottom panel showing the app-owned
// designer session. Renders the shared SessionDock shell (#2808).
//
// #3357: the dock no longer OWNS the terminal. The designer session was migrated off its bespoke
// single-mount xterm (`useDesignerTerminal` → `useScreenSession`) onto the shared TerminalHost, exactly
// like the debug session (#3326) and every fleet terminal — so this dock just drops a <TerminalSlot> and
// the host re-parents the one live terminal into it. That is what lets the Glance `designer` node MORPH
// into the running session (a `useScreenSession` xterm could not be re-parented, so the graph could only
// send the user to this page instead).
//
// Lifecycle is now the studios feature's: showing this page opens the session (`useStudioViewer` → lazy
// start), it stays warm on TerminalHost when the user navigates away, and a 30-minute idle reaper reclaims
// it once neither this dock nor the Glance morph is showing it.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { STUDIO_SESSIONS, useStudioViewer, useStudioPageShowing } from "@/features/studio-sessions";

export function DesignerTerminal({ height }: { height?: number }) {
  // The Designs page is kept MOUNTED but CSS-hidden across page switches, so mounting is not "on screen".
  const showing = useStudioPageShowing("designer");
  useStudioViewer("designer", showing);
  return (
    <SessionDock
      testid="designer-terminal"
      height={height}
      title="✦ Designer session · UI kits via bsc ui"
      subtitle="design-studio · restricted"
    >
      <TerminalSlot paneId={STUDIO_SESSIONS.designer.paneId} visible={showing} focused={false} />
    </SessionDock>
  );
}
