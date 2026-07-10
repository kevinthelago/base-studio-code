// DesignerTerminal (#2471/#2597) — the Design Studio's ALWAYS-ON bottom panel hosting the dedicated,
// heavily-restricted designer session (see useDesignerTerminal for the launch wiring). Renders the
// shared SessionDock shell (#2808). It is docked at the bottom of the center column and mounted for the
// whole Design Studio lifecycle; unmounting (leaving the Studio) runs the hook's cleanup and kills the PTY.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { useDesignerTerminal } from "./useDesignerTerminal";

export function DesignerTerminal({ height }: { height?: number }) {
  const { containerRef } = useDesignerTerminal(true);
  return (
    <SessionDock
      containerRef={containerRef}
      testid="designer-terminal"
      height={height}
      title="✦ Designer session · UI kits via bsc ui"
      subtitle="design-studio · restricted"
    />
  );
}
