// LibrarianTerminal (#2787) — the Algorithms tab's docked bottom panel hosting the dedicated,
// heavily-restricted knowledge-store librarian session (see useLibrarianTerminal for the launch
// wiring). A mirror of the Teams Studio's ArchitectTerminal. Kept in its own component so the
// AlgorithmsWorkspace diff stays small. It is docked below the graph; leaving the Algorithms tab
// unmounts it, which runs the hook's cleanup and kills the PTY.
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { useLibrarianTerminal } from "./useLibrarianTerminal";

export function LibrarianTerminal({ height }: { height?: number }) {
  const { containerRef } = useLibrarianTerminal(true);
  return (
    <Box className="algo-terminal" data-testid="librarian-terminal" style={height !== undefined ? { height } : undefined}>
      <Box className="algo-colhead">
        <Eyebrow size={9.5}>◆ Knowledge librarian · the graph via bsc graph</Eyebrow>
        <Text mono size="xxs" tone="dim">algorithms-studio · restricted</Text>
      </Box>
      {/* eslint-disable-next-line no-restricted-syntax -- xterm mounts onto a real DOM node via ref (primitives aren't forwardRef) */}
      <div ref={containerRef} className="algo-termhost" />
    </Box>
  );
}
