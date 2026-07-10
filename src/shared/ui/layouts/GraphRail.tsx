// GraphRail (#2767) — the shared LEFT-RAIL scaffold every GraphCanvas page hand-rolled: a full-height
// elevated column (border + surface) with a section header (label · count) over a scrolling body, plus
// an optional tools strip under the header (e.g. a search field) and an optional pinned footer. Feature
// pages bring only the label/count and the rows; the frame is UNIFORM across Teams, Glance, and Designs.
// Pass it to GraphCanvas's `rail` prop — it fills the width GraphCanvas owns (flex:1), so don't set a
// width here. Part of the graph-page-structure epic (#2765), the sibling of the GraphCanvas shell (#2754).
import type { CSSProperties, ReactNode } from "react";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Text } from "@/shared/ui/typography/Text";

export interface GraphRailProps {
  /** The section label (left of the header) — the rail's title. */
  label: ReactNode;
  /** Optional right-aligned count/aside in the header (a node count, "N comps", …). Rendered in the
   *  standard dim mono micro-style; pass `0` explicitly to show a zero (only `null`/`undefined` hide it). */
  count?: ReactNode;
  /** Optional strip directly under the header, above the scroll body (e.g. a search field). */
  tools?: ReactNode;
  /** Optional content pinned BELOW the scroll body (e.g. Glance's coordination hazards). Brings its own
   *  border/padding — it's rendered as-is, outside the scroll region. */
  footer?: ReactNode;
  /** Scroll-body padding. Default "8px 8px 16px". */
  bodyPad?: string;
  /** The scrolling rows. */
  children: ReactNode;
  /** Extra class on the scroll body (a page scoping hook). */
  bodyClassName?: string;
  /** Merged over the column defaults. */
  style?: CSSProperties;
}

/** The uniform left rail for a {@link GraphCanvas} page: header (label · count) · optional tools · scroll
 *  body · optional footer. See {@link GraphRailProps}. */
export function GraphRail({
  label, count, tools, footer, bodyPad = "8px 8px 16px", children, bodyClassName, style,
}: GraphRailProps) {
  return (
    <Stack gap={0} style={{ flex: 1, minWidth: 0, minHeight: 0, borderRight: "1px solid var(--border-soft)", background: "var(--bg-elev)", ...style }}>
      <Box style={{ flex: "none", padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <SectionLabel size={9.5} right={count != null ? <Text as="span" mono size={10} tone="dim">{count}</Text> : undefined}>
          {label}
        </SectionLabel>
      </Box>
      {tools && <Box style={{ flex: "none", padding: "8px 8px 0" }}>{tools}</Box>}
      <Box className={bodyClassName} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: bodyPad }}>
        {children}
      </Box>
      {footer}
    </Stack>
  );
}
