// The org canvas (#2193, interactive #2199) — the relationship graph: nodes (positions) + curved edges
// (relationships). Renders the WORLD-LAYER content (grid + edges + labels + nodes) and owns NODE-DRAG
// (a local preview that commits to the store on drop). The pan/zoom viewport frame is owned by the
// shared GraphCanvas template + useGraphViewport in the parent (#2208, epic #2197 slice 2) — a press
// on a node's `[data-node]` element does not start a background pan. Pure geometry lives in
// orgLayout.ts, view metadata in orgView.ts. The relationship legend is OrgLegend (a fixed overlay).
import { useRef, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { RELATIONSHIP_ARCHETYPES, archetypeById, type Org } from "./lib/org";
import { CANVAS_W, CANVAS_H, nodeBox, edgeGeometry, styleDash } from "./lib/orgLayout";
import { positionDisplay, hueColor, type PositionDisplay } from "./lib/orgView";
import { Chip } from "@/shared/ui/data/Chip";
import type { Pool } from "./lib/orgPools";
import type { Persona } from "@/features/personas";

export interface Selection { type: "node" | "edge"; id: string }

interface CanvasProps {
  org: Org;
  personas: Persona[];
  sel: Selection;
  /** Current viewport scale — converts a client-pixel drag delta into design-space. */
  scale: number;
  /** Connect-mode is active — a node press is a connect click, never a drag. */
  connecting: boolean;
  /** True during a background pan-drag — suppresses the edge click that ends it. */
  dragMoved: React.MutableRefObject<boolean>;
  /** Synthetic pool nodes (a collapsed swarm) keyed by nodeId — rendered as stacked cards that drill in
   *  instead of select/drag. Empty inside a pool's own sub-graph. */
  poolInfo?: Record<string, Pool>;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (relId: string) => void;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  /** Enter a pool's own graph (clicking its stacked card). */
  onDrillPool?: (poolNodeId: string) => void;
  /** Right-click a node/edge → open the canvas context menu (delete, …). #2385. */
  onContext?: (sel: Selection, e: React.MouseEvent) => void;
}

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag (vs a click)

/** The agent card face (glyph · name + role pill · blurb) — shared by a normal agent node and the top
 *  card of a pool's stack. */
function AgentFace({ d, isSel }: { d: PositionDisplay; isSel: boolean }) {
  return (
    <Box style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 8, borderRadius: 13, background: "var(--bg-elev)",
      border: `1px solid ${isSel ? "var(--accent)" : "var(--border)"}`,
      boxShadow: isSel ? "0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent)" : "0 3px 12px rgba(0,0,0,.3)" }}>
      <Row gap={9} align="start">
        <Box style={{ width: 27, height: 27, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, color: isSel ? "#fff" : "var(--accent)", background: isSel ? "var(--accent)" : "color-mix(in oklch, var(--accent) 14%, transparent)", flex: "none" }}>{d.glyph}</Box>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Row gap={6} align="center">
            <Text as="span" weight={600} size={13.5} style={{ lineHeight: 1.15, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</Text>
            {d.role && <Chip color="var(--accent)" style={{ flex: "none" }}>{d.role}</Chip>}
          </Row>
          <Text as="div" size={10.5} tone="muted" style={{ lineHeight: 1.3, marginTop: 2 }}>{d.blurb}</Text>
        </Box>
      </Row>
    </Box>
  );
}

/** The world-layer content — placed inside GraphCanvas's transformed world box. */
export function OrgCanvas(props: CanvasProps) {
  const { org, personas, sel, scale, connecting, dragMoved, poolInfo,
    onSelectNode, onSelectEdge, onMoveNode, onDrillPool, onContext } = props;
  /** Right-click a node/edge → open the context menu at the cursor (delete). */
  const context = (s: Selection) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onContext?.(s, e); };

  const boxes = new Map(org.positions.map((p) => [p.nodeId, nodeBox(p)]));
  // Live node-drag preview (design-space x/y). Commits to the store on drop.
  const [drag, setDrag] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const gesture = useRef<{ nodeId: string; sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);
  // A pool card's press is a drill (a click), never a drag — its own tiny gesture tracks click-vs-drag.
  const poolGesture = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
  const onPoolDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    poolGesture.current = { sx: e.clientX, sy: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPoolMove = (e: React.PointerEvent) => {
    const g = poolGesture.current;
    if (g && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > DRAG_THRESHOLD) g.moved = true;
  };
  const onPoolUp = (poolNodeId: string) => (e: React.PointerEvent) => {
    const g = poolGesture.current;
    poolGesture.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (g && !g.moved) onDrillPool?.(poolNodeId);
  };

  /** The x/y to render a node at — its live drag preview if being dragged, else its stored box. */
  const at = (nodeId: string) => (drag?.nodeId === nodeId ? drag : boxes.get(nodeId)!);
  /** The box for edge geometry, with the (possibly dragged) live position substituted in. */
  const liveBox = (nodeId: string) => ({ ...boxes.get(nodeId)!, ...at(nodeId) });

  /** An edge click, suppressed if a background pan-drag just ended over it. stopPropagation so it
   *  doesn't bubble to the canvas backdrop's deselect handler (#2230). */
  const edgeClick = (relId: string) => (e: React.MouseEvent) => { e.stopPropagation(); if (!dragMoved.current) onSelectEdge(relId); };

  // Whether something is actually selected. The empty sentinel {type:"node", id:""} means "nothing
  // focused" (a background-click deselect, or a pool drill) — then the whole graph renders at full
  // opacity rather than dimming everything (#2230).
  const focused = !(sel.type === "node" && sel.id === "");

  const nodeActive = (id: string): boolean => {
    if (sel.type === "node") return id === sel.id;
    const e = org.relationships.find((r) => r.id === sel.id);
    return !!e && (e.from === id || e.to === id);
  };
  const edgeActive = (from: string, to: string): boolean =>
    sel.type === "edge" ? false : from === sel.id || to === sel.id;

  const onNodeDown = (nodeId: string) => (e: React.PointerEvent) => {
    e.stopPropagation(); // don't start a background pan
    const b = boxes.get(nodeId)!;
    gesture.current = { nodeId, sx: e.clientX, sy: e.clientY, bx: b.x, by: b.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onNodeMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || connecting) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < DRAG_THRESHOLD) return;
    g.moved = true;
    setDrag({ nodeId: g.nodeId, x: Math.round(g.bx + (e.clientX - g.sx) / scale), y: Math.round(g.by + (e.clientY - g.sy) / scale) });
  };
  const onNodeUp = (nodeId: string) => (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    setDrag(null);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (g && g.moved && !connecting) onMoveNode(nodeId, Math.round(g.bx + (e.clientX - g.sx) / scale), Math.round(g.by + (e.clientY - g.sy) / scale));
    else onSelectNode(nodeId); // a click (also drives connect-mode)
  };

  return (
    <>
      {/* The dotted graph-paper backdrop is owned by the shared GraphCanvas (an infinite viewport grid),
          so it fills the whole canvas instead of stopping at the world box this content overflows. */}

      {/* edges */}
      <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} style={{ position: "absolute", left: 0, top: 0, width: CANVAS_W, height: CANVAS_H, overflow: "visible" }}>
        <defs>
          <marker id="org-ah" markerWidth={10} markerHeight={10} refX={7} refY={3.4} orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L7.5,3.4 L0,6.8 Z" fill="context-stroke" />
          </marker>
          <marker id="org-ah-s" markerWidth={10} markerHeight={10} refX={7} refY={3.4} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0,0 L7.5,3.4 L0,6.8 Z" fill="context-stroke" />
          </marker>
        </defs>
        {org.relationships.map((r) => {
          const arch = archetypeById(r.archetype);
          if (!arch || !boxes.get(r.from) || !boxes.get(r.to)) return null;
          const { d } = edgeGeometry(liveBox(r.from), liveBox(r.to), r.bow ?? 0);
          const act = edgeActive(r.from, r.to);
          const isSelEdge = sel.type === "edge" && r.id === sel.id;
          const color = hueColor(arch.hue);
          return (
            <g key={r.id}>
              <path d={d} fill="none" stroke="transparent" strokeWidth={18} style={{ cursor: "pointer" }} onClick={edgeClick(r.id)} onContextMenu={context({ type: "edge", id: r.id })} />
              <path d={d} fill="none" stroke={color} strokeWidth={isSelEdge ? 2.8 : act ? 2 : 1.7}
                strokeDasharray={styleDash(arch.style)} strokeLinecap="round"
                markerEnd="url(#org-ah)" markerStart={arch.bidirectional ? "url(#org-ah-s)" : undefined}
                opacity={!focused ? 1 : (isSelEdge || act ? 1 : 0.26)} style={{ cursor: "pointer", transition: "opacity .15s" }} onClick={edgeClick(r.id)} />
            </g>
          );
        })}
      </svg>

      {/* edge labels */}
      <Box style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {org.relationships.map((r) => {
          const arch = archetypeById(r.archetype);
          if (!arch || !boxes.get(r.from) || !boxes.get(r.to)) return null;
          const { lx, ly } = edgeGeometry(liveBox(r.from), liveBox(r.to), r.bow ?? 0);
          const act = edgeActive(r.from, r.to);
          const isSelEdge = sel.type === "edge" && r.id === sel.id;
          const color = hueColor(arch.hue);
          return (
            <Box key={r.id} onClick={edgeClick(r.id)} onContextMenu={context({ type: "edge", id: r.id })}
              style={{ position: "absolute", left: lx, top: ly, transform: "translate(-50%,-50%)",
                display: "inline-flex", alignItems: "center", gap: 5, padding: "2.5px 8px", borderRadius: 999,
                background: "var(--bg-elev)", border: `1px solid ${color}`, color: "var(--fg)", fontSize: 10, fontWeight: 600,
                whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer", opacity: !focused ? 1 : (isSelEdge || act ? 1 : 0.32), transition: "opacity .15s" }}>
              <Box style={{ width: 6, height: 6, borderRadius: "50%", background: color, flex: "none" }} />
              {arch.label}
            </Box>
          );
        })}
      </Box>

      {/* nodes */}
      {org.positions.map((pos) => {
        const xy = at(pos.nodeId);
        const box = boxes.get(pos.nodeId)!;
        const d = positionDisplay(pos, personas);
        const isSel = sel.type === "node" && sel.id === pos.nodeId;
        const dim = focused && !nodeActive(pos.nodeId);
        const pool = poolInfo?.[pos.nodeId];

        // A pool: a stacked card (offset shadow cards behind + a ×N badge). A press drills into the
        // pool's own graph rather than selecting/dragging.
        if (pool) {
          return (
            // eslint-disable-next-line no-restricted-syntax -- data-node marks it as owning its own press gesture (no background pan)
            <div key={pos.nodeId} data-node={pos.nodeId}
              onPointerDown={onPoolDown} onPointerMove={onPoolMove} onPointerUp={onPoolUp(pos.nodeId)}
              style={{ position: "absolute", left: xy.x, top: xy.y, width: box.w, height: box.h,
                cursor: "pointer", zIndex: isSel ? 6 : 3, opacity: dim ? 0.5 : 1, transition: "opacity .15s", touchAction: "none" }}>
              {/* stacked shadow cards behind the face — the "N of them" cue */}
              <Box style={{ position: "absolute", inset: 0, transform: "translate(11px,11px)", borderRadius: 13, background: "var(--bg-elev)", border: "1px solid var(--border)", opacity: 0.45 }} />
              <Box style={{ position: "absolute", inset: 0, transform: "translate(6px,6px)", borderRadius: 13, background: "var(--bg-elev)", border: "1px solid var(--border)", opacity: 0.7 }} />
              <Box style={{ position: "relative", width: "100%", height: "100%" }}><AgentFace d={d} isSel={isSel} /></Box>
              {/* ×N badge + a drill hint */}
              <Box style={{ position: "absolute", top: -9, right: -9, minWidth: 22, height: 22, padding: "0 6px", borderRadius: 11,
                background: "var(--accent)", color: "var(--bg-canvas)", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,.35)" }}>×{pool.count}</Box>
              <Text as="div" mono size={8.5} tone="dim" style={{ position: "absolute", left: 0, right: 0, bottom: -14, textAlign: "center", pointerEvents: "none" }}>click to open pool</Text>
            </div>
          );
        }

        return (
          // eslint-disable-next-line no-restricted-syntax -- node needs the data-node marker + pointer-capture on the element for drag
          <div key={pos.nodeId} data-node={pos.nodeId}
            onPointerDown={onNodeDown(pos.nodeId)} onPointerMove={onNodeMove} onPointerUp={onNodeUp(pos.nodeId)}
            onContextMenu={context({ type: "node", id: pos.nodeId })}
            style={{ position: "absolute", left: xy.x, top: xy.y, width: box.w, height: box.h,
              cursor: connecting ? "crosshair" : "grab", zIndex: isSel ? 6 : 3, opacity: dim ? 0.5 : 1, transition: drag ? "none" : "opacity .15s", touchAction: "none" }}>
            {pos.kind === "agent" && <AgentFace d={d} isSel={isSel} />}
            {pos.kind === "resource" && (
              <Box style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: "11px 13px", display: "flex", flexDirection: "column", justifyContent: "center",
                clipPath: "polygon(12% 0,88% 0,100% 50%,88% 100%,12% 100%,0 50%)",
                background: isSel ? hueColor(340, 0.5, 0.09) : "color-mix(in oklch, var(--fg) 4%, transparent)",
                border: `1px solid ${isSel ? hueColor(340) : "var(--border)"}` }}>
                <Text as="span" mono size={9} tone="dim" style={{ letterSpacing: ".1em", textTransform: "uppercase" }}>Resource</Text>
                <Row gap={7} align="center" style={{ marginTop: 3 }}>
                  <Text as="span" style={{ fontSize: 15, color: hueColor(340) }}>{d.glyph}</Text>
                  <Text as="span" weight={600} size={13}>{d.name}</Text>
                </Row>
              </Box>
            )}
            {pos.kind === "external" && (
              <Box style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: "11px 13px", display: "flex", flexDirection: "column", justifyContent: "center",
                borderRadius: 12, background: "color-mix(in oklch, var(--fg) 2%, transparent)",
                border: `1.5px dashed ${isSel ? "var(--accent)" : "var(--border)"}` }}>
                <Text as="span" mono size={9} tone="dim" style={{ letterSpacing: ".1em", textTransform: "uppercase" }}>External · person</Text>
                <Row gap={8} align="center" style={{ marginTop: 4 }}>
                  <Box style={{ width: 22, height: 22, borderRadius: "50%", border: "1.5px dashed var(--fg-dim)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--fg-muted)" }}>{d.glyph}</Box>
                  <Text as="span" weight={600} size={13}>{d.name}</Text>
                </Row>
              </Box>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The relationship legend — a fixed overlay (bottom-left), not transformed with the world. */
export function OrgLegend() {
  return (
    <Box style={{ position: "absolute", left: 16, bottom: 16, background: "color-mix(in oklch, var(--bg-elev) 92%, transparent)",
      backdropFilter: "blur(8px)", border: "1px solid var(--border-soft)", borderRadius: 11, padding: "11px 13px",
      display: "flex", flexDirection: "column", gap: 7, boxShadow: "0 8px 24px rgba(0,0,0,.4)" }}>
      <Text as="span" className="ulabel" tone="dim" size={9} style={{ marginBottom: 2 }}>Relationships</Text>
      {RELATIONSHIP_ARCHETYPES.map((a) => (
        <Row key={a.id} gap={9} align="center">
          <svg width={30} height={8} style={{ flex: "none", overflow: "visible" }}>
            <line x1={1} y1={4} x2={29} y2={4} stroke={hueColor(a.hue)} strokeWidth={a.style === "dotted" ? 1.9 : 1.7} strokeDasharray={styleDash(a.style)} strokeLinecap="round" />
          </svg>
          <Text as="span" size={11} weight={500} style={{ width: 66 }}>{a.label}</Text>
          <Text as="span" mono size={9.5} tone="dim">{a.fromLabel} → {a.toLabel}</Text>
        </Row>
      ))}
    </Box>
  );
}
