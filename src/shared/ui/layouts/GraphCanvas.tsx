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
import { useDragResize } from "@/shared/hooks/useDragResize";
import type { GraphViewport } from "./useGraphViewport";
import "./graphCanvas.css"; // the shared .graph-drill-anim drill transition (#2418)

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
  /** Dotted graph-paper backdrop. An INFINITE grid on the viewport (not the world box), so it always
   *  fills the visible area and never stops at the world edge, while its dot spacing tracks zoom and
   *  its origin tracks pan — i.e. it reads as world-aligned graph paper under the whole graph. */
  grid?: boolean;
  /** Grid tile size in world px (scaled by zoom on screen). Default 24. */
  gridSize?: number;
  /** Grid dot color. Default a faint `--fg` mix. */
  gridColor?: string;
  /** Escape hatch for the canvas backdrop. Default var(--bg). */
  canvasBackground?: string;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
  /** Make the left rail drag-resizable (a `.resize-x` splitter, like MasterDetail #2209). When set, the
   *  rail node should FILL its wrapper (GraphCanvas owns the width) — don't give it a fixed width. */
  railResizable?: boolean;
  railWidth?: number; railMin?: number; railMax?: number;
  /** Make the right inspector drag-resizable (splitter on its LEFT edge — it grows as the pointer moves
   *  left). Same fill-your-wrapper contract as the rail. */
  inspectorResizable?: boolean;
  inspectorWidth?: number; inspectorMin?: number; inspectorMax?: number;
  /** Fires on a genuine click on the empty canvas backdrop — not the end of a pan-drag, and not a
   *  node press (`[data-node]`). Opt-in (e.g. to clear the selection). Edges/other selectable world
   *  content should `stopPropagation` on their click so they don't reach this. */
  onBackgroundClick?: () => void;
}

export function GraphCanvas({
  vp, world, toolbar, children, rail, inspector, overlays,
  grid = false, gridSize = 24, gridColor = "color-mix(in oklch, var(--fg) 8%, transparent)",
  canvasBackground, className,
  railResizable = false, railWidth = 260, railMin = 200, railMax = 460,
  inspectorResizable = false, inspectorWidth = 344, inspectorMin = 260, inspectorMax = 620,
  onBackgroundClick,
}: GraphCanvasProps) {
  // Pull the plain viewport values out as locals — worldTransform is a computed style object, not a
  // ref, so reading it (and the callback refs) here keeps the render free of ref-access.
  const { setVp, onCanvasDown, worldTransform, view } = vp;
  // The infinite grid lives on the viewport (untransformed) so it fills the whole visible area: the
  // dot SPACING scales with zoom (`gridSize * scale`) and the origin follows the pan (`tx,ty`), so it
  // stays aligned to world coords without ever stopping at the world box the content overflows.
  const gridStyle: CSSProperties | undefined = grid ? {
    position: "absolute", inset: 0, pointerEvents: "none",
    backgroundImage: `radial-gradient(${gridColor} 1px, transparent 1px)`,
    backgroundSize: `${gridSize * view.scale}px ${gridSize * view.scale}px`,
    backgroundPosition: `${view.tx}px ${view.ty}px`,
  } : undefined;
  // Hooks always run (rules of hooks); the live size only drives a column when that side is resizable.
  const railDrag = useDragResize({ initial: railWidth, min: railMin, max: railMax, axis: "x" });
  const inspDrag = useDragResize({ initial: inspectorWidth, min: inspectorMin, max: inspectorMax, axis: "x", invert: true });
  const paneBox = (size: number): CSSProperties => ({ flex: `0 0 ${size}px`, width: size, minWidth: 0, display: "flex", overflow: "hidden" });
  return (
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0 }}>
      {/* ── toolbar ── */}
      <Row gap={16} align="center" style={{ height: 52, flex: "none", padding: "0 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)" }}>
        {toolbar}
      </Row>

      {/* ── body: rail · canvas · inspector (rail/inspector optionally drag-resizable) ── */}
      <Row gap={0} align="stretch" style={{ flex: 1, minHeight: 0 }}>
        {rail && (railResizable ? (
          <>
            <Box style={paneBox(railDrag.size)}>{rail}</Box>
            <Box className="resize-x" {...railDrag.handleProps} title="Drag to resize" />
          </>
        ) : rail)}
        {/* The pan/zoom viewport: a raw div for the native wheel listener + backdrop mousedown. */}
        <div ref={setVp} onMouseDown={onCanvasDown}
          onClick={onBackgroundClick ? (e) => {
            // A genuine backdrop click — ignore the end of a pan-drag and any node press.
            if (vp.dragMoved.current) return;
            if ((e.target as HTMLElement).closest("[data-node]")) return;
            onBackgroundClick();
          } : undefined}
          style={{ position: "relative", flex: 1, overflow: "hidden", cursor: "grab", minWidth: 0, background: canvasBackground ?? "var(--bg)" }}>
          {gridStyle && <div style={gridStyle} />}
          {/* No text selection of node labels / edges on click or drag (#2527) — shared here so every
              graph (Org · Glance · Design Studio) is covered in one place. Inspector/toolbar text (outside
              the world layer) stays selectable. */}
          <Box style={{ position: "absolute", left: 0, top: 0, width: world.w, height: world.h, userSelect: "none", ...worldTransform, willChange: "transform" }}>
            {children}
          </Box>
          {overlays}
        </div>
        {inspector && (inspectorResizable ? (
          <>
            <Box className="resize-x" {...inspDrag.handleProps} title="Drag to resize" />
            <Box style={paneBox(inspDrag.size)}>{inspector}</Box>
          </>
        ) : inspector)}
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
