// The org canvas (#2193) — the relationship graph: nodes (positions) + curved edges (relationships) in
// a zoomable design-space stage, ported from the Claude Design prototype onto the app's tokens + kit.
// Pure geometry lives in orgLayout.ts; view metadata in orgView.ts — this file is the renderer.
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { RELATIONSHIP_ARCHETYPES, archetypeById, type Org } from "./lib/org";
import { CANVAS_W, CANVAS_H, nodeBox, edgeGeometry, styleDash } from "./lib/orgLayout";
import { positionDisplay, hueColor } from "./lib/orgView";
import { TierChips } from "./components";
import type { Persona } from "@/features/personas";

export interface Selection { type: "node" | "edge"; id: string }

interface CanvasProps {
  org: Org;
  personas: Persona[];
  sel: Selection;
  zoom: number;
  gridOn: boolean;
  legendOn: boolean;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (relId: string) => void;
}

export function OrgCanvas({ org, personas, sel, zoom, gridOn, legendOn, onSelectNode, onSelectEdge }: CanvasProps) {
  const boxes = new Map(org.positions.map((p) => [p.nodeId, nodeBox(p)]));

  const nodeActive = (id: string): boolean => {
    if (sel.type === "node") return id === sel.id;
    const e = org.relationships.find((r) => r.id === sel.id);
    return !!e && (e.from === id || e.to === id);
  };
  const edgeActive = (relId: string, from: string, to: string): boolean => {
    if (sel.type === "edge") return relId === sel.id;
    return from === sel.id || to === sel.id;
  };

  return (
    <Box id="orgCanvas" style={{ flex: 1, position: "relative", overflow: "auto", background: "var(--bg)", minWidth: 0, display: "flex" }}>
      <Box style={{ position: "relative", width: CANVAS_W * zoom, height: CANVAS_H * zoom, margin: "auto", flex: "none" }}>
        <Box style={{ position: "absolute", top: 0, left: 0, width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})`, transformOrigin: "top left" }}>
          {gridOn && (
            <Box style={{ position: "absolute", inset: 0, pointerEvents: "none",
              backgroundImage: "radial-gradient(color-mix(in oklch, var(--fg) 8%, transparent) 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
          )}

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
              const A = boxes.get(r.from), B = boxes.get(r.to);
              const arch = archetypeById(r.archetype);
              if (!A || !B || !arch) return null;
              const { d } = edgeGeometry(A, B, r.bow ?? 0);
              const act = edgeActive(r.id, r.from, r.to);
              const isSelEdge = sel.type === "edge" && r.id === sel.id;
              const color = hueColor(arch.hue);
              return (
                <g key={r.id}>
                  {/* fat invisible hit target */}
                  <path d={d} fill="none" stroke="transparent" strokeWidth={18} style={{ cursor: "pointer" }} onClick={() => onSelectEdge(r.id)} />
                  <path d={d} fill="none" stroke={color} strokeWidth={isSelEdge ? 2.8 : act ? 2 : 1.7}
                    strokeDasharray={styleDash(arch.style)} strokeLinecap="round"
                    markerEnd="url(#org-ah)" markerStart={arch.bidirectional ? "url(#org-ah-s)" : undefined}
                    opacity={act ? 1 : 0.26} style={{ cursor: "pointer", transition: "opacity .15s" }} onClick={() => onSelectEdge(r.id)} />
                </g>
              );
            })}
          </svg>

          {/* edge labels */}
          <Box style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {org.relationships.map((r) => {
              const A = boxes.get(r.from), B = boxes.get(r.to);
              const arch = archetypeById(r.archetype);
              if (!A || !B || !arch) return null;
              const { lx, ly } = edgeGeometry(A, B, r.bow ?? 0);
              const act = edgeActive(r.id, r.from, r.to);
              const color = hueColor(arch.hue);
              return (
                <Box key={r.id} onClick={() => onSelectEdge(r.id)}
                  style={{ position: "absolute", left: lx, top: ly, transform: "translate(-50%,-50%)",
                    display: "inline-flex", alignItems: "center", gap: 5, padding: "2.5px 8px", borderRadius: 999,
                    background: "var(--bg-elev)", border: `1px solid ${color}`, color: "var(--fg)", fontSize: 10, fontWeight: 600,
                    whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer", opacity: act ? 1 : 0.32, transition: "opacity .15s" }}>
                  <Box style={{ width: 6, height: 6, borderRadius: "50%", background: color, flex: "none" }} />
                  {arch.label}
                </Box>
              );
            })}
          </Box>

          {/* nodes */}
          {org.positions.map((pos) => {
            const box = boxes.get(pos.nodeId)!;
            const d = positionDisplay(pos, personas);
            const isSel = sel.type === "node" && sel.id === pos.nodeId;
            const dim = !nodeActive(pos.nodeId);
            return (
              <Box key={pos.nodeId} onClick={() => onSelectNode(pos.nodeId)}
                style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
                  cursor: "pointer", zIndex: isSel ? 6 : 3, opacity: dim ? 0.5 : 1, transition: "opacity .15s" }}>
                {pos.kind === "agent" && (
                  <Box style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: "10px 12px",
                    display: "flex", flexDirection: "column", gap: 8, borderRadius: 13, background: "var(--bg-elev)",
                    border: `1px solid ${isSel ? "var(--accent)" : "var(--border)"}`,
                    boxShadow: isSel ? "0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent)" : "0 3px 12px rgba(0,0,0,.3)" }}>
                    <Row gap={9} align="start">
                      <Box style={{ width: 27, height: 27, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, color: isSel ? "#fff" : "var(--accent)", background: isSel ? "var(--accent)" : "color-mix(in oklch, var(--accent) 14%, transparent)", flex: "none" }}>{d.glyph}</Box>
                      <Box style={{ minWidth: 0, flex: 1 }}>
                        <Text as="div" weight={600} size={13.5} style={{ lineHeight: 1.15 }}>{d.name}</Text>
                        <Text as="div" size={10.5} tone="muted" style={{ lineHeight: 1.3, marginTop: 2 }}>{d.blurb}</Text>
                      </Box>
                    </Row>
                    {d.role && <TierChips role={d.role} />}
                  </Box>
                )}
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
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* legend */}
      {legendOn && (
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
      )}
    </Box>
  );
}
