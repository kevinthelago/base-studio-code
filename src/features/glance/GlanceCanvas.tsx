// Glance canvas (#2206) — the transform-based project-network graph: SVG dependency edges + project
// node cards. Renders the WORLD-LAYER content (grid + edges + nodes); the pan/zoom viewport frame is
// owned by the shared GraphCanvas template + useGraphViewport in the parent (#2208). Node = project;
// edge = dependency contract. The fixed hint/legend overlays are GlanceOverlays (drawn over, untransformed).
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { ROLE_COLOR, STATUS_META, EDGE_META, NW, NH, type GraphModel } from "./lib/glanceGraph";

const REST_N = 0.14, REST_E = 0.06;
const ROLE_ROWS: [string, string][] = [["infra", ROLE_COLOR.infra], ["service", ROLE_COLOR.service], ["data", ROLE_COLOR.data], ["client", ROLE_COLOR.client]];
const EDGE_ROWS: [string, string, string][] = [["api contract", EDGE_META.api.color, ""], ["data read", EDGE_META.data.color, ""], ["event stream", EDGE_META.events.color, "6 5"], ["cycle", "#f2555f", "7 6"]];

interface CanvasProps {
  model: GraphModel;
  /** True during a pan-drag — suppresses the click that ends it (from the shared viewport). */
  dragMoved: React.MutableRefObject<boolean>;
  focus: { nodes: Set<string>; edges: Set<string> } | null;
  selNodeId: string | null;
  selEdgeId: string | null;
  onHoverNode: (id: string | null) => void;
  onHoverEdge: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

/** The world-layer content — placed inside GraphCanvas's transformed world box. */
export function GlanceCanvas(p: CanvasProps) {
  const { model, focus } = p;
  // A node/edge click: suppressed after a pan-drag, and stopPropagation so it doesn't bubble to the
  // backdrop deselect (Glance nodes aren't [data-node]) (#2232).
  const click = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); if (!p.dragMoved.current) fn(); };

  return (
    <>
      {/* dotted grid */}
      <Box style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.6,
        backgroundImage: "radial-gradient(color-mix(in oklch, var(--fg) 12%, transparent) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />

      {/* edges */}
      <svg width={model.worldW} height={model.worldH} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        {model.edges.map((e) => {
          const meta = EDGE_META[e.kind];
          const inFocus = focus ? focus.edges.has(e.id) : true;
          const color = e.isCycle ? "#f2555f" : meta.color;
          const width = (e.isCycle ? 2.3 : meta.w) + (inFocus && focus ? 0.7 : 0);
          const dash = e.isCycle ? "7 6" : meta.dash;
          const opacity = e.isCycle ? (focus ? (inFocus ? 1 : 0.4) : 0.95) : (focus ? (inFocus ? 1 : REST_E) : 0.82);
          return (
            <g key={e.id} opacity={opacity} onMouseEnter={() => p.onHoverEdge(e.id)} onMouseLeave={() => p.onHoverEdge(null)} onClick={click(() => p.onSelectEdge(e.id))} style={{ cursor: "pointer", transition: "opacity .18s" }}>
              <path d={e.d} stroke="transparent" strokeWidth={16} fill="none" />
              <path d={e.d} stroke={color} strokeWidth={width} strokeDasharray={dash} fill="none" strokeLinecap="round"
                style={e.isCycle ? { animation: "glance-dashmove .75s linear infinite" } : undefined} />
              <path d={e.arrow} fill={color} />
            </g>
          );
        })}
      </svg>

      {/* nodes */}
      {model.nodes.map((n) => {
        const role = ROLE_COLOR[n.role], st = STATUS_META[n.status];
        const selected = p.selNodeId === n.id;
        const inFocus = focus ? focus.nodes.has(n.id) : true;
        const isCycle = model.cycleNodeIds.has(n.id);
        const border = selected ? "var(--accent)" : isCycle ? "color-mix(in oklch, #f2555f 55%, transparent)" : (focus && inFocus ? "var(--border)" : "var(--border-soft)");
        const faults = n.faults ?? 0; // #2265: unresolved runtime-fault count → corner badge
        return (
          <Box key={n.id} data-glance-node={n.id} onMouseEnter={() => p.onHoverNode(n.id)} onMouseLeave={() => p.onHoverNode(null)} onClick={click(() => p.onSelectNode(n.id))}
            style={{ position: "absolute", left: n.x, top: n.y, width: NW, height: NH, cursor: "pointer",
              zIndex: selected ? 6 : inFocus ? 3 : 1, opacity: focus ? (inFocus ? 1 : REST_N) : 1, transition: "opacity .18s ease" }}>
            <Box style={{ width: "100%", height: "100%", background: "var(--bg-elev)", border: `1px solid ${border}`,
              borderRadius: 9, padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center",
              boxShadow: selected ? "0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent)" : "0 2px 8px rgba(0,0,0,.45)", transition: "border-color .15s, box-shadow .15s" }}>
              <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Box style={{ width: 8, height: 8, borderRadius: "50%", background: st.color, flex: "none",
                  boxShadow: st.pulse ? `0 0 8px ${st.color}` : "none", animation: st.pulse ? "glance-softpulse 1.4s ease-in-out infinite" : "none" }} />
                <Text as="span" mono size={13} weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.slug}</Text>
              </Box>
              <Box style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
                <Text as="span" mono size={10} style={{ textTransform: "uppercase", letterSpacing: ".5px", color: role }}>{n.roleLabel ?? n.role}</Text>
                <Box style={{ flex: 1 }} />
                <Text as="span" mono size={10} weight={500} style={{ color: st.color }}>{st.label}</Text>
              </Box>
            </Box>
            {/* FAULT badge (#2265): unresolved runtime faults, top-right corner. Orthogonal to the
                liveness status dot (#2263), so it never fights the status/role coloring. */}
            {faults > 0 && (
              <Box title={`${faults} unresolved runtime fault${faults === 1 ? "" : "s"}`}
                style={{ position: "absolute", top: -7, right: -7, minWidth: 18, height: 18, padding: "0 5px",
                  display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 9,
                  background: "#f2555f", color: "#fff", fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700,
                  border: "1.5px solid var(--bg-elev)", boxShadow: "0 0 8px rgba(242,85,95,.55)", zIndex: 7 }}>
                {faults > 99 ? "99+" : faults}
              </Box>
            )}
          </Box>
        );
      })}
    </>
  );
}

