// ArchitectTerminal (#2755) — the Teams Studio's docked bottom panel hosting the dedicated,
// heavily-restricted team-architect session (see useArchitectTerminal for the launch wiring). A mirror
// of the Design Studio's DesignerTerminal. Kept in its own component so the TeamsPanel diff stays
// small. It is docked below the team graph and mounted while a team is entered; unmounting (leaving
// the team back to the Teams overview) runs the hook's cleanup and kills the PTY.
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { useArchitectTerminal } from "./useArchitectTerminal";

export function ArchitectTerminal({ height }: { height?: number }) {
  const { containerRef } = useArchitectTerminal(true);
  return (
    <Box className="teams-terminal" data-testid="architect-terminal" style={height !== undefined ? { height } : undefined}>
      <Box className="teams-colhead">
        <Eyebrow size={9.5}>◆ Team architect · teams &amp; personas via bsc</Eyebrow>
        <Text mono size="xxs" tone="dim">teams-studio · restricted</Text>
      </Box>
      {/* eslint-disable-next-line no-restricted-syntax -- xterm mounts onto a real DOM node via ref (primitives aren't forwardRef) */}
      <div ref={containerRef} className="teams-termhost" />
    </Box>
  );
}
