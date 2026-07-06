// GlanceStreamMorph (#2401) — presents a live agent node's CLI session as the node GROWING in place.
// A portal overlay that morphs from the clicked node's on-screen rect to an expanded panel hosting the
// SAME GlanceChatDock (the real PTY stream + a "message the agent" input). The morph animates GEOMETRY
// (left/top/width/height), never a scale — so the terminal text stays pixel-crisp the whole way. Esc,
// the scrim, or the dock's ✕ morphs it back to the node. Reduced-motion → an instant swap (the CSS zeroes
// the transitions; the fallback timer still fires onClose).
//
// The graph stays the entire UI: a node just gains a second state. Nothing new is mounted permanently —
// closing UNMOUNTS the TerminalView, which keeps its PTY alive (TerminalView cleanup is kill-free), so
// the agent is untouched.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box } from "@/shared/ui/layout/Box";
import { GlanceChatDock } from "./GlanceChatDock";

/** Panel transition duration (ms) — the reduced-motion / missing-node fallback for onClose. Keep in
 *  sync with the `.glance-morph-panel` transition in glance.css. */
const EXIT_MS = 420;

interface Rect { left: number; top: number; w: number; h: number }

export function GlanceStreamMorph({ nodeId, paneId, name, role, onClose }: {
  /** The graph node this session belongs to — the morph's origin + return rect (`[data-glance-node]`). */
  nodeId: string;
  /** The agent's identity pane id (`<project>:<stream>`) — the live PTY the dock reconnects to. */
  paneId: string;
  name: string;
  role?: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const closingRef = useRef(false);

  const nodeRect = (): DOMRect | null =>
    document.querySelector(`[data-glance-node="${CSS.escape(nodeId)}"]`)?.getBoundingClientRect() ?? null;

  // The expanded rect: a panel anchored toward the node's centre, clamped on-screen (never scaled).
  const targetRect = (): Rect => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(760, vw - 48);
    const h = Math.min(Math.round(vh * 0.64), vh - 96);
    const o = nodeRect();
    const cx = o ? o.left + o.width / 2 : vw / 2;
    const cy = o ? o.top + o.height / 2 : vh / 2;
    return {
      left: Math.max(24, Math.min(cx - w / 2, vw - 24 - w)),
      top: Math.max(24, Math.min(cy - h / 2, vh - 24 - h)),
      w, h,
    };
  };
  const setRect = (el: HTMLDivElement, r: Rect) => {
    el.style.left = `${r.left}px`; el.style.top = `${r.top}px`; el.style.width = `${r.w}px`; el.style.height = `${r.h}px`;
  };

  // Mount: start ON the node's rect (no transition), then grow to the target on the next frame.
  useLayoutEffect(() => {
    const el = panelRef.current; if (!el) return;
    const o = nodeRect();
    el.style.transition = "none";
    if (o) setRect(el, { left: o.left, top: o.top, w: o.width, h: o.height });
    else { const t = targetRect(); setRect(el, { left: t.left + t.w / 2 - 20, top: t.top + t.h / 2 - 20, w: 40, h: 40 }); }
    const id = requestAnimationFrame(() => {
      el.style.transition = "";  // re-enable the CSS transition
      setRect(el, targetRect());
      setOpen(true);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    const el = panelRef.current;
    const o = nodeRect();
    let fired = false;
    const fire = () => { if (fired) return; fired = true; onClose(); };
    if (el && o) {
      setRect(el, { left: o.left, top: o.top, w: o.width, h: o.height }); // shrink back to the node
      const onEnd = () => { el.removeEventListener("transitionend", onEnd); fire(); };
      el.addEventListener("transitionend", onEnd);
    }
    window.setTimeout(fire, EXIT_MS); // reduced-motion (no transitionend) or the node is gone
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <Box className={`glance-morph${open ? " open" : ""}`} role="dialog" aria-label={`${name} session`}>
      <Box className="glance-morph-scrim" onClick={close} />
      {/* eslint-disable-next-line no-restricted-syntax -- ref'd panel whose geometry (left/top/width/height)
          is measured + animated imperatively for the morph; a Box would obscure the direct ref/style access. */}
      <div className="glance-morph-panel" ref={panelRef}>
        <Box className="glance-morph-body">
          <GlanceChatDock paneId={paneId} name={name} role={role} onClose={close} />
        </Box>
      </div>
    </Box>,
    document.body,
  );
}