/** The fixed hint + legend overlays — drawn over the canvas, not transformed. */
export function GlanceOverlays() {
  return (
    <>
      {/* hint */}
      <Box style={{ position: "absolute", left: 16, bottom: 16, pointerEvents: "none" }}>
        <Text as="div" mono size={10.5} tone="dim" style={{ lineHeight: 1.7 }}>drag to pan · scroll to zoom<br />click node → enter · click edge → contract</Text>
      </Box>

      {/* legend */}
      <Box style={{ position: "absolute", right: 16, bottom: 16, background: "color-mix(in oklch, var(--bg-elev) 85%, transparent)", backdropFilter: "blur(8px)",
        border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", pointerEvents: "none", display: "flex", gap: 22 }}>
        <Box>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", marginBottom: 8 }}>ROLE</Text>
          <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ROLE_ROWS.map(([label, color]) => (
              <Box key={label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Box style={{ width: 9, height: 3, borderRadius: 2, background: color }} />
                <Text as="span" mono size={10} tone="muted">{label}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        <Box>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", marginBottom: 8 }}>EDGE</Text>
          <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {EDGE_ROWS.map(([label, color, dash]) => (
              <Box key={label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <svg width={14} height={2} style={{ flex: "none", overflow: "visible" }}><line x1={0} y1={1} x2={14} y2={1} stroke={color} strokeWidth={2} strokeDasharray={dash} /></svg>
                <Text as="span" mono size={10} style={{ color: label === "cycle" ? "#f2848b" : "var(--fg-muted)" }}>{label}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </>
  );
}
