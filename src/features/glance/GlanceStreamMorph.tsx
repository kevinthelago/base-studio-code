// GlanceStreamMorph (#2401, #2534) — a live agent node GROWING in place into its CLI session, IN the
// graph. The expanded terminal is a WORLD-LAYER child positioned at the node's world coords, so it pans,
// zooms, and scales WITH the graph (#2534, option A) — the rest of the fleet stays visible + interactive.
// No portal, no scrim: the graph never leaves; a node just gains a second state. The card animates world
// GEOMETRY (left/top/width/height) from the node's box to an expanded panel hosting the SAME
// GlanceChatDock (the real PTY stream — the terminal is the input surface, #3523). It's RESIZABLE from every EDGE and
// CORNER (standard window handles), in WORLD units (so it scales with zoom), and REPORTS its box up
// (`onRect`) so the canvas can push overlapping neighbour nodes out of the way (#2662). Esc or the dock's
// ✕ shrinks it back into the node. Reduced-motion → an instant swap (the CSS zeroes the transitions; the
// fallback timer still fires onClose). Closing UNMOUNTS the TerminalView, which keeps its PTY alive
// (cleanup is kill-free), so the agent is untouched.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { clampCell } from "./lib/morphGrid";
import { GlanceChatDock, type DockPlan } from "./GlanceChatDock";
import { NW, NH } from "./lib/glanceGraph";
import type { MorphRect } from "./lib/glancePush";

/** Grow/shrink duration (ms) — the reduced-motion fallback for onClose. Keep in sync with the
 *  `.glance-card` transition in glance.css. */
const EXIT_MS = 420;
// Card geometry lives in `lib/morphGrid` since #3361 — the SLOT the morph grows into is computed by the
// grid, and resize drives the grid's shared cell size rather than this one card's box.

/** The eight resize handles: which edges each grip drives, its box within the card, and its cursor. */
const HANDLES: { dir: string; style: CSSProperties }[] = (() => {
  const E = 8, C = 15;                                   // edge thickness · corner size (screen px)
  const ns = "ns-resize", ew = "ew-resize", nwse = "nwse-resize", nesw = "nesw-resize";
  return [
    { dir: "n",  style: { top: -E / 2, left: C, right: C, height: E, cursor: ns } },
    { dir: "s",  style: { bottom: -E / 2, left: C, right: C, height: E, cursor: ns } },
    { dir: "w",  style: { left: -E / 2, top: C, bottom: C, width: E, cursor: ew } },
    { dir: "e",  style: { right: -E / 2, top: C, bottom: C, width: E, cursor: ew } },
    { dir: "nw", style: { top: -E / 2, left: -E / 2, width: C, height: C, cursor: nwse } },
    { dir: "se", style: { bottom: -E / 2, right: -E / 2, width: C, height: C, cursor: nwse } },
    { dir: "ne", style: { top: -E / 2, right: -E / 2, width: C, height: C, cursor: nesw } },
    { dir: "sw", style: { bottom: -E / 2, left: -E / 2, width: C, height: C, cursor: nesw } },
  ];
})();

