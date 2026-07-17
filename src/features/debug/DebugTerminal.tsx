// DebugTerminal (#3298) — the DEBUG session's terminal, filling its own OS window. Uses the shared
// SessionDock shell (the sanctioned xterm ref-container; shared/ui primitives aren't forwardRef) but
// overrides its fixed dock height to fill the window. Mounted only in the `?debug=1` detached window.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { Box } from "@/shared/ui/layout/Box";
import { useDebugTerminal } from "./useDebugTerminal";
import "./debugTerminal.css";

export function DebugTerminal() {
  const { containerRef } = useDebugTerminal(true);
  return (
    <Box className="debug-window-body">
      <SessionDock
        containerRef={containerRef}
        testid="debug-terminal"
        title="⚙ Debug session · full codebase · fixes bsc ui"
        subtitle="base-studio-code · bypass"
      />
    </Box>
  );
}
