// DesignerTerminal (#2471) — the Design Studio's collapsible bottom panel hosting the dedicated,
// heavily-restricted designer session (see useDesignerTerminal for the launch wiring). Kept in its
// own component so the DesignStudio diff stays small. IMPORTANT: the panel is mounted once and only
// CSS-hidden on collapse — unmounting would run the hook's cleanup and kill the PTY.
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { useDesignerTerminal } from "./useDesignerTerminal";

export function DesignerTerminal({ open }: { open: boolean }) {
  const { containerRef } = useDesignerTerminal(open);
  return (
    <Box className="ds-terminal" data-testid="designer-terminal" style={{ display: open ? "flex" : "none" }}>
      <Box className="ds-colhead">
        <Text className="ds-eyebrow" as="span">✦ Designer session · UI kits via bsc ui</Text>
        <Text mono size="xxs" tone="dim">design-studio · restricted</Text>
      </Box>
      {/* eslint-disable-next-line no-restricted-syntax -- xterm mounts onto a real DOM node via ref (primitives aren't forwardRef) */}
      <div ref={containerRef} className="ds-termhost" />
    </Box>
  );
}
