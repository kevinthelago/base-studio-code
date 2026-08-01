// GraphCanvas — the Layouts-tier template for a pan/zoom graph page (#2208, epic #2197 slice 2). The
// standardized shell every graph workspace shares: an optional left RAIL and right INSPECTOR that run
// FULL HEIGHT, flanking a content column whose TOOLBAR sits only over the CANVAS (the viewport-clip
// element + the transformed "world" layer), with an optional bottom DOCK strip below the canvas. The
// rail/inspector are full-height siblings of the content column — the toolbar spans the canvas, not
// the rail/inspector (#2754, matching the Designs workbench). It owns the frame — the viewport
// ref/wheel/pan wiring, the world-layer transform, overflow/cursor — so a graph page brings only its
// world content (grid/edges/nodes), its toolbar controls, and its rail/inspector. The viewport itself
// is created by the page via useGraphViewport and passed in as `vp`, so the page keeps its own
// fit/persist effects and the toolbar can read zoom.
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
import { ProfiledRegion } from "@/shared/lib/core/renderProfiler";
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
  /** Optional strip docked BELOW the canvas (inside the content column, `flex: none`), e.g. a docked
   *  session terminal (#2755). The caller owns its height + any resize handle — GraphCanvas just gives
   *  it the slot. Nothing renders here when absent. */
  dock?: ReactNode;
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
  /** #3618: id for the render Profiler wrapped around this graph — logs slow commits to the app log
   *  tagged by graph (glance/designs/algorithms/…). Defaults to `className`, else "graph". */
  profileId?: string;
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
  vp, world, toolbar, children, rail, inspector, dock, overlays,
  grid = false, gridSize = 24, gridColor = "color-mix(in oklch, var(--fg) 8%, transparent)",
  canvasBackground, className, profileId,
  railResizable = false, railWidth = 260, railMin = 200, railMax = 460,
  inspectorResizable = false, inspectorWidth = 344, inspectorMin = 260, inspectorMax = 620,
  onBackgroundClick,
}: GraphCanvasProps) {
  // Pull the plain viewport values out as locals — worldTransform is a computed style object, not a
  // ref, so reading it (and the callback refs) here keeps the render free of ref-access.
  const { setVp, setWorld, onCanvasDown, worldTransform } = vp;
  // The infinite grid lives on the viewport (untransformed) so it fills the whole visible area, and it is
  // STATIC (#4142): a fixed dot field that neither pans nor scales.
  //
  // It used to track world coords by reading `view.tx/ty/scale`. #4140 stopped the drag from calling
  // `setView` per mousemove — the world layer's transform is written imperatively and committed once, on
  // mouseup — so a state-keyed grid stopped moving DURING the drag and then jumped when the commit
  // landed. Pinning it to the viewport instead of the world removes the coupling outright rather than
  // adding a second imperative write path for a parallax cue; it also drops the last reason this
  // component reads `view` on the render path.
  const gridStyle: CSSProperties | undefined = grid ? {
    position: "absolute", inset: 0, pointerEvents: "none",
    backgroundImage: `radial-gradient(${gridColor} 1px, transparent 1px)`,
    backgroundSize: `${gridSize}px ${gridSize}px`,
  } : undefined;
  // Hooks always run (rules of hooks); the live size only drives a column when that side is resizable.
  const railDrag = useDragResize({ initial: railWidth, min: railMin, max: railMax, axis: "x" });
  const inspDrag = useDragResize({ initial: inspectorWidth, min: inspectorMin, max: inspectorMax, axis: "x", invert: true });
  // A side-pane box. `shrink` 0 = rigid (holds its width — the priority pane); 1 = yields when the row
  // is too narrow to hold rail + inspector + graph, so nothing overflows off the right edge (#3097).
  const paneBox = (size: number, shrink = 0): CSSProperties => ({ flex: `0 ${shrink} ${size}px`, width: size, minWidth: 0, display: "flex", overflow: "hidden" });
  return (
    // #3618: ProfiledRegion logs slow commits of this graph (tagged) to the app log — the fix stays inert
    // (quiet) unless a graph render exceeds one frame, so it pinpoints a laggy graph without spamming.
    <ProfiledRegion id={profileId ?? className ?? "graph"}>
    {/* rail · content-column · inspector — the rail/inspector run FULL HEIGHT (siblings of the content
        column) so the toolbar spans only the canvas, not the whole page (#2754). minWidth:0 keeps the flex
        shrink chain intact (with KeptMountedPage above): without it this Row pins to the graph's intrinsic
        width, can't shrink, and pushes the inspector off the right edge (#3097). Load-bearing — don't drop. */}
    <Row gap={0} align="stretch" className={className} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      {rail && (railResizable ? (
        <>
          {/* The rail YIELDS (shrink 1) so the inspector keeps its width on a narrow window (#3097): the
              graph column collapses first, then the rail; the inspector stays put and never gets pushed
              off the right edge. */}
          <Box style={paneBox(railDrag.size, 1)}>{rail}</Box>
          <Box className="resize-x" {...railDrag.handleProps} title="Drag to resize" />
        </>
      ) : rail)}

      {/* ── content column: toolbar (over the canvas only) · canvas · optional dock. overflow:hidden WRAPS
          the graph + terminal so their content can't spill past the (shrinking) column into a horizontal
          overflow — the column yields width to the side panes cleanly instead (#3097). ── */}
      <Stack gap={0} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        {/* ── toolbar ── omitted entirely (no empty 52px bar) when the page passes none, so a page can
            hand the whole content column to a full-canvas overlay (#2849, Design Studio theme preview). */}
        {toolbar ? (
          <Row gap={16} align="center" style={{ height: 52, flex: "none", padding: "0 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)" }}>
            {toolbar}
          </Row>
        ) : null}

        {/* The pan/zoom viewport: a raw div for the native wheel listener + backdrop mousedown. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- pan/zoom canvas (pointer-driven); graph nodes are separately interactive */}
        <div ref={setVp} onMouseDown={onCanvasDown}
          onClick={onBackgroundClick ? (e) => {
            // A genuine backdrop click — ignore the end of a pan-drag and any node press.
            if (vp.dragMoved.current) return;
            if ((e.target as HTMLElement).closest("[data-node]")) return;
            onBackgroundClick();
          } : undefined}
          style={{ position: "relative", flex: 1, overflow: "hidden", cursor: "grab", minWidth: 0, minHeight: 0, background: canvasBackground ?? "var(--bg)" }}>
          {gridStyle && <div style={gridStyle} />}
          {/* No text selection of node labels / edges on click or drag (#2527) — shared here so every
              graph (Org · Glance · Design Studio) is covered in one place. Inspector/toolbar text (outside
              the world layer) stays selectable. */}
          {/* NO `will-change: transform` here (#graph-zoom-blur): it pins the world layer to a GPU
              texture rasterized at 100%, so zooming IN just stretches that texture → blurry cards/text
              (the HTML node divs; the SVG edges are vector, so they stayed crisp). Without it the
              browser re-rasterizes the layer at the settled zoom, so text is sharp at every level. */}
          {/* #4140: a raw div (like the viewport above) because `setWorld` needs a REAL DOM ref — Box
              does not forward one — so a pan can write this element's transform DIRECTLY, with no React
              render per mousemove. `worldTransform` stays for the initial/committed paint; both go
              through `viewTransform`, so the two paths cannot disagree on the string. */}
          {/* eslint-disable-next-line no-restricted-syntax -- needs a real DOM ref for the imperative pan transform (#4140) */}
          <div ref={setWorld} style={{ position: "absolute", left: 0, top: 0, width: world.w, height: world.h, userSelect: "none", ...worldTransform }}>
            {children}
          </div>
          {overlays}
        </div>

        {/* ── dock: an optional strip below the canvas (e.g. a docked session terminal #2755). The
            caller owns its height + any resize handle; GraphCanvas just gives it a flex:none slot. ── */}
        {dock && <Box style={{ flex: "none" }}>{dock}</Box>}
      </Stack>

      {inspector && (inspectorResizable ? (
        <>
          <Box className="resize-x" {...inspDrag.handleProps} title="Drag to resize" />
          <Box style={paneBox(inspDrag.size)}>{inspector}</Box>
        </>
      ) : inspector)}
    </Row>
    </ProfiledRegion>
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
