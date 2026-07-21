// ArchitectTerminal (#2755/#3357) — the Teams Studio's docked bottom panel showing the app-owned
// team-architect session. Renders the shared SessionDock shell (#2808). It is docked below the graph on
// BOTH levels (the Teams overview AND an entered team) and stays mounted across that switch (#2759).
//
// #3357: migrated off the bespoke single-mount xterm (`useArchitectTerminal` → `useScreenSession`) onto the
// shared TerminalHost, so this dock only drops a <TerminalSlot> and the host re-parents the one live
// terminal into it — which is what lets the Glance `architect` node MORPH into the running session. It also
// FIXES the harshest of the three lifecycles: leaving the Teams page used to unmount this dock and
// `pty_kill` the architect outright. The session now survives navigation and is reclaimed only by the
// studios feature's 30-minute idle reaper.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { STUDIO_SESSIONS, useStudioViewer, useStudioPageShowing } from "@/features/studio-sessions";

export function ArchitectTerminal({ height }: { height?: number }) {
  const showing = useStudioPageShowing("architect");
  useStudioViewer("architect", showing);
  return (
    <SessionDock
      testid="architect-terminal"
      height={height}
      title="◆ Team architect · teams & personas via bsc"
      subtitle="teams-studio · restricted"
    >
      <TerminalSlot paneId={STUDIO_SESSIONS.architect.paneId} visible={showing} focused={false} />
    </SessionDock>
  );
}
