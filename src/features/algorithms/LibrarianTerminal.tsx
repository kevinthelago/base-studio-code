// LibrarianTerminal (#2787) — the Algorithms tab's docked bottom panel hosting the dedicated,
// heavily-restricted knowledge-store librarian session (see useLibrarianTerminal for the launch
// wiring). Renders the shared SessionDock shell (#2808). The Algorithms tab is kept mounted across tab
// switches (#2827), so leaving it no longer unmounts this / kills the PTY — the hook's cleanup (which
// kills the PTY) runs only on app shutdown or a tear-off ownership release.
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
