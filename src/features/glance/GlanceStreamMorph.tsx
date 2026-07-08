// GlanceStreamMorph (#2401, #2534) — a live agent node GROWING in place into its CLI session, IN the
// graph. The expanded terminal is a WORLD-LAYER child positioned at the node's world coords, so it pans,
// zooms, and scales WITH the graph (#2534, option A) — the rest of the fleet stays visible + interactive.
// No portal, no scrim: the graph never leaves; a node just gains a second state. The card animates world
// GEOMETRY (left/top/width/height) from the node's box to an expanded panel hosting the SAME
// GlanceChatDock (the real PTY stream + a "message the agent" input). It's RESIZABLE — a corner handle
// drags the panel bigger/smaller in WORLD units (so it stays part of the graph, scaling with zoom). Esc
// or the dock's ✕ shrinks it back into the node. Reduced-motion → an instant swap (the CSS zeroes the
// transitions; the fallback timer still fires onClose). Closing UNMOUNTS the TerminalView, which keeps
// its PTY alive (cleanup is kill-free), so the agent is untouched.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { clamp } from "@/shared/lib/core/math";
import { GlanceChatDock } from "./GlanceChatDock";
import { NW, NH } from "./lib/glanceGraph";

/** Grow/shrink duration (ms) — the reduced-motion fallback for onClose. Keep in sync with the
 *  `.glance-card` transition in glance.css. */
const EXIT_MS = 420;
/** The expanded panel's DEFAULT size, in WORLD units (it renders at world-size × the current zoom). */
const CARD_W = 760, CARD_H = 520;
/** Resize bounds (world units) — small enough to tuck beside a node, large enough for a full session. */
const MIN_W = 380, MIN_H = 280, MAX_W = 1600, MAX_H = 1100;

export function GlanceStreamMorph({ node, paneId, name, role, zoom = 1, onClose }: {
  /** The graph node this session belongs to — the card's origin + return box, in WORLD coords. */
  node: { x: number; y: number };
  /** The agent's identity pane id (`<project>:<stream>`) — the live PTY the dock reconnects to. */
  paneId: string;
  name: string;
  role?: string;
  /** The graph's current zoom (`vp.view.scale`) — converts a screen-pixel resize drag into world units. */
  zoom?: number;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ w: CARD_W, h: CARD_H });
  const [resizing, setResizing] = useState(false);
  const closingRef = useRef(false);

  // Grow to the expanded box on the next frame; the CSS transition tweens the world geometry.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);                       // shrink back into the node
    window.setTimeout(onClose, EXIT_MS);  // unmount after the transition (or immediately, reduced-motion)
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
  // panning/zooming/selecting and the card stays open. A press that starts inside the card is ignored.
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      start = (e.target as HTMLElement)?.closest(".glance-card") ? null : { x: e.clientX, y: e.clientY };
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

  // Corner-drag resize: track the pointer at the window (robust across the whole drag) and grow the panel
  // in WORLD units — a screen-pixel delta ÷ the current zoom — so the terminal scales with the graph, not
  // the viewport. The width/height CSS transition is suppressed WHILE dragging so it tracks the pointer.
  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX, startY = e.clientY, startW = size.w, startH = size.h;
    const z = zoom || 1;
    const move = (ev: PointerEvent) => setSize({
      w: clamp(startW + (ev.clientX - startX) / z, MIN_W, MAX_W),
      h: clamp(startH + (ev.clientY - startY) / z, MIN_H, MAX_H),
    });
    const up = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // World box: collapsed = the node's card; open = an expanded panel. Its top-left is anchored where the
  // DEFAULT-sized panel would centre on the node, and width/height grow from there — so a bottom-right
  // resize grows toward the bottom-right (natural) instead of ballooning symmetrically.
  const cx = node.x + NW / 2, cy = node.y + NH / 2;
  const box = open
    ? { left: cx - CARD_W / 2, top: cy - CARD_H / 2, width: size.w, height: size.h }
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
        // While actively resizing, drop the width/height tween so the panel tracks the pointer 1:1.
        ...(resizing ? { transition: "none" } : null) }}
    >
      <Box className="glance-card-body">
        <GlanceChatDock paneId={paneId} name={name} role={role} onClose={close} />
      </Box>
      {open ? (
        <Box
          as="div"
          onPointerDown={onResizeDown}
          aria-label="Resize terminal"
          title="Drag to resize"
          style={{ position: "absolute", right: 2, bottom: 2, width: 18, height: 18, cursor: "nwse-resize",
            zIndex: 3, color: "var(--fg-muted)", display: "flex", alignItems: "flex-end", justifyContent: "flex-end",
            fontSize: 13, lineHeight: 1, userSelect: "none" }}
        >◢</Box>
      ) : null}
    </Box>
  );
}
