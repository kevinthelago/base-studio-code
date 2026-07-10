// ArchitectTerminal (#2755) — the Teams Studio's docked bottom panel hosting the dedicated,
// heavily-restricted team-architect session (see useArchitectTerminal for the launch wiring). Renders
// the shared SessionDock shell (#2808). It is docked below the graph on BOTH levels — the Teams
// overview AND an entered team — and, because TeamsPanel passes the SAME dock element to one reconciled
// GraphCanvas, it stays mounted across the overview↔team switch (#2759). Only leaving the Teams tab
// entirely unmounts it, which runs the hook's cleanup and kills the PTY.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { useArchitectTerminal } from "./useArchitectTerminal";

export function ArchitectTerminal({ height }: { height?: number }) {
  const { containerRef } = useArchitectTerminal(true);
  return (
    <SessionDock
      containerRef={containerRef}
      testid="architect-terminal"
      height={height}
      title="◆ Team architect · teams & personas via bsc"
      subtitle="teams-studio · restricted"
    />
  );
}
