// SessionDock (#2808) — the shared docked-session panel: a title/subtitle head over the xterm host
// element. The three graph-view session terminals — DesignerTerminal (designs), ArchitectTerminal
// (teams), LibrarianTerminal (algorithms) — were byte-identical shells differing only in a className
// prefix, testid, the labels, and the launch hook; they now all render this. Each keeps its own
// `use*Terminal` hook (it owns the PTY lifecycle) and passes the resulting `containerRef` in.
import type { ReactNode, RefObject } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import "./sessionDock.css";

export interface SessionDockProps {
  /** The xterm host element ref (from the feature's `use*Terminal` hook). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The head's eyebrow title (e.g. "◆ Team architect · teams & personas via bsc"). */
  title: ReactNode;
  /** The head's right-aligned dim mono subtitle (e.g. "teams-studio · restricted"). */
  subtitle?: ReactNode;
  /** Panel height in px — the caller owns it (a `.resize-y` handle above the dock). */
  height?: number;
  /** data-testid for the panel (e.g. "architect-terminal"). */
  testid?: string;
}

/** The shared docked-session terminal panel. See {@link SessionDockProps}. */
export function SessionDock({ containerRef, title, subtitle, height, testid }: SessionDockProps) {
  return (
    <Box className="session-dock" data-testid={testid} style={height !== undefined ? { height } : undefined}>
      <Box className="session-dock-head">
        <Eyebrow size={9.5}>{title}</Eyebrow>
        {subtitle != null && <Text mono size="xxs" tone="dim">{subtitle}</Text>}
      </Box>
      {/* xterm mounts onto this real DOM node via ref (shared/ui primitives aren't forwardRef). */}
      <div ref={containerRef} className="session-dock-host" />
    </Box>
  );
}
