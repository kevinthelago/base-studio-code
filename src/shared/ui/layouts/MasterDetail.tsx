// MasterDetail — the first Layouts-tier template (#2197/#2198): the standardized list+detail page
// skeleton. A fixed-width bordered scroll RAIL (the master list/nav) + a flex:1 scroll DETAIL, under
// an optional full-width TOOLBAR. It owns the rail width/border/scroll + detail scroll/padding by
// construction, so every list page looks and behaves identically and a page becomes just
// `<MasterDetail rail={…} detail={…} />`. Sits on the layout primitives (Box/Row/Stack) in the same
// inline-style/token idiom; the escape hatches (railWidth/railPad/detailPad/railStyle/detailStyle)
// cover the rare deliberate difference — needing many is the signal a page is a DIFFERENT template.
//
// `resizable` (#2209) opts into a drag-resizable rail (a `.resize-x` splitter, backed by useDragResize)
// bounded by railMin/railMax, with railWidth as the starting size — for the pages that want it (GitHub
// repos). The default stays a fixed rail, so existing call sites are unaffected.
import type { CSSProperties, ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import type { Space } from "@/shared/ui/layout/space";
import { useDragResize } from "@/shared/hooks/useDragResize";

export interface MasterDetailProps {
  /** The master column — the list/nav rail. */
  rail: ReactNode;
  /** The detail column — the selected item's editor/view. */
  detail: ReactNode;
  /** Optional full-width toolbar/header above both columns (search, filters, actions). */
  toolbar?: ReactNode;
  /** Fixed rail width in px (the starting width when `resizable`). Default 240. */
  railWidth?: number;
  /** Rail inner padding — a space rung or [block, inline]. Default 14. */
  railPad?: Space | [Space, Space];
  /** Detail inner padding. Default 20. */
  detailPad?: Space | [Space, Space];
  /** Opt into a drag-resizable rail (a `.resize-x` splitter between rail and detail). Default false. */
  resizable?: boolean;
  /** Min rail width when `resizable`. Default 160. */
  railMin?: number;
  /** Max rail width when `resizable`. Default 460. */
  railMax?: number;
  /** Escape hatch for a deliberate rail override (e.g. a canvas background). */
  railStyle?: CSSProperties;
  /** Escape hatch for a deliberate detail override. */
  detailStyle?: CSSProperties;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function MasterDetail({
  rail, detail, toolbar,
  railWidth = 240, railPad = 14, detailPad = 20,
  resizable = false, railMin = 160, railMax = 460,
  railStyle, detailStyle, className,
}: MasterDetailProps) {
  // Always call the hook (rules of hooks); its live size only drives the rail when `resizable`.
  const drag = useDragResize({ initial: railWidth, min: railMin, max: railMax, axis: "x" });
  const width = resizable ? drag.size : railWidth;
  return (
    // Fills the <Screen> body; the toolbar (if any) sits above the two scrolling columns.
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {toolbar}
      <Row gap={0} align="stretch" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <Box pad={railPad} style={{
          flex: `0 0 ${width}px`, width, overflowY: "auto",
          borderRight: "1px solid var(--border-soft)", ...railStyle,
        }}>
          {rail}
        </Box>
        {/* The `.resize-x` grabber is a thin transparent strip after the rail's border (visible on hover). */}
        {resizable && <Box className="resize-x" {...drag.handleProps} title="Drag to resize" />}
        {/* Flex column so a centered empty-state (flex:1) fills, and scrolling content sizes right. */}
        <Box pad={detailPad} style={{
          flex: 1, minWidth: 0, overflow: "auto", display: "flex", flexDirection: "column", ...detailStyle,
        }}>
          {detail}
        </Box>
      </Row>
    </Stack>
  );
}
