// SplitView — the Layouts-tier template for a two-pane split page (#2197 slice 2). A flexing PRIMARY
// pane beside (or above) a fixed-size, drag-resizable SECONDARY pane, with an optional full-width
// TOOLBAR. It owns the frame — the split direction, the divider border, the splitter wiring + its
// bounds — so a split page brings only its two pane contents. The canonical consumer is the Planner
// session (terminal PRIMARY + inspector SECONDARY); it generalizes the hand-rolled terminal/inspector
// split. Distinct from MasterDetail (whose fixed-width rail comes FIRST): here the resized pane is the
// SECOND one and the PRIMARY flexes to fill, so the splitter drives the trailing pane (invert).
//
// Sits on the layout primitives (Box/Row/Stack) in the same inline-style/token idiom. The escape
// hatches (secondaryMin/secondaryMax, divider, primaryStyle/secondaryStyle) cover the rare deliberate
// difference — needing many is the signal a page is a DIFFERENT template.
import type { CSSProperties, ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { useDragResize } from "@/shared/hooks/useDragResize";

export interface SplitViewProps {
  /** The flexing pane — fills the remaining space (terminal, editor, main content). */
  primary: ReactNode;
  /** The fixed-size, drag-resizable pane — the trailing side (inspector, sidebar, detail). */
  secondary: ReactNode;
  /** Split direction. "horizontal" (default) → side by side; "vertical" → primary above secondary. */
  orientation?: "horizontal" | "vertical";
  /** Opt out of the drag splitter for a fixed secondary. Default true. */
  resizable?: boolean;
  /** Secondary size in px (width when horizontal, height when vertical) — the starting size. Default 340. */
  secondarySize?: number;
  /** Min secondary size when resizable. Default 200. */
  secondaryMin?: number;
  /** Max secondary size when resizable. Default 640. */
  secondaryMax?: number;
  /** Optional full-width toolbar/header above the split (title, actions). */
  toolbar?: ReactNode;
  /** Draw the 1px divider border between the two panes. Default true. */
  divider?: boolean;
  /** Escape hatch for a deliberate primary override. */
  primaryStyle?: CSSProperties;
  /** Escape hatch for a deliberate secondary override. */
  secondaryStyle?: CSSProperties;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function SplitView({
  primary, secondary, orientation = "horizontal", resizable = true,
  secondarySize = 340, secondaryMin = 200, secondaryMax = 640,
  toolbar, divider = true, primaryStyle, secondaryStyle, className,
}: SplitViewProps) {
  const horizontal = orientation === "horizontal";
  // The secondary sits AFTER the splitter, so it grows as the pointer moves back toward the primary
  // (left/up) — invert the delta, like the GraphCanvas inspector.
  const drag = useDragResize({
    initial: secondarySize, min: secondaryMin, max: secondaryMax,
    axis: horizontal ? "x" : "y", invert: true,
  });
  const size = resizable ? drag.size : secondarySize;
  // The divider lives on the primary's trailing edge (right when horizontal, bottom when vertical);
  // when resizable the splitter strip already visually separates, so keep the border for a crisp seam.
  const primaryBorder = divider
    ? (horizontal ? { borderRight: "1px solid var(--border-soft)" } : { borderBottom: "1px solid var(--border-soft)" })
    : {};
  const Split = horizontal ? Row : Stack;

  const body = (
    <Split gap={0} align="stretch" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      {/* Flex pane — fills the remaining axis, clips its own content. */}
      <Box style={{
        flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column",
        overflow: "hidden", ...primaryBorder, ...primaryStyle,
      }}>
        {primary}
      </Box>
      {/* The splitter grabber (thin transparent strip, visible on hover); axis-appropriate class. */}
      {resizable && <Box className={horizontal ? "resize-x" : "resize-y"} {...drag.handleProps} title="Drag to resize" />}
      {/* Fixed/resized trailing pane. */}
      <Box style={{
        flex: `0 0 ${size}px`, ...(horizontal ? { width: size } : { height: size }),
        minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column",
        overflow: "hidden", ...secondaryStyle,
      }}>
        {secondary}
      </Box>
    </Split>
  );

  // Fills the <Screen> body; the toolbar (if any) sits above the split, matching MasterDetail.
  return (
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {toolbar}
      {body}
    </Stack>
  );
}
