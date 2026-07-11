// ForceGraph (#2820) — a REAL force-directed graph: an actual `d3-force` physics simulation rendered
// as SVG. Unlike the hand-rolled analytics SVG in `Charts.tsx` (viewBox math, no library), this runs a
// live many-body/link/collide simulation, so it's the Design Studio's proof that a component built on an
// external library (d3) renders live in the preview — not a hand-drawn mock. It ships as its own
// `react-d3` kit (`@data/components/react-d3.json`), a second visual language under the React tech axis.
//
// The layout is a thin renderer over the pure, deterministic `forceLayout` (see ./forceLayout).
import { useMemo, type CSSProperties } from "react";
import { forceLayout, FORCE_GROUP_COLORS, FORCE_NODE_R, type ForceGraphNode, type ForceGraphLink } from "./forceLayout";

export type { ForceGraphNode, ForceGraphLink } from "./forceLayout";

export interface ForceGraphProps {
  nodes: ForceGraphNode[];
  links: ForceGraphLink[];
  /** SVG width in px. Default 320. */
  width?: number;
  /** SVG height in px. Default 220. */
  height?: number;
  style?: CSSProperties;
}

/** A live force-directed graph — a real `d3-force` layout drawn as SVG (edges then labelled nodes). */
export function ForceGraph({ nodes, links, width = 320, height = 220, style }: ForceGraphProps) {
  const layout = useMemo(() => forceLayout(nodes, links, width, height), [nodes, links, width, height]);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Force-directed graph"
      style={{ maxWidth: "100%", display: "block", ...style }}
    >
      {layout.links.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="var(--border-strong, #3a434d)" strokeWidth={1.25} strokeOpacity={0.7} />
      ))}
      {layout.nodes.map((nd) => (
        <g key={nd.id} transform={`translate(${nd.x} ${nd.y})`}>
          <circle r={FORCE_NODE_R} fill={FORCE_GROUP_COLORS[nd.group % FORCE_GROUP_COLORS.length]} stroke="var(--bg)" strokeWidth={1.5} />
          {nd.label && (
            <text x={0} y={FORCE_NODE_R + 11} textAnchor="middle" fontFamily="var(--mono)" fontSize={9} fill="var(--fg-muted)">{nd.label}</text>
          )}
        </g>
      ))}
    </svg>
  );
}
