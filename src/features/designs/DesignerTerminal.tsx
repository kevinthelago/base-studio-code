// DesignerTerminal (#2471/#2597) — the Design Studio's ALWAYS-ON bottom panel hosting the dedicated,
// heavily-restricted designer session (see useDesignerTerminal for the launch wiring). Kept in its
// own component so the DesignsWorkbench diff stays small. It is docked at the bottom of the center column
// and mounted for the whole Design Studio lifecycle; unmounting (leaving the Studio) runs the hook's
// cleanup and kills the PTY.
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { useDesignerTerminal } from "./useDesignerTerminal";

export function DesignerTerminal({ height }: { height?: number }) {
  const { containerRef } = useDesignerTerminal(true);
  return (
    <Box className="ds-terminal" data-testid="designer-terminal" style={height !== undefined ? { height } : undefined}>
      <Box className="ds-colhead">
        <Eyebrow size={9.5}>✦ Designer session · UI kits via bsc ui</Eyebrow>
        <Text mono size="xxs" tone="dim">design-studio · restricted</Text>
      </Box>
      {/* eslint-disable-next-line no-restricted-syntax -- xterm mounts onto a real DOM node via ref (primitives aren't forwardRef) */}
      <div ref={containerRef} className="ds-termhost" />
    </Box>
  );
}