export function GlanceStreamMorph({ node, slot, paneId, name, role, plan, zoom = 1, onRect, onResizeCell, onClose, onEnd }: {
  /** The graph node this session belongs to — the card's origin + return box, in WORLD coords. */
  node: { x: number; y: number };
  /** The GRID SLOT this morph grows into (#3361), in world coords. For the FIRST opened node this is the
   *  cell centred on its own node, so a single open morph lands exactly where it always has; later
   *  morphs get the next slot of the grid anchored on that first one, which is what makes overlap
   *  impossible by construction. */
  slot: MorphRect;
  /** The agent's identity pane id (`<project>:<stream>`) — the live PTY the dock reconnects to. */
  paneId: string;
  name: string;
  role?: string;
  /** This worker's owned issues (#4102) — forwarded to the dock's Plan screen. */
  plan?: DockPlan;
  /** The graph's current zoom (`vp.view.scale`) — converts a screen-pixel resize drag into world units. */
  zoom?: number;
  /** Report the expanded world box (or null when collapsed/closed) so the canvas can push neighbours
   *  (#2662). With several morphs open the canvas unions every reported box (#3361). */
  onRect?: (rect: MorphRect | null) => void;
  /** A resize drag, in WORLD units — drives the grid's SHARED cell size, so every open morph resizes
   *  together (#3361). A per-morph size would let two cells grow into each other, breaking the
   *  non-overlap guarantee the grid exists to provide. */
  onResizeCell?: (w: number, h: number) => void;
  /** Collapse the morph back into its node (keeps the PTY alive). */
  onClose: () => void;
  /** END the session — kill the PTY + drop the cell from the live set (#3049) — for a soft-locked
   *  fleet the user needs to fully tear a stuck agent down before relaunching triage. Undefined ⇒
   *  the dock omits the affordance. */
  onEnd?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The expanded panel's world box IS its grid slot (#3361) — no longer local state. The grid owns
  // placement (so morphs can't overlap) and the shared cell size (so a resize moves them as one).
  // Collapsed, the card renders at the node box instead (see `box` below).
  const rect = slot;
  const [resizing, setResizing] = useState(false);
  const closingRef = useRef(false);
  // The pending grow→collapse→onClose timer. Held in a ref so we can CANCEL it if this morph unmounts
  // before it fires (#3049) — e.g. the user clicks another live node, which remounts a FRESH morph for
  // it (keyed by paneId). Without this, the old morph's delayed onClose (setChatNode(null)) fires ~420ms
  // later and clobbers the newly-grown node, collapsing everything instead of switching.
  const exitTimer = useRef<number | null>(null);

  // Grow to the expanded box on the next frame; the CSS transition tweens the world geometry.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Report the live box up while open; clear it on collapse + on unmount (so neighbours snap back).
  useEffect(() => {
    onRect?.(open && !closingRef.current ? rect : null);
  }, [open, rect, onRect]);
  useEffect(() => () => onRect?.(null), [onRect]);
  // Cancel a pending exit on unmount so a superseded morph's onClose can't fire after it's gone (#3049).
  useEffect(() => () => { if (exitTimer.current != null) window.clearTimeout(exitTimer.current); }, []);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    onRect?.(null);                       // release the neighbours immediately
    setOpen(false);                       // shrink back into the node
    exitTimer.current = window.setTimeout(onClose, EXIT_MS);  // unmount after the transition (or immediately, reduced-motion)
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A CLICK anywhere OUTSIDE the card closes it (#2537). We do NOT use a scrim — that would swallow the
  // graph's own gestures — so we listen at the window (capture phase, before any stopPropagation) and
  // decide on mouseUP: only a press-release that STAYED put is a click. A press that DRAGGED past the
  // viewport's own 4px pan threshold is a pan (or a terminal text-selection), so the graph keeps
  // panning/zooming/selecting and the card stays open.
  //
  // TWO kinds of press are exempt (#3365):
  //  • inside ANY `.glance-card` — every morph shares the class, so with several open a click in one
  //    card dismisses none of them (including this one).
  //  • on a graph NODE (`[data-glance-node]`) — clicking a node is a deliberate OPEN/SELECT gesture,
  //    not a dismiss. Without this, opening a second node tore down the first: the press on node B is
  //    outside A's card, so A closed the moment B opened, and only one morph was ever visible. That
  //    silently defeated the whole multi-open grid (#3361).
  // Empty canvas is neither, so a click on the backdrop still dismisses everything.
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const exempt = !!t?.closest(".glance-card") || !!t?.closest("[data-glance-node]");
      start = exempt ? null : { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: MouseEvent) => {
      if (!start) return;
      const moved = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
      start = null;
      if (moved <= 4) close(); // a click, not a drag/pan
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Edge/corner resize: track the pointer at the window (robust across the whole drag) and resize in
  // WORLD units — a screen-pixel delta ÷ the current zoom — so the terminal scales with the graph. The
  // geometry tween is suppressed WHILE dragging so it tracks the pointer 1:1.
  //
  // #3361: a drag now resizes the grid's SHARED CELL, not this one card, so every open morph grows
  // together and the grid stays a grid. A west/north drag therefore only INVERTS the delta (grow as the
  // pointer moves left/up) — it can no longer move the card's origin, which the slot owns.
  const startResize = (dir: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    const sx = e.clientX, sy = e.clientY, s = rect, z = zoom || 1;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      let { w, h } = s;
      if (dir.includes("e")) w = s.w + dx;
      if (dir.includes("w")) w = s.w - dx;
      if (dir.includes("s")) h = s.h + dy;
      if (dir.includes("n")) h = s.h - dy;
      const c = clampCell(w, h);
      onResizeCell?.(c.w, c.h);
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // World box: collapsed = the node's card; open = the resizable panel box.
  const box = open
    ? { left: rect.left, top: rect.top, width: rect.w, height: rect.h }
    : { left: node.x, top: node.y, width: NW, height: NH };

  return (
    // A world-layer child (absolute in world coords): pans/zooms/scales with the graph (#2534). Pointer
    // events stopPropagation so interacting with the terminal never starts a canvas pan / deselect.
    <Box
      className={`glance-card${open ? " open" : ""}`}
      role="dialog" aria-label={`${name} session`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, zIndex: 20,
        // While actively resizing, drop the geometry tween so the panel tracks the pointer 1:1.
        ...(resizing ? { transition: "none" } : null) }}
    >
      <Box className="glance-card-body">
        <GlanceChatDock paneId={paneId} name={name} role={role} plan={plan} onClose={close} onEnd={onEnd} />
      </Box>
      {open ? HANDLES.map((hnd) => (
        <Box
          key={hnd.dir}
          as="div"
          onPointerDown={startResize(hnd.dir)}
          aria-label={`Resize ${hnd.dir}`}
          style={{ position: "absolute", zIndex: 4, ...hnd.style }}
        />
      )) : null}
    </Box>
  );
}
