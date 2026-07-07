// GlanceStreamMorph (#2401, #2534) — a live agent node GROWING in place into its CLI session, IN the
// graph. The expanded terminal is a WORLD-LAYER child positioned at the node's world coords, so it pans,
// zooms, and scales WITH the graph (#2534, option A) — the rest of the fleet stays visible + interactive.
// No portal, no scrim: the graph never leaves; a node just gains a second state. The card animates world
// GEOMETRY (left/top/width/height) from the node's box to an expanded panel hosting the SAME
// GlanceChatDock (the real PTY stream + a "message the agent" input). Esc or the dock's ✕ shrinks it back
// into the node. Reduced-motion → an instant swap (the CSS zeroes the transitions; the fallback timer
// still fires onClose). Closing UNMOUNTS the TerminalView, which keeps its PTY alive (cleanup is
// kill-free), so the agent is untouched.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { GlanceChatDock } from "./GlanceChatDock";
import { NW, NH } from "./lib/glanceGraph";

/** Grow/shrink duration (ms) — the reduced-motion fallback for onClose. Keep in sync with the
 *  `.glance-card` transition in glance.css. */
const EXIT_MS = 420;
/** The expanded panel size, in WORLD units (it renders at world-size × the current zoom). ~3× a node. */
const CARD_W = 560, CARD_H = 380;

export function GlanceStreamMorph({ node, paneId, name, role, onClose }: {
  /** The graph node this session belongs to — the card's origin + return box, in WORLD coords. */
  node: { x: number; y: number };
  /** The agent's identity pane id (`<project>:<stream>`) — the live PTY the dock reconnects to. */
  paneId: string;
  name: string;
  role?: string;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
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

  // World box: collapsed = the node's card; open = an expanded panel centered on the node's centre.
  const cx = node.x + NW / 2, cy = node.y + NH / 2;
  const box = open
    ? { left: cx - CARD_W / 2, top: cy - CARD_H / 2, width: CARD_W, height: CARD_H }
    : { left: node.x, top: node.y, width: NW, height: NH };

  return (
    // A world-layer child (absolute in world coords): pans/zooms/scales with the graph (#2534). Pointer
    // events stopPropagation so interacting with the terminal never starts a canvas pan / deselect.
    <Box
      className={`glance-card${open ? " open" : ""}`}
      role="dialog" aria-label={`${name} session`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, zIndex: 20 }}
    >
      <Box className="glance-card-body">
        <GlanceChatDock paneId={paneId} name={name} role={role} onClose={close} />
      </Box>
    </Box>
  );
}
