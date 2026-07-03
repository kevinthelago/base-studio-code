// GraphCanvas — the Layouts-tier template for a pan/zoom graph page (#2208, epic #2197 slice 2). The
// standardized shell every graph workspace shares: a full-width TOOLBAR, an optional left RAIL, the
// pan/zoom CANVAS (the viewport-clip element + the transformed "world" layer), and an optional
// INSPECTOR column. It owns the frame — the viewport ref/wheel/pan wiring, the world-layer transform,
// overflow/cursor — so a graph page brings only its world content (grid/edges/nodes), its toolbar
// controls, and its rail/inspector. The viewport itself is created by the page via useGraphViewport
// and passed in as `vp`, so the page keeps its own fit/persist effects and the toolbar can read zoom.
//
// Consumers: Org designer (features/org) and Glance (features/glance). Sits on the layout primitives
// (Box/Row/Stack) + shared controls in the same inline-style/token idiom.
import type { CSSProperties, ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { IconButton } from "@/shared/ui/controls/IconButton";
import type { GraphViewport } from "./useGraphViewport";

export interface GraphCanvasProps {
  /** The viewport created by the page's useGraphViewport(). */
  vp: GraphViewport;
  /** World (design-space) size — drives the world layer's box. */
  world: { w: number; h: number };
  /** Full toolbar content (org/search + palette + a <ZoomControls vp={vp}/> + fit, etc.). */
  toolbar: ReactNode;
  /** World-layer content: the grid, SVG edges, and node cards. Positioned in world coords. */
  children: ReactNode;
  /** Optional left rail/sidebar (feature-styled full node). */
  rail?: ReactNode;
  /** Optional inspector column on the right (feature-styled full node). */
  inspector?: ReactNode;
  /** Fixed overlays drawn over the canvas but NOT transformed (hints, legends). */
  overlays?: ReactNode;
  /** Escape hatch for the canvas backdrop. Default var(--bg). */
  canvasBackground?: string;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function GraphCanvas({
  vp, world, toolbar, children, rail, inspector, overlays, canvasBackground, className,
}: GraphCanvasProps) {
  // Pull the plain viewport values out as locals — worldTransform is a computed style object, not a
  // ref, so reading it (and the callback refs) here keeps the render free of ref-access.
  const { setVp, onCanvasDown, worldTransform } = vp;
  return (
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0 }}>
      {/* ── toolbar ── */}
      <Row gap={16} align="center" style={{ height: 52, flex: "none", padding: "0 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)" }}>
        {toolbar}
      </Row>

      {/* ── body: rail · canvas · inspector ── */}
      <Row gap={0} align="stretch" style={{ flex: 1, minHeight: 0 }}>
        {rail}
        {/* The pan/zoom viewport: a raw div for the native wheel listener + backdrop mousedown. */}
        <div ref={setVp} onMouseDown={onCanvasDown}
          style={{ position: "relative", flex: 1, overflow: "hidden", cursor: "grab", minWidth: 0, background: canvasBackground ?? "var(--bg)" }}>
          <Box style={{ position: "absolute", left: 0, top: 0, width: world.w, height: world.h, ...worldTransform, willChange: "transform" }}>
            {children}
          </Box>
          {overlays}
        </div>
        {inspector}
      </Row>
    </Stack>
  );
}

/** The shared zoom cluster (− / % / +) for a GraphCanvas toolbar. Fit is placed separately by the page. */
export function ZoomControls({ vp, step = 1.1, style }: { vp: GraphViewport; step?: number; style?: CSSProperties }) {
  return (
    <Row gap={2} align="center" style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, ...style }}>
      <IconButton aria-label="zoom out" onClick={() => vp.zoomBy(1 / step)}>−</IconButton>
      <Text as="span" mono size={11} style={{ minWidth: 46, textAlign: "center" }}>{Math.round(vp.view.scale * 100)}%</Text>
      <IconButton aria-label="zoom in" onClick={() => vp.zoomBy(step)}>+</IconButton>
    </Row>
  );
}
