// LibrarianTerminal (#2787) — the Algorithms tab's docked bottom panel hosting the dedicated,
// heavily-restricted knowledge-store librarian session (see useLibrarianTerminal for the launch
// wiring). Renders the shared SessionDock shell (#2808); leaving the Algorithms tab unmounts it, which
// runs the hook's cleanup and kills the PTY.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { useLibrarianTerminal } from "./useLibrarianTerminal";

export function LibrarianTerminal({ height }: { height?: number }) {
  const { containerRef } = useLibrarianTerminal(true);
  return (
    <SessionDock
      containerRef={containerRef}
      testid="librarian-terminal"
      height={height}
      title="◆ Knowledge librarian · the graph via bsc graph"
      subtitle="algorithms-studio · restricted"
    />
  );
}
